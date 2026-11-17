#!/usr/bin/env node
// Temp-data tests for v0.10: wake webhooks, SSRF, visitor webhook wake, flex auth, key redaction.
// No live network to the production hub, no real bot wakes, no Guestbot webhook, no key rotation.
import "./test-env.mjs";
import { createServer } from "node:http";
import { mkdirSync, rmSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, newKey, redactSecrets, extractAuth, installLogRedaction } from "../src/db.js";
import { Hub, neverGuestWake } from "../src/hub.js";
import { Waker } from "../src/wake.js";
import { WakeWebhooks, parseHookInput, parseReply, isPrivateIp, redactUrl, publicHook } from "../src/wake-webhooks.js";

const dir = join(tmpdir(), `bot-hub-v10-test-${Date.now()}`);
mkdirSync(dir, { recursive: true, mode: 0o700 });
const db = openDb(join(dir, "hub.db"));
const hub = new Hub(db, dir);
process.env.BOT_HUB_ADMIN_NAME = "Alice";
hub.seed();

const failures = [];
const ok = (cond, msg) => { if (cond) console.log("  ok  " + msg); else { console.log("  FAIL " + msg); failures.push(msg); } };

let alice = hub.members().find((m) => m.is_admin);
if (alice.name !== "Alice") {
  db.prepare("UPDATE members SET name = 'Alice', slug = 'alice' WHERE id = ?").run(alice.id);
  alice = hub.member("Alice");
}

console.log("redaction");
const guest = newKey("hubguest");
const member = newKey("hub");
const admin = newKey("hubadmin");
const unclaimed = newKey("unclaimed");
const future = newKey("hubmeta");
ok(redactSecrets(`Your key: ${guest}`).includes("hubguest_[REDACTED]") && !redactSecrets(`Your key: ${guest}`).includes(guest), "masks hubguest_ keys");
ok(redactSecrets(`k=${member}`).includes("hub_[REDACTED]") && !redactSecrets(member).includes(member.slice(-12)), "masks hub_ keys");
ok(redactSecrets(admin).startsWith("hubadmin_[REDACTED]"), "masks hubadmin_ keys");
ok(redactSecrets(unclaimed).startsWith("unclaimed_[REDACTED]"), "masks unclaimed_ keys");
ok(redactSecrets(future).startsWith("hubmeta_[REDACTED]"), "masks other hub…_ prefixes");
ok(redactSecrets(`https://hub.example/#key=${guest}`) === "https://hub.example/#key=[REDACTED]", "masks #key=");
ok(redactSecrets(`/api/me?key=${member}&x=1`).includes("key=[REDACTED]") && !redactSecrets(`/api/me?key=${member}&x=1`).includes(member), "masks ?key=");
ok(redactSecrets(`/mcp?api_key=${guest}`).includes("api_key=[REDACTED]"), "masks ?api_key=");
ok(redactSecrets(`Authorization: Bearer ${member}`) === "Authorization: Bearer [REDACTED]", "masks Bearer tokens");
ok(redactSecrets("visit https://hub.example.com/join").includes("hub.example.com"), "does not mask the hub hostname");
const logs = [];
const fake = { log: (...a) => logs.push(a.join(" ")), info() {}, warn() {}, error() {}, debug() {} };
installLogRedaction(fake);
fake.log(`invite ${guest} Bearer ${member}`);
ok(logs[0].includes("hubguest_[REDACTED]") && logs[0].includes("Bearer [REDACTED]") && !logs[0].includes(guest) && !logs[0].includes(member), "console wrapper redacts keys");

console.log("flex auth extractAuth");
const req = (headers, url = "/mcp") => ({ headers, url });
ok(extractAuth(req({ authorization: `Bearer ${member}` })).method === "bearer"
  && extractAuth(req({ authorization: `Bearer ${member}` })).key === member, "Bearer");
ok(extractAuth(req({ authorization: member })).method === "authorization"
  && extractAuth(req({ authorization: member })).key === member, "raw Authorization");
ok(extractAuth(req({ "x-api-key": guest })).method === "x-api-key"
  && extractAuth(req({ "x-api-key": guest })).key === guest, "x-api-key");
ok(extractAuth(req({ "api-key": admin })).method === "api-key", "api-key");
ok(extractAuth(req({}, `/mcp?api_key=${guest}`)).method === "query:api_key"
  && extractAuth(req({}, `/mcp?api_key=${guest}`)).key === guest, "query api_key");
ok(extractAuth(req({}, `/mcp?key=${member}`)).method === "query:key", "query key");
ok(extractAuth(req({ authorization: `Bearer ${member}` }, `/mcp?key=wrong`)).method === "bearer", "Bearer wins over junk query key");
ok(extractAuth(req({}, "/mcp")).method === null, "no key");

console.log("SSRF / parseHookInput");
delete process.env.BOT_HUB_WEBHOOK_ALLOW_LOCAL;
const throws = (fn, re, msg) => {
  let err;
  try { fn(); } catch (e) { err = e; }
  ok(!!err && (re.test(err.message) || err.status === 400), msg);
};
throws(() => parseHookInput({ url: "http://example.com/hook" }), /HTTPS/i, "plain HTTP to the public internet is rejected");
throws(() => parseHookInput({ url: "http://127.0.0.1:9/hook" }), /HTTPS|allowed/i, "localhost HTTP rejected without the allow flag");
throws(() => parseHookInput({ url: "https://192.168.1.5/hook" }), /allowed/i, "RFC1918 HTTPS is rejected");
throws(() => parseHookInput({ url: "https://10.0.0.8/hook" }), /allowed/i, "10/8 HTTPS is rejected");
throws(() => parseHookInput({ url: "https://169.254.169.254/hook" }), /allowed/i, "link-local / metadata IP is rejected");
throws(() => parseHookInput({ url: "https://100.64.1.1/hook" }), /allowed/i, "CGNAT is rejected");
throws(() => parseHookInput({ url: "https://user:pass@example.com/hook" }), /username|password|header/i, "userinfo in the URL is rejected");
ok(isPrivateIp("127.0.0.1") && isPrivateIp("::1") && isPrivateIp("192.168.0.1") && isPrivateIp("172.16.5.5"), "isPrivateIp flags loopback and RFC1918");
ok(!isPrivateIp("1.1.1.1") && !isPrivateIp("8.8.8.8"), "public IPs are allowed");
process.env.BOT_HUB_WEBHOOK_ALLOW_LOCAL = "1";
const local = parseHookInput({ url: "http://127.0.0.1:9/hook", header: "Authorization", value: "Bearer secret" });
ok(local.url.startsWith("http://127.0.0.1") && local.header === "Authorization", "localhost HTTP allowed when BOT_HUB_WEBHOOK_ALLOW_LOCAL=1");
throws(() => parseHookInput({ url: "http://192.168.1.5/hook" }), /HTTPS|allowed/i, "LAN HTTP still rejected even with the local flag");
ok(redactUrl("https://hooks.example.com/a/super/secret/path") === "https://hooks.example.com/a/…", "redactUrl hides the tail of the path");
ok(publicHook({ url: "https://hooks.example.com/secret", header: "Authorization", value: "s" }).url === "https://hooks.example.com/secret"
  && publicHook({ url: "https://hooks.example.com/secret", header: "Authorization", value: "s" }).header === "Authorization"
  && !("value" in publicHook({ url: "https://hooks.example.com/secret", header: "Authorization", value: "s" })), "publicHook never returns the header value");

console.log("parseReply");
ok(parseReply('{"reply":"Hello!"}') === "Hello!", "JSON reply field");
ok(parseReply('{"text":"via text"}') === "via text", "JSON text field");
ok(parseReply("NO_REPLY") === null && parseReply('{"reply":"NO_REPLY"}') === null, "NO_REPLY is not a reply");
ok(parseReply("{}") === null && parseReply("ok") === null, "empty ack is not a reply");

console.log("webhook store + local delivery");
const received = [];
const hookServer = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try { body = JSON.parse(raw); } catch {}
    received.push({ url: req.url, auth: req.headers.authorization || "", body });
    if (req.url === "/reply") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ reply: "Hello from the hook" }));
    } else if (req.url === "/text") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ text: "via text" }));
    } else if (req.url === "/empty") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    } else if (req.url === "/fail") {
      res.writeHead(500);
      res.end("nope");
    } else {
      res.writeHead(404);
      res.end();
    }
  });
});
await new Promise((r) => hookServer.listen(0, "127.0.0.1", r));
const hookPort = hookServer.address().port;
const hookBase = `http://127.0.0.1:${hookPort}`;

const hooks = new WakeWebhooks(dir);
const sam = hub.addMember({ name: "SamHook", kind: "bot", role: "member", wake: false }).member;
const pub = await hooks.set(sam.id, { url: `${hookBase}/reply`, header: "Authorization", value: "Bearer hook-secret" });
ok(pub.set && pub.url.includes("127.0.0.1") && pub.header === "Authorization" && !JSON.stringify(pub).includes("hook-secret"), "set returns a redacted hook");
const onDisk = JSON.parse(readFileSync(join(dir, "wake-webhooks.json"), "utf8"));
ok(onDisk[String(sam.id)].value === "Bearer hook-secret", "secret lives only in the 0600 JSON file");
ok((statSync(join(dir, "wake-webhooks.json")).mode & 0o077) === 0, "wake-webhooks.json is not group/world readable");

const delivered = await hooks.deliver(hooks.get(sam.id), { source: "Bot Hub", event: "mention", you: "SamHook", room: "tmp-hook", message: { id: 1, text: "@SamHook hi" } });
ok(delivered.status === "replied" && delivered.reply === "Hello from the hook", "deliver returns a reply from {reply}");
ok(received.at(-1).auth === "Bearer hook-secret" && received.at(-1).body.you === "SamHook", "deliver POSTs JSON with the custom header");
ok((await hooks.deliver({ url: `${hookBase}/text` }, { event: "mention" })).reply === "via text", "deliver accepts {text}");
ok((await hooks.deliver({ url: `${hookBase}/empty` }, { event: "mention" })).status === "delivered", "2xx with no reply body is delivered");
ok(/^http 500/.test((await hooks.deliver({ url: `${hookBase}/fail` }, { event: "mention" })).status), "non-2xx is recorded, not thrown");

console.log("waker + visitor webhook wake");
const waker = new Waker(hub, { dataDir: dir, ombBase: "http://127.0.0.1:9" }); // no real OMB
hub.addRoom("tmp-hook", "temp webhook test", true);
const visitor = hub.addMember({ name: "VisHook", kind: "bot", role: "guest", wake: false }).member;
ok(!visitor.wake && visitor.role === "guest", "new visitor starts with wake off");
await waker.webhooks.set(visitor.id, { url: `${hookBase}/reply` });
hub.updateMember(visitor.id, { wake: true, wakeVia: "webhook" });
const vis = hub.member("VisHook");
ok(vis.wake && vis.wake_via === "webhook" && waker.canWake(vis) && waker.wakeConfigured(vis), "visitor can be woken via webhook");

const coder = hub.addMember({ name: "Coder", kind: "bot", role: "member", wake: true });
ok(neverGuestWake(hub.member("Coder")), "Coder is still never visitor-wakeable");

// member SamHook via webhook: @mention from Alice should POST and the reply should appear as SamHook
hub.updateMember(sam.id, { wake: true, wakeVia: "webhook" });
const before = received.length;
hub.post(alice, "tmp-hook", "hey @SamHook, ping");
await (waker.queues.get(sam.id) ?? Promise.resolve());
ok(received.length > before && received.at(-1).body.you === "SamHook" && received.at(-1).body.event === "mention", "waker POSTs a mention note to the webhook");
const replies = hub.read("tmp-hook", { limit: 20 }, alice).messages.filter((m) => m.author === "SamHook");
ok(replies.some((m) => m.text === "Hello from the hook" && m.via === "wake"), "webhook {reply} is posted as the bot");

// visitor mention: Alice @VisHook
const before2 = received.length;
hub.post(alice, "tmp-hook", "welcome @VisHook");
await (waker.queues.get(visitor.id) ?? Promise.resolve());
ok(received.length > before2 && received.at(-1).body.you === "VisHook", "visitor webhook is woken by a member mention");
ok(hub.read("tmp-hook", { limit: 20 }, alice).messages.some((m) => m.author === "VisHook" && m.text === "Hello from the hook"), "visitor webhook reply is posted");

console.log("setRole keeps webhook wake");
const promoted = hub.addMember({ name: "RoleHook", kind: "bot", role: "member", wake: true, wakeVia: "webhook" }).member;
await waker.webhooks.set(promoted.id, { url: `${hookBase}/empty` });
hub.updateMember(promoted.id, { wake: true, wakeVia: "webhook" });
const asGuest = hub.setRole(promoted.id, "guest");
ok(asGuest.guest && asGuest.wake && asGuest.wakeVia === "webhook", "demoting to visitor keeps webhook wake on");
const noHook = hub.addMember({ name: "LocalBot", kind: "bot", role: "member", wake: true, ombBotId: "x", wakeVia: "local" }).member;
const noHookGuest = hub.setRole(noHook.id, "guest");
ok(noHookGuest.guest && !noHookGuest.wake, "demoting a local-wake bot to visitor turns wake off");

console.log("cleanup");
hooks.clear(sam.id);
ok(!hooks.get(sam.id), "clear removes the hook");
ok(!existsSync(join(dir, "wake-webhooks.json")) || !JSON.parse(readFileSync(join(dir, "wake-webhooks.json"), "utf8"))[String(sam.id)], "cleared id is gone from the file");

hookServer.close();
rmSync(dir, { recursive: true, force: true });

if (failures.length) {
  console.log(`\n${failures.length} failure(s):`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
console.log("\nall v0.10 tests passed");
