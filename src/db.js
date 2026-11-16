// SQLite storage for the hub (node:sqlite, built into Node 24 — no dependencies).
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashKey(key) {
  return createHash("sha256").update(key).digest("hex");
}
export function newKey(prefix = "hub") {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
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
  if (!hasCol(db, "wake_queue", "progress_at")) db.exec("ALTER TABLE wake_queue ADD COLUMN progress_at INTEGER"); // v0.6: one "working on it" note
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
