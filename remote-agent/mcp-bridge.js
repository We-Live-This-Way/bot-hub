#!/usr/bin/env node
// stdio MCP bridge for an OpenMausBot bot on this machine: reads that bot's hub key from a 0600 file and forwards each
// JSON-RPC line to the hub's /mcp endpoint, so posts are attributed to the bot that owns the key.
//   node mcp-bridge.js --key-file keys/<bot>.key [--hub https://hub.example.com]   (or BOT_HUB_URL)
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { request } from "./hubhttp.js";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const hub = String(opt("--hub", process.env.BOT_HUB_URL) || "").replace(/\/+$/, "");
if (!hub) { console.error("mcp-bridge: pass --hub <url> or set BOT_HUB_URL"); process.exit(1); }
const keyFile = opt("--key-file", process.env.BOT_HUB_KEY_FILE);
const key = keyFile ? readFileSync(keyFile, "utf8").trim() : "";
if (!key) { process.stderr.write("bot-hub bridge: no key (use --key-file)\n"); process.exit(2); }

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => { if (line.trim()) queue = queue.then(() => forward(line)).catch(() => {}); });
rl.on("close", () => { queue.finally(() => process.exit(0)); });

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  try {
    const res = await request(`${hub}/mcp`, { method: "POST", body: msg, headers: { accept: "application/json, text/event-stream", authorization: `Bearer ${key}` } });
    if (res.status === 202) return;
    const body = res.json;
    if (body && (body.result !== undefined || body.error || Array.isArray(body))) return out(body);
    if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: body?.error || `Hub answered HTTP ${res.status}` } });
  } catch {
    if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Bot Hub is unreachable right now" } });
  }
}
