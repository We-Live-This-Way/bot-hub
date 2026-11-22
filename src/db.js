// SQLite storage for the hub (node:sqlite, built into Node 24 — no dependencies).
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashKey(key) {
  return createHash("sha256").update(key).digest("hex");
}
export function newKey(prefix = "hub") {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}
/** Mask hub keys (hub_, hubguest_, hubadmin_, unclaimed_, any future hub…_ prefix),
 *  #key= / ?key= / ?api_key= values, and Bearer tokens. Use on logs and any output
 *  that is not the one-time "shown once" invite/rotate display. */
export function redactSecrets(text) {
  if (text == null) return text;
  let s = typeof text === "string" ? text : (text instanceof Error ? (text.stack || text.message) : (() => { try { return JSON.stringify(text); } catch { return String(text); } })());
  s = s.replace(/#key=[^\s&#"']+/gi, "#key=[REDACTED]");
  s = s.replace(/([?&](?:api_key|key)=)[^&\s"']+/gi, "$1[REDACTED]");
  s = s.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
  s = s.replace(/(\b(?:x-)?api-?key\s*[:=]\s*)\S+/gi, "$1[REDACTED]");
  s = s.replace(/\b(?:hub[a-z]*|unclaimed)_[A-Za-z0-9_-]{8,}/gi, (m) => `${m.slice(0, m.indexOf("_") + 1)}[REDACTED]`);
  return s;
}
export function installLogRedaction(cons = console) {
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    const orig = cons[m].bind(cons);
    cons[m] = (...args) => orig(...args.map((a) => {
      if (typeof a === "string") return redactSecrets(a);
      if (a instanceof Error) {
        const e = new Error(redactSecrets(a.message));
        e.name = a.name;
        e.stack = a.stack ? redactSecrets(a.stack) : a.stack;
        if (a.status != null) e.status = a.status;
        return e;
      }
      return a;
    }));
  }
}
function headerVal(req, name) {
  const v = req?.headers?.[name];
  if (v == null) return "";
  return String(Array.isArray(v) ? v[0] : v).trim();
}
/** Pull a hub key from the headers or query Meta AI and other connectors actually send.
 *  Order: Bearer, raw Authorization, x-api-key, api-key, then api_key / key query params. */
export function extractAuth(req) {
  const auth = headerVal(req, "authorization");
  if (auth) {
    const m = auth.match(/^Bearer\s+(\S+)/i);
    if (m) return { key: m[1], method: "bearer" };
    return { key: auth, method: "authorization" };
  }
  const xApi = headerVal(req, "x-api-key");
  if (xApi) return { key: xApi, method: "x-api-key" };
  const apiKey = headerVal(req, "api-key");
  if (apiKey) return { key: apiKey, method: "api-key" };
  let url;
  try { url = new URL(req.url, "http://hub.local"); } catch { url = null; }
  const qApi = url?.searchParams.get("api_key");
  if (qApi && qApi.trim()) return { key: qApi.trim(), method: "query:api_key" };
  const qKey = url?.searchParams.get("key");
  if (qKey && qKey.trim()) return { key: qKey.trim(), method: "query:key" };
  return { key: "", method: null };
}
export function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "member";
}

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS members (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      slug TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT 'bot',          -- bot | human
      is_admin INTEGER NOT NULL DEFAULT 0,
      key_hash TEXT NOT NULL,
      managed_key INTEGER NOT NULL DEFAULT 0,    -- 1: a copy of the key lives in data/keys/<slug>.key (for a local bridge)
      omb_bot_id TEXT,                           -- OpenMausBot bot id, for wake-ups
      wake INTEGER NOT NULL DEFAULT 0,           -- wake on @mention
      created_at INTEGER NOT NULL,
      last_seen INTEGER
    );
    CREATE TABLE IF NOT EXISTS rooms (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      topic TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      author_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
      author_name TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to INTEGER,
      mentions TEXT NOT NULL DEFAULT '[]',
      depth INTEGER NOT NULL DEFAULT 0,          -- wake-reply chain depth (loop guard)
      via TEXT NOT NULL DEFAULT 'api',           -- api | mcp | web | wake
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_room ON messages(room_id, id);
    CREATE TABLE IF NOT EXISTS wake_threads (
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      thread TEXT NOT NULL,
      PRIMARY KEY (member_id, room_id)
    );
    CREATE TABLE IF NOT EXISTS wake_log (
      id INTEGER PRIMARY KEY,
      member_id INTEGER, message_id INTEGER, status TEXT, detail TEXT, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (k TEXT PRIMARY KEY, v TEXT NOT NULL);
  `);
  migrate(db);
  return db;
}

// Additive migrations (v0.2: visitors). Each runs once, when its column first appears.
function hasCol(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}
function migrate(db) {
  if (!hasCol(db, "members", "role")) {
    db.exec("ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'"); // member | guest (admin = is_admin)
    db.exec("ALTER TABLE members ADD COLUMN expires_at INTEGER");                  // guests: key stops working after this
    db.exec("ALTER TABLE members ADD COLUMN invited_by TEXT");
  }
  if (!hasCol(db, "members", "guest_wake")) db.exec("ALTER TABLE members ADD COLUMN guest_wake INTEGER NOT NULL DEFAULT 0"); // visitors may wake this bot
  if (!hasCol(db, "rooms", "visitors")) {
    db.exec("ALTER TABLE rooms ADD COLUMN visitors INTEGER NOT NULL DEFAULT 0");   // 1: open to guest keys
    db.exec("UPDATE rooms SET visitors = 1 WHERE name IN ('general', 'visitors')");
  }
  if (!hasCol(db, "messages", "guest")) {
    db.exec("ALTER TABLE messages ADD COLUMN guest INTEGER NOT NULL DEFAULT 0");        // author was a visitor
    db.exec("ALTER TABLE messages ADD COLUMN guest_origin INTEGER NOT NULL DEFAULT 0"); // visitor started this wake chain
  }
  const home = (process.env.BOT_HUB_MACHINE || "home").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32) || "home";
  // v0.3: bots on other machines that pick up their own @mentions by polling
  if (!hasCol(db, "members", "machine")) db.exec("ALTER TABLE members ADD COLUMN machine TEXT");                        // the hub's own machine (BOT_HUB_MACHINE) | another machine's name | null (humans, visitors)
  if (!hasCol(db, "members", "wake_via")) db.exec("ALTER TABLE members ADD COLUMN wake_via TEXT NOT NULL DEFAULT 'local'"); // local (hub calls OpenMausBot) | poll (bot's machine pulls)
  db.exec(`CREATE TABLE IF NOT EXISTS wake_queue (
      id INTEGER PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      message_id INTEGER NOT NULL,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      depth INTEGER NOT NULL DEFAULT 0,
      guest_origin INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      claimed_at INTEGER,
      done_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS wake_queue_member ON wake_queue(member_id, done_at);`);
  // One-time backfill (v0.3); run on every start it would also tag approved outside members as house bots.
  if (!db.prepare("SELECT 1 FROM settings WHERE k = 'mig_machine_backfill'").get()) {
    db.prepare("UPDATE members SET machine = ? WHERE machine IS NULL AND kind = 'bot' AND role = 'member' AND wake_via = 'local'").run(home);
    db.prepare("INSERT OR REPLACE INTO settings(k, v) VALUES ('mig_machine_backfill', 'done')").run();
  }
  // v0.4: agent type (platform) and model per member; self-serve join requests (admin-approved)
  if (!hasCol(db, "members", "platform")) {
    db.exec("ALTER TABLE members ADD COLUMN platform TEXT"); // OpenMausBot | Grok Bot | ChatGPT | Claude | Custom | ... (null for people)
    db.exec("ALTER TABLE members ADD COLUMN model TEXT");    // e.g. DeepSeek V4.1 Flash (blank when unknown)
    db.exec("UPDATE members SET platform = 'OpenMausBot' WHERE kind = 'bot' AND role = 'member' AND machine IS NOT NULL");
  }
  db.exec(`CREATE TABLE IF NOT EXISTS join_requests (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      platform TEXT,
      note TEXT NOT NULL DEFAULT '',
      contact TEXT NOT NULL DEFAULT '',
      claim_hash TEXT NOT NULL UNIQUE,        -- sha256 of the one-time claim code; the code itself is only ever shown to the requester
      status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | claimed | expired
      days INTEGER,
      member_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL,
      decided_at INTEGER,
      decided_by TEXT,
      claimed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS join_requests_status ON join_requests(status, created_at);`);
  // v0.5: room listeners: bots woken by a person's un-@mentioned posts in that room
  db.exec(`CREATE TABLE IF NOT EXISTS room_listeners (
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, member_id)
    );`);
  if (!hasCol(db, "wake_queue", "ambient")) db.exec("ALTER TABLE wake_queue ADD COLUMN ambient INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      message_id INTEGER,
      uploader_id INTEGER REFERENCES members(id) ON DELETE SET NULL,
      uploader_name TEXT NOT NULL,
      name TEXT NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      content TEXT NOT NULL,
      guest INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );`);                                                                                  // v0.6: .md/.txt attachments
  if (!hasCol(db, "messages", "file_id")) db.exec("ALTER TABLE messages ADD COLUMN file_id INTEGER");
  // v0.6.1: uploads are opt-in (admin, plus members the admin marks as uploaders); every file gets an unguessable public link
  if (!hasCol(db, "members", "uploader")) db.exec("ALTER TABLE members ADD COLUMN uploader INTEGER NOT NULL DEFAULT 0");
  if (!hasCol(db, "files", "public_token")) {
    db.exec("ALTER TABLE files ADD COLUMN public_token TEXT");
    const set = db.prepare("UPDATE files SET public_token = ? WHERE id = ?");
    for (const f of db.prepare("SELECT id FROM files WHERE public_token IS NULL").all()) set.run(randomBytes(18).toString("base64url"), f.id);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS files_public_token ON files(public_token)");
  }
  // v0.6.1: private rooms with a roster (only roster members, plus the admin, can see or be woken there)
  if (!hasCol(db, "rooms", "private")) db.exec("ALTER TABLE rooms ADD COLUMN private INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE TABLE IF NOT EXISTS room_roster (
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, member_id)
    );`);
  // v0.7: class notes: a file can be gated (no open link, not listed) and handed to chosen members only
  if (!hasCol(db, "files", "gated")) db.exec("ALTER TABLE files ADD COLUMN gated INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE TABLE IF NOT EXISTS file_grants (
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      granted_by TEXT,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (file_id, member_id)
    );`);
  if (!hasCol(db, "wake_queue", "progress_at")) db.exec("ALTER TABLE wake_queue ADD COLUMN progress_at INTEGER"); // v0.6: one "working on it" note
  if (!hasCol(db, "wake_queue", "progress_msg")) db.exec("ALTER TABLE wake_queue ADD COLUMN progress_msg INTEGER"); // v0.8: that note's message id (edited into the answer)
  if (!hasCol(db, "messages", "edited_at")) db.exec("ALTER TABLE messages ADD COLUMN edited_at INTEGER"); // v0.8: last edit time (null: never edited)
  db.exec("CREATE INDEX IF NOT EXISTS messages_edited ON messages(room_id, edited_at) WHERE edited_at IS NOT NULL");
  // v0.8.4: /clear archives a room's messages (hidden, not deleted) so they can be restored
  if (!hasCol(db, "messages", "archived_at")) {
    db.exec("ALTER TABLE messages ADD COLUMN archived_at INTEGER");
    db.exec("CREATE INDEX IF NOT EXISTS messages_room_live ON messages(room_id, id) WHERE archived_at IS NULL");
  }
  if (!hasCol(db, "rooms", "transcript_at")) db.exec("ALTER TABLE rooms ADD COLUMN transcript_at INTEGER");
  // v0.9: direct messages are private rooms with kind='dm' (channel is the default)
  if (!hasCol(db, "rooms", "kind")) db.exec("ALTER TABLE rooms ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel'"); // channel | dm

  // v0.8.5: /clear hides a room's current messages for one member only (across their devices)
  db.exec(`CREATE TABLE IF NOT EXISTS member_clears (
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      cleared_through INTEGER NOT NULL DEFAULT 0,
      cleared_at INTEGER NOT NULL,
      PRIMARY KEY (member_id, room_id)
    );`);
  // v0.8.7: named groups of members (e.g. sales); membership only, no extra access
  db.exec(`CREATE TABLE IF NOT EXISTS groups (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS group_members (
      group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (group_id, member_id)
    );`);
  // v0.11: class notes reach every bot they're granted to: a delivery per (file, member), plus a one-time download link
  db.exec(`CREATE TABLE IF NOT EXISTS note_deliveries (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      requested_by TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      done_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending',
      detail TEXT,
      path TEXT,
      parts INTEGER,
      dm_message_id INTEGER,
      link_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS note_deliveries_status ON note_deliveries(status);
    CREATE TABLE IF NOT EXISTS note_links (
      id INTEGER PRIMARY KEY,
      file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      delivery_id INTEGER,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      used_ip TEXT,
      revoked_at INTEGER
    );`);
  // v0.11: polled bots get class notes through their wake queue: the part's own text, and where the answer goes
  if (!hasCol(db, "wake_queue", "payload")) db.exec("ALTER TABLE wake_queue ADD COLUMN payload TEXT");
  if (!hasCol(db, "wake_queue", "delivery_id")) db.exec("ALTER TABLE wake_queue ADD COLUMN delivery_id INTEGER");
  if (!hasCol(db, "wake_queue", "part")) db.exec("ALTER TABLE wake_queue ADD COLUMN part INTEGER");
  if (!hasCol(db, "wake_queue", "reply_room_id")) db.exec("ALTER TABLE wake_queue ADD COLUMN reply_room_id INTEGER");
  // v0.11.3: read-only owner-view links: a token per member that shows what that bot sees, but can
  // never sign in or post as them. Only the sha256 hash is stored; the token is shown once, to the admin.
  db.exec(`CREATE TABLE IF NOT EXISTS owner_links (
      id INTEGER PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER
    );`);
  // v0.11.4: member_clears.kept — how many messages a partial /clear<N> kept (0 = a full /clear).
  if (!hasCol(db, "member_clears", "kept")) db.exec("ALTER TABLE member_clears ADD COLUMN kept INTEGER NOT NULL DEFAULT 0");
}

export function findMemberByKey(db, key) {
  if (!key || typeof key !== "string" || key.length > 200) return null;
  const h = hashKey(key);
  const row = db.prepare("SELECT * FROM members WHERE key_hash = ?").get(h);
  if (!row) return null;
  if (row.expires_at && row.expires_at < Date.now()) return null; // expired visitor key
  const a = Buffer.from(h, "hex"), b = Buffer.from(row.key_hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? row : null;
}
