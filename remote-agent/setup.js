#!/usr/bin/env node
// Connects this machine's OpenMausBot bots to Bot Hub. Run ONLY while OpenMausBot is closed (it edits
// ~/.openmausbot/config.json and bot-api.json; back them up first).
//   node setup.js [--tools] [--no-wake] [--new-hub-key] [<bot name>...]   (default: every bot in bots.json)
// For each bot: a hub key in keys/<slug>.key (kept if it exists), a fresh OpenMausBot Bot API key in wake/<slug>.key
// (its hash goes into bot-api.json, the record the app's "Turn on" writes), and with --tools an MCP server "hub-<slug>"
// in config.json scoped to that bot. Writes agent.json. Prints names, ids and the SHA-256 of each hub key, never keys.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const OMB = process.env.OMB_DATA || join(homedir(), ".openmausbot");
const HUB = process.env.BOT_HUB_URL || (() => { console.error("Set BOT_HUB_URL to your hub, e.g. https://hub.example.com"); process.exit(1); })();
const args = process.argv.slice(2);
const tools = args.includes("--tools"), wake = !args.includes("--no-wake"), newHub = args.includes("--new-hub-key");
const names = args.filter((a) => !a.startsWith("--"));
const sha = (s) => createHash("sha256").update(s).digest("hex");
const slugify = (n) => String(n).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "member";
const secret = (f, v) => { writeFileSync(f, v + "\n", { mode: 0o600 }); chmodSync(f, 0o600); };
for (const d of [DIR, join(DIR, "keys"), join(DIR, "wake")]) { mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700); }

const bots = JSON.parse(readFileSync(join(OMB, "bots.json"), "utf8"));
const cfgFile = join(OMB, "config.json");
const config = JSON.parse(readFileSync(cfgFile, "utf8"));
const cfgMode = statSync(cfgFile).mode & 0o777;
const apiFile = join(OMB, "bot-api.json");
const api = existsSync(apiFile) ? JSON.parse(readFileSync(apiFile, "utf8")) : { version: 1, bots: [], attempts: [] };
config.mcpServers ??= {};
const chosen = names.length ? bots.filter((b) => names.some((n) => n.toLowerCase() === b.name.toLowerCase() || n === b.id)) : bots;
const agentBots = [];
for (const bot of chosen) {
  const slug = slugify(bot.name);
  const hubKeyFile = join(DIR, "keys", `${slug}.key`);
  if (newHub || !existsSync(hubKeyFile)) secret(hubKeyFile, `hub_${randomBytes(32).toString("base64url")}`);
  const hubKey = readFileSync(hubKeyFile, "utf8").trim();
  const server = `hub-${slug}`.slice(0, 32);
  if (tools) config.mcpServers[server] = { command: process.execPath, args: [join(DIR, "mcp-bridge.js"), "--key-file", hubKeyFile, "--hub", HUB], env: {}, enabled: true, bot: bot.id };
  else delete config.mcpServers[server];
  if (wake) {
    const key = `bak_${randomBytes(32).toString("base64url")}`, now = Date.now();
    const rec = api.bots.find((r) => r.botId === bot.id);
    if (rec) Object.assign(rec, { keyHash: sha(key), keyCreatedAt: now });
    else api.bots.unshift({ botId: bot.id, keyHash: sha(key), createdAt: now, keyCreatedAt: now, callCount: 0 });
    secret(join(DIR, "wake", `${slug}.key`), key);
  }
  agentBots.push({ name: bot.name, slug, botId: bot.id });
  console.log(`BOT\t${bot.name}\t${bot.id}\t${sha(hubKey)}\t${tools ? server : "no-tools"}`);
}
writeFileSync(cfgFile, JSON.stringify(config, null, 2) + "\n", { mode: cfgMode || 0o600 });
if (wake) writeFileSync(apiFile, JSON.stringify(api, null, 2) + "\n", { mode: 0o600 });
const agentFile = join(DIR, "agent.json");
const prev = existsSync(agentFile) ? JSON.parse(readFileSync(agentFile, "utf8")).bots : [];
const merged = [...prev.filter((p) => !agentBots.some((b) => b.botId === p.botId)), ...agentBots];
writeFileSync(agentFile, JSON.stringify({ hub: HUB, omb: "http://127.0.0.1:8800", bots: merged }, null, 2) + "\n", { mode: 0o600 });
