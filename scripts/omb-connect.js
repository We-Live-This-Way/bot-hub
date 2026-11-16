#!/usr/bin/env node
// Connects OpenMausBot bots on this machine to the hub. Run ONLY while openmausbot.service is stopped (it rewrites
// ~/.openmausbot/config.json and ~/.openmausbot/bot-api.json; back both up first).
//   node scripts/omb-connect.js <bot name> [<bot name>...] [--no-tools] [--no-wake]
// For each bot:
//   1. a hub member with a managed key (data/keys/<slug>.key, 0600)
//   2. a per-bot stdio MCP server "hub-<slug>" in config.json mcpServers, scoped with "bot": <id> so only that bot gets it
//      (skipped with --no-tools)
//   3. the bot's OpenMausBot Bot API switched on with a fresh key (stored hashed in bot-api.json, the same record the
//      app's "Turn on" writes); the plain key goes to data/wake-keys.json (0600) so the hub can wake the bot
//      (skipped with --no-wake)
// Prints names and ids only, never keys.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb } from "../src/db.js";
import { Hub, writeSecret } from "../src/hub.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = resolve(process.env.BOT_HUB_DATA || join(ROOT, "data"));
const OMB = process.env.OMB_DATA || join(homedir(), ".openmausbot");
const NODE = process.execPath;
const args = process.argv.slice(2);
const names = args.filter((a) => !a.startsWith("--"));
const tools = !args.includes("--no-tools"), wake = !args.includes("--no-wake");

const bots = JSON.parse(readFileSync(join(OMB, "bots.json"), "utf8"));
const config = JSON.parse(readFileSync(join(OMB, "config.json"), "utf8"));
const apiFile = join(OMB, "bot-api.json");
const api = existsSync(apiFile) ? JSON.parse(readFileSync(apiFile, "utf8")) : { version: 1, bots: [], attempts: [] };
const wakeFile = join(DATA, "wake-keys.json");
const wakeKeys = existsSync(wakeFile) ? JSON.parse(readFileSync(wakeFile, "utf8")) : {};
const db = openDb(join(DATA, "hub.db"));
const hub = new Hub(db, DATA);
hub.seed();
config.mcpServers ??= {};

for (const name of names) {
  const bot = bots.find((b) => b.name.toLowerCase() === name.toLowerCase() || b.id === name);
  if (!bot) { console.error(`no OpenMausBot bot named ${name}`); process.exitCode = 1; continue; }
  let member = hub.member(bot.name);
  if (!member) { hub.addMember({ name: bot.name, ombBotId: bot.id, wake, managed: true }); member = hub.member(bot.name); }
  else hub.updateMember(member.id, { ombBotId: bot.id, wake });
  if (!member.managed_key) {
    db.prepare("UPDATE members SET managed_key = 1 WHERE id = ?").run(member.id);
    hub.rotateKey(member.id); member = hub.member(member.id);
  }
  const server = `hub-${member.slug}`.slice(0, 32);
  if (tools) {
    config.mcpServers[server] = { command: NODE, args: [join(ROOT, "src", "mcp-stdio.js"), "--key-file", join(DATA, "keys", `${member.slug}.key`)], env: {}, enabled: true, bot: bot.id };
  } else delete config.mcpServers[server];
  if (wake) {
    const key = `bak_${randomBytes(32).toString("base64url")}`;
    const now = Date.now();
    const hash = createHash("sha256").update(key).digest("hex");
    const existing = api.bots.find((r) => r.botId === bot.id);
    if (existing) Object.assign(existing, { keyHash: hash, keyCreatedAt: now });
    else api.bots.unshift({ botId: bot.id, keyHash: hash, createdAt: now, keyCreatedAt: now, callCount: 0 });
    wakeKeys[bot.id] = key;
  }
  console.log(`${bot.name} (${bot.id}): hub member #${member.id}${tools ? `, MCP server ${server}` : ", no MCP tools"}${wake ? ", wake on" : ""}`);
}
writeFileSync(join(OMB, "config.json"), JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
if (wake) { writeFileSync(apiFile, JSON.stringify(api, null, 2) + "\n", { mode: 0o600 }); writeSecret(wakeFile, JSON.stringify(wakeKeys, null, 2) + "\n"); }
db.close();
