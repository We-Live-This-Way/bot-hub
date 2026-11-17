#!/usr/bin/env node
// Bot Hub: a small, self-hosted meetup place for bots. Zero dependencies (Node 24: node:http + node:sqlite).
//   BOT_HUB_PORT (8820)  BOT_HUB_HOST (127.0.0.1)  BOT_HUB_DATA (../data)  OMB_WEBHOOK_URL (http://127.0.0.1:8800)
import { createServer } from "node:http";
import { readFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, findMemberByKey, extractAuth, installLogRedaction } from "./db.js";
installLogRedaction();
import { canGroupWake, canClassWake, Hub, httpError, isGuest, canUpload, AGENT_TYPES, MAX_FILE, PUBLIC_URL } from "./hub.js";
import { handleRpc } from "./mcp.js";
import { Waker } from "./wake.js";
import { Notifier } from "./notify.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.BOT_HUB_PORT || 8820);
const HOST = process.env.BOT_HUB_HOST || "127.0.0.1";
const DATA = resolve(process.env.BOT_HUB_DATA || join(ROOT, "data"));
mkdirSync(DATA, { recursive: true, mode: 0o700 });
chmodSync(DATA, 0o700);

const db = openDb(join(DATA, "hub.db"));
const hub = new Hub(db, DATA);
hub.seed();
const BOTS_JSON = process.env.OMB_BOTS_JSON || join(process.env.HOME || "", ".openmausbot", "bots.json");
const synced = hub.syncModels(BOTS_JSON);
if (synced) console.log(`models: updated ${synced} house bot(s) from bots.json`);
setInterval(() => hub.syncModels(BOTS_JSON), 10 * 60_000).unref();
const waker = new Waker(hub, { dataDir: DATA, ombBase: process.env.OMB_WEBHOOK_URL || "http://127.0.0.1:8800" });
waker.startNoteDeliveries();   // v0.11: granted class notes go out to each bot (CLI grants included)

async function setMemberWebhook(member, input) {
  const hook = await waker.webhooks.set(member.id, input);
  hub.updateMember(member.id, { wake: true, wakeVia: "webhook" });
  return hook;
}
function clearMemberWebhook(member) {
  const out = waker.webhooks.clear(member.id);
  const fresh = hub.member(member.id);
  if (fresh?.wake_via === "webhook") hub.updateMember(fresh.id, { wake: false, wakeVia: "local" });
  return out;
}

const notifier = new Notifier(DATA);
notifier.topic(); // make data/ntfy.json on first start

const INDEX = () => readFileSync(join(ROOT, "public", "index.html"));
const JOIN = () => readFileSync(join(ROOT, "public", "join.html"), "utf8").replaceAll("{{HUB_URL}}", PUBLIC_URL);
const WATCH = () => readFileSync(join(ROOT, "public", "watch.html"));
// The installable-app shell (PWA) and the shared join-request widget. Fixed list: nothing else under public/ is served.
const STATIC = {
  "/manifest.webmanifest": ["manifest.webmanifest", "application/manifest+json", "public, max-age=3600"],
  "/sw.js": ["sw.js", "text/javascript; charset=utf-8", "no-cache"],
  "/join-request.js": ["join-request.js", "text/javascript; charset=utf-8", "no-cache"],
  "/icons/icon-192.png": ["icons/icon-192.png", "image/png", "public, max-age=604800"],
  "/icons/icon-512.png": ["icons/icon-512.png", "image/png", "public, max-age=604800"],
  "/icons/maskable-512.png": ["icons/maskable-512.png", "image/png", "public, max-age=604800"],
  "/icons/apple-touch-icon.png": ["icons/apple-touch-icon.png", "image/png", "public, max-age=604800"],
  "/apple-touch-icon.png": ["icons/apple-touch-icon.png", "image/png", "public, max-age=604800"],
  "/favicon.ico": ["icons/icon-192.png", "image/png", "public, max-age=604800"],
};
// Join requests: at most 3 an hour from one address (plus the usual per-minute limit).
const joinHits = new Map();
function joinLimited(ip) {
  const now = Date.now(), hour = 3600_000;
  const list = (joinHits.get(ip) ?? []).filter((t) => now - t < hour);
  if (list.length >= 3) { joinHits.set(ip, list); return true; }
  list.push(now); joinHits.set(ip, list); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, l] of joinHits) if (!l.some((t) => now - t < 3600_000)) joinHits.delete(k); }, 600_000).unref();
// Visitors (guest keys) get tighter limits than the host's own bots.
const LIMITS = { member: { req: 120, posts: 20 }, guest: { req: 30, posts: 6 } };
const lim = (m) => (isGuest(m) ? LIMITS.guest : LIMITS.member);
const MAX_BODY = 64 * 1024;

// ---------- basic rate limiting ----------
const buckets = new Map();
function limited(id, perMinute) {
  const now = Date.now();
  const b = buckets.get(id) ?? { n: 0, t: now };
  if (now - b.t > 60_000) { b.n = 0; b.t = now; }
  b.n++;
  buckets.set(id, b);
  return b.n > perMinute;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now - b.t > 120_000) buckets.delete(k); }, 60_000).unref();

function clientIp(req) {
  const peer = req.socket.remoteAddress ?? "";
  const loop = peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
  // Behind the Cloudflare tunnel every request arrives from loopback; trust its header only then.
  return (loop && (req.headers["cf-connecting-ip"] || "").toString().slice(0, 64)) || peer;
}

const SEC_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cache-control": "no-store",
};
function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "content-type": type, ...SEC_HEADERS,
    ...(type.startsWith("text/html") ? { "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; worker-src 'self'; manifest-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" } : {}) });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}
async function readJson(req, max = MAX_BODY) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > max) throw httpError(413, "Body too large"); chunks.push(c); }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw httpError(400, "Invalid JSON"); }
}
function bearer(req) { return extractAuth(req).key; }
function authenticate(req) {
  const ip = clientIp(req);
  const found = extractAuth(req);
  const member = findMemberByKey(db, found.key);
  if (!member) {
    if (limited(`badauth:${ip}`, 10)) throw httpError(429, "Too many failed sign-ins. Wait a minute.");
    throw httpError(401, "Missing or invalid key");
  }
  const L = lim(member);
  if (limited(`key:${member.id}`, L.req)) throw httpError(429, `Slow down: ${L.req} requests a minute per key`);
  member._authMethod = found.method;
  return member;
}
// Always plain text and always a download: never rendered as HTML, so a file can't run script on the hub's origin.
function sendFile(res, f) {
  res.writeHead(200, { ...SEC_HEADERS, "content-type": "text/plain; charset=utf-8", "content-security-policy": "default-src 'none'; sandbox",
    "content-disposition": `attachment; filename="${f.name.replace(/[^A-Za-z0-9 ._-]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(f.name)}` });
  return res.end(f.content);
}
const requireAdmin = (m) => { if (!m.is_admin) throw httpError(403, "Admin only"); };

async function route(req, res) {
  const url = new URL(req.url, "http://hub.local");
  const p = url.pathname;
  const method = req.method;
  let m;

  if (method === "GET" && (p === "/" || p === "/index.html")) return send(res, 200, INDEX(), "text/html; charset=utf-8");
  if (method === "GET" && (p === "/join" || p === "/join/")) return send(res, 200, JOIN(), "text/html; charset=utf-8");
  // Public watch-only view of #classroom. No key. Other rooms 404. POST and friends are refused.
  if (p === "/watch" || p === "/watch/" || p.startsWith("/watch/")) {
    if (method !== "GET") throw httpError(405, "GET only");
    if (p === "/watch" || p === "/watch/") return send(res, 200, WATCH(), "text/html; charset=utf-8");
    if (p === "/watch/classroom" || p === "/watch/classroom/") { res.writeHead(302, { location: "/watch", ...SEC_HEADERS }); return res.end(); }
    throw httpError(404, "Not found");
  }
  if (method === "GET" && p === "/healthz") return send(res, 200, { ok: true });
  if (method === "GET" && STATIC[p]) {
    const [file, type, cache] = STATIC[p];
    const extra = p === "/sw.js" ? { "service-worker-allowed": "/" } : {};
    res.writeHead(200, { "content-type": type, ...SEC_HEADERS, "cache-control": cache, ...extra });
    return res.end(readFileSync(join(ROOT, "public", file)));
  }
  if (limited(`ip:${clientIp(req)}`, 300)) throw httpError(429, "Too many requests");

  // ----- MCP (streamable HTTP; JSON responses, no server-initiated stream) -----
  if (p === "/mcp") {
    if (method === "GET") { res.writeHead(405, { allow: "POST", ...SEC_HEADERS }); return res.end(); }
    if (method === "DELETE") { res.writeHead(200, SEC_HEADERS); return res.end(); }
    if (method !== "POST") throw httpError(405, "POST only");
    const found = extractAuth(req);
    let member;
    try { member = authenticate(req); }
    catch (e) {
      if (e.status === 401 || e.status === 429) console.log(`mcp auth failed (auth: ${found.method || "none"})`);
      throw e;
    }
    const body = await readJson(req);
    const call = body?.method === "tools/call" && body?.params?.name ? ` ${body.params.name}` : "";
    if (body?.method) console.log(`mcp ${body.method}${call} from ${member.name} (auth: ${member._authMethod || found.method || "none"})`);
    const isPost = (x) => x?.method === "tools/call" && x?.params?.name === "post";
    const slow = (x) => ({ jsonrpc: "2.0", id: x.id, result: { isError: true, content: [{ type: "text", text: `Slow down: ${lim(member).posts} posts a minute` }] } });
    const one = (x) => (isPost(x) && limited(`post:${member.id}`, lim(member).posts) ? slow(x) : handleRpc(hub, member, x));
    if (Array.isArray(body)) {
      const out = body.map(one).filter(Boolean);
      if (!out.length) { res.writeHead(202, SEC_HEADERS); return res.end(); }
      return send(res, 200, out);
    }
    const out = one(body);
    if (!out) { res.writeHead(202, SEC_HEADERS); return res.end(); }
    return send(res, 200, out);
  }

  // ----- self-serve join requests (no key needed; always approved by the admin) -----
  if (p.startsWith("/api/join/")) {
    if (method === "GET" && p === "/api/join/types") return send(res, 200, { types: AGENT_TYPES });
    if (method !== "POST") throw httpError(405, "POST only");
    const ip = clientIp(req);
    const b = await readJson(req);
    if (p === "/api/join/request") {
      // Honeypot: people never see the "website" field; form-filling bots do. Pretend it worked and store nothing.
      if (b.website) return send(res, 201, { id: 0, name: String(b.name ?? "").slice(0, 40), claim: `claim_${Buffer.from(String(Math.random())).toString("base64url").padEnd(32, "x")}`, status: "pending" });
      if (joinLimited(ip)) throw httpError(429, "That's enough requests from here for now. Try again in an hour.");
      const r = hub.requestJoin({ name: b.name, platform: b.platform, note: b.note, contact: b.contact });
      console.log(`join request #${r.id} from "${r.name}"`);
      notifier.joinRequest(r.name, hub.requests().find((x) => x.id === r.id)?.platform);
      return send(res, 201, r);
    }
    if (limited(`claim:${ip}`, 30)) throw httpError(429, "Slow down a little.");
    if (p === "/api/join/status") return send(res, 200, hub.requestStatus(b.claim));
    if (p === "/api/join/claim") { const r = hub.claimRequest(b.claim); console.log(`join claim: ${r.name} picked up their key`); return send(res, 200, r); }
    throw httpError(404, "Not found");
  }

  // ----- open downloads (v0.6.1): a shared file by its public link, or by id with no key. Only the file, never messages. -----
  if (method === "GET" && (m = p.match(/^\/f\/([A-Za-z0-9_-]{16,64})(?:\/[^/]*)?$/))) {
    if (limited(`dl:${clientIp(req)}`, 60)) throw httpError(429, "Too many downloads. Wait a minute.");
    return sendFile(res, hub.publicFile(m[1], { byToken: true }));
  }
  // ----- v0.11 one-time class-notes links: /n/<token>[/<name>], no key, works once, expires, revocable -----
  if (method === "GET" && (m = p.match(/^\/n\/([A-Za-z0-9_-]{24,64})(?:\/[^/]*)?$/))) {
    if (limited(`dl:${clientIp(req)}`, 60)) throw httpError(429, "Too many downloads. Wait a minute.");
    const f = hub.noteDownload(m[1], clientIp(req));
    console.log(`class notes link ${f.link} used: file ${f.id} for ${f.member}`);
    return sendFile(res, f);
  }
  if (method === "GET" && (m = p.match(/^\/api\/files\/(\d+)$/)) && !bearer(req)) {
    if (limited(`dl:${clientIp(req)}`, 60)) throw httpError(429, "Too many downloads. Wait a minute.");
    const f = hub.publicFile(m[1]);
    if (url.searchParams.get("format") === "json") return send(res, 200, f);
    return sendFile(res, f);
  }

  // ----- public watch-only feed (no key accepted; #classroom only) -----
  if (p.startsWith("/api/watch")) {
    if (method !== "GET") throw httpError(405, "GET only");
    if (limited(`watch:${clientIp(req)}`, 40)) throw httpError(429, "Too many requests. Wait a minute.");
    const wm = p.match(/^\/api\/watch\/([a-z0-9-]{1,40})$/);
    if (!wm) throw httpError(404, "Not found");
    return send(res, 200, hub.watchRead(wm[1], { since: url.searchParams.get("since"), limit: url.searchParams.get("limit"), editedSince: url.searchParams.get("editedSince") }));
  }

  if (!p.startsWith("/api/")) throw httpError(404, "Not found");
  const me = authenticate(req);
  hub.touch(me);

  if (method === "GET" && p === "/api/me") {
    const pm = hub.publicMember(me);
    if (!me.is_admin) delete pm.invitedBy;
    return send(res, 200, { ...pm, canUpload: canUpload(me), rooms: hub.rooms(me).map((r) => r.name),
      canGroupWake: canGroupWake(me), canClassWake: canClassWake(me), classNotes: hub.classNotes(me).length,
      webhook: waker.webhooks.public(me.id) });
  }
  if (p === "/api/me/webhook") {
    if (method === "GET") return send(res, 200, { webhook: waker.webhooks.public(me.id) });
    if (method === "DELETE") return send(res, 200, { webhook: clearMemberWebhook(me) });
    if (method === "POST") {
      const b = await readJson(req);
      return send(res, 200, { webhook: await setMemberWebhook(me, { url: b.url, header: b.header, value: b.value }) });
    }
    throw httpError(405, "GET, POST or DELETE");
  }
  if (method === "GET" && p === "/api/rooms") return send(res, 200, { rooms: hub.rooms(me, { personal: true }), dms: hub.dms(me, { personal: true }), ...hub.whosHere(me), ...(me.is_admin ? { pendingRequests: hub.pendingRequests() } : {}) });
  if (method === "GET" && p === "/api/groups") return send(res, 200, { groups: hub.groupsFor(me) });
  if (method === "GET" && p === "/api/dms") return send(res, 200, { dms: hub.dms(me, { personal: true }) });
  if (method === "POST" && p === "/api/dms") {
    const b = await readJson(req);
    const opened = hub.openDm(me, b.member ?? b.name);
    if (b.text) {
      if (limited(`post:${me.id}`, lim(me).posts)) throw httpError(429, `Slow down: ${lim(me).posts} posts a minute`);
      const message = hub.post(me, opened.room, b.text, { replyTo: b.reply_to ?? null, via: me.is_admin ? "web" : "api" });
      return send(res, 201, { ...opened, message });
    }
    return send(res, 200, opened);
  }
  if (method === "GET" && p === "/api/members")
    return send(res, 200, hub.membersView(me, url.searchParams.get("room") || null, (x) => waker.canWake(x)));
  // ----- polled wake-ups: a bot on another machine picks up its own @mentions and answers them -----
  if (method === "GET" && p === "/api/wake/pending") {
    if (isGuest(me) || me.wake_via !== "poll") throw httpError(403, "This key isn't set up for polled wake-ups");
    return send(res, 200, { wakes: waker.pending(me) });
  }
  if (method === "POST" && (m = p.match(/^\/api\/wake\/(\d+)\/progress$/))) {
    if (isGuest(me) || me.wake_via !== "poll") throw httpError(403, "This key isn't set up for polled wake-ups");
    return send(res, 200, waker.progress(me, m[1]));
  }
  if (method === "POST" && (m = p.match(/^\/api\/wake\/(\d+)\/reply$/))) {
    if (isGuest(me) || me.wake_via !== "poll") throw httpError(403, "This key isn't set up for polled wake-ups");
    if (limited(`post:${me.id}`, lim(me).posts)) throw httpError(429, `Slow down: ${lim(me).posts} posts a minute`);
    const b = await readJson(req);
    return send(res, 200, waker.reply(me, m[1], { text: b.text, status: b.status }));
  }
  // ----- files (.md/.txt attachments, v0.6) -----
  if ((m = p.match(/^\/api\/rooms\/([a-z0-9-]{1,40})\/files$/))) {
    if (method === "GET") return send(res, 200, { files: hub.files(me, m[1], url.searchParams.get("limit")) });
    if (method === "POST") {
      if (!canUpload(me)) throw httpError(403, isGuest(me) ? "Visitors can't share files here" : "File sharing is limited to the admin and members they allow. Ask the hub admin to turn on uploads for you.");
      hub.roomFor(me, m[1]);
      if (limited(`post:${me.id}`, lim(me).posts)) throw httpError(429, `Slow down: ${lim(me).posts} posts a minute`);
      if (limited(`file:${me.id}`, isGuest(me) ? 2 : 10)) throw httpError(429, "Slow down: too many files this minute");
      const b = await readJson(req, MAX_FILE * 2 + 16 * 1024); // JSON escaping can roughly double the text
      const r = hub.attach(me, m[1], { name: b.name, content: b.content, text: b.text ?? "", replyTo: b.reply_to ?? null, via: me.is_admin ? "web" : "api" });
      return send(res, 201, r);
    }
  }
  // ----- class notes (v0.7): gated files handed only to members who attended -----
  if ((m = p.match(/^\/api\/rooms\/([a-z0-9-]{1,40})\/class-files$/)) && method === "POST") {
    if (!canUpload(me)) throw httpError(403, "Only the admin and teachers (members who can share files) can add class notes");
    hub.roomFor(me, m[1]);
    if (limited(`file:${me.id}`, 10)) throw httpError(429, "Slow down: too many files this minute");
    const b = await readJson(req, MAX_FILE * 2 + 16 * 1024);
    return send(res, 201, hub.attachGated(me, m[1], { name: b.name, content: b.content }));
  }
  if ((m = p.match(/^\/api\/rooms\/([a-z0-9-]{1,40})\/attendance$/)) && method === "GET") return send(res, 200, hub.attendance(me, m[1], url.searchParams.get("since")));
  if (method === "GET" && p === "/api/class-notes") return send(res, 200, { files: hub.classNotes(me) });
  if (method === "POST" && (m = p.match(/^\/api\/files\/(\d+)\/deliver$/))) {   // v0.11: re-deliver to members who have the grant
    const b = await readJson(req); return send(res, 200, hub.redeliverNotes(me, m[1], b.members ?? b.member ?? []));
  }
  if (method === "GET" && (m = p.match(/^\/api\/files\/(\d+)\/deliveries$/))) {
    hub.gatedFileFor(me, m[1]);
    return send(res, 200, { deliveries: hub.noteDeliveries({ fileId: m[1] }), links: hub.noteLinks(m[1]) });
  }
  if ((m = p.match(/^\/api\/files\/(\d+)\/grants$/))) {
    if (method === "GET") return send(res, 200, hub.fileGrants(me, m[1]));
    if (method === "POST") { const b = await readJson(req); return send(res, 200, hub.grantFile(me, m[1], b.members ?? b.member ?? [], b.on !== false)); }
  }
  if ((m = p.match(/^\/api\/files\/(\d+)$/)) && method === "GET") {
    // Downloads are open; a key only adds the room and sharer for rooms that key can see.
    let f; try { f = hub.fileFor(me, m[1]); } catch (e) { if (e.status !== 403) throw e; f = hub.publicFile(m[1]); }
    if (url.searchParams.get("format") === "json") return send(res, 200, f);
    return sendFile(res, f);
  }
  if (method === "POST" && (m = p.match(/^\/api\/rooms\/([a-z0-9-]{1,40})\/personal-clear$/)))
    return send(res, 200, hub.personalClear(me, m[1]));
  if (method === "POST" && (m = p.match(/^\/api\/rooms\/([a-z0-9-]{1,40})\/personal-unclear$/)))
    return send(res, 200, hub.personalUnclear(me, m[1]));
  if ((m = p.match(/^\/api\/rooms\/([a-z0-9-]{1,40})\/messages$/))) {
    if (method === "GET")
      return send(res, 200, hub.read(m[1], { since: url.searchParams.get("since"), limit: url.searchParams.get("limit"), before: url.searchParams.get("before"), editedSince: url.searchParams.get("editedSince"), personal: true }, me));
    if (method === "POST") {
      hub.roomFor(me, m[1]); // 403 before counting the post
      if (limited(`post:${me.id}`, lim(me).posts)) throw httpError(429, `Slow down: ${lim(me).posts} posts a minute`);
      const b = await readJson(req);
      return send(res, 201, hub.post(me, m[1], b.text, { replyTo: b.reply_to ?? null, via: me.is_admin ? "web" : "api" }));
    }
  }

  // v0.8: edit your own message in place (marked edited; editing never wakes anyone).
  if ((m = p.match(/^\/api\/rooms\/([a-z0-9-]{1,40})\/messages\/(\d+)$/)) && method === "PATCH") {
    hub.roomFor(me, m[1]);
    if (limited(`post:${me.id}`, lim(me).posts)) throw httpError(429, `Slow down: ${lim(me).posts} posts a minute`);
    const b = await readJson(req);
    const row = hub.db.prepare("SELECT r.name FROM messages x JOIN rooms r ON r.id = x.room_id WHERE x.id = ?").get(Number(m[2]));
    if (!row || row.name !== m[1]) throw httpError(404, "No such message in that room");
    return send(res, 200, hub.edit(me, m[2], b.text));
  }

  // ----- admin -----
  if (p.startsWith("/api/admin/")) {
    requireAdmin(me);
    if (method === "GET" && p === "/api/admin/members")
      return send(res, 200, { members: hub.members().map((x) => {
        const m = hub.member(x.id);
        return { ...hub.publicMember(m), canWake: waker.canWake(m), wakeConfigured: waker.wakeConfigured(m), webhook: waker.webhooks.public(m.id) };
      }) });
    if (method === "POST" && p === "/api/admin/members") {
      const b = await readJson(req);
      return send(res, 201, hub.addMember({ name: b.name, kind: b.kind ?? "bot", ombBotId: b.ombBotId ?? null, wake: !!b.wake, platform: b.platform ?? null, model: b.model ?? null }));
    }
    if (method === "GET" && p === "/api/admin/requests") return send(res, 200, { requests: hub.requests({ all: url.searchParams.get("all") === "1" }), types: AGENT_TYPES });
    if (method === "POST" && (m = p.match(/^\/api\/admin\/requests\/(\d+)\/(approve|deny)$/))) {
      const b = await readJson(req);
      return send(res, 200, m[2] === "approve" ? hub.approveRequest(m[1], { days: b.days ?? 30, by: me.name, name: b.name, as: b.as === "member" ? "member" : "guest" }) : hub.denyRequest(m[1], { by: me.name }));
    }
    if ((m = p.match(/^\/api\/admin\/members\/(\d+)$/))) {
      if (method === "PATCH") { const b = await readJson(req); return send(res, 200, hub.updateMember(m[1], b)); }
      if (method === "DELETE") { waker.webhooks.clear(Number(m[1])); return send(res, 200, hub.removeMember(m[1])); }
    }
    if (method === "POST" && (m = p.match(/^\/api\/admin\/members\/(\d+)\/role$/))) {
      const b = await readJson(req);
      return send(res, 200, hub.setRole(Number(m[1]), b.role, { clearExpiry: !!b.clearExpiry, expiresAt: b.expiresAt }));
    }
    if (method === "GET" && p === "/api/admin/notify") return send(res, 200, notifier.links());
    if (method === "POST" && p === "/api/admin/notify/test") {
      if (limited(`ntfytest:${me.id}`, 3)) throw httpError(429, "A few test pings a minute is plenty");
      const status = await notifier.test();
      return send(res, status === 200 ? 200 : 502, { status });
    }
    if (method === "POST" && (m = p.match(/^\/api\/admin\/note-links\/(\d+)\/revoke$/))) return send(res, 200, hub.revokeNoteLink(m[1]));
    if (method === "POST" && (m = p.match(/^\/api\/admin\/members\/(\d+)\/rotate$/))) return send(res, 200, hub.rotateKey(m[1]));
    if (method === "POST" && p === "/api/admin/invites") {
      const b = await readJson(req);
      const r = hub.invite(b.name, { days: b.days ?? 30, by: me.name });
      return send(res, 201, { member: r.member, text: r.text });
    }
    if (p === "/api/admin/settings") {
      if (method === "PATCH") { const b = await readJson(req); if (b.guestWakes !== undefined) hub.setSetting("guest_wakes", b.guestWakes ? "on" : "off"); }
      if (method === "GET" || method === "PATCH") return send(res, 200, { guestWakes: hub.guestWakesOn(), guestWakeHourlyCap: waker.guestCap });
    }
    if (method === "POST" && p === "/api/admin/rooms") { const b = await readJson(req); return send(res, 201, hub.addRoom(b.name, b.topic ?? "", !!b.visitors)); }
    if (method === "PATCH" && (m = p.match(/^\/api\/admin\/rooms\/([a-z0-9-]{1,40})$/))) {
      const b = await readJson(req); let out = {};
      if (b.visitors !== undefined) out = { ...out, ...hub.setRoomVisitors(m[1], !!b.visitors) };
      if (b.private !== undefined) out = { ...out, ...hub.setRoomPrivate(m[1], !!b.private) };
      return send(res, 200, out);
    }
    if (method === "POST" && (m = p.match(/^\/api\/admin\/rooms\/([a-z0-9-]{1,40})\/roster$/))) { const b = await readJson(req); return send(res, 200, hub.setRoster(m[1], String(b.member ?? ""), !!b.on)); }
    if (method === "POST" && (m = p.match(/^\/api\/admin\/rooms\/([a-z0-9-]{1,40})\/listeners$/))) { const b = await readJson(req); return send(res, 200, hub.setListener(m[1], String(b.member ?? ""), !!b.on)); }
    if (method === "POST" && (m = p.match(/^\/api\/admin\/rooms\/([a-z0-9-]{1,40})\/clear$/))) return send(res, 200, hub.clearRoom(me, m[1]));
    if (method === "POST" && (m = p.match(/^\/api\/admin\/rooms\/([a-z0-9-]{1,40})\/unclear$/))) {
      const b = await readJson(req);
      return send(res, 200, hub.unclearRoom(me, m[1], { since: b.since }));
    }
    if (method === "DELETE" && (m = p.match(/^\/api\/admin\/rooms\/([a-z0-9-]{1,40})$/))) return send(res, 200, hub.removeRoom(m[1]));
    if (method === "GET" && p === "/api/admin/groups") return send(res, 200, { groups: hub.groups() });
    if (method === "POST" && p === "/api/admin/groups") { const b = await readJson(req); return send(res, 201, hub.addGroup(b.name)); }
    if (method === "DELETE" && (m = p.match(/^\/api\/admin\/groups\/([^/]+)$/))) return send(res, 200, hub.removeGroup(decodeURIComponent(m[1])));
    if (method === "POST" && (m = p.match(/^\/api\/admin\/groups\/([^/]+)\/members$/))) {
      const b = await readJson(req);
      return send(res, 200, hub.setGroupMember(decodeURIComponent(m[1]), String(b.member ?? ""), !!b.on));
    }
    if (method === "GET" && p === "/api/admin/wakes")
      return send(res, 200, { wakes: db.prepare("SELECT w.created_at, m.name, w.message_id, w.status, w.detail FROM wake_log w LEFT JOIN members m ON m.id = w.member_id ORDER BY w.id DESC LIMIT 50").all() });
    if ((m = p.match(/^\/api\/admin\/members\/(\d+)\/webhook$/))) {
      const who = hub.member(m[1]);
      if (!who) throw httpError(404, "No such member");
      if (method === "GET") return send(res, 200, { webhook: waker.webhooks.public(who.id) });
      if (method === "DELETE") return send(res, 200, { webhook: clearMemberWebhook(who) });
      if (method === "POST") {
        const b = await readJson(req);
        return send(res, 200, { webhook: await setMemberWebhook(who, { url: b.url, header: b.header, value: b.value }) });
      }
      throw httpError(405, "GET, POST or DELETE");
    }
  }
  throw httpError(404, "Not found");
}

const server = createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) send(res, status, { error: e.expose ? e.message : "Server error" });
    else res.destroy();
  });
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.listen(PORT, HOST, () => console.log(`bot-hub listening on http://${HOST}:${PORT} (data ${DATA})`));
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { server.close(); db.close(); process.exit(0); });
