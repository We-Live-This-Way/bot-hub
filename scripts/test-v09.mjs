#!/usr/bin/env node
// Temp-data tests for v0.9: group mentions, @class, DMs. No live network, no real wakes.
import "./test-env.mjs";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/db.js";
import { Hub, canGroupWake, canClassWake, neverGuestWake, CLASS_ATTEND_MS } from "../src/hub.js";
import { hookFor, isDmRoomName } from "../src/omb-runs.js";
import { Waker } from "../src/wake.js";

const dir = join(tmpdir(), `bot-hub-v09-test-${Date.now()}`);
mkdirSync(join(dir), { recursive: true, mode: 0o700 });
const db = openDb(join(dir, "hub.db"));
const hub = new Hub(db, dir);
process.env.BOT_HUB_ADMIN_NAME = "Alice";
hub.seed();

const failures = [];
const ok = (cond, msg) => { if (cond) console.log("  ok  " + msg); else { console.log("  FAIL " + msg); failures.push(msg); } };

// Rebuild admin as Alice (seed used env or default)
let alice = hub.members().find((m) => m.is_admin);
if (alice.name !== "Alice") {
  db.prepare("UPDATE members SET name = 'Alice', slug = 'alice' WHERE id = ?").run(alice.id);
  alice = hub.member("Alice");
}

const add = (name, { kind = "bot", role = "member", wake = true, guestWake = 0, slug } = {}) => {
  const r = hub.addMember({ name, kind, role, wake: role === "guest" ? false : wake });
  const m = hub.member(name);
  if (guestWake) db.prepare("UPDATE members SET guest_wake = 1 WHERE id = ?").run(m.id);
  return hub.member(name);
};

const mentor = add("Mentor", { kind: "bot" });
const chief = add("Chief", { kind: "bot" });
const lead = add("Lead", { kind: "bot" });
const coder = add("Coder", { kind: "bot" });
const dev = add("Dev", { kind: "bot" });
const seller = add("Seller", { kind: "bot" });
const visitor = add("Guestbot", { kind: "bot", role: "guest", wake: false });
// seed groups after members exist
hub.seedDefaultGroups();

console.log("groups");
const sales = hub.groups().find((g) => g.name === "sales");
const coders = hub.groups().find((g) => g.name === "coders");
ok(sales && sales.members.includes("Alice") && sales.members.includes("Seller"), "sales includes Alice and Seller");
ok(coders && coders.members.includes("Coder") && coders.members.includes("Dev"), "coders includes Coder and Dev");
ok(canGroupWake(alice) && canGroupWake(mentor) && canGroupWake(chief) && canGroupWake(lead), "Alice, Mentor, Chief, Lead can group-wake");
ok(!canGroupWake(coder) && !canGroupWake(seller) && !canGroupWake(visitor), "Coder, Seller, visitors cannot group-wake");
ok(canClassWake(alice) && canClassWake(mentor) && !canClassWake(chief) && !canClassWake(visitor), "@class only Alice and Mentor");
ok(neverGuestWake(coder) && neverGuestWake(seller) && !neverGuestWake(chief), "Coder and Seller are never visitor-wakeable");
let threw = false;
try { hub.addGroup("class"); } catch (e) { threw = e.status === 400; }
ok(threw, "cannot name a group 'class'");
threw = false;
try { hub.addGroup("Coder"); } catch (e) { threw = e.status === 409; }
ok(threw, "cannot name a group after a member");

console.log("group mentions");
hub.addRoom("tmp-group", "temp test", true);
const evs = [];
const rec = (ev) => evs.push(ev);
hub.listeners.add(rec);

const gpost = hub.post(alice, "tmp-group", "hey @sales and @Seller check this");
ok(gpost.mentions.includes("Seller") && gpost.mentions.filter((n) => n === "Seller").length === 1, "@sales + @Seller dedupes Seller");
ok(gpost.mentions.includes("Alice") === false, "author is not in mentions");
ok(!gpost.notice, "admin group mention has no refusal notice");
const last = evs.at(-1);
ok(last && last.mentions.some((m) => m.name === "Seller"), "listener sees Seller mention");

const adaPost = hub.post(coder, "tmp-group", "@sales hello from Coder");
ok(!adaPost.mentions.includes("Seller") && !adaPost.mentions.includes("Alice"), "Coder's @sales expands to no one");
ok(/staff/i.test(adaPost.notice || ""), "Coder gets a sender-only notice");

const visPost = hub.post(visitor, "tmp-group", "@coders please wake");
ok(!visPost.mentions.includes("Coder") && !visPost.mentions.includes("Dev"), "visitor @coders expands to no one");
ok(visPost.notice && /Nobody was woken/i.test(visPost.notice), "visitor gets a sender-only notice");

const reedPost = hub.post(chief, "tmp-group", "@coders ping");
ok(reedPost.mentions.includes("Coder") && reedPost.mentions.includes("Dev") && !reedPost.notice, "Chief can trigger @coders");

console.log("@class");
// classroom may already exist from seed rooms? SEED_ROOMS doesn't include classroom. Add it.
if (!hub.room("classroom")) hub.addRoom("classroom", "class", true);
// attendees: dev and guestbot posted recently, coder did not
hub.post(dev, "classroom", "here for class");
hub.post(visitor, "classroom", "visiting the class");
const classOk = hub.post(mentor, "classroom", "@class welcome");
ok(classOk.mentions.includes("Dev") && classOk.mentions.includes("Guestbot"), "@class includes recent posters (Dev, Guestbot)");
ok(!classOk.mentions.includes("Coder"), "@class does not include Coder (didn't post recently)");
ok(!classOk.notice, "Mentor @class has no notice");
const classDenied = hub.post(chief, "classroom", "@class from Chief");
ok(!classDenied.mentions.includes("Dev") && /instructors/i.test(classDenied.notice || ""), "Chief cannot use @class");
const classWrongRoom = hub.post(alice, "tmp-group", "@class in the wrong room");
ok(/#classroom/.test(classWrongRoom.notice || "") && !classWrongRoom.mentions.includes("Dev"), "@class outside classroom does not expand");

console.log("DMs");
const opened = hub.openDm(alice, "Dev");
ok(/^dm-\d+-\d+$/.test(opened.room) && opened.peer === "Dev" && opened.dm, "Alice can open a DM with Dev");
const again = hub.openDm(alice, "Dev");
ok(again.room === opened.room, "openDm is idempotent");
const msg = hub.post(alice, opened.room, "hello Dev, this is a private test on temp data");
ok(msg.dm && msg.id, "can post in a DM");
ok(hub.rooms(alice).every((r) => r.name !== opened.room), "DMs are not in rooms()");
ok(hub.dms(alice).some((d) => d.name === opened.room && d.peer === "Dev"), "DM appears in dms() for Alice");
ok(hub.dms(dev).some((d) => d.peer === "Alice"), "Dev sees the same DM");
ok(hub.dms(coder).every((d) => d.name !== opened.room), "Coder cannot see Alice-Dev DM");
threw = false;
try { hub.read(opened.room, { limit: 10 }, coder); } catch (e) { threw = e.status === 403; }
ok(threw, "Coder gets 403 reading someone else's DM");
ok(hub.rooms(alice, { personal: true }).every((r) => !r.dm), "rooms() never flags DMs");
threw = false;
try { hub.openDm(visitor, "Dev"); } catch (e) { threw = e.status === 403; }
ok(threw, "visitor-to-bot DM is blocked");
const toCourt = hub.openDm(visitor, "Alice");
ok(toCourt.peer === "Alice", "visitor can DM the human owner");
threw = false;
try { hub.addRoom("dm-1-2", "nope"); } catch (e) { threw = e.status === 400; }
ok(threw, "cannot create a regular room named dm-…");
threw = false;
try { hub.setRoomPrivate(opened.room, false); } catch (e) { threw = e.status === 400; }
ok(threw, "cannot un-private a DM");

// /clear in a DM
const clr = hub.personalClear(alice, opened.room);
ok(clr.clearedThrough >= msg.id, "personal /clear works in a DM");
ok(hub.read(opened.room, { personal: true, limit: 20 }, alice).messages.length === 0, "Alice's personal clear hides DM messages");
hub.personalUnclear(alice, opened.room);
ok(hub.read(opened.room, { personal: true, limit: 20 }, alice).messages.some((m) => m.id === msg.id), "/unclear restores them");
const all = hub.clearRoom(alice, opened.room);
ok(all.archived >= 1, "/clearall archives a DM");
ok(hub.read(opened.room, { limit: 20 }, dev).messages.every((m) => m.via === "system"), "after clearall Dev only sees the system line");
// restore so later reads aren't confusing
hub.unclearRoom(alice, opened.room);

console.log("waker + hookFor");
ok(isDmRoomName(opened.room) && !isDmRoomName("general"), "isDmRoomName");
const hooks = { "bot-coder": { endpoint: "wh_gen", secret: "s", rooms: { general: { endpoint: "wh_gen2", secret: "s2" } } } };
ok(hookFor(hooks, "bot-coder", "general").endpoint === "wh_gen2", "room hook preferred");
ok(hookFor(hooks, "bot-coder", opened.room) == null, "DM does not fall back to the general hook");
ok(hookFor(hooks, "bot-coder", "heads-of-staff").endpoint === "wh_gen", "unknown channel falls back to general");

// Waker: empty keys/hooks so enqueue records "skipped" or doesn't call network.
// We'll intercept record/enqueue.
const waker = new Waker(hub, { dataDir: dir, ombBase: "http://127.0.0.1:1", log: () => {} });
const log = [];
waker.record = (member, message, status, detail = "") => { log.push({ name: member.name, status, detail, id: message.id }); };
waker.wakeConfigured = (m) => !!m.wake && m.role !== "guest";
waker.enqueue = (member, room, message, depth, guestOrigin = false, ambient = false) => {
  log.push({ name: member.name, status: "enqueued", guestOrigin, ambient, room: room.name, id: message.id });
};

// member DM to bot should enqueue Dev
log.length = 0;
const dm2 = hub.post(alice, opened.room, "another private hello");
ok(log.some((x) => x.name === "Dev" && x.status === "enqueued" && !x.guestOrigin), "member-to-bot DM enqueues the bot");
ok(!log.some((x) => x.name === "Coder"), "DM does not enqueue Coder");

// visitor group tag must not enqueue
log.length = 0;
hub.post(visitor, "tmp-group", "@coders @Coder hey");
// @Coder is a direct mention from a visitor — Coder is neverGuestWake, guestOrigin true
const adaWake = log.filter((x) => x.name === "Coder");
ok(adaWake.length === 0 || adaWake.every((x) => x.status === "skipped"), "visitor @Coder does not enqueue Coder");
ok(!log.some((x) => x.name === "Dev" && x.status === "enqueued"), "visitor @coders does not enqueue Dev");

// Chief @coders enqueues Coder and Dev once
log.length = 0;
hub.post(chief, "tmp-group", "@coders @Dev hi");
const ivyHits = log.filter((x) => x.name === "Dev" && x.status === "enqueued");
const adaHits = log.filter((x) => x.name === "Coder" && x.status === "enqueued");
ok(ivyHits.length === 1 && adaHits.length === 1, "@coders + @Dev dedupes to one enqueue each");

// guest_wake cannot be turned on for Coder
threw = false;
try { hub.updateMember(coder.id, { guestWake: true }); } catch (e) { threw = e.status === 400; }
ok(threw && !hub.member("Coder").guest_wake, "cannot enable visitor wake for Coder");

// watch allowlist
threw = false;
try { hub.watchRead(opened.room); } catch (e) { threw = e.status === 404; }
ok(threw, "watchRead 404s for a DM");

console.log("done");
db.close();
rmSync(dir, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n${failures.length} failure(s):\n- ` + failures.join("\n- "));
  process.exit(1);
}
console.log("\nAll temp-data tests passed.");
