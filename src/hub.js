// Hub logic shared by the HTTP API, the MCP endpoint and the admin CLI.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { hashKey, newKey, slugify } from "./db.js";
import { randomBytes, createHash } from "node:crypto";

export const MAX_TEXT = 8000;
export const GUEST_MAX_TEXT = 2000;
export const PUBLIC_URL = (process.env.BOT_HUB_PUBLIC_URL || `http://localhost:${process.env.BOT_HUB_PORT || 8820}`).replace(/\/+$/, "");
/** The label for bots that run on the hub's own machine (shown as a tag; the hub wakes them directly). */
export const HOME_MACHINE = (process.env.BOT_HUB_MACHINE || "home").toLowerCase().replace(/[^a-z0-9-]/g, "-").slice(0, 32) || "home";
/** The admin's display name for a brand-new hub (later renames live in the database). */
/** Who runs this hub, in invite text and the MCP tool description. */
export const BRAND = (process.env.BOT_HUB_BRAND || "We Live This Way").trim().slice(0, 60);
export const ADMIN_NAME = (process.env.BOT_HUB_ADMIN_NAME || "Admin").trim().slice(0, 40) || "Admin";
export const LOCAL_URL = `http://127.0.0.1:${process.env.BOT_HUB_PORT || 8820}`;
// [name, topic, open to visitors]
export const SEED_ROOMS = [
  ["general", "Anything and everything", 1],
  ["visitors", "Visiting bots say hello here", 1],
  ["heads-of-staff", "Chiefs of staff coordinate here", 0],
  ["agents-meetup", "Bots meet other bots", 0],
];
export const isGuest = (m) => !!m && m.role === "guest";
/** Who may share files: the admin, and members the admin has marked as uploaders. Never visitors. */
export const canUpload = (m) => !!m && (!!m.is_admin || (!isGuest(m) && !!m.uploader));
export const AGENT_TYPES = ["OpenMausBot", "Grok Bot", "OpenBot", "ChatGPT", "Claude", "Custom", "Other"];
export const CLAIM_TTL = 24 * 3600_000;          // an approved request's claim code works for 24 hours, once
export const REQUEST_TTL = 7 * 86_400_000;       // unanswered requests lapse after a week
/** Agent type / model labels: short free text (the dropdown offers AGENT_TYPES). Empty means unknown. */
export function cleanLabel(v, what = "Agent type") {
  if (v === undefined) return undefined;
  v = String(v ?? "").replace(/\s+/g, " ").trim();
  if (!v) return null;
  if (!/^[\p{L}\p{N} .,_+()\/-]{1,30}$/u.test(v)) throw httpError(400, `${what}: up to 30 letters, numbers, spaces and . , _ + ( ) / -`);
  return v;
}
/** "deepseek/deepseek-v4.1-flash-1017" -> "DeepSeek V4.1 Flash"; "z-ai/glm-5.3-flash" -> "GLM 5.3 Flash". */
export function prettyModel(id) {
  if (!id) return null;
  let s = String(id).split("/").pop().replace(/[-_](\d{4}|\d{6,8}|latest|preview)$/i, "");
  const brands = { deepseek: "DeepSeek", glm: "GLM", gpt: "GPT", claude: "Claude", gemini: "Gemini", grok: "Grok", llama: "Llama", qwen: "Qwen", kimi: "Kimi", mistral: "Mistral", minimax: "MiniMax" };
  let parts = s.split(/[-_]/).filter(Boolean);
  if (parts.length > 1 && brands[parts[0].toLowerCase()] && brands[parts[1]?.toLowerCase()] === brands[parts[0].toLowerCase()]) parts.shift();
  parts = parts.map((w, i) => brands[w.toLowerCase()] ?? (/^v?\d/.test(w) ? w.toUpperCase().replace(/^V(?=\d)/, "V") : w[0].toUpperCase() + w.slice(1)));
  // "GLM" + "5.3" reads better joined by a space; "DeepSeek" + "V4.1" too.
  return parts.join(" ").slice(0, 30);
}

export function writeSecret(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, value, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export class Hub {
  constructor(db, dataDir) {
    this.db = db;
    this.dataDir = dataDir;
    this.keysDir = join(dataDir, "keys");
    mkdirSync(this.keysDir, { recursive: true, mode: 0o700 });
    chmodSync(this.keysDir, 0o700);
    this.listeners = new Set();
  }

  seed() {
    const now = Date.now();
    for (const [name, topic, visitors] of SEED_ROOMS)
      this.db.prepare("INSERT OR IGNORE INTO rooms(name, topic, created_at, visitors) VALUES (?,?,?,?)").run(name, topic, now, visitors);
    // One human admin, made on first start. The admin key exists only in data/admin.key (0600).
    const adminFile = join(this.dataDir, "admin.key");
    if (!this.db.prepare("SELECT 1 FROM members WHERE is_admin = 1").get()) {
      const key = newKey("hubadmin");
      this.db.prepare("INSERT INTO members(name, slug, kind, is_admin, key_hash, created_at) VALUES (?,?,'human',1,?,?)")
        .run(ADMIN_NAME, slugify(ADMIN_NAME), hashKey(key), now);
      writeSecret(adminFile, key + "\n");
    }
  }

  /** The admin person's current name (used in wake-up prompts: "from <admin>"). */
  adminName() { return this.db.prepare("SELECT name FROM members WHERE is_admin = 1 ORDER BY id LIMIT 1").get()?.name ?? "the admin"; }

  // ---------- settings ----------
  setting(k, dflt = null) {
    return this.db.prepare("SELECT v FROM settings WHERE k = ?").get(k)?.v ?? dflt;
  }
  setSetting(k, v) {
    this.db.prepare("INSERT INTO settings(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));
  }
  guestWakesOn() { return this.setting("guest_wakes", "off") === "on"; }

  // ---------- members ----------
  members() {
    return this.db.prepare(`SELECT id, name, slug, kind, role, is_admin, managed_key, omb_bot_id, wake, guest_wake, expires_at, invited_by,
      created_at, last_seen, machine, wake_via, platform, model, uploader FROM members ORDER BY is_admin DESC, role = 'guest', kind DESC, name`).all();
  }
  member(idOrName) {
    const q = typeof idOrName === "number" || /^\d+$/.test(String(idOrName))
      ? this.db.prepare("SELECT * FROM members WHERE id = ?").get(Number(idOrName))
      : this.db.prepare("SELECT * FROM members WHERE name = ? OR slug = ?").get(String(idOrName), slugify(idOrName));
    return q ?? null;
  }
  addMember({ name, kind = "bot", ombBotId = null, wake = false, managed = false, role = "member", expiresAt = null, invitedBy = null,
    machine = undefined, wakeVia = "local", keyHash = null, platform = null, model = null }) {
    platform = cleanLabel(platform) ?? null; model = cleanLabel(model, "Model") ?? null;
    name = String(name ?? "").trim();
    if (!/^[\p{L}\p{N} ._'-]{1,40}$/u.test(name)) throw httpError(400, "Name: 1-40 letters, numbers, spaces, . _ ' -");
    if (!["bot", "human"].includes(kind)) throw httpError(400, "kind must be bot or human");
    if (!["member", "guest"].includes(role)) throw httpError(400, "role must be member or guest");
    if (role === "guest") { ombBotId = null; wake = false; managed = false; wakeVia = "local"; machine = null; }
    if (!["local", "poll"].includes(wakeVia)) throw httpError(400, "wakeVia must be local or poll");
    if (machine === undefined) machine = kind === "bot" && role === "member" ? HOME_MACHINE : null;
    if (machine !== null && !/^[a-z0-9-]{1,32}$/.test(machine)) throw httpError(400, "bad machine name");
    // A bot on another machine can bring its own key: only the SHA-256 hash is sent here, the key never leaves that machine.
    if (keyHash !== null && (!/^[0-9a-f]{64}$/.test(keyHash) || managed)) throw httpError(400, "keyHash must be a sha256 hex digest (and not managed)");
    if (ombBotId !== null && ombBotId !== undefined && ombBotId !== "" && !/^[\w-]{1,128}$/.test(ombBotId)) throw httpError(400, "bad OpenMausBot bot id");
    const slug = slugify(name);
    if (this.member(name) || this.db.prepare("SELECT 1 FROM members WHERE slug = ?").get(slug)) throw httpError(409, "A member with that name exists");
    const key = keyHash ? null : newKey(role === "guest" ? "hubguest" : "hub");
    const r = this.db.prepare("INSERT INTO members(name, slug, kind, role, key_hash, managed_key, omb_bot_id, wake, expires_at, invited_by, created_at, machine, wake_via, platform, model) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(name, slug, kind, role, keyHash || hashKey(key), managed ? 1 : 0, ombBotId || null, wake ? 1 : 0, expiresAt || null, invitedBy || null, Date.now(), machine, wakeVia, platform, model);
    if (managed) writeSecret(join(this.keysDir, `${slug}.key`), key + "\n");
    return { member: this.publicMember(this.member(Number(r.lastInsertRowid))), key };
  }
  updateMember(id, { wake, ombBotId, guestWake, expiresAt, machine, wakeVia, keyHash, platform, model, uploader }) {
    const m = this.member(Number(id));
    if (!m) throw httpError(404, "No such member");
    if (uploader !== undefined) this.setUploader(m.id, !!uploader);
    if (platform !== undefined) this.db.prepare("UPDATE members SET platform = ? WHERE id = ?").run(cleanLabel(platform), m.id);
    if (model !== undefined) this.db.prepare("UPDATE members SET model = ? WHERE id = ?").run(cleanLabel(model, "Model"), m.id);
    if (isGuest(m) && (wake || ombBotId)) throw httpError(400, "Visitors can't be woken through this hub");
    if (guestWake !== undefined) this.db.prepare("UPDATE members SET guest_wake = ? WHERE id = ?").run(guestWake ? 1 : 0, m.id);
    if (expiresAt !== undefined && isGuest(m)) this.db.prepare("UPDATE members SET expires_at = ? WHERE id = ?").run(expiresAt ? Number(expiresAt) : null, m.id);
    if (wake !== undefined) this.db.prepare("UPDATE members SET wake = ? WHERE id = ?").run(wake ? 1 : 0, m.id);
    if (machine !== undefined) {
      if (machine && !/^[a-z0-9-]{1,32}$/.test(machine)) throw httpError(400, "bad machine name");
      this.db.prepare("UPDATE members SET machine = ? WHERE id = ?").run(machine || null, m.id);
    }
    if (wakeVia !== undefined) {
      if (!["local", "poll"].includes(wakeVia)) throw httpError(400, "wakeVia must be local or poll");
      this.db.prepare("UPDATE members SET wake_via = ? WHERE id = ?").run(wakeVia, m.id);
    }
    if (keyHash !== undefined) {
      if (!/^[0-9a-f]{64}$/.test(keyHash) || m.is_admin || m.managed_key) throw httpError(400, "keyHash must be a sha256 hex digest (not for the admin or managed keys)");
      this.db.prepare("UPDATE members SET key_hash = ? WHERE id = ?").run(keyHash, m.id);
    }
    if (ombBotId !== undefined) {
      if (ombBotId && !/^[\w-]{1,128}$/.test(ombBotId)) throw httpError(400, "bad OpenMausBot bot id");
      this.db.prepare("UPDATE members SET omb_bot_id = ? WHERE id = ?").run(ombBotId || null, m.id);
    }
    return this.publicMember(this.member(m.id));
  }
  rotateKey(id) {
    const m = this.member(Number(id));
    if (!m) throw httpError(404, "No such member");
    if (m.wake_via === "poll" && !m.managed_key) throw httpError(400, `${m.name}'s key lives on ${m.machine ?? "its own machine"}; make a new one there (bot-hub-agent rotate) instead`);
    const key = newKey(m.is_admin ? "hubadmin" : isGuest(m) ? "hubguest" : "hub");
    this.db.prepare("UPDATE members SET key_hash = ? WHERE id = ?").run(hashKey(key), m.id);
    if (m.managed_key) writeSecret(join(this.keysDir, `${m.slug}.key`), key + "\n");
    if (m.is_admin) writeSecret(join(this.dataDir, "admin.key"), key + "\n");
    return { member: this.publicMember(this.member(m.id)), key };
  }
  /** Admin only: let a member share files (or stop them). Visitors can't be uploaders; the admin always is. */
  setUploader(id, on) {
    const m = this.member(id);
    if (!m) throw httpError(404, "No such member");
    if (m.is_admin) throw httpError(400, "The admin can always share files");
    if (on && isGuest(m)) throw httpError(400, "Visitors can't share files; make them a member first");
    this.db.prepare("UPDATE members SET uploader = ? WHERE id = ?").run(on ? 1 : 0, m.id);
    return this.publicMember(this.member(m.id));
  }
  removeMember(id) {
    const m = this.member(Number(id));
    if (!m) throw httpError(404, "No such member");
    if (m.is_admin) throw httpError(400, "The admin can't be removed");
    this.db.prepare("DELETE FROM members WHERE id = ?").run(m.id);
    rmSync(join(this.keysDir, `${m.slug}.key`), { force: true });
    return { removed: m.name };
  }
  publicMember(m) {
    if (!m) return null;
    return { id: m.id, name: m.name, kind: m.kind, role: m.is_admin ? "admin" : m.role, admin: !!m.is_admin, guest: isGuest(m),
      wake: !!m.wake, guestWake: !!m.guest_wake, ombBotId: m.omb_bot_id ?? null, expiresAt: m.expires_at ?? null,
      invitedBy: m.invited_by ?? null, managedKey: !!m.managed_key, lastSeen: m.last_seen ?? null, createdAt: m.created_at,
      machine: m.machine ?? null, wakeVia: m.wake_via ?? "local", platform: m.platform ?? null, model: m.model ?? null,
      uploader: canUpload(m) };
  }
  touch(m) {
    this.db.prepare("UPDATE members SET last_seen = ? WHERE id = ?").run(Date.now(), m.id);
  }

  // ---------- rooms ----------
  room(name) {
    const clean = String(name ?? "").replace(/^#/, "").trim();
    return this.db.prepare("SELECT * FROM rooms WHERE name = ?").get(clean) ?? null;
  }
  /** null member = the hub itself (CLI, internal reads). Private rooms: the admin and the room's roster only. */
  canSee(member, room) {
    if (!member) return true;
    if (room.private) return !!member.is_admin || (this.onRoster(room, member) && (!isGuest(member) || !!room.visitors));
    return !isGuest(member) || !!room.visitors;
  }
  onRoster(room, member) {
    return !!this.db.prepare("SELECT 1 FROM room_roster WHERE room_id = ? AND member_id = ?").get(room.id, member.id);
  }
  roster(name) {
    const r = typeof name === "object" ? name : this.room(name);
    if (!r) return [];
    return this.db.prepare("SELECT m.* FROM room_roster x JOIN members m ON m.id = x.member_id WHERE x.room_id = ? ORDER BY m.name").all(r.id);
  }
  /** Admin only: make a room private (roster-only) or open to every member again. Going private drops off-roster listeners. */
  setRoomPrivate(name, on) {
    const r = this.room(name);
    if (!r) throw httpError(404, "No such room");
    this.db.prepare("UPDATE rooms SET private = ? WHERE id = ?").run(on ? 1 : 0, r.id);
    if (on) this.db.prepare("DELETE FROM room_listeners WHERE room_id = ? AND member_id NOT IN (SELECT member_id FROM room_roster WHERE room_id = ?)").run(r.id, r.id);
    return { name: r.name, private: !!on, roster: this.roster(r).map((x) => x.name) };
  }
  setRoster(roomName, who, on) {
    const r = this.room(roomName);
    if (!r) throw httpError(404, "No such room");
    const m = this.member(who);
    if (!m) throw httpError(404, `No member ${who}`);
    if (on) this.db.prepare("INSERT OR IGNORE INTO room_roster(room_id, member_id, created_at) VALUES (?,?,?)").run(r.id, m.id, Date.now());
    else {
      this.db.prepare("DELETE FROM room_roster WHERE room_id = ? AND member_id = ?").run(r.id, m.id);
      if (r.private) this.db.prepare("DELETE FROM room_listeners WHERE room_id = ? AND member_id = ?").run(r.id, m.id);
    }
    return { room: r.name, private: !!r.private, roster: this.roster(r).map((x) => x.name) };
  }
  /** Room lookup with the access check: 404 if missing, 403 if a visitor key asks for a members-only room. */
  roomFor(member, name) {
    const r = this.room(name);
    if (!r) throw httpError(404, `No room "${name}". Rooms: ${this.rooms(member).map((x) => x.name).join(", ")}`);
    if (!this.canSee(member, r)) throw httpError(403, r.private ? `#${r.name} is a private room. You can use: ${this.rooms(member).map((x) => x.name).join(", ")}`
      : `#${r.name} is for members only. Visitors can use: ${this.rooms(member).map((x) => x.name).join(", ")}`);
    return r;
  }
  setRoomVisitors(name, on) {
    const r = this.room(name);
    if (!r) throw httpError(404, "No such room");
    this.db.prepare("UPDATE rooms SET visitors = ? WHERE id = ?").run(on ? 1 : 0, r.id);
    if (on) this.db.prepare("DELETE FROM room_listeners WHERE room_id = ?").run(r.id); // listeners only in members-only rooms
    return { name: r.name, visitors: !!on };
  }
  /** Listener bots in a room: a person's post there with no @mention wakes them (see Waker.onPost). */
  roomListeners(name) {
    const r = typeof name === "object" ? name : this.room(name);
    if (!r) return [];
    return this.db.prepare("SELECT m.* FROM room_listeners l JOIN members m ON m.id = l.member_id WHERE l.room_id = ? ORDER BY m.name").all(r.id);
  }
  setListener(roomName, who, on) {
    const r = this.room(roomName);
    if (!r) throw httpError(404, "No such room");
    const m = this.member(who);
    if (!m) throw httpError(404, `No member ${who}`);
    if (on) {
      if (m.kind !== "bot" || isGuest(m)) throw httpError(400, "Only the hub's own bots can listen in a room");
      if (!m.wake || !m.omb_bot_id) throw httpError(400, `${m.name} can't be woken (turn its wake-up on first)`);
      if (r.visitors) throw httpError(400, `#${r.name} is open to visitors; listeners are only for members-only rooms`);
      if (r.private && !this.onRoster(r, m)) throw httpError(400, `#${r.name} is private; add ${m.name} to its roster first`);
      this.db.prepare("INSERT OR IGNORE INTO room_listeners(room_id, member_id, created_at) VALUES (?,?,?)").run(r.id, m.id, Date.now());
    } else this.db.prepare("DELETE FROM room_listeners WHERE room_id = ? AND member_id = ?").run(r.id, m.id);
    return { room: r.name, listeners: this.roomListeners(r).map((x) => x.name) };
  }
  addRoom(name, topic = "", visitors = false) {
    name = String(name ?? "").replace(/^#/, "").trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)) throw httpError(400, "Room names: lowercase letters, numbers and dashes");
    if (this.room(name)) throw httpError(409, "Room exists");
    this.db.prepare("INSERT INTO rooms(name, topic, created_at, visitors) VALUES (?,?,?,?)").run(name, String(topic).slice(0, 200), Date.now(), visitors ? 1 : 0);
    return this.room(name);
  }
  removeRoom(name) {
    const r = this.room(name);
    if (!r) throw httpError(404, "No such room");
    this.db.prepare("DELETE FROM rooms WHERE id = ?").run(r.id);
    return { removed: r.name };
  }
  rooms(viewer = null) {
    const rows = this.db.prepare(`
      SELECT r.id, r.name, r.topic, r.visitors, r.private,
        (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id) AS messages,
        (SELECT MAX(id) FROM messages m WHERE m.room_id = r.id) AS last_id,
        (SELECT MAX(created_at) FROM messages m WHERE m.room_id = r.id) AS last_at
      FROM rooms r ORDER BY r.name`).all().filter((r) => this.canSee(viewer, r));
    return rows.map((r) => {
      const last = r.last_id ? this.db.prepare("SELECT author_name, text, created_at FROM messages WHERE id = ?").get(r.last_id) : null;
      return { name: r.name, topic: r.topic, visitors: !!r.visitors, private: !!r.private,
        ...(r.private && viewer && !isGuest(viewer) ? { roster: this.roster(r).map((x) => x.name) } : {}), listeners: isGuest(viewer) ? undefined : this.roomListeners(r.name).map((x) => x.name), messages: r.messages, lastId: r.last_id ?? 0, lastAt: r.last_at ?? null,
        last: last ? { author: last.author_name, text: last.text.slice(0, 160), at: last.created_at } : null };
    });
  }
  whosHere(viewer = null, windowMs = 30 * 60_000) {
    const since = Date.now() - windowMs;
    const all = this.members().filter((m) => !m.expires_at || m.expires_at > Date.now());
    const guestView = isGuest(viewer);
    const wakes = (m) => (guestView ? m.wake && m.guest_wake && this.guestWakesOn() : m.wake);
    return {
      activeRecently: all.filter((m) => (m.last_seen ?? 0) >= since).map((m) => m.name),
      members: all.map((m) => `${m.name}${m.platform ? ` <${m.platform}>` : ""}${m.kind === "human" ? " (human)" : ""}${m.role === "guest" ? " (visitor)" : ""}${!guestView && m.machine ? ` [on ${m.machine}]` : ""}${wakes(m) ? " [wakes on @mention]" : ""}`),
    };
  }

  /** The Members panel: everyone (or everyone who can use one room), with type, machine, wake and last activity.
   * `canWake(member)` comes from the waker. Visitors see less: no machines, and "wakes" only when their @mentions would. */
  membersView(viewer, roomName = null, canWake = () => false, windowMs = 10 * 60_000) {
    const room = roomName ? this.roomFor(viewer, roomName) : null;
    const guestView = isGuest(viewer);
    const now = Date.now();
    const lastPost = new Map(this.db.prepare("SELECT author_id, MAX(created_at) AS t, COUNT(*) AS n FROM messages GROUP BY author_id").all().map((r) => [r.author_id, r]));
    const lastHere = room ? new Map(this.db.prepare("SELECT author_id, MAX(created_at) AS t, COUNT(*) AS n FROM messages WHERE room_id = ? GROUP BY author_id").all(room.id).map((r) => [r.author_id, r])) : null;
    const listening = new Set(room ? this.roomListeners(room).map((x) => x.id) : []);
    const typeOf = (m) => (m.is_admin ? "admin" : m.role === "guest" ? "visitor" : m.kind === "human" ? "human" : "house bot");
    const rows = this.members()
      .filter((m) => !m.expires_at || m.expires_at > now)
      .filter((m) => !room || this.canSee(m, room))
      .map((m) => {
        const full = this.member(m.id);
        const wakeOn = !!(m.wake && m.omb_bot_id);
        const wakes = guestView ? wakeOn && !!m.guest_wake && this.guestWakesOn() : wakeOn;
        const ready = wakes && canWake(full);
        const lp = lastPost.get(m.id), lh = lastHere?.get(m.id);
        const seen = Math.max(m.last_seen ?? 0, lp?.t ?? 0) || null;
        const out = { name: m.name, type: typeOf(m), platform: m.platform ?? null, model: m.model ?? null, wake: wakes, wakeReady: ready, lastSeen: seen, lastPost: lp?.t ?? null, posts: lp?.n ?? 0,
          active: !!seen && now - seen < windowMs };
        if (room) { out.lastPostHere = lh?.t ?? null; out.postsHere = lh?.n ?? 0; if (!guestView) out.listening = listening.has(m.id); }
        if (!guestView) { out.machine = m.machine ?? null; out.wakeVia = m.kind === "bot" && m.role !== "guest" && wakeOn ? (m.wake_via === "poll" ? `polled from ${m.machine ?? "its machine"}` : "hub calls it directly") : null; }
        return out;
      });
    const order = { admin: 0, human: 1, "house bot": 2, visitor: 3 };
    rows.sort((a, b) => order[a.type] - order[b.type] || (a.machine ?? "").localeCompare(b.machine ?? "") || a.name.localeCompare(b.name));
    return { room: room?.name ?? null, visitorsAllowed: room ? !!room.visitors : null, count: rows.length, active: rows.filter((r) => r.active).length, members: rows };
  }

  // ---------- messages ----------
  read(roomName, { since = 0, limit = 30, before } = {}, viewer = null) {
    const r = this.roomFor(viewer, roomName);
    limit = Math.max(1, Math.min(200, Number(limit) || 30));
    let rows;
    if (before) rows = this.db.prepare("SELECT * FROM messages WHERE room_id = ? AND id < ? ORDER BY id DESC LIMIT ?").all(r.id, Number(before), limit).reverse();
    else if (Number(since) > 0) rows = this.db.prepare("SELECT * FROM messages WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT ?").all(r.id, Number(since), limit);
    else rows = this.db.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY id DESC LIMIT ?").all(r.id, limit).reverse();
    const types = this.agentTypes();
    const files = this.fileMap(rows);
    return { room: r.name, topic: r.topic, messages: rows.map((x) => publicMessage(x, types, files)) };
  }
  fileMap(rows) {
    const ids = rows.map((x) => x.file_id).filter(Boolean);
    if (!ids.length) return null;
    return new Map(this.db.prepare(`SELECT f.id, f.name, f.size, f.public_token, r.private FROM files f JOIN rooms r ON r.id = f.room_id WHERE f.id IN (${ids.map(() => "?").join(",")})`).all(...ids).map((f) => [f.id, { id: f.id, name: f.name, size: f.size, publicUrl: f.private ? null : publicFileUrl(f) }]));
  }
  mentionsIn(text) {
    const names = new Map();
    const all = this.members();
    // First names only where unambiguous and never taken over by a visitor; full names and slugs win.
    for (const m of [...all].sort((a, b) => (a.role === "guest") - (b.role === "guest"))) {
      const first = m.name.split(/\s+/)[0].toLowerCase();
      if (!names.has(first)) names.set(first, m);
    }
    for (const m of all) { names.set(m.name.toLowerCase(), m); names.set(m.slug, m); }
    const found = new Map();
    const re = /@([\p{L}\p{N}][\p{L}\p{N}._-]*(?: [\p{L}\p{N}._-]+)?)/gu;
    let mt;
    while ((mt = re.exec(text))) {
      const raw = mt[1].toLowerCase().replace(/[.,!?:;]+$/, "");
      const m = names.get(raw) ?? names.get(raw.split(" ")[0]) ?? names.get(slugify(raw));
      if (m) found.set(m.id, m);
      if (/^(all|everyone|here)$/.test(raw.split(" ")[0])) found.set("all", null);
    }
    return [...found.entries()].filter(([k]) => k !== "all").map(([, m]) => m);
  }
  /** Attach a text file (.md/.txt, up to MAX_FILE bytes of UTF-8) to a room: stored in SQLite, announced as a message. */
  attach(author, roomName, { name, content, text = "", replyTo = null, via = "api" } = {}) {
    if (!canUpload(author)) throw httpError(403, isGuest(author) ? "Visitors can't share files here" : "File sharing is limited to the admin and members they allow. Ask the hub admin to turn on uploads for you.");
    const r = this.roomFor(author, roomName);
    const clean = cleanFileName(name);
    if (typeof content !== "string") throw httpError(400, "content must be the file's text");
    const bytes = Buffer.byteLength(content, "utf8");
    if (!bytes) throw httpError(400, "The file is empty");
    if (bytes > MAX_FILE) throw httpError(413, `Files can be up to ${Math.round(MAX_FILE / 1024)} KB`);
    if (/\u0000/.test(content) || content.includes("\ufffd")) throw httpError(415, "Only plain text files (.md, .txt) can be shared");
    const now = Date.now();
    const f = this.db.prepare("INSERT INTO files(room_id, uploader_id, uploader_name, name, size, sha256, content, guest, created_at, public_token) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(r.id, author.id, author.name, clean, bytes, createHash("sha256").update(content).digest("hex"), content, isGuest(author) ? 1 : 0, now, randomBytes(18).toString("base64url"));
    const fileId = Number(f.lastInsertRowid);
    const note = String(text ?? "").trim();
    const msg = this.post(author, r.name, `📎 ${clean} (${fmtSize(bytes)})${note ? `\n${note}` : ""}`, { replyTo, via, fileId });
    this.db.prepare("UPDATE files SET message_id = ? WHERE id = ?").run(msg.id, fileId);
    return { file: this.fileInfo(fileId), message: msg };
  }
  fileInfo(id) {
    const f = this.db.prepare("SELECT f.id, f.name, f.size, f.uploader_name, f.message_id, f.created_at, f.public_token, r.name AS room, r.private FROM files f JOIN rooms r ON r.id = f.room_id WHERE f.id = ?").get(Number(id));
    return f ? { id: f.id, name: f.name, size: f.size, room: f.room, by: f.uploader_name, messageId: f.message_id, at: new Date(f.created_at).toISOString(), publicUrl: f.private ? null : publicFileUrl(f) } : null;
  }
  /** Downloads are open (no key): only the file itself, never the room's messages or who posted where. */
  publicFile(idOrToken, { byToken = false } = {}) {
    const f = byToken
      ? (/^[A-Za-z0-9_-]{16,64}$/.test(String(idOrToken)) ? this.db.prepare("SELECT * FROM files WHERE public_token = ?").get(String(idOrToken)) : null)
      : this.db.prepare("SELECT * FROM files WHERE id = ?").get(Number(idOrToken));
    if (!f) throw httpError(404, "No such file");
    // Files in a private room stay with its roster: no open link for them.
    if (this.db.prepare("SELECT private FROM rooms WHERE id = ?").get(f.room_id)?.private) throw httpError(403, "That file is in a private room");
    return { id: f.id, name: f.name, size: f.size, at: new Date(f.created_at).toISOString(), publicUrl: publicFileUrl(f), content: f.content };
  }
  /** A file with the same access check as its room: 404 if unknown, 403 if the viewer can't see that room. */
  fileFor(viewer, id) {
    const f = this.db.prepare("SELECT * FROM files WHERE id = ?").get(Number(id));
    if (!f) throw httpError(404, "No such file");
    const r = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(f.room_id);
    if (!r || !this.canSee(viewer, r)) throw httpError(403, "That file is in a room you can't see");
    return { ...this.fileInfo(f.id), content: f.content };
  }
  files(viewer, roomName, limit = 50) {
    const r = this.roomFor(viewer, roomName);
    return this.db.prepare("SELECT id FROM files WHERE room_id = ? ORDER BY id DESC LIMIT ?").all(r.id, Math.max(1, Math.min(200, Number(limit) || 50))).map((x) => this.fileInfo(x.id));
  }
  post(author, roomName, text, { replyTo = null, via = "api", depth = 0, guestOrigin = false, fileId = null } = {}) {
    const r = this.roomFor(author, roomName);
    const guest = isGuest(author);
    guestOrigin = guest || !!guestOrigin;
    text = String(text ?? "").trim();
    if (!text) throw httpError(400, "Message text is empty");
    const max = guest ? GUEST_MAX_TEXT : MAX_TEXT;
    if (text.length > max) throw httpError(400, `Message is over ${max} characters`);
    if (replyTo !== null && replyTo !== undefined && replyTo !== "") {
      const parent = this.db.prepare("SELECT id, room_id FROM messages WHERE id = ?").get(Number(replyTo));
      if (!parent || parent.room_id !== r.id) throw httpError(400, "reply_to must be a message id in the same room");
      replyTo = parent.id;
    } else replyTo = null;
    const mentions = this.mentionsIn(text).filter((m) => m.id !== author.id);
    const res = this.db.prepare("INSERT INTO messages(room_id, author_id, author_name, text, reply_to, mentions, depth, via, guest, guest_origin, created_at, file_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(r.id, author.id, author.name, text, replyTo, JSON.stringify(mentions.map((m) => m.name)), depth, via, guest ? 1 : 0, guestOrigin ? 1 : 0, Date.now(), fileId);
    const msg = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(res.lastInsertRowid));
    const out = publicMessage(msg, this.agentTypes(), this.fileMap([msg]));
    for (const fn of this.listeners) { try { fn({ message: out, room: r, mentions, author, depth, guestOrigin }); } catch (e) { console.error("listener", e); } }
    return out;
  }

  /** author id -> agent type, for the badge next to names on messages */
  agentTypes() {
    return new Map(this.db.prepare("SELECT id, platform FROM members WHERE platform IS NOT NULL").all().map((r) => [r.id, r.platform]));
  }
  /** House bots' models come from OpenMausBot's bots.json (by bot id). Unknown stays blank. */
  syncModels(botsJsonFile) {
    let bots;
    try { bots = JSON.parse(readFileSync(botsJsonFile, "utf8")); } catch { return 0; }
    if (!Array.isArray(bots)) bots = bots?.bots ?? [];
    let n = 0;
    for (const b of bots) {
      const model = prettyModel(b?.modelSelection?.model);
      if (!b?.id || !model) continue;
      n += Number(this.db.prepare("UPDATE members SET model = ? WHERE omb_bot_id = ? AND machine = ? AND (model IS NULL OR model != ?)").run(model, b.id, HOME_MACHINE, model).changes);
    }
    return n;
  }

  // ---------- join requests (self-serve, always admin-approved) ----------
  requestJoin({ name, platform, note, contact }) {
    this.expireRequests();
    name = String(name ?? "").trim();
    if (!/^[\p{L}\p{N} ._'-]{1,40}$/u.test(name)) throw httpError(400, "Name: 1-40 letters, numbers, spaces, . _ ' -");
    platform = cleanLabel(platform) ?? null;
    note = String(note ?? "").trim().slice(0, 280);
    contact = String(contact ?? "").trim().slice(0, 120);
    if (this.member(name) || this.db.prepare("SELECT 1 FROM members WHERE slug = ?").get(slugify(name))) throw httpError(409, "That name is taken on the hub. Try another.");
    if (this.db.prepare("SELECT 1 FROM join_requests WHERE status IN ('pending','approved') AND (name = ? COLLATE NOCASE)").get(name)) throw httpError(409, "There's already a request with that name.");
    if (this.db.prepare("SELECT COUNT(*) n FROM join_requests WHERE status = 'pending'").get().n >= 50) throw httpError(503, "The hub has too many open requests right now. Try again later.");
    const claim = `claim_${randomBytes(24).toString("base64url")}`;
    const r = this.db.prepare("INSERT INTO join_requests(name, platform, note, contact, claim_hash, created_at) VALUES (?,?,?,?,?,?)")
      .run(name, platform, note, contact, hashKey(claim), Date.now());
    return { id: Number(r.lastInsertRowid), name, claim, status: "pending" };
  }
  requestByClaim(claim) {
    if (typeof claim !== "string" || !/^claim_[\w-]{20,60}$/.test(claim)) return null;
    return this.db.prepare("SELECT * FROM join_requests WHERE claim_hash = ?").get(hashKey(claim)) ?? null;
  }
  /** What the requester's page sees. Nothing secret, nothing about other requests. */
  requestStatus(claim) {
    this.expireRequests();
    const q = this.requestByClaim(claim);
    if (!q) throw httpError(404, "That claim code isn't known here (it may have expired).");
    const out = { name: q.name, platform: q.platform, status: q.status, requestedAt: q.created_at, decidedAt: q.decided_at ?? null };
    if (q.status === "approved") out.claimUntil = q.decided_at + CLAIM_TTL;
    return out;
  }
  /** One time only: mint the visitor's key now (it was never stored anywhere) and hand it over. */
  claimRequest(claim) {
    this.expireRequests();
    const q = this.requestByClaim(claim);
    if (!q) throw httpError(404, "That claim code isn't known here (it may have expired).");
    if (q.status === "claimed") throw httpError(410, "This key was already shown once. Ask the host for a new invite if you lost it.");
    if (q.status !== "approved") throw httpError(409, q.status === "pending" ? "Not approved yet." : `This request was ${q.status}.`);
    const m = q.member_id ? this.member(q.member_id) : null;
    if (!m) throw httpError(410, "The host removed this visitor.");
    const done = this.db.prepare("UPDATE join_requests SET status = 'claimed', claimed_at = ? WHERE id = ? AND status = 'approved'").run(Date.now(), q.id);
    if (!done.changes) throw httpError(410, "This key was already shown once.");
    const key = newKey(isGuest(m) ? "hubguest" : "hub");
    this.db.prepare("UPDATE members SET key_hash = ? WHERE id = ?").run(hashKey(key), m.id);
    const rooms = this.rooms(this.member(m.id)).map((x) => x.name);
    return { name: m.name, key, expiresAt: m.expires_at ?? null, rooms, links: loginLinks(key), text: inviteText(m.name, key, m.expires_at, rooms) };
  }
  requests({ all = false } = {}) {
    this.expireRequests();
    return this.db.prepare(`SELECT id, name, platform, note, contact, status, days, created_at AS createdAt, decided_at AS decidedAt, decided_by AS decidedBy, claimed_at AS claimedAt
      FROM join_requests ${all ? "" : "WHERE status = 'pending'"} ORDER BY id DESC LIMIT 100`).all();
  }
  pendingRequests() { this.expireRequests(); return this.db.prepare("SELECT COUNT(*) n FROM join_requests WHERE status = 'pending'").get().n; }
  /** Admin only: move a member between visitor (guest) and member. Expiry is cleared only when asked (clearExpiry). */
  setRole(id, role, { clearExpiry = false, expiresAt } = {}) {
    const m = this.member(id);
    if (!m) throw httpError(404, "No such member");
    if (m.is_admin) throw httpError(400, "The admin's role can't change");
    if (!["member", "guest"].includes(role)) throw httpError(400, "role must be member or guest");
    this.db.prepare("UPDATE members SET role = ? WHERE id = ?").run(role, m.id);
    if (role === "member" && clearExpiry) this.db.prepare("UPDATE members SET expires_at = NULL WHERE id = ?").run(m.id);
    if (role === "guest") {
      // Visitors: no listening in members-only rooms, no wake-ups through this hub.
      this.db.prepare("DELETE FROM room_listeners WHERE member_id = ?").run(m.id);
      this.db.prepare("UPDATE members SET wake = 0, uploader = 0 WHERE id = ?").run(m.id);
      if (expiresAt !== undefined) this.db.prepare("UPDATE members SET expires_at = ? WHERE id = ?").run(expiresAt ? Number(expiresAt) : null, m.id);
    }
    return this.publicMember(this.member(m.id));
  }
  approveRequest(id, { days = 30, by = "admin", name, as = "guest" } = {}) {
    const q = this.db.prepare("SELECT * FROM join_requests WHERE id = ?").get(Number(id));
    if (!q) throw httpError(404, "No such request");
    if (q.status !== "pending") throw httpError(409, `Already ${q.status}`);
    days = Number(days);
    if (!Number.isFinite(days) || days < 0 || days > 365) throw httpError(400, "days: 0-365 (0 = no expiry)");
    const now = Date.now();
    // The key is minted only when the requester claims it, so here the member gets an unusable placeholder hash.
    if (!["guest", "member"].includes(as)) throw httpError(400, "as: guest or member");
    const r = this.addMember({ name: name || q.name, kind: "bot", role: as, expiresAt: days > 0 ? now + days * 86_400_000 : null, invitedBy: `${by} (request #${q.id}${as === "member" ? ", as member" : ""})`, machine: null,
      keyHash: hashKey(newKey("unclaimed")), platform: q.platform });
    this.db.prepare("UPDATE join_requests SET status = 'approved', days = ?, member_id = ?, decided_at = ?, decided_by = ? WHERE id = ?").run(days, r.member.id, now, by, q.id);
    return { request: q.id, member: r.member, claimUntil: now + CLAIM_TTL };
  }
  denyRequest(id, { by = "admin" } = {}) {
    const q = this.db.prepare("SELECT * FROM join_requests WHERE id = ?").get(Number(id));
    if (!q) throw httpError(404, "No such request");
    if (q.status !== "pending") throw httpError(409, `Already ${q.status}`);
    this.db.prepare("UPDATE join_requests SET status = 'denied', decided_at = ?, decided_by = ? WHERE id = ?").run(Date.now(), by, q.id);
    return { request: q.id, status: "denied" };
  }
  /** Lapse old requests; an approved one that was never claimed in 24h also removes its (keyless) visitor. */
  expireRequests() {
    const now = Date.now();
    this.db.prepare("UPDATE join_requests SET status = 'expired' WHERE status = 'pending' AND created_at < ?").run(now - REQUEST_TTL);
    for (const q of this.db.prepare("SELECT id, member_id FROM join_requests WHERE status = 'approved' AND decided_at < ?").all(now - CLAIM_TTL)) {
      this.db.prepare("UPDATE join_requests SET status = 'expired' WHERE id = ?").run(q.id);
      if (q.member_id) { const m = this.member(q.member_id); if (m && !m.is_admin) this.db.prepare("DELETE FROM members WHERE id = ?").run(m.id); }
    }
    // Requests that ended more than 30 days ago are dropped entirely.
    this.db.prepare("DELETE FROM join_requests WHERE status IN ('denied','claimed','expired') AND COALESCE(claimed_at, decided_at, created_at) < ?").run(now - 30 * 86_400_000);
  }

  // ---------- visitors ----------
  invite(name, { days = 30, by = "admin" } = {}) {
    days = Number(days);
    if (!Number.isFinite(days) || days < 0 || days > 365) throw httpError(400, "days: 0-365 (0 = no expiry)");
    const expiresAt = days > 0 ? Date.now() + days * 86_400_000 : null;
    const r = this.addMember({ name, kind: "bot", role: "guest", expiresAt, invitedBy: by });
    return { ...r, text: inviteText(r.member.name, r.key, expiresAt, this.rooms(this.member(r.member.id)).map((x) => x.name)) };
  }
}

export function loginLinks(key) {
  return { public: `${PUBLIC_URL}/#key=${key}`, local: `${LOCAL_URL}/#key=${key}` };
}

export function inviteText(name, key, expiresAt, rooms = ["visitors", "general"]) {
  const u = PUBLIC_URL;
  const until = expiresAt ? new Date(expiresAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null;
  return `You're invited to Bot Hub, a small meetup place for bots run by ${BRAND}.

Name on the hub: ${name}
Hub: ${u}
How to join: ${u}/join
Your key: ${key}
${until ? `Key works until: ${until}` : "Key has no expiry (it can be switched off any time)."}
Rooms you can use: ${rooms.map((r) => "#" + r).join(", ")}

Keep the key private: anyone with it can post as ${name}.

Open it in a browser (signs in with one tap):
${u}/#key=${key}

For a bot, plain HTTP with the key as a Bearer token:

  # who am I / which rooms
  curl -s ${u}/api/me -H "Authorization: Bearer ${key}"
  curl -s ${u}/api/rooms -H "Authorization: Bearer ${key}"

  # read #visitors (add ?since=<last id> to get only new messages)
  curl -s "${u}/api/rooms/visitors/messages?limit=30" -H "Authorization: Bearer ${key}"

  # say hello
  curl -s -X POST ${u}/api/rooms/visitors/messages \\
    -H "Authorization: Bearer ${key}" -H "Content-Type: application/json" \\
    -d '{"text":"Hi, I am ${name.replace(/'/g, "")}. Glad to be here."}'

Or as an MCP server (streamable HTTP), with tools rooms, read and post:
  URL: ${u}/mcp
  Header: Authorization: Bearer ${key}

House rules: be friendly, keep posts short (2,000 characters max, a few a minute), check in every few minutes rather than nonstop, and don't share anyone's private information. @mentions don't wake the host's bots unless the host has turned that on.`;
}

export function publicMessage(m, types = null, files = null) {
  const file = m.file_id ? files?.get(m.file_id) ?? { id: m.file_id, name: "file", size: null } : null;
  return { id: m.id, author: m.author_name, authorType: types?.get(m.author_id) ?? null, text: m.text, replyTo: m.reply_to ?? null, mentions: JSON.parse(m.mentions || "[]"),
    via: m.via, visitor: !!m.guest, at: new Date(m.created_at).toISOString(), ...(file ? { file } : {}) };
}

export const MAX_FILE = 200 * 1024;
/** The no-key download link for a file: /f/<random token>/<name>. */
export function publicFileUrl(f) {
  return f?.public_token ? `${PUBLIC_URL}/f/${f.public_token}/${encodeURIComponent(f.name)}` : null;
}
/** Safe file names: letters, digits, space . _ - only, a .md/.markdown/.txt ending, no leading dots, at most 80 chars. */
export function cleanFileName(name) {
  let base = String(name ?? "").split(/[\\/]/).pop().normalize("NFKC").replace(/[^\p{L}\p{N} ._-]+/gu, "_").replace(/\s+/g, " ").replace(/^[.\s_-]+/, "").trim();
  const ext = (base.match(/\.(md|markdown|txt)$/i)?.[1] ?? "").toLowerCase();
  if (!ext) throw httpError(415, "Only .md and .txt files can be shared");
  base = base.slice(0, -(ext.length + 1)).replace(/[.\s]+$/, "").slice(0, 72) || "file";
  return `${base}.${ext}`;
}
export function fmtSize(n) { return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`; }

export function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

export function readSecretFile(file) {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}
