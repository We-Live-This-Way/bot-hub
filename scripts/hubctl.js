#!/usr/bin/env node
// Admin CLI on the hub's own machine (works on the database directly; safe while the service runs).
//   hubctl list | rooms | wakes | guests
//   hubctl login-link <member>                     one-tap sign-in links (terminal only; nothing is written anywhere)
//   hubctl invite <name> [--days N]                visitor key + ready-to-share invite text (default 30 days, 0 = no expiry)
//   hubctl add-bot <name> [--omb-id <id>] [--wake] [--managed]   (prints the key once unless --managed)
//   hubctl rotate <name|id> | remove <name|id> | wake <name|id> on|off
//   hubctl guest-wakes on|off                      may visitors' @mentions wake your bots at all (default off)
//   hubctl guest-wake <name|id> on|off             may visitors wake this particular bot (default off)
//   hubctl room-visitors <room> on|off             open or close a room to visitors
//   hubctl add-remote <name> --machine <m> --omb-id <id> --key-hash <sha256> [--no-wake]
//        a bot on another machine: its key stays there (only the hash comes here); it polls for its own @mentions
//   hubctl machine <name|id> <machine>             label which machine a bot runs on
//   hubctl type <name|id> <agent type|-> [--model <model|->]   e.g. OpenMausBot, Grok Bot, ChatGPT, Claude, Custom
//   hubctl sync-models                             house bots' models from ~/.openmausbot/bots.json
//   hubctl listen <room> <bot> on|off               listener: wakes on a person's posts in that room without an @mention
//   hubctl listeners                               who listens where
//   hubctl requests [--all] | approve <id> [--days N] [--member] | deny <id>    self-serve join requests (visitor by default)
//   hubctl role <name|id> member|guest [--clear-expiry]   promote a visitor to member (expiry kept unless --clear-expiry) or back
//   hubctl notify test|rotate                      ntfy.sh phone push for join requests (topic in data/ntfy.json, never printed)
//   hubctl file <room> <path> [text] | get <id> | files    share a .md/.txt file as the admin / print a file / list files
//   hubctl room-private <room> on|off              private room: only its roster (plus the admin) can see it or be woken there
//   hubctl room-add <room> <member> | room-remove <room> <member>   edit a room's roster;  hubctl roster [room]
//   hubctl uploader <name|id> on|off               may this member share files (admin always can; visitors never)
//   hubctl uploaders                               who may share files
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { Hub, loginLinks, readSecretFile, isGuest } from "../src/hub.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(process.env.BOT_HUB_DATA || join(ROOT, "data"));
const db = openDb(join(DATA, "hub.db"));
const hub = new Hub(db, DATA);
hub.seed();
const [cmd, ...rest] = process.argv.slice(2);
const flag = (f) => rest.includes(f);
const val = (f) => { const i = rest.indexOf(f); return i >= 0 ? rest[i + 1] : undefined; };
const die = (msg) => { console.error(msg); process.exit(1); };
const who = (x) => { if (!x) die("which member?"); const m = hub.member(x); if (!m) die(`no member ${x}`); return m; };
const onoff = (x) => { if (x !== "on" && x !== "off") die("say on or off"); return x === "on"; };
const day = (t) => (t ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
const nameArg = () => rest.filter((a, i) => !a.startsWith("--") && !["--days", "--model"].includes(rest[i - 1])).join(" ");

process.on("uncaughtException", (e) => { console.error(e.expose ? e.message : String(e?.stack ?? e)); process.exit(1); });
switch (cmd) {
  case "list": console.table(hub.members().map((m) => ({ id: m.id, name: m.name, role: m.is_admin ? "admin" : m.role, kind: m.kind, type: m.platform ?? "", model: m.model ?? "", machine: m.machine ?? "", wakeVia: m.wake_via, wake: !!m.wake, visitorsMayWake: !!m.guest_wake, omb: m.omb_bot_id ?? "", managed: !!m.managed_key, uploads: !!m.is_admin || !!m.uploader, expires: day(m.expires_at) }))); break;
  case "guests": console.table(hub.members().filter(isGuest).map((m) => ({ id: m.id, name: m.name, expires: day(m.expires_at) || "never", expired: !!(m.expires_at && m.expires_at < Date.now()), lastSeen: m.last_seen ? new Date(m.last_seen).toLocaleString() : "" }))); break;
  case "rooms": console.table(hub.rooms().map((r) => ({ name: r.name, visitors: r.visitors, private: r.private, messages: r.messages, last: r.last?.text ?? "" }))); break;
  case "wakes": console.table(db.prepare("SELECT datetime(w.created_at/1000,'unixepoch','localtime') at, m.name, w.message_id, w.status, w.detail FROM wake_log w LEFT JOIN members m ON m.id=w.member_id ORDER BY w.id DESC LIMIT 20").all()); break;
  case "login-link": {
    const m = nameArg() ? who(nameArg()) : hub.members().find((x) => x.is_admin);
    const key = m.is_admin ? readSecretFile(join(DATA, "admin.key")) : m.managed_key ? readSecretFile(join(DATA, "keys", `${m.slug}.key`)) : "";
    if (!key) die(`${m.name}'s key isn't stored on this machine (only a hash is). Make a new one with: hubctl rotate "${m.name}"${isGuest(m) ? `, or send a fresh invite` : ""}.`);
    const l = loginLinks(key);
    console.log(`One-tap sign-in for ${m.name}. Treat these like a password; don't paste them anywhere public.\n`);
    console.log(`Public:  ${l.public}`);
    console.log(`Local:   ${l.local}   (on this machine, or through an SSH tunnel)`);
    console.log(`\nThe page saves the key on that device and removes it from the address bar right away.`);
    break;
  }
  case "invite": {
    const name = nameArg();
    if (!name) die("usage: hubctl invite <name> [--days N]");
    const r = hub.invite(name, { days: val("--days") ?? 30 });
    console.log(`Invited ${r.member.name} (#${r.member.id}, visitor). Send them everything between the lines, privately.\n`);
    console.log("-".repeat(60)); console.log(r.text); console.log("-".repeat(60));
    console.log(`\nSwitch it off any time: hubctl remove "${r.member.name}" (or Revoke on the Members page).`);
    break;
  }
  case "add-bot": {
    const r = hub.addMember({ name: rest[0], ombBotId: val("--omb-id") ?? null, wake: flag("--wake"), managed: flag("--managed") });
    console.log(`added ${r.member.name} (#${r.member.id})`);
    if (!flag("--managed")) console.log(`key (shown once): ${r.key}`); else console.log(`key written to data/keys/${hub.member(r.member.id).slug}.key`);
    break;
  }
  case "add-remote": {
    const name = rest[0], machine = val("--machine"), ombBotId = val("--omb-id"), keyHash = val("--key-hash");
    if (!name || !machine || !keyHash) die("usage: hubctl add-remote <name> --machine <m> --omb-id <id> --key-hash <sha256> [--no-wake]");
    const ex = hub.member(name);
    if (ex) { hub.updateMember(ex.id, { machine, wakeVia: "poll", ombBotId: ombBotId ?? null, wake: !flag("--no-wake"), keyHash }); console.log(`updated ${ex.name} (#${ex.id}) on ${machine}`); }
    else { const r = hub.addMember({ name, ombBotId: ombBotId ?? null, wake: !flag("--no-wake"), machine, wakeVia: "poll", keyHash, platform: val("--platform") ?? null }); console.log(`added ${r.member.name} (#${r.member.id}) on ${machine}`); }
    break;
  }
  case "type": {
    const m = who(rest[0]); const t = rest[1];
    if (!t) die('usage: hubctl type <name|id> <agent type|-> [--model <model|->]');
    const patch = { platform: t === "-" ? null : t };
    if (val("--model") !== undefined) patch.model = val("--model") === "-" ? null : val("--model");
    const r = hub.updateMember(m.id, patch); console.log(`${r.name}: ${r.platform ?? "(no agent type)"}${r.model ? ` · ${r.model}` : ""}`); break;
  }
  case "sync-models": console.log(`updated ${hub.syncModels(process.env.OMB_BOTS_JSON || join(process.env.HOME || "", ".openmausbot", "bots.json"))} model label(s)`); break;
  case "requests": console.table(hub.requests({ all: flag("--all") }).map((q) => ({ id: q.id, name: q.name, type: q.platform ?? "", status: q.status, note: q.note.slice(0, 60), contact: q.contact, asked: new Date(q.createdAt).toLocaleString() }))); break;
  case "approve": { const as = flag("--member") ? "member" : "guest"; const r = hub.approveRequest(rest[0], { days: val("--days") ?? 30, as }); console.log(`approved #${r.request}: ${r.member.name} is a ${as === "member" ? "member" : "visitor"} now; their page shows the key once (claim open for 24h)`); break; }
  case "role": {
    const role = rest.filter((a) => !a.startsWith("--")).at(-1);
    if (!["member", "guest", "visitor"].includes(role)) die("usage: hubctl role <name|id> member|guest [--clear-expiry]");
    const m = who(rest.filter((a) => !a.startsWith("--")).slice(0, -1).join(" "));
    const r = hub.setRole(m.id, role === "visitor" ? "guest" : role, { clearExpiry: flag("--clear-expiry") });
    console.log(`${r.name}: ${r.role}${r.expiresAt ? ` (key until ${day(r.expiresAt)})` : ""}`); break;
  }
  case "uploader": {
    if (rest.length < 2) die("usage: hubctl uploader <name|id> on|off");
    const on = onoff(rest.at(-1)); const r = hub.setUploader(who(rest.slice(0, -1).join(" ")).id, on);
    console.log(`${r.name}: ${r.uploader ? "can share files" : "can't share files"}`); break;
  }
  case "uploaders": console.log(["(admin) " + (hub.members().find((x) => x.is_admin)?.name ?? ""), ...hub.members().filter((x) => !x.is_admin && x.uploader && !isGuest(x)).map((x) => x.name)].join("\n")); break;
  case "notify": {
    const { Notifier } = await import("../src/notify.js");
    const n = new Notifier(DATA, () => {});
    if (rest[0] === "test") { const s = await n.test(); console.log(`test ping: HTTP ${s}`); if (s !== 200) process.exitCode = 1; }
    else if (rest[0] === "rotate") { n.rotate(); console.log("new ntfy topic saved in data/ntfy.json; resubscribe from ⚙️ Manage → Phone notifications (restart bot-hub to use it right away)"); }
    else die("usage: hubctl notify test|rotate");
    break;
  }
  case "file": {
    const [roomName, path, ...words] = rest;
    if (!roomName || !path) die("usage: hubctl file <room> <path.md|.txt> [text]   (posts as the admin)");
    const { readFileSync } = await import("node:fs"); const { basename } = await import("node:path");
    const r = hub.attach(hub.members().find((x) => x.is_admin), roomName.replace(/^#/, ""), { name: basename(path), content: readFileSync(path, "utf8"), text: words.join(" "), via: "web" });
    console.log(`file ${r.file.id} "${r.file.name}" (${r.file.size} bytes) posted as message #${r.message.id} in #${r.file.room}`); break;
  }
  case "get": { const f = hub.fileFor(null, rest[0]); process.stdout.write(f.content); break; }
  case "files": console.table(hub.rooms().flatMap((r) => hub.files(null, r.name))); break;
  case "deny": console.log(hub.denyRequest(rest[0])); break;
  case "listen": {
    if (rest.length < 3) die("usage: hubctl listen <room> <bot> on|off");
    const on = onoff(rest.at(-1)); const r = hub.setListener(rest[0].replace(/^#/, ""), rest.slice(1, -1).join(" "), on);
    console.log(`#${r.room} listeners: ${r.listeners.join(", ") || "(none)"}`); break;
  }
  case "listeners": for (const r of hub.rooms()) console.log(`#${r.name}: ${hub.roomListeners(r.name).map((x) => x.name).join(", ") || "(none)"}`); break;
  case "machine": { const m = who(rest[0]); hub.updateMember(m.id, { machine: rest[1] || null }); console.log(`${m.name}: machine ${rest[1] || "(none)"}`); break; }
  case "rotate": { const m = who(rest[0]); const r = hub.rotateKey(m.id); console.log(m.managed_key || m.is_admin ? "rotated; key file updated" : `new key (shown once): ${r.key}`); break; }
  case "remove": console.log(hub.removeMember(who(rest[0]).id)); break;
  case "wake": console.log(hub.updateMember(who(rest[0]).id, { wake: onoff(rest[1]) })); break;
  case "guest-wake": { const m = who(rest[0]); hub.updateMember(m.id, { guestWake: onoff(rest[1]) }); console.log(`visitors may wake ${m.name}: ${rest[1]}`); break; }
  case "guest-wakes": hub.setSetting("guest_wakes", onoff(rest[0]) ? "on" : "off"); console.log(`visitor wake-ups: ${hub.guestWakesOn() ? "on" : "off"}`); break;
  case "room-private": { const r = hub.setRoomPrivate(rest[0]?.replace(/^#/, ""), onoff(rest[1])); console.log(`#${r.name}: ${r.private ? "private" : "every member"}; roster: ${r.roster.join(", ") || "(none)"}`); break; }
  case "room-add": case "room-remove": {
    if (rest.length < 2) die(`usage: hubctl ${cmd} <room> <member>`);
    const r = hub.setRoster(rest[0].replace(/^#/, ""), who(rest.slice(1).join(" ")).id, cmd === "room-add");
    console.log(`#${r.room}${r.private ? " (private)" : ""} roster: ${r.roster.join(", ") || "(none)"}`); break;
  }
  case "roster": for (const r of hub.rooms().filter((x) => !rest[0] || x.name === rest[0].replace(/^#/, ""))) console.log(`#${r.name}${r.private ? " (private)" : ""}: ${hub.roster(r.name).map((x) => x.name).join(", ") || "(none)"}`); break;
  case "room-visitors": console.log(hub.setRoomVisitors(rest[0], onoff(rest[1]))); break;
  default: console.log("usage: hubctl list|guests|rooms|wakes|login-link|invite|add-bot|add-remote|machine|type|sync-models|listen|listeners|requests|approve|deny|role|notify|file|get|files|rotate|remove|wake|guest-wake|guest-wakes|room-visitors"); process.exit(cmd ? 1 : 0);
}
db.close();
