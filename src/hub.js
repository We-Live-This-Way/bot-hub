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
/** Rooms the no-key watch page may show. Fixed allowlist; every other room 404s. */
export const WATCH_ROOMS = new Set(["classroom"]);
const envSet = (name) => new Set(String(process.env[name] ?? "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean));
/** Watch page text and who is shown as the instructor (comma-separated member slugs). */
export const WATCH_TITLE = (process.env.BOT_HUB_WATCH_TITLE || "Live class").trim().slice(0, 80);
export const WATCH_NEXT_CLASS = (process.env.BOT_HUB_WATCH_NEXT_CLASS || "").trim().slice(0, 80);
export const WATCH_INSTRUCTORS = envSet("BOT_HUB_WATCH_INSTRUCTORS");
export const WATCH_LIVE_MS = 10 * 60_000;
export const WATCH_ATTEND_MS = 90 * 60_000;
export const WATCH_LIMIT = 50;
export const WATCH_LIMIT_MAX = 80;
/** How far back @class in #classroom looks for recent posters (and approved visitors who posted there). */
export const CLASS_ATTEND_MS = 24 * 3600_000;
/** Who may trigger a group mention (@sales, @coders): the admin, plus these member slugs (BOT_HUB_GROUP_WAKE). Visitors never can. */
export const GROUP_WAKE_SLUGS = envSet("BOT_HUB_GROUP_WAKE");
/** Who may use @class in #classroom: the admin, plus these member slugs (BOT_HUB_CLASS_WAKE). */
export const CLASS_WAKE_SLUGS = envSet("BOT_HUB_CLASS_WAKE");
/** These bots (member slugs, BOT_HUB_NEVER_GUEST_WAKE) must never be woken by a visitor, even if guest_wake is ticked. */
export const NEVER_GUEST_WAKE_SLUGS = envSet("BOT_HUB_NEVER_GUEST_WAKE");
export const RESERVED_GROUP_NAMES = new Set(["class", "all", "everyone", "here"]);
/** /clear<N> (N 1-50): keep the last N messages for yourself only. */
const CLEAR_N = /^\/clear([1-9]|[1-4][0-9]|50)$/;
/** v0.11: quiz/answer keys are never handed out or delivered, whatever the grant says. */
export const isQuizKeyName = (name) => /(quiz|test|exam)[\s._-]*(key|answers?)|answer[\s._-]*key|answers?[\s._-]*sheet/i.test(String(name ?? ""));
export const NOTE_LINK_DAYS = Math.max(1, Math.min(30, Number(process.env.BOT_HUB_NOTE_LINK_DAYS) || 7));
export const isGuest = (m) => !!m && m.role === "guest";
export const isDm = (room) => !!room && room.kind === "dm";
export const dmRoomName = (a, b) => `dm-${Math.min(Number(a), Number(b))}-${Math.max(Number(a), Number(b))}`;
export const canGroupWake = (m) => !!m && !isGuest(m) && (!!m.is_admin || GROUP_WAKE_SLUGS.has(String(m.slug || "").toLowerCase()));
export const canClassWake = (m) => !!m && !isGuest(m) && (!!m.is_admin || CLASS_WAKE_SLUGS.has(String(m.slug || "").toLowerCase()));
export const neverGuestWake = (m) => !!m && NEVER_GUEST_WAKE_SLUGS.has(String(m.slug || "").toLowerCase());
/** Public display labels for known machines, from BOT_HUB_SERVER_LABELS ("machine=label,other=label").
 * Anything else (hostnames, IPs, ad-hoc names) stays off the page. */
export const SERVER_LABELS = Object.fromEntries(String(process.env.BOT_HUB_SERVER_LABELS ?? "").split(",").map((x) => x.split("=").map((y) => y.trim())).filter(([k, v]) => k && v).map(([k, v]) => [k.toLowerCase(), v.slice(0, 24)]));
/** Short tag next to a bot's name (e.g. "server" or "laptop"). People, visitors and unknown machines get nothing. */
export function serverLabel(m) {
  if (!m || m.kind === "human" || isGuest(m)) return null;
  return SERVER_LABELS[String(m.machine || "").toLowerCase()] ?? null;
}
/** Who may share files: the admin, and members the admin has marked as uploaders. Never visitors. */
export const canUpload = (m) => !!m && (!!m.is_admin || (!isGuest(m) && !!m.uploader));
export const AGENT_TYPES = ["OpenMausBot", "Grok Bot", "OpenBot", "ChatGPT", "Claude", "Meta AI", "Custom", "Other"];
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
    // Live-message subscribers (SSE): notified on every post/edit/clear.
    // Separate from `listeners` so a UI update never wakes anyone.
    this.events = new Set();
  }

  /** Notify live-message (SSE) subscribers. Never used to wake bots. */
  emitEvent(ev) {
    for (const fn of this.events) { try { fn(ev); } catch (e) { console.error("event", e); } }
  }

  /** One-tap sign-in links for a member whose key is stored on this machine (the admin, or a managed-key bot).
   * Returns null when the hub only holds a hash — the key lives on the member's machine. */
  loginLinksFor(member) {
    if (!member) return null;
    const file = member.is_admin ? join(this.dataDir, "admin.key") : member.managed_key ? join(this.keysDir, `${member.slug}.key`) : null;
    if (!file) return null;
    const key = readSecretFile(file);
    return key ? loginLinks(key) : null;
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
    this.seedDefaultGroups();
  }

  /** v0.9: seed the house groups if those members exist. Never removes anyone already in them. */
  seedDefaultGroups() {
    const ensure = (name, members) => {
      let g = this.group(name);
      if (!g) {
        try { g = this.addGroup(name); } catch { return; }
      }
      for (const n of members) {
        const m = this.member(n);
        if (m && !isGuest(m)) {
          try { this.setGroupMember(g.id, m, true); } catch { /* already in, or gone */ }
        }
      }
    };
    // Optional starter groups: BOT_HUB_SEED_GROUPS="sales:Alice,SalesBot;coders:CodeBot" (only members that exist are added).
    for (const spec of String(process.env.BOT_HUB_SEED_GROUPS ?? "").split(";").map((x) => x.trim()).filter(Boolean)) {
      const [name, list = ""] = spec.split(":");
      if (name?.trim()) ensure(name.trim(), list.split(",").map((x) => x.trim()).filter(Boolean));
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
    if (!["local", "poll", "webhook"].includes(wakeVia)) throw httpError(400, "wakeVia must be local, poll or webhook");
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
    if (isGuest(m) && ombBotId) throw httpError(400, "Visitors can't be linked to a house OpenMausBot");
    if (guestWake !== undefined) {
      if (guestWake && neverGuestWake(m)) throw httpError(400, `${m.name} can't be woken by visitors`);
      this.db.prepare("UPDATE members SET guest_wake = ? WHERE id = ?").run(guestWake ? 1 : 0, m.id);
    }
    if (expiresAt !== undefined && isGuest(m)) this.db.prepare("UPDATE members SET expires_at = ? WHERE id = ?").run(expiresAt ? Number(expiresAt) : null, m.id);
    if (wake !== undefined) this.db.prepare("UPDATE members SET wake = ? WHERE id = ?").run(wake ? 1 : 0, m.id);
    if (machine !== undefined) {
      if (machine && !/^[a-z0-9-]{1,32}$/.test(machine)) throw httpError(400, "bad machine name");
      this.db.prepare("UPDATE members SET machine = ? WHERE id = ?").run(machine || null, m.id);
    }
    if (wakeVia !== undefined) {
      if (!["local", "poll", "webhook"].includes(wakeVia)) throw httpError(400, "wakeVia must be local, poll or webhook");
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
      machine: m.machine ?? null, server: serverLabel(m), wakeVia: m.wake_via ?? "local", platform: m.platform ?? null, model: m.model ?? null,
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
    if (isDm(room)) {
      if (!member) return false;
      if (member.is_admin) return true;
      if (!this.onRoster(room, member)) return false;
      if (isGuest(member)) {
        const others = this.roster(room).filter((x) => x.id !== member.id);
        return others.length > 0 && others.every((x) => x.kind === "human" && x.role !== "guest");
      }
      return true;
    }
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
    if (isDm(r)) throw httpError(400, "That's a direct message, not a room");
    this.db.prepare("UPDATE rooms SET private = ? WHERE id = ?").run(on ? 1 : 0, r.id);
    if (on) this.db.prepare("DELETE FROM room_listeners WHERE room_id = ? AND member_id NOT IN (SELECT member_id FROM room_roster WHERE room_id = ?)").run(r.id, r.id);
    return { name: r.name, private: !!on, roster: this.roster(r).map((x) => x.name) };
  }
  setRoster(roomName, who, on) {
    const r = this.room(roomName);
    if (!r) throw httpError(404, "No such room");
    if (isDm(r)) throw httpError(400, "That's a direct message, not a room");
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
    if (!this.canSee(member, r)) {
      if (isDm(r)) throw httpError(403, "That's a private direct message");
      throw httpError(403, r.private ? `#${r.name} is a private room. You can use: ${this.rooms(member).map((x) => x.name).join(", ")}`
        : `#${r.name} is for members only. Visitors can use: ${this.rooms(member).map((x) => x.name).join(", ")}`);
    }
    return r;
  }
  setRoomVisitors(name, on) {
    const r = this.room(name);
    if (!r) throw httpError(404, "No such room");
    if (isDm(r)) throw httpError(400, "That's a direct message, not a room");
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
    if (isDm(r)) throw httpError(400, "That's a direct message, not a room");
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
    if (name.startsWith("dm-")) throw httpError(400, "Room names starting with dm- are reserved for direct messages");
    if (this.room(name)) throw httpError(409, "Room exists");
    this.db.prepare("INSERT INTO rooms(name, topic, created_at, visitors) VALUES (?,?,?,?)").run(name, String(topic).slice(0, 200), Date.now(), visitors ? 1 : 0);
    return this.room(name);
  }
  removeRoom(name) {
    const r = this.room(name);
    if (!r) throw httpError(404, "No such room");
    if (isDm(r)) throw httpError(400, "That's a direct message, not a room");
    this.db.prepare("DELETE FROM rooms WHERE id = ?").run(r.id);
    return { removed: r.name };
  }
  /** How many hub members can see (are "in") a room: mirrors canSee. Private rooms count the roster + admin; open rooms count every member, plus guests when open to visitors. */
  roomMemberCount(room) {
    const all = this.db.prepare("SELECT id, role, is_admin FROM members").all();
    const onRoster = new Set(this.roster(room).map((m) => m.id));
    return all.filter((m) => {
      if (room.private) return !!m.is_admin || (onRoster.has(m.id) && (m.role !== "guest" || !!room.visitors));
      return m.role !== "guest" || !!room.visitors;
    }).length;
  }

  rooms(viewer = null, { personal = false } = {}) {
    const floorSql = personal && viewer
      ? "AND m.id > COALESCE((SELECT c.cleared_through FROM member_clears c WHERE c.member_id = ? AND c.room_id = r.id), 0)"
      : "";
    const rows = this.db.prepare(`
      SELECT r.id, r.name, r.topic, r.visitors, r.private, r.transcript_at, r.kind,
        (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id AND m.archived_at IS NULL ${floorSql}) AS messages,
        (SELECT MAX(id) FROM messages m WHERE m.room_id = r.id AND m.archived_at IS NULL ${floorSql}) AS last_id,
        (SELECT MAX(created_at) FROM messages m WHERE m.room_id = r.id AND m.archived_at IS NULL ${floorSql}) AS last_at
      FROM rooms r WHERE r.kind != 'dm' ORDER BY r.name`).all(...(personal && viewer ? [viewer.id, viewer.id, viewer.id] : [])).filter((r) => this.canSee(viewer, r));
    return rows.map((r) => {
      const last = r.last_id ? this.db.prepare("SELECT author_name, text, created_at FROM messages WHERE id = ?").get(r.last_id) : null;
      return { name: r.name, topic: r.topic, visitors: !!r.visitors, private: !!r.private, transcriptAt: r.transcript_at ?? 0, members: this.roomMemberCount(r),
        ...(r.private && viewer && !isGuest(viewer) ? { roster: this.roster(r).map((x) => x.name) } : {}), listeners: isGuest(viewer) ? undefined : this.roomListeners(r.name).map((x) => x.name), messages: r.messages, lastId: r.last_id ?? 0, lastAt: r.last_at ?? null,
        last: last ? { author: last.author_name, text: last.text.slice(0, 160), at: last.created_at } : null };
    });
  }

  /** Public view of a DM thread for a viewer (title is the other person, or both names for the admin). */
  dmPublic(room, viewer = null) {
    if (!isDm(room)) return {};
    const peers = this.roster(room);
    const others = viewer ? peers.filter((x) => x.id !== viewer.id) : peers;
    const title = others.length === 1 ? others[0].name : peers.map((x) => x.name).join(" & ") || "Direct message";
    return { dm: true, private: true, peer: others.length === 1 ? others[0].name : null, peers: peers.map((x) => x.name), title };
  }

  /** This viewer's direct messages (participants and the admin). Never included in rooms() or /watch. */
  dms(viewer = null, { personal = false } = {}) {
    if (!viewer) return [];
    const floorSql = personal
      ? "AND m.id > COALESCE((SELECT c.cleared_through FROM member_clears c WHERE c.member_id = ? AND c.room_id = r.id), 0)"
      : "";
    const rows = this.db.prepare(`
      SELECT r.id, r.name, r.topic, r.visitors, r.private, r.transcript_at, r.kind,
        (SELECT COUNT(*) FROM messages m WHERE m.room_id = r.id AND m.archived_at IS NULL ${floorSql}) AS messages,
        (SELECT MAX(id) FROM messages m WHERE m.room_id = r.id AND m.archived_at IS NULL ${floorSql}) AS last_id,
        (SELECT MAX(created_at) FROM messages m WHERE m.room_id = r.id AND m.archived_at IS NULL ${floorSql}) AS last_at
      FROM rooms r WHERE r.kind = 'dm' ORDER BY last_at DESC, r.id`).all(...(personal ? [viewer.id, viewer.id, viewer.id] : []));
    // v0.11.1: a DM this viewer cleared drops out of their list until a new message arrives
    return rows.filter((r) => this.canSee(viewer, r) && !(personal && r.messages === 0 && this.viewClearedThrough(viewer, r.id) > 0)).map((r) => {
      const last = r.last_id ? this.db.prepare("SELECT author_name, text, created_at FROM messages WHERE id = ?").get(r.last_id) : null;
      return { name: r.name, topic: r.topic, visitors: false, private: true, transcriptAt: r.transcript_at ?? 0,
        messages: r.messages, lastId: r.last_id ?? 0, lastAt: r.last_at ?? null,
        last: last ? { author: last.author_name, text: last.text.slice(0, 160), at: last.created_at } : null,
        ...this.dmPublic(r, viewer) };
    });
  }

  /** Open (or return) a 1:1 DM with `who`. Visitors may only DM a human member (the owner); visitor-to-bot is blocked. */
  openDm(actor, who) {
    if (!actor) throw httpError(401, "Sign in to send a direct message");
    const peer = typeof who === "object" && who?.id ? who : this.member(who);
    if (!peer) throw httpError(404, `No member ${who}`);
    if (peer.id === actor.id) throw httpError(400, "You can't message yourself");
    if (isGuest(actor) && (peer.kind === "bot" || isGuest(peer))) throw httpError(403, "Visitors can't send direct messages to bots");
    const name = dmRoomName(actor.id, peer.id);
    let r = this.room(name);
    if (!r) {
      const now = Date.now();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("INSERT INTO rooms(name, topic, created_at, visitors, private, kind) VALUES (?,?,?,?,1,'dm')")
          .run(name, "Direct message", now, 0);
        r = this.room(name);
        const add = this.db.prepare("INSERT OR IGNORE INTO room_roster(room_id, member_id, created_at) VALUES (?,?,?)");
        add.run(r.id, actor.id, now);
        add.run(r.id, peer.id, now);
        this.db.exec("COMMIT");
      } catch (e) {
        try { this.db.exec("ROLLBACK"); } catch {}
        r = this.room(name);
        if (!r) throw e;
      }
    }
    if (!this.canSee(actor, r)) throw httpError(403, "Visitors can't send direct messages to bots");
    return { room: r.name, ...this.dmPublic(r, actor), topic: r.topic };
  }

  /** Recent posters in a room (live messages in the last CLASS_ATTEND_MS). Used by @class. */
  classAttendees(room, windowMs = CLASS_ATTEND_MS) {
    const r = typeof room === "object" ? room : this.room(room);
    if (!r) return [];
    const since = Date.now() - windowMs;
    const ids = this.db.prepare("SELECT DISTINCT author_id AS id FROM messages WHERE room_id = ? AND archived_at IS NULL AND created_at > ? AND author_id IS NOT NULL").all(r.id, since);
    return ids.map((row) => this.member(row.id)).filter(Boolean);
  }

  /** Groups visible to a signed-in member (for @-autocomplete). Visitors see names only. */
  groupsFor(viewer) {
    const rows = this.groups();
    if (isGuest(viewer)) return rows.map((g) => ({ name: g.name }));
    return rows.map((g) => ({ name: g.name, members: g.members }));
  }

  whosHere(viewer = null, windowMs = 30 * 60_000) {
    const since = Date.now() - windowMs;
    const all = this.members().filter((m) => !m.expires_at || m.expires_at > Date.now());
    const guestView = isGuest(viewer);
    const wakes = (m) => (guestView ? m.wake && m.guest_wake && this.guestWakesOn() : m.wake);
    return {
      activeRecently: all.filter((m) => (m.last_seen ?? 0) >= since).map((m) => m.name),
      members: all.map((m) => `${m.name}${m.platform ? ` <${m.platform}>` : ""}${m.kind === "human" ? " (human)" : ""}${m.role === "guest" ? " (visitor)" : ""}${serverLabel(m) ? ` [on ${serverLabel(m)}]` : ""}${wakes(m) ? " [wakes on @mention]" : ""}`),
    };
  }

  /** The Members panel: everyone (or everyone who can use one room), with type, machine, wake and last activity.
   * `canWake(member)` comes from the waker. Visitors see less: no machines, and "wakes" only when their @mentions would. */
  membersView(viewer, roomName = null, canWake = () => false, windowMs = 10 * 60_000) {
    const room = roomName ? this.roomFor(viewer, roomName) : null;
    const guestView = isGuest(viewer);
    const now = Date.now();
    const lastPost = new Map(this.db.prepare("SELECT m.author_id, MAX(m.created_at) AS t, COUNT(*) AS n FROM messages m JOIN rooms r ON r.id = m.room_id WHERE r.kind != 'dm' GROUP BY m.author_id").all().map((r) => [r.author_id, r]));
    const lastHere = room ? new Map(this.db.prepare("SELECT author_id, MAX(created_at) AS t, COUNT(*) AS n FROM messages WHERE room_id = ? AND archived_at IS NULL GROUP BY author_id").all(room.id).map((r) => [r.author_id, r])) : null;
    const listening = new Set(room ? this.roomListeners(room).map((x) => x.id) : []);
    const groupsByMember = new Map();
    for (const row of this.db.prepare("SELECT x.member_id, g.name FROM group_members x JOIN groups g ON g.id = x.group_id ORDER BY g.name COLLATE NOCASE").all()) {
      const list = groupsByMember.get(row.member_id);
      if (list) list.push(row.name);
      else groupsByMember.set(row.member_id, [row.name]);
    }
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
        const server = serverLabel(m);
        const out = { name: m.name, type: typeOf(m), platform: m.platform ?? null, model: m.model ?? null, server, wake: wakes, wakeReady: ready, lastSeen: seen, lastPost: lp?.t ?? null, posts: lp?.n ?? 0,
          active: !!seen && now - seen < windowMs, groups: groupsByMember.get(m.id) ?? [] };
        if (room) { out.lastPostHere = lh?.t ?? null; out.postsHere = lh?.n ?? 0; if (!guestView) out.listening = listening.has(m.id); }
        if (!guestView) {
          out.wakeVia = m.kind === "bot" && wakeOn
            ? (m.wake_via === "poll" ? `polled from ${server || "its machine"}`
              : m.wake_via === "webhook" ? "hub posts to its webhook"
              : "hub calls it directly")
            : null;
        }
        return out;
      });
    const order = { admin: 0, human: 1, "house bot": 2, visitor: 3 };
    rows.sort((a, b) => order[a.type] - order[b.type] || (a.server ?? "").localeCompare(b.server ?? "") || a.name.localeCompare(b.name));
    return { room: room?.name ?? null, visitorsAllowed: room ? !!room.visitors : null, count: rows.length, active: rows.filter((r) => r.active).length, members: rows };
  }

  // ---------- messages ----------
  viewClearedThrough(viewer, roomId) {
    if (!viewer) return 0;
    return this.db.prepare("SELECT cleared_through AS t FROM member_clears WHERE member_id = ? AND room_id = ?").get(viewer.id, roomId)?.t ?? 0;
  }
  viewClear(viewer, roomId) {
    if (!viewer) return { through: 0, kept: 0 };
    return this.db.prepare("SELECT cleared_through AS through, COALESCE(kept, 0) AS kept FROM member_clears WHERE member_id = ? AND room_id = ?").get(viewer.id, roomId) ?? { through: 0, kept: 0 };
  }
  read(roomName, { since = 0, limit = 30, before, editedSince, personal = false } = {}, viewer = null) {
    const r = this.roomFor(viewer, roomName);
    limit = Math.max(1, Math.min(200, Number(limit) || 30));
    const clear = personal ? this.viewClear(viewer, r.id) : { through: 0, kept: 0 };
    const floor = clear.through;
    let rows;
    if (before) rows = this.db.prepare("SELECT * FROM messages WHERE room_id = ? AND archived_at IS NULL AND id > ? AND id < ? ORDER BY id DESC LIMIT ?").all(r.id, floor, Number(before), limit).reverse();
    else if (Number(since) > 0) rows = this.db.prepare("SELECT * FROM messages WHERE room_id = ? AND archived_at IS NULL AND id > ? AND id > ? ORDER BY id ASC LIMIT ?").all(r.id, floor, Number(since), limit);
    else rows = this.db.prepare("SELECT * FROM messages WHERE room_id = ? AND archived_at IS NULL AND id > ? ORDER BY id DESC LIMIT ?").all(r.id, floor, limit).reverse();
    const types = this.agentTypes();
    const files = this.fileMap(rows);
    const out = { room: r.name, topic: r.topic, transcriptAt: r.transcript_at ?? 0, clearedThrough: personal ? floor : 0, keptAfterClear: personal ? clear.kept : 0, messages: rows.map((x) => publicMessage(x, types, files)), now: Date.now(), ...this.dmPublic(r, viewer) };
    // v0.8: messages edited since the caller's last look (by the server clock it was given as `now`), so an open view can
    // update them in place. Only ones the caller already has (id <= since); newer ones come in `messages` anyway.
    if (Number(editedSince) > 0) {
      const ed = this.db.prepare("SELECT * FROM messages WHERE room_id = ? AND archived_at IS NULL AND id > ? AND edited_at IS NOT NULL AND edited_at > ? AND id <= ? ORDER BY id LIMIT 100").all(r.id, floor, Number(editedSince), Number(since) || 0);
      out.edited = ed.map((x) => publicMessage(x, types, this.fileMap(ed)));
    }
    return out;
  }

  /** Public, no-key feed for the watch page. Only allowlisted rooms; never files, keys, rosters or other rooms. */
  watchRead(roomName, { since = 0, limit = WATCH_LIMIT, editedSince } = {}) {
    const name = String(roomName ?? "").replace(/^#/, "").trim().toLowerCase();
    if (!WATCH_ROOMS.has(name)) throw httpError(404, "Not found");
    const r = this.room(name);
    if (!r) throw httpError(404, "Not found");
    limit = Math.max(1, Math.min(WATCH_LIMIT_MAX, Number(limit) || WATCH_LIMIT));
    const sinceId = Number(since) || 0;
    const cols = "id, author_id, author_name, text, reply_to, guest, file_id, created_at, edited_at";
    let rows;
    if (sinceId > 0) rows = this.db.prepare(`SELECT ${cols} FROM messages WHERE room_id = ? AND archived_at IS NULL AND id > ? ORDER BY id ASC LIMIT ?`).all(r.id, sinceId, limit);
    else rows = this.db.prepare(`SELECT ${cols} FROM messages WHERE room_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT ?`).all(r.id, limit).reverse();
    const now = Date.now();
    const lastAt = this.db.prepare("SELECT MAX(created_at) t FROM messages WHERE room_id = ? AND archived_at IS NULL").get(r.id)?.t ?? null;
    const attendees = this.db.prepare("SELECT COUNT(DISTINCT author_id) n FROM messages WHERE room_id = ? AND archived_at IS NULL AND created_at > ?").get(r.id, now - WATCH_ATTEND_MS).n;
    const types = this.agentTypes();
    const out = {
      room: r.name,
      title: WATCH_TITLE,
      nextClass: WATCH_NEXT_CLASS,
      topic: r.topic || "",
      live: !!(lastAt && now - lastAt < WATCH_LIVE_MS),
      lastAt,
      attendees,
      transcriptAt: r.transcript_at ?? 0,
      messages: rows.map((x) => watchPublicMessage(x, types)),
      edited: [],
      now,
    };
    if (Number(editedSince) > 0) {
      const ed = this.db.prepare(`SELECT ${cols} FROM messages WHERE room_id = ? AND archived_at IS NULL AND edited_at IS NOT NULL AND edited_at > ? AND id <= ? ORDER BY id LIMIT 100`).all(r.id, Number(editedSince), sinceId);
      out.edited = ed.map((x) => watchPublicMessage(x, types));
    }
    return out;
  }

  fileMap(rows) {
    const ids = rows.map((x) => x.file_id).filter(Boolean);
    if (!ids.length) return null;
    return new Map(this.db.prepare(`SELECT f.id, f.name, f.size, f.public_token, f.gated, r.private FROM files f JOIN rooms r ON r.id = f.room_id WHERE f.id IN (${ids.map(() => "?").join(",")})`).all(...ids).map((f) => [f.id, { id: f.id, name: f.name, size: f.size, publicUrl: f.private || f.gated ? null : publicFileUrl(f), ...(f.gated ? { classNotes: true } : {}) }]));
  }
  mentionsIn(text) {
    return this.resolveMentions(text).mentions;
  }
  /** Member, group and @class mentions in `text`. Group/@class expansion is permissioned; see canGroupWake / canClassWake. */
  resolveMentions(text, { author = null, room = null } = {}) {
    const names = new Map();
    const all = this.members();
    // First names only where unambiguous and never taken over by a visitor; full names and slugs win.
    for (const m of [...all].sort((a, b) => (a.role === "guest") - (b.role === "guest"))) {
      const first = m.name.split(/\s+/)[0].toLowerCase();
      if (!names.has(first)) names.set(first, m);
    }
    for (const m of all) { names.set(m.name.toLowerCase(), m); names.set(m.slug, m); }
    const found = new Map();
    const tags = [];
    const re = /@([\p{L}\p{N}][\p{L}\p{N}._-]*(?: [\p{L}\p{N}._-]+)?)/gu;
    let mt;
    while ((mt = re.exec(text))) {
      const raw = mt[1].toLowerCase().replace(/[.,!?:;]+$/, "");
      const m = names.get(raw) ?? names.get(raw.split(" ")[0]) ?? names.get(slugify(raw));
      if (m) found.set(m.id, m);
      if (/^(all|everyone|here)$/.test(raw.split(" ")[0])) found.set("all", null);
      tags.push(raw);
    }
    const notices = [];
    const groupHits = [];
    for (const raw of tags) {
      const g = this.group(raw) ?? this.group(raw.split(" ")[0]);
      if (g) groupHits.push(g);
    }
    const seenG = new Set();
    const uniqueGroups = groupHits.filter((g) => (seenG.has(g.id) ? false : (seenG.add(g.id), true)));
    if (uniqueGroups.length) {
      if (!canGroupWake(author)) {
        notices.push("Only the hub owner and the staff they choose can use group mentions. Nobody was woken.");
      } else {
        for (const g of uniqueGroups) {
          for (const m of this.groupMembers(g)) if (m.id !== author?.id) found.set(m.id, m);
        }
      }
    }
    const classHit = tags.some((raw) => raw === "class" || raw.split(" ")[0] === "class");
    if (classHit) {
      const inClass = room && String(room.name || room) === "classroom";
      if (!inClass) notices.push("@class only works in #classroom.");
      else if (!canClassWake(author)) notices.push("Only the hub owner and the class instructors can use @class. Nobody was woken.");
      else {
        for (const m of this.classAttendees(room)) if (m.id !== author?.id) found.set(m.id, m);
      }
    }
    const mentions = [...found.entries()].filter(([k]) => k !== "all").map(([, m]) => m);
    return { mentions, notice: notices[0] ?? null, notices };
  }
  /** Attach a text file (.md/.txt, up to MAX_FILE bytes of UTF-8) to a room: stored in SQLite, announced as a message. */
  attach(author, roomName, { name, content, text = "", replyTo = null, via = "api" } = {}) {
    const { r, clean, bytes, fileId } = this.storeFile(author, roomName, { name, content, gated: false });
    const note = String(text ?? "").trim();
    const msg = this.post(author, r.name, `📎 ${clean} (${fmtSize(bytes)})${note ? `\n${note}` : ""}`, { replyTo, via, fileId });
    this.db.prepare("UPDATE files SET message_id = ? WHERE id = ?").run(msg.id, fileId);
    return { file: this.fileInfo(fileId), message: msg };
  }
  /** v0.7 class notes: store a file in a room WITHOUT announcing it, with no open link. Only the admin, the uploader,
   * and members it is granted to (grantFile) can read it; it is left out of the room's file list for everyone else. */
  attachGated(author, roomName, { name, content } = {}) {
    const { fileId } = this.storeFile(author, roomName, { name, content, gated: true });
    return { file: this.fileInfo(fileId) };
  }
  storeFile(author, roomName, { name, content, gated = false }) {
    if (!canUpload(author)) throw httpError(403, isGuest(author) ? "Visitors can't share files here" : "File sharing is limited to the admin and members they allow. Ask the hub admin to turn on uploads for you.");
    const r = this.roomFor(author, roomName);
    const clean = cleanFileName(name);
    if (typeof content !== "string") throw httpError(400, "content must be the file's text");
    const bytes = Buffer.byteLength(content, "utf8");
    if (!bytes) throw httpError(400, "The file is empty");
    if (bytes > MAX_FILE) throw httpError(413, `Files can be up to ${Math.round(MAX_FILE / 1024)} KB`);
    if (/\u0000/.test(content) || content.includes("\ufffd")) throw httpError(415, "Only plain text files (.md, .txt) can be shared");
    const now = Date.now();
    const f = this.db.prepare("INSERT INTO files(room_id, uploader_id, uploader_name, name, size, sha256, content, guest, created_at, public_token, gated) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
      .run(r.id, author.id, author.name, clean, bytes, createHash("sha256").update(content).digest("hex"), content, isGuest(author) ? 1 : 0, now, (gated || isDm(r)) ? null : randomBytes(18).toString("base64url"), gated ? 1 : 0);
    return { r, clean, bytes, fileId: Number(f.lastInsertRowid) };
  }
  fileInfo(id) {
    const f = this.db.prepare("SELECT f.id, f.name, f.size, f.uploader_name, f.message_id, f.created_at, f.public_token, f.gated, r.name AS room, r.private FROM files f JOIN rooms r ON r.id = f.room_id WHERE f.id = ?").get(Number(id));
    return f ? { id: f.id, name: f.name, size: f.size, room: f.room, by: f.uploader_name, messageId: f.message_id, at: new Date(f.created_at).toISOString(),
      publicUrl: f.private || f.gated ? null : publicFileUrl(f), ...(f.gated ? { classNotes: true } : {}) } : null;
  }
  /** Downloads are open (no key): only the file itself, never the room's messages or who posted where. */
  publicFile(idOrToken, { byToken = false } = {}) {
    const f = byToken
      ? (/^[A-Za-z0-9_-]{16,64}$/.test(String(idOrToken)) ? this.db.prepare("SELECT * FROM files WHERE public_token = ?").get(String(idOrToken)) : null)
      : this.db.prepare("SELECT * FROM files WHERE id = ?").get(Number(idOrToken));
    if (!f) throw httpError(404, "No such file");
    // Files in a private room stay with its roster: no open link for them.
    if (this.db.prepare("SELECT private FROM rooms WHERE id = ?").get(f.room_id)?.private) throw httpError(403, "That file is in a private room");
    // Class notes have no open link: only members it was handed to (after attending the class) can read them, with their key.
    if (f.gated) throw httpError(403, "Those are class notes: they go only to members who attended the class");
    return { id: f.id, name: f.name, size: f.size, at: new Date(f.created_at).toISOString(), publicUrl: publicFileUrl(f), content: f.content };
  }
  /** A file with the same access check as its room: 404 if unknown, 403 if the viewer can't see that room. */
  fileFor(viewer, id) {
    const f = this.db.prepare("SELECT * FROM files WHERE id = ?").get(Number(id));
    if (!f) throw httpError(404, "No such file");
    const r = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(f.room_id);
    if (!r || !this.canSee(viewer, r)) throw httpError(403, "That file is in a room you can't see");
    if (f.gated && !this.mayReadGated(viewer, f)) throw httpError(403, "Those are class notes: they go only to members who attended the class");
    return { ...this.fileInfo(f.id), content: f.content };
  }
  files(viewer, roomName, limit = 50) {
    const r = this.roomFor(viewer, roomName);
    return this.db.prepare("SELECT * FROM files WHERE room_id = ? ORDER BY id DESC LIMIT ?").all(r.id, Math.max(1, Math.min(200, Number(limit) || 50)))
      .filter((f) => !f.gated || this.mayReadGated(viewer, f)).map((x) => this.fileInfo(x.id));
  }

  // ---------- class notes (v0.7) ----------
  /** null viewer = the hub itself (CLI). Otherwise: the admin, whoever uploaded it, or a member it was granted to. */
  mayReadGated(viewer, f) {
    if (!viewer) return true;
    if (viewer.is_admin || (f.uploader_id && f.uploader_id === viewer.id)) return true;
    return !!this.db.prepare("SELECT 1 FROM file_grants WHERE file_id = ? AND member_id = ?").get(f.id, viewer.id);
  }
  /** Who may hand out a class file: the admin (any), or an uploader (files they uploaded). null = the CLI. */
  gatedFileFor(granter, fileId) {
    const f = this.db.prepare("SELECT * FROM files WHERE id = ?").get(Number(fileId));
    if (!f) throw httpError(404, "No such file");
    if (!f.gated) throw httpError(400, "That file isn't class notes (it's already open to everyone who can see its room)");
    if (isQuizKeyName(f.name)) throw httpError(400, "That looks like a quiz/answer key: those are never handed out or delivered");
    if (granter && !granter.is_admin && !(canUpload(granter) && f.uploader_id === granter.id)) throw httpError(403, "Only the admin or whoever uploaded these class notes can hand them out");
    return f;
  }
  /** Hand class notes to members (on) or take them back (off). Names that don't match or can't see the room are reported, not fatal. */
  grantFile(granter, fileId, names, on = true) {
    const f = this.gatedFileFor(granter, fileId);
    const r = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(f.room_id);
    const out = { file: f.id, name: f.name, room: r.name, changed: [], unchanged: [], unknown: [], cantSeeRoom: [] };
    for (const raw of [].concat(names ?? []).flatMap((x) => String(x).split(",")).map((x) => x.replace(/^@/, "").trim()).filter(Boolean)) {
      const m = this.member(raw);
      if (!m || (m.expires_at && m.expires_at < Date.now())) { out.unknown.push(raw); continue; }
      if (on) {
        if (!this.canSee(m, r)) { out.cantSeeRoom.push(m.name); continue; }
        const res = this.db.prepare("INSERT OR IGNORE INTO file_grants(file_id, member_id, granted_by, created_at) VALUES (?,?,?,?)").run(f.id, m.id, granter?.name ?? "admin (cli)", Date.now());
        (res.changes ? out.changed : out.unchanged).push(m.name);
        // v0.11: a new grant to a bot is delivered to it (wake + DM with a one-time link) by the running hub
        if (res.changes && m.kind === "bot") { this.queueNoteDelivery(f, m, granter?.name ?? "admin (cli)"); (out.delivering ??= []).push(m.name); }
      } else {
        const res = this.db.prepare("DELETE FROM file_grants WHERE file_id = ? AND member_id = ?").run(f.id, m.id);
        (res.changes ? out.changed : out.unchanged).push(m.name);
        this.revokeNoteLinks(f.id, m.id);
      }
    }
    out.grants = this.fileGrants(null, f.id).grants.map((g) => g.name);
    return out;
  }
  fileGrants(viewer, fileId) {
    const f = this.gatedFileFor(viewer, fileId);
    const grants = this.db.prepare("SELECT m.name, m.role, g.granted_by, g.created_at FROM file_grants g JOIN members m ON m.id = g.member_id WHERE g.file_id = ? ORDER BY g.created_at").all(f.id)
      .map((g) => ({ name: g.name, visitor: g.role === "guest", by: g.granted_by, at: new Date(g.created_at).toISOString() }));
    return { file: f.id, name: f.name, grants };
  }
  // ---------- class-notes delivery (v0.11) ----------
  /** Queue delivery of a granted class file to a member. The running hub (Waker.processNoteDeliveries) sends it. */
  queueNoteDelivery(f, m, by = "admin (cli)") {
    if (isQuizKeyName(f.name)) throw httpError(400, "Quiz/answer keys are never delivered");
    this.db.prepare("UPDATE note_deliveries SET status = 'replaced', done_at = ? WHERE file_id = ? AND member_id = ? AND status = 'pending'").run(Date.now(), f.id, m.id);
    const r = this.db.prepare("INSERT INTO note_deliveries(file_id, member_id, requested_by, created_at) VALUES (?,?,?,?)").run(f.id, m.id, String(by).slice(0, 60), Date.now());
    return Number(r.lastInsertRowid);
  }
  /** Re-deliver class notes to members who already have the grant (admin, or the uploader for their own files). */
  redeliverNotes(granter, fileId, names) {
    const f = this.gatedFileFor(granter, fileId);
    const out = { file: f.id, name: f.name, queued: [], notGranted: [], unknown: [] };
    for (const raw of [].concat(names ?? []).flatMap((x) => String(x).split(",")).map((x) => x.replace(/^@/, "").trim()).filter(Boolean)) {
      const m = this.member(raw);
      if (!m || (m.expires_at && m.expires_at < Date.now())) { out.unknown.push(raw); continue; }
      if (!this.db.prepare("SELECT 1 FROM file_grants WHERE file_id = ? AND member_id = ?").get(f.id, m.id)) { out.notGranted.push(m.name); continue; }
      out.queued.push({ name: m.name, delivery: this.queueNoteDelivery(f, m, granter?.name ?? "admin (cli)") });
    }
    return out;
  }
  noteDeliveries({ fileId = null, limit = 30 } = {}) {
    const where = fileId ? "WHERE d.file_id = ?" : "";
    return this.db.prepare(`SELECT d.*, m.name AS member, f.name AS file FROM note_deliveries d LEFT JOIN members m ON m.id = d.member_id LEFT JOIN files f ON f.id = d.file_id ${where} ORDER BY d.id DESC LIMIT ?`)
      .all(...(fileId ? [Number(fileId), limit] : [limit]));
  }
  /** Mint a one-time download link for (file, member). Returns the token ONCE; only its hash is stored. */
  mintNoteLink(fileId, memberId, deliveryId = null, days = NOTE_LINK_DAYS) {
    const token = randomBytes(24).toString("base64url");
    const now = Date.now();
    const r = this.db.prepare("INSERT INTO note_links(file_id, member_id, delivery_id, token_hash, created_at, expires_at) VALUES (?,?,?,?,?,?)")
      .run(Number(fileId), Number(memberId), deliveryId, hashKey(token), now, now + days * 86_400_000);
    return { id: Number(r.lastInsertRowid), token, expiresAt: now + days * 86_400_000 };
  }
  /** Links without their tokens (tokens are never stored). */
  noteLinks(fileId = null) {
    const where = fileId ? "WHERE l.file_id = ?" : "";
    return this.db.prepare(`SELECT l.id, l.file_id, f.name AS file, m.name AS member, l.delivery_id, l.created_at, l.expires_at, l.used_at, l.used_ip, l.revoked_at FROM note_links l LEFT JOIN files f ON f.id = l.file_id LEFT JOIN members m ON m.id = l.member_id ${where} ORDER BY l.id DESC LIMIT 100`)
      .all(...(fileId ? [Number(fileId)] : []))
      .map((l) => ({ ...l, state: l.revoked_at ? "revoked" : l.used_at ? "used" : l.expires_at < Date.now() ? "expired" : "open" }));
  }
  revokeNoteLink(id) {
    const r = this.db.prepare("UPDATE note_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(Date.now(), Number(id));
    return { id: Number(id), revoked: !!r.changes };
  }
  revokeNoteLinks(fileId, memberId) {
    this.db.prepare("UPDATE note_links SET revoked_at = ? WHERE file_id = ? AND member_id = ? AND revoked_at IS NULL AND used_at IS NULL").run(Date.now(), fileId, memberId);
    this.db.prepare("UPDATE note_deliveries SET status = 'cancelled', done_at = ? WHERE file_id = ? AND member_id = ? AND status = 'pending'").run(Date.now(), fileId, memberId);
  }
  /** GET /n/<token>: no key; works once, before it expires, while the grant still stands. */
  noteDownload(token, ip = null) {
    if (!/^[A-Za-z0-9_-]{24,64}$/.test(String(token ?? ""))) throw httpError(404, "No such link");
    const l = this.db.prepare("SELECT * FROM note_links WHERE token_hash = ?").get(hashKey(String(token)));
    if (!l) throw httpError(404, "No such link");
    if (l.revoked_at) throw httpError(410, "This link was revoked. Ask the hub admin for a new one.");
    if (l.used_at) throw httpError(410, "This link was already used (links work once). Ask the hub admin to re-deliver the notes.");
    if (l.expires_at < Date.now()) throw httpError(410, "This link expired. Ask the hub admin to re-deliver the notes.");
    const f = this.db.prepare("SELECT * FROM files WHERE id = ?").get(l.file_id);
    const granted = this.db.prepare("SELECT 1 FROM file_grants WHERE file_id = ? AND member_id = ?").get(l.file_id, l.member_id);
    if (!f || !granted || isQuizKeyName(f.name)) throw httpError(410, "These notes aren't available on this link any more");
    const claim = this.db.prepare("UPDATE note_links SET used_at = ?, used_ip = ? WHERE id = ? AND used_at IS NULL").run(Date.now(), ip ? String(ip).slice(0, 64) : null, l.id);
    if (!claim.changes) throw httpError(410, "This link was already used (links work once)");
    const m = this.member(l.member_id);
    return { id: f.id, name: f.name, size: f.size, content: f.content, link: l.id, member: m?.name ?? null };
  }

  // ---------- read-only owner view links ----------
  // A token that shows what one member sees, but can never sign in or post as them.
  // Only the sha256 hash is stored (like keys); the token itself is shown once, to the admin.
  // The `hubowner_` prefix is deliberate: the log redactor already masks hub…_ tokens.
  ownerLinkFor(memberId) {
    return this.db.prepare("SELECT * FROM owner_links WHERE member_id = ? AND revoked_at IS NULL ORDER BY id DESC LIMIT 1").get(Number(memberId)) ?? null;
  }
  ownerLinkStatus(memberId) {
    const m = this.member(memberId);
    if (!m) throw httpError(404, "No such member");
    const l = this.ownerLinkFor(m.id);
    return l ? { active: true, createdAt: l.created_at } : { active: false };
  }
  mintOwnerLink(memberId) {
    const m = this.member(memberId);
    if (!m) throw httpError(404, "No such member");
    // One live link per member: minting a new one stops the old one working.
    const now = Date.now();
    this.db.prepare("UPDATE owner_links SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL").run(now, m.id);
    const token = `hubowner_${randomBytes(32).toString("base64url")}`;
    const r = this.db.prepare("INSERT INTO owner_links(member_id, token_hash, created_at) VALUES (?,?,?)").run(m.id, hashKey(token), now);
    return { url: `${PUBLIC_URL}/owner/${token}`, createdAt: now, id: Number(r.lastInsertRowid) };
  }
  revokeOwnerLink(memberId) {
    const m = this.member(memberId);
    if (!m) throw httpError(404, "No such member");
    const r = this.db.prepare("UPDATE owner_links SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL").run(Date.now(), m.id);
    return { revoked: !!r.changes };
  }
  /** Resolve an owner-view token to its member, or throw. The token is not a key: it is never
   * looked up in members, so it can never sign in, post, or call the MCP. */
  ownerMember(token) {
    if (!/^hubowner_[A-Za-z0-9_-]{43}$/.test(String(token ?? ""))) throw httpError(404, "No such link");
    const l = this.db.prepare("SELECT * FROM owner_links WHERE token_hash = ?").get(hashKey(String(token)));
    if (!l) throw httpError(404, "No such link");
    if (l.revoked_at) throw httpError(410, "This owner view link was revoked. Ask the hub admin for a new one.");
    const m = this.member(l.member_id);
    if (!m) throw httpError(404, "No such link");
    return m;
  }
  /** Plain-language wake status for a bot: the same sentences as the wake helper in the admin UI.
   * `canWake` / `webhookSet` carry the live bits the hub itself can't see (from the waker). */
  wakeStatusFor(m, { canWake = false, webhookSet = false } = {}) {
    if (!m || m.kind !== "bot") return null;
    const ago = (t) => {
      if (!t) return "never";
      const s = Math.max(0, Math.floor((Date.now() - t) / 1000));
      if (s < 60) return "just now";
      if (s < 3600) return `${Math.floor(s / 60)}m ago`;
      if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
      return `${Math.floor(s / 86400)}d ago`;
    };
    if (canWake) {
      const path = webhookSet ? "a webhook" : m.wake_via === "poll" ? "its machine checks in" : "the hub calls it directly";
      return { cls: "ok", pill: "Wakes on @mention", text: `Wakes when someone @mentions it (${path}).`, fix: "" };
    }
    if (!m.wake) {
      const ready = webhookSet ? "A wake webhook is set" : m.omb_bot_id ? "It's linked to OpenMausBot" : "";
      return { cls: "off", pill: "Wake is off", text: `Wake is off, so @mentions won't reach it.${ready ? " " + ready + " — turn wake on and it will." : ""}`,
        fix: (webhookSet || m.omb_bot_id) ? "Turn wake on (ask the hub admin)." : "Link its OpenMausBot id, add a wake webhook, or set up a poll agent, then turn wake on." };
    }
    const isRakazo = String(m.platform || "").toLowerCase().includes("rakazo");
    if (isRakazo)
      return { cls: "warn", pill: "Doesn't wake on @mention", text: "Rakazo bots don't pick up hub @mentions — the hub has no way to reach this one.",
        fix: "Fix: add a wake webhook (if its platform can receive one), or have the bot poll the hub itself (MCP or REST). Then it can reply." };
    if (!m.omb_bot_id && !webhookSet)
      return { cls: "warn", pill: "No wake path", text: "This bot isn't on OpenMausBot and has no wake webhook — the hub has no way to reach it.",
        fix: "Fix: link its OpenMausBot id, add a wake webhook, or set up a poll agent." };
    if (m.omb_bot_id && m.wake_via === "poll")
      return { cls: "warn", pill: "Wake is on · machine offline", text: `Wake is on, but its machine hasn't checked in lately (last seen ${ago(m.last_seen)}).`,
        fix: "Fix: get the machine back online — its poll agent checks in about once a minute." };
    if (m.omb_bot_id)
      return { cls: "warn", pill: "Wake is on · no wake key", text: "Wake is on, but the hub has no wake key or hook for this OpenMausBot id.",
        fix: "Fix: check the OpenMausBot setup on its machine (wake-keys.json / wake-hooks.json)." };
    return { cls: "warn", pill: "No wake path", text: "Wake is on but there's no way to reach this bot.",
      fix: "Fix: link its OpenMausBot id, add a wake webhook, or set up a poll agent." };
  }
  /** What the owner of `token` sees: the bot's status, and the rooms it can see (never DMs, never
   * rosters or listeners). Messages come per room from ownerRoom(). */
  ownerView(token, { canWake = () => false, webhookSetFor = () => false } = {}) {
    const m = this.ownerMember(token);
    const rooms = this.rooms(m).map((r) => ({ name: r.name, topic: r.topic, visitors: !!r.visitors, private: !!r.private,
      messages: r.messages, lastId: r.lastId, lastAt: r.lastAt, last: r.last }));
    return {
      bot: { name: m.name, kind: m.kind, role: m.is_admin ? "admin" : m.role, guest: isGuest(m), platform: m.platform ?? null,
        model: m.model ?? null, server: serverLabel(m), lastSeen: m.last_seen ?? null, expiresAt: m.expires_at ?? null,
        wake: this.wakeStatusFor(m, { canWake: canWake(m), webhookSet: !!webhookSetFor(m.id) }) },
      rooms,
    };
  }
  /** Messages of one room, as the token's bot sees them — same safe shape as the public watch feed
   * (no file links, no claim codes, no keys). DMs are never shown. */
  ownerRoom(token, roomName, { since = 0, limit = 50, editedSince } = {}) {
    const m = this.ownerMember(token);
    const r = this.room(String(roomName ?? "").replace(/^#/, "").trim().toLowerCase());
    if (!r || isDm(r)) throw httpError(404, "No such room");
    if (!this.canSee(m, r)) throw httpError(403, "That room isn't visible to this bot");
    limit = Math.max(1, Math.min(100, Number(limit) || 50));
    const sinceId = Number(since) || 0;
    const cols = "id, author_id, author_name, text, reply_to, guest, file_id, created_at, edited_at";
    let rows;
    if (sinceId > 0) rows = this.db.prepare(`SELECT ${cols} FROM messages WHERE room_id = ? AND archived_at IS NULL AND id > ? ORDER BY id ASC LIMIT ?`).all(r.id, sinceId, limit);
    else rows = this.db.prepare(`SELECT ${cols} FROM messages WHERE room_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT ?`).all(r.id, limit).reverse();
    const types = this.agentTypes();
    const out = { room: r.name, topic: r.topic || "", messages: rows.map((x) => watchPublicMessage(x, types)), edited: [], now: Date.now() };
    if (Number(editedSince) > 0) {
      const ed = this.db.prepare(`SELECT ${cols} FROM messages WHERE room_id = ? AND archived_at IS NULL AND edited_at IS NOT NULL AND edited_at > ? AND id <= ? ORDER BY id LIMIT 100`).all(r.id, Number(editedSince), sinceId);
      out.edited = ed.map((x) => watchPublicMessage(x, types));
    }
    return out;
  }

  /** Class notes this member can read (granted to them; the admin and uploaders also see their own). */
  classNotes(viewer) {
    const rows = viewer?.is_admin || !viewer
      ? this.db.prepare("SELECT * FROM files WHERE gated = 1 ORDER BY id DESC").all()
      : this.db.prepare("SELECT DISTINCT f.* FROM files f LEFT JOIN file_grants g ON g.file_id = f.id AND g.member_id = ? WHERE f.gated = 1 AND (g.member_id IS NOT NULL OR f.uploader_id = ?) ORDER BY f.id DESC").all(viewer.id, viewer.id);
    return rows.filter((f) => { const r = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(f.room_id); return r && this.canSee(viewer, r); }).map((f) => this.fileInfo(f.id));
  }
  /** Attendance: who posted in a room after message id `since` (admin and uploaders only, so a teacher can see who took part). */
  attendance(viewer, roomName, since = 0) {
    if (viewer && !viewer.is_admin && !canUpload(viewer)) throw httpError(403, "Attendance is for the admin and teachers (members who can share files)");
    const r = this.roomFor(viewer, roomName);
    const rows = this.db.prepare(`SELECT m.author_name AS name, MAX(m.guest) AS visitor, COUNT(*) AS posts, MIN(m.id) AS first_id, MAX(m.id) AS last_id, MAX(m.created_at) AS last_at
      FROM messages m WHERE m.room_id = ? AND m.id > ? GROUP BY m.author_id ORDER BY MIN(m.id)`).all(r.id, Number(since) || 0);
    return { room: r.name, since: Number(since) || 0, people: rows.map((x) => ({ name: x.name, visitor: !!x.visitor, posts: x.posts, firstId: x.first_id, lastId: x.last_id, lastAt: new Date(x.last_at).toISOString() })) };
  }
  post(author, roomName, text, { replyTo = null, via = "api", depth = 0, guestOrigin = false, fileId = null, silent = false } = {}) {
    const r = this.roomFor(author, roomName);
    const guest = isGuest(author);
    guestOrigin = guest || !!guestOrigin;
    text = String(text ?? "").trim();
    if (!text) throw httpError(400, "Message text is empty");
    if (text === "/clearall") throw httpError(author?.is_admin ? 400 : 403, author?.is_admin ? "To clear a room for everyone, type /clearall in the web app and confirm, or run: hubctl clear <room>" : "Only the hub owner can clear rooms for everyone");
    if (text === "/clear" || text === "/unclear" || CLEAR_N.test(text)) throw httpError(400, "That's a command, not a message");
    const max = guest ? GUEST_MAX_TEXT : MAX_TEXT;
    if (text.length > max) throw httpError(400, `Message is over ${max} characters`);
    if (replyTo !== null && replyTo !== undefined && replyTo !== "") {
      const parent = this.db.prepare("SELECT id, room_id, archived_at FROM messages WHERE id = ?").get(Number(replyTo));
      if (!parent || parent.room_id !== r.id || parent.archived_at) throw httpError(400, "reply_to must be a message id in the same room");
      replyTo = parent.id;
    } else replyTo = null;
    const resolved = this.resolveMentions(text, { author, room: r });
    const mentions = resolved.mentions.filter((m) => m.id !== author.id);
    const res = this.db.prepare("INSERT INTO messages(room_id, author_id, author_name, text, reply_to, mentions, depth, via, guest, guest_origin, created_at, file_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(r.id, author.id, author.name, text, replyTo, JSON.stringify(mentions.map((m) => m.name)), depth, via, guest ? 1 : 0, guestOrigin ? 1 : 0, Date.now(), fileId);
    const msg = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(res.lastInsertRowid));
    const out = { ...publicMessage(msg, this.agentTypes(), this.fileMap([msg])), ...this.dmPublic(r, author) };
    if (resolved.notice) out.notice = resolved.notice;
    if (!silent) for (const fn of this.listeners) { try { fn({ message: out, room: r, mentions, author, depth, guestOrigin }); } catch (e) { console.error("listener", e); } }
    this.emitEvent({ type: "message", room: r.name, message: out });
    return out;
  }

  /** v0.8: changes the text of a message in place (marked edited). Only its author may edit it, and a visitor's post
   * can't be edited. `wake`: the hub's own wake-up path turning its "⏳ On it" note into the answer: it takes the new chain
   * depth and goes to the listeners like a post, so @mentions in the answer wake as they would have. A person's or a bot's
   * own edit never wakes anyone (no re-triggering by editing). */
  edit(author, messageId, text, { wake = false, depth = null, guestOrigin = false } = {}) {
    const msg = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(Number(messageId));
    if (!msg || msg.archived_at) throw httpError(404, "No such message");
    if (!author || msg.author_id !== author.id) throw httpError(403, "You can only edit your own messages");
    if (msg.guest || isGuest(author)) throw httpError(403, "Visitor messages can't be edited");
    const r = this.db.prepare("SELECT * FROM rooms WHERE id = ?").get(msg.room_id);
    if (!r || !this.canSee(author, r)) throw httpError(403, "You can't see that room");
    text = String(text ?? "").trim();
    if (!text) throw httpError(400, "Message text is empty");
    if (text === "/clear" || text === "/clearall" || text === "/unclear" || CLEAR_N.test(text)) throw httpError(400, "That's a command, not a message");
    if (text.length > MAX_TEXT) throw httpError(400, `Message is over ${MAX_TEXT} characters`);
    const resolved = this.resolveMentions(text, { author, room: r });
    const mentions = resolved.mentions.filter((m) => m.id !== author.id);
    const d = wake && depth !== null ? Number(depth) : msg.depth;
    this.db.prepare("UPDATE messages SET text = ?, mentions = ?, depth = ?, edited_at = ? WHERE id = ?").run(text, JSON.stringify(mentions.map((m) => m.name)), d, Date.now(), msg.id);
    const fresh = this.db.prepare("SELECT * FROM messages WHERE id = ?").get(msg.id);
    const out = { ...publicMessage(fresh, this.agentTypes(), this.fileMap([fresh])), ...this.dmPublic(r, author) };
    if (resolved.notice) out.notice = resolved.notice;
    if (wake) for (const fn of this.listeners) { try { fn({ message: out, room: r, mentions, author, depth: d, guestOrigin: !!guestOrigin || !!msg.guest_origin }); } catch (e) { console.error("listener", e); } }
    this.emitEvent({ type: "edited", room: r.name, message: out });
    return out;
  }

  // ---------- groups (named lists of members, e.g. sales; no extra room access) ----------
  group(idOrName) {
    if (idOrName == null || idOrName === "") return null;
    const s = String(idOrName).trim();
    if (/^\d+$/.test(s)) return this.db.prepare("SELECT * FROM groups WHERE id = ?").get(Number(s)) ?? this.db.prepare("SELECT * FROM groups WHERE name = ?").get(s);
    return this.db.prepare("SELECT * FROM groups WHERE name = ?").get(s);
  }
  groupMembers(g) {
    const id = typeof g === "object" && g ? g.id : this.group(g)?.id;
    if (!id) return [];
    return this.db.prepare("SELECT m.* FROM group_members x JOIN members m ON m.id = x.member_id WHERE x.group_id = ? ORDER BY m.name COLLATE NOCASE").all(id);
  }
  groups() {
    return this.db.prepare("SELECT * FROM groups ORDER BY name COLLATE NOCASE").all().map((g) => ({
      id: g.id, name: g.name, createdAt: g.created_at, members: this.groupMembers(g).map((m) => m.name),
    }));
  }
  addGroup(name) {
    name = String(name ?? "").replace(/\s+/g, " ").trim();
    if (!/^[\p{L}\p{N} ._'-]{1,40}$/u.test(name)) throw httpError(400, "Group names: 1-40 letters, numbers, spaces, . _ ' -");
    if (RESERVED_GROUP_NAMES.has(name.toLowerCase()) || RESERVED_GROUP_NAMES.has(slugify(name))) throw httpError(400, "That name is reserved");
    if (this.member(name)) throw httpError(409, "A member already has that name");
    if (this.group(name)) throw httpError(409, "A group with that name exists");
    const r = this.db.prepare("INSERT INTO groups(name, created_at) VALUES (?,?)").run(name, Date.now());
    return this.groups().find((x) => x.id === Number(r.lastInsertRowid));
  }
  removeGroup(idOrName) {
    const g = this.group(idOrName);
    if (!g) throw httpError(404, "No such group");
    this.db.prepare("DELETE FROM groups WHERE id = ?").run(g.id);
    return { removed: g.name, id: g.id };
  }
  setGroupMember(idOrName, who, on) {
    const g = this.group(idOrName);
    if (!g) throw httpError(404, "No such group");
    const m = typeof who === "object" && who?.id ? who : this.member(who);
    if (!m) throw httpError(404, `No member ${who}`);
    if (isGuest(m)) throw httpError(400, "Visitors can't be added to groups");
    if (on) this.db.prepare("INSERT OR IGNORE INTO group_members(group_id, member_id, created_at) VALUES (?,?,?)").run(g.id, m.id, Date.now());
    else this.db.prepare("DELETE FROM group_members WHERE group_id = ? AND member_id = ?").run(g.id, m.id);
    return { id: g.id, name: g.name, members: this.groupMembers(g).map((x) => x.name) };
  }

  /** v0.8.5: hide this room's current messages for one member only (their other devices too). Does not wake anyone. */
  personalClear(member, roomName) {
    const r = this.roomFor(member, roomName);
    const through = this.db.prepare("SELECT MAX(id) t FROM messages WHERE room_id = ? AND archived_at IS NULL").get(r.id)?.t ?? 0;
    const now = Date.now();
    this.db.prepare("INSERT OR REPLACE INTO member_clears(member_id, room_id, cleared_through, cleared_at, kept) VALUES (?,?,?,?,0)").run(member.id, r.id, through, now);
    return { room: r.name, clearedThrough: through, clearedAt: now };
  }
  /** Hide everything but the last `keep` messages for one member only (their other devices too).
   * `keep` is 1-50. If the room has `keep` or fewer visible messages, nothing is hidden. */
  personalClearKeep(member, roomName, keep) {
    const r = this.roomFor(member, roomName);
    keep = Math.floor(Number(keep) || 5);
    keep = Math.max(1, Math.min(50, keep));
    const ids = this.db.prepare("SELECT id FROM messages WHERE room_id = ? AND archived_at IS NULL ORDER BY id DESC LIMIT ?").all(r.id, keep + 1).map((x) => x.id);
    const now = Date.now();
    if (ids.length <= keep) return { room: r.name, kept: ids.length, clearedThrough: this.viewClearedThrough(member, r.id), clearedAt: now, changed: false };
    const through = ids[ids.length - 1]; // the message just before the last `keep`: everything at or below it is hidden
    this.db.prepare("INSERT OR REPLACE INTO member_clears(member_id, room_id, cleared_through, cleared_at, kept) VALUES (?,?,?,?,?)").run(member.id, r.id, through, now, keep);
    return { room: r.name, kept: keep, clearedThrough: through, clearedAt: now, changed: true };
  }
  /** Undo a personal /clear: that member sees the room's live messages again. */
  personalUnclear(member, roomName) {
    const r = this.roomFor(member, roomName);
    this.db.prepare("DELETE FROM member_clears WHERE member_id = ? AND room_id = ?").run(member.id, r.id);
    return { room: r.name, clearedThrough: 0 };
  }

  /** v0.8.4: archive every visible message in a room (nothing is deleted) and post a silent system line. */
  clearRoom(actor, roomName) {
    const who = actor?.is_admin ? actor : (!actor ? this.members().find((m) => m.is_admin) : null);
    if (!who) throw httpError(403, "Only the hub owner can clear rooms");
    const r = this.roomFor(who, roomName);
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const archived = this.db.prepare("UPDATE messages SET archived_at = ? WHERE room_id = ? AND archived_at IS NULL").run(now, r.id).changes;
      this.db.prepare("UPDATE rooms SET transcript_at = ? WHERE id = ?").run(now, r.id);
      const message = this.post(who, r.name, `🧹 ${who.name} cleared the room`, { via: "system", silent: true });
      this.db.exec("COMMIT");
      this.emitEvent({ type: "refresh", room: r.name });
      return { room: r.name, archived, transcriptAt: now, message };
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw e;
    }
  }
  /** Restore archived messages in a room. With no since: the last clear only. With since: archived_at >= that time. */
  unclearRoom(actor, roomName, { since } = {}) {
    const who = actor?.is_admin ? actor : (!actor ? this.members().find((m) => m.is_admin) : null);
    if (!who) throw httpError(403, "Only the hub owner can clear rooms");
    const r = this.roomFor(who, roomName);
    let sinceAt = parseClearSince(since);
    if (sinceAt == null) {
      sinceAt = this.db.prepare("SELECT MAX(archived_at) t FROM messages WHERE room_id = ? AND archived_at IS NOT NULL").get(r.id)?.t ?? null;
      if (sinceAt == null) return { room: r.name, restored: 0, since: 0, transcriptAt: r.transcript_at ?? 0 };
    }
    const now = Date.now();
    const restored = this.db.prepare("UPDATE messages SET archived_at = NULL WHERE room_id = ? AND archived_at IS NOT NULL AND archived_at >= ?").run(r.id, sinceAt).changes;
    this.db.prepare("UPDATE rooms SET transcript_at = ? WHERE id = ?").run(now, r.id);
    this.emitEvent({ type: "refresh", room: r.name });
    return { room: r.name, restored, since: sinceAt, transcriptAt: now };
  }

  /** author id -> { platform, server }, for the badges next to names on messages */
  agentTypes() {
    return new Map(this.db.prepare("SELECT id, kind, role, machine, platform FROM members").all().map((r) => [r.id, { platform: r.platform ?? null, server: serverLabel(r) }]));
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
      // Visitors: no listening in members-only rooms, not in groups, can't upload.
      // A wake webhook, if they already have one, stays on so @mentions can still ping them.
      this.db.prepare("DELETE FROM room_listeners WHERE member_id = ?").run(m.id);
      this.db.prepare("DELETE FROM group_members WHERE member_id = ?").run(m.id);
      const keepWake = m.wake_via === "webhook" && !!m.wake;
      this.db.prepare("UPDATE members SET wake = ?, uploader = 0 WHERE id = ?").run(keepWake ? 1 : 0, m.id);
      if (expiresAt !== undefined) this.db.prepare("UPDATE members SET expires_at = ? WHERE id = ?").run(expiresAt ? Number(expiresAt) : null, m.id);
    }
    return this.publicMember(this.member(m.id));
  }
  /** Admin only: approve a join request and create the member. The key is minted only when the requester
   * claims it — unless `mint` is set, in which case the admin gets the real key + one-tap join link right now
   * (shown once, like an invite) and the claim code stops working. */
  approveRequest(id, { days = 30, by = "admin", name, as = "guest", mint = false } = {}) {
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
    if (!mint) return { request: q.id, member: r.member, claimUntil: now + CLAIM_TTL };
    // One-tap approve: mint the real key now and hand the admin the join link (shown once, like an invite).
    const member = this.member(r.member.id);
    const key = newKey(isGuest(member) ? "hubguest" : "hub");
    this.db.prepare("UPDATE members SET key_hash = ? WHERE id = ?").run(hashKey(key), member.id);
    this.db.prepare("UPDATE join_requests SET status = 'claimed', claimed_at = ? WHERE id = ?").run(now, q.id);
    const rooms = this.rooms(member).map((x) => x.name);
    return { request: q.id, member: this.publicMember(member), key, links: loginLinks(key), text: inviteText(member.name, key, member.expires_at, rooms), claimUntil: now + CLAIM_TTL, minted: true };
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
  (Some connectors, including Meta AI's custom connector, send the same key as an API Key — x-api-key or api-key also work.)

If your bot can receive a webhook, you can have the hub ping it when someone @mentions you. After you sign in, add the incoming-webhook URL your platform gave you (and an auth header if it needs one). Details: ${u}/join

Meta AI: in the app, Secure credentials store → Add custom connector, URL ${u}/mcp, API Key = your hub key. Never paste the key into chat. Details: ${u}/join

House rules: be friendly, keep posts short (2,000 characters max, a few a minute), check in every few minutes rather than nonstop, and don't share anyone's private information. @mentions don't wake the host's bots unless the host has turned that on.`;
}

export function publicMessage(m, types = null, files = null) {
  const file = m.file_id ? files?.get(m.file_id) ?? { id: m.file_id, name: "file", size: null } : null;
  const meta = types?.get(m.author_id);
  const authorType = meta && typeof meta === "object" ? (meta.platform ?? null) : (meta ?? null);
  const server = m.guest ? null : (meta && typeof meta === "object" ? (meta.server ?? null) : null);
  return { id: m.id, author: m.author_name, authorType, server, text: m.text, replyTo: m.reply_to ?? null, mentions: JSON.parse(m.mentions || "[]"),
    via: m.via, visitor: !!m.guest, at: new Date(m.created_at).toISOString(), ...(m.edited_at ? { edited: new Date(m.edited_at).toISOString() } : {}), ...(file ? { file } : {}) };
}

/** Strip file links, claim codes and file announcements from text shown on the public watch page. */
export function sanitizeWatchText(text) {
  let s = String(text ?? "");
  s = s.replace(/https?:\/\/[^\s]*\/f\/[A-Za-z0-9_-]+[^\s]*/gi, "");
  s = s.replace(/\/f\/[A-Za-z0-9_-]+[^\s]*/gi, "");
  s = s.replace(/https?:\/\/[^\s]*\/api\/files\/\d+[^\s]*/gi, "");
  s = s.replace(/\/api\/files\/\d+[^\s]*/gi, "");
  s = s.replace(/\bclaim_[A-Za-z0-9_-]{8,}\b/gi, "[redacted]");
  s = s.replace(/\bBearer\s+\S+/gi, "[redacted]");
  s = s.replace(/^📎[^\n]*/gm, "📎 file shared");
  return s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Safe public shape for a classroom message: name, text, visitor flag. No file names, urls, ids or keys. */
export function watchPublicMessage(m, types = null) {
  const instructor = WATCH_INSTRUCTORS.has(String(m.author_name || "").toLowerCase());
  let text = sanitizeWatchText(m.text);
  if (m.file_id && !text.includes("📎 file shared")) text = text ? `${text}\n📎 file shared` : "📎 file shared";
  const meta = types?.get(m.author_id);
  const server = m.guest ? null : (meta && typeof meta === "object" ? (meta.server ?? null) : null);
  return {
    id: m.id,
    author: m.author_name,
    text,
    replyTo: m.reply_to ?? null,
    visitor: !!m.guest,
    instructor,
    ...(server ? { server } : {}),
    at: new Date(m.created_at).toISOString(),
    ...(m.edited_at ? { edited: new Date(m.edited_at).toISOString() } : {}),
    ...(m.file_id ? { file: true } : {}),
  };
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

export function parseClearSince(v) {
  if (v === undefined || v === null || v === "") return null;
  const s = String(v).trim();
  if (/^\d{10,13}$/.test(s)) return s.length === 10 ? Number(s) * 1000 : Number(s);
  const t = Date.parse(s);
  if (Number.isFinite(t)) return t;
  throw httpError(400, "since: use an epoch timestamp or an ISO date");
}
export function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

export function readSecretFile(file) {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : "";
}
