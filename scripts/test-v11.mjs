#!/usr/bin/env node
// Temp-data tests for v0.11: class notes delivered whole to every granted bot (OpenMausBot room trigger, generic webhook,
// polled machine, DM-only), one-time links (single use, expiry, revoke, grant revoked), quiz keys refused, no truncation.
// Uses a fake OpenMausBot on 127.0.0.1 and a fake webhook fetch; never touches the real hub or real bots.
import "./test-env.mjs";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.BOT_HUB_NOTES_CHUNK = "1000";
process.env.BOT_HUB_ADMIN_NAME = "Alice";
const dir = join(tmpdir(), `bot-hub-v11-test-${Date.now()}`);
const omb = join(dir, "omb");
mkdirSync(omb, { recursive: true, mode: 0o700 });
process.env.OMB_DATA_DIR = omb;
const { openDb } = await import("../src/db.js");
const { Hub } = await import("../src/hub.js");
const { Waker } = await import("../src/wake.js");
const { chunkText, savePath } = await import("../src/notes-delivery.js");

const failures = [];
const ok = (cond, msg) => { if (cond) console.log("  ok  " + msg); else { console.log("  FAIL " + msg); failures.push(msg); } };
const db = openDb(join(dir, "hub.db"));
const hub = new Hub(db, dir);
hub.seed();
const alice = hub.members().find((m) => m.is_admin);
hub.addRoom("classroom", "class", false);

// fake OpenMausBot webhook trigger: records each run's text and finishes it at once (routines.json)
const runs = [];
const srv = createServer((req, res) => {
  let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
    const id = `run-${runs.length + 1}`;
    runs.push({ path: req.url, body: b });
    const last = /part (\d+) of (\d+)\]/.exec(b);
    const output = last && last[1] === last[2] ? "Saved to debug-like-a-pro/SKILL.md" : "NO_REPLY";
    const all = runs.map((r, i) => ({ id: `run-${i + 1}`, status: "completed", output: i === runs.length - 1 ? output : "NO_REPLY" }));
    writeFileSync(join(omb, "routines.json"), JSON.stringify({ runs: all }));
    res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ runId: id }));
  });
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

const logs = [];
const waker = new Waker(hub, { dataDir: dir, ombBase: `http://127.0.0.1:${port}`, log: (s) => logs.push(s) });
const add = (o) => hub.addMember({ kind: "bot", role: "member", ...o }).member;
let mentor = add({ name: "Mentor", uploader: true });
hub.setUploader(mentor.id, true); mentor = hub.member(mentor.id);
const coder = add({ name: "Coder", ombBotId: "coder-omb", wake: true });
const dev = add({ name: "Dev", ombBotId: "dev-omb", wake: true, machine: "laptop1", wakeVia: "poll" });
const guestbot = add({ name: "Guestbot-proto" });
const hooky = add({ name: "Hooky", wake: true });
writeFileSync(join(dir, "wake-hooks.json"), JSON.stringify({ "coder-omb": { endpoint: "general-ep", secret: "s1", rooms: { classroom: { endpoint: "class-ep", secret: "s2" } } } }));
writeFileSync(join(dir, "wake-webhooks.json"), JSON.stringify({ [hooky.id]: { url: "https://hooks.example.com/x", header: null, value: null } }));
const sent = [];
waker.webhooks.fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body)); return new Response(sent.length && JSON.parse(init.body).part === JSON.parse(init.body).parts ? JSON.stringify({ reply: "Hooky saved it" }) : "ok", { status: 200 }); };

console.log("helpers");
const content = "---\nname: debug-like-a-pro\ndescription: test\n---\n" + Array.from({ length: 120 }, (_, i) => `Line ${i}: ${"x".repeat(20)} ünïcode ✓`).join("\n") + "\n";
const parts = chunkText(content, 1000);
ok(parts.join("") === content && parts.length > 2 && parts.every((p) => p.length <= 1000), `chunkText splits into ${parts.length} parts that join back exactly`);
ok(savePath({ name: "debug-like-a-pro-SKILL.md", content }).path === "debug-like-a-pro/SKILL.md", "skill file saves as <name>/SKILL.md");
ok(savePath({ name: "lesson-01.md", content: "hi" }).path === "class-notes/lesson-01.md", "other notes save under class-notes/");

console.log("quiz keys");
const quiz = hub.attachGated(mentor, "classroom", { name: "lesson-01-quiz-key.md", content: "answers" }).file;
let err; try { hub.grantFile(alice, quiz.id, ["Coder"]); } catch (e) { err = e; }
ok(err?.status === 400 && /quiz/i.test(err.message), "granting a quiz key is refused");

console.log("grant → delivery");
const f = hub.attachGated(mentor, "classroom", { name: "debug-like-a-pro-SKILL.md", content }).file;
const g = hub.grantFile(null, f.id, ["Coder", "Dev", "Guestbot-proto", "Hooky"]);
ok(g.delivering?.length === 4, "a new grant queues delivery for each bot");
waker.processNoteDeliveries();
await Promise.all([...waker.queues.values()]);
const dels = Object.fromEntries(hub.noteDeliveries({ fileId: f.id }).map((d) => [d.member, d]));
const dmOf = (m) => db.prepare("SELECT x.* FROM messages x JOIN rooms r ON r.id = x.room_id WHERE r.kind = 'dm' AND x.via = 'notes' AND x.room_id IN (SELECT room_id FROM room_roster WHERE member_id = ?) ORDER BY x.id DESC").get(m.id);
const tokenOf = (m) => /\/n\/([A-Za-z0-9_-]+)\//.exec(dmOf(m)?.text ?? "")?.[1];

// Coder: tool runs on her #classroom trigger, parts in order, joined back exactly
const adaRuns = runs.filter((r) => r.path === "/hooks/class-ep");
const extract = (t) => { const m = /<<<NOTES-([0-9a-f]+) part \d+\/\d+\n([\s\S]*)\nNOTES-\1>>>/.exec(t); return m ? m[2] : null; };
ok(adaRuns.length === parts.length, `Coder got ${adaRuns.length} tool runs (one per part) on her #classroom trigger`);
ok(adaRuns.map((r) => extract(r.body)).join("") === content, "Coder's parts join back to the whole file");
ok(/part 1 of \d+/.test(adaRuns[0].body) && /debug-like-a-pro\/SKILL\.md/.test(adaRuns[0].body), "parts are numbered and name the save path");
ok(dels.Coder?.status === "delivered" && dels.Coder.path === "tools", `Coder delivery: ${dels.Coder?.status} via ${dels.Coder?.path}`);
const adaReply = db.prepare("SELECT * FROM messages WHERE author_id = ? AND reply_to = ?").get(coder.id, dmOf(coder)?.id);
ok(adaReply && /SKILL\.md/.test(adaReply.text), "Coder's confirmation is posted in her DM, as a reply to the notes DM");
ok(dmOf(coder)?.author_id === mentor.id && !!tokenOf(coder), "the DM comes from the teacher (uploader) with a one-time link");
ok(!logs.some((l) => l.includes(tokenOf(coder))), "the link token never appears in logs");
ok(!JSON.stringify(db.prepare("SELECT * FROM note_links").all()).includes(tokenOf(coder)), "only the token's hash is stored");

// Webhook: parts in JSON with content + savePath, last reply posted in DM
ok(sent.length === parts.length && sent.map((b) => b.content).join("") === content && sent[0].event === "class_notes" && sent[0].file.savePath === "debug-like-a-pro/SKILL.md", "webhook bot gets every part, whole, with savePath");
ok(dels.Hooky?.status === "delivered", `Hooky (webhook) delivery: ${dels.Hooky?.status}`);

// Guestbot-proto: no wake path → DM + link only
ok(dels["Guestbot-proto"]?.status === "dm-only" && !!tokenOf(guestbot), "a bot with no wake path gets the DM with the link (and MCP pointers)");

// Dev (polled): one part at a time; answers finish the delivery
ok(dels.Dev?.status === "queued", "polled bot's parts are queued for its machine");
db.prepare("UPDATE members SET last_seen = ? WHERE id = ?").run(Date.now(), dev.id);
const got = [];
for (let i = 0; i < 20; i++) {
  const w = waker.pending(hub.member(dev.id), 3);
  if (!w.length) break;
  ok(w.length === 1, `pending gives one notes part at a time (round ${i + 1})`);
  ok(waker.pending(hub.member(dev.id), 3).length === 0, "the next part waits until this one is answered");
  got.push(extract(w[0].toolPrompt));
  const isLast = /part (\d+) of \1\]/.test(w[0].toolPrompt);
  waker.reply(hub.member(dev.id), w[0].id, { text: isLast ? "Saved debug-like-a-pro/SKILL.md" : "NO_REPLY" });
}
ok(got.join("") === content, `Dev's ${got.length} parts join back to the whole file`);
ok(hub.noteDeliveries({ fileId: f.id }).find((d) => d.member === "Dev")?.status === "delivered", "Dev's delivery finishes when the last part is answered");

console.log("one-time links");
const t = tokenOf(guestbot);
const first = hub.noteDownload(t, "1.2.3.4");
ok(first.content === content, "the link returns the whole file");
let e2; try { hub.noteDownload(t); } catch (e) { e2 = e; }
ok(e2?.status === 410, "a second use is refused (410)");
ok(hub.noteLinks(f.id).some((l) => l.state === "used" && l.used_ip === "1.2.3.4"), "use is logged (time and IP)");
let e3; try { hub.noteDownload("A".repeat(32)); } catch (e) { e3 = e; }
ok(e3?.status === 404, "an unknown token is 404");
const linkA = hub.noteLinks(f.id).find((l) => l.member === "Hooky");
hub.revokeNoteLink(linkA.id);
let e4; try { hub.noteDownload(tokenOf(hooky)); } catch (e) { e4 = e; }
ok(e4?.status === 410, "a revoked link is refused");
const fresh = hub.mintNoteLink(f.id, coder.id, null);
db.prepare("UPDATE note_links SET expires_at = ? WHERE id = ?").run(Date.now() - 1, fresh.id);
let e5; try { hub.noteDownload(fresh.token); } catch (e) { e5 = e; }
ok(e5?.status === 410 && /expired/.test(e5.message), "an expired link is refused");
const ivyLink = tokenOf(dev);
hub.grantFile(null, f.id, ["Dev"], false);
let e6; try { hub.noteDownload(ivyLink); } catch (e) { e6 = e; }
ok(e6?.status === 410, "revoking the grant kills the person's open links");

console.log("re-delivery");
const rd = hub.redeliverNotes(null, f.id, ["Coder", "Dev"]);
ok(rd.queued.length === 1 && rd.queued[0].name === "Coder" && rd.notGranted.includes("Dev"), "class-deliver only re-sends to members who still have the grant");

console.log("wake prompt no longer cuts the message that woke the bot");
const long = "Please read this. " + "y".repeat(3000) + " END-MARK";
const dm = hub.openDm(alice, coder);
const msg = hub.post(alice, dm.room, long, { silent: true });
const prompt = waker.prompt(coder, hub.room(dm.room), msg, false, false, true);
ok(prompt.includes("END-MARK"), "the waking message arrives whole");

srv.close();
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall passed");
process.exit(failures.length ? 1 : 0);
