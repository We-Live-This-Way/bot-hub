#!/usr/bin/env node
// Gives each listed bot a "Bot Hub wake-ups" webhook trigger in OpenMausBot (webhooks.json), so hub wake-ups run with
// the bot's normal tools (see src/omb-runs.js). Run it with OpenMausBot STOPPED (it only reads webhooks.json at start).
//   node omb-tool-hooks.js --omb-dir ~/.openmausbot --out data/wake-hooks.json [--rooms general,heads-of-staff,...] <botId>=<Name> ...
// v0.8: every trigger it writes has sameConversation on, so its runs continue one OpenMausBot conversation. With --rooms,
// each bot also gets one trigger per listed hub room ("Bot Hub wake-ups (Name) · #general"): one conversation per room.
// Secrets go only to --out (0600) as { botId: { endpoint, secret, name } }; webhooks.json keeps their SHA-256.
// Re-running rotates the secret of an existing hub trigger instead of adding another. Prints names and ids only.
import { readFileSync, writeFileSync, existsSync, copyFileSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HOOK_NAME, hookInstructions, roomHookName, roomInstructions } from "../src/omb-runs.js";

const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const dir = resolve(opt("--omb-dir") || join(process.env.HOME, ".openmausbot"));
const out = resolve(opt("--out") || "wake-hooks.json");
const port = opt("--port") || "8800";
const rooms = (opt("--rooms") || "").split(",").map((r) => r.trim().toLowerCase()).filter((r) => /^[a-z0-9-]{1,40}$/.test(r));
const bots = args.map((a) => a.split("=")).filter(([id, name]) => id && name);
if (!bots.length) { console.error("usage: omb-tool-hooks.js --omb-dir DIR --out FILE <botId>=<Name> ..."); process.exit(2); }

const up = await fetch(`http://127.0.0.1:${port}/hooks/health`, { signal: AbortSignal.timeout(3000) }).then(() => true, () => false);
if (up) { console.error(`OpenMausBot is running (port ${port} answers): stop it first, then run this again.`); process.exit(1); }

const file = join(dir, "webhooks.json");
const data = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { version: 1, webhooks: [], deliveries: [] };
if (existsSync(file)) copyFileSync(file, `${file}.bak-hubhooks-${Date.now()}`);
const known = existsSync(join(dir, "bots.json")) ? JSON.parse(readFileSync(join(dir, "bots.json"), "utf8")) : null;
const ids = new Set((Array.isArray(known) ? known : known?.bots ?? []).map((b) => b.id));
const saved = existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : {};
const now = Date.now();
const fresh = () => { const secret = `hubwh_${randomBytes(32).toString("base64url")}`; return { secret, secretHash: createHash("sha256").update(secret).digest("hex") }; };
/** Finds the trigger called `title` for the bot (or makes it), points it at `prompt`, rotates its secret; returns { endpoint, secret }. */
function upsert(botId, title, prompt, match) {
  const { secret, secretHash } = fresh();
  let t = data.webhooks.find((w) => w.botId === botId && w.name === title) ?? (match ? data.webhooks.find((w) => w.botId === botId && match(w.name)) : null);
  if (t) {
    Object.assign(t, { name: title, prompt, secretHash, enabled: true, verificationPending: false, sameConversation: true, updatedAt: now });
    delete t.sealedSecret;
  } else {
    t = { id: randomUUID(), endpointId: `wh_${randomBytes(18).toString("base64url")}`, name: title, prompt,
      botId, runOn: "maus", delivery: "run", enabled: true, verificationPending: false, sameConversation: true, createdAt: now, updatedAt: now, deliveryCount: 0, secretHash };
    data.webhooks.unshift(t);
  }
  return { endpoint: t.endpointId, secret };
}
for (const [botId, name] of bots) {
  if (ids.size && !ids.has(botId)) { console.log(`skip ${name}: no bot ${botId} in bots.json`); continue; }
  const main = upsert(botId, `${HOOK_NAME} (${name})`, hookInstructions(name), (n) => n.startsWith(HOOK_NAME) && !n.includes(" · #"));
  const byRoom = {};
  for (const room of rooms) byRoom[room] = upsert(botId, roomHookName(name, room), roomInstructions(name, room));
  saved[botId] = { ...main, name, ...(rooms.length ? { rooms: byRoom } : {}) };
  console.log(`${name}\t${botId}\t${main.endpoint}${rooms.length ? `\t+${rooms.length} room trigger(s)` : ""}`);
}
writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2), { mode: 0o600 }); renameSync(`${file}.tmp`, file);
writeFileSync(`${out}.tmp`, JSON.stringify(saved, null, 2), { mode: 0o600 }); renameSync(`${out}.tmp`, out);
