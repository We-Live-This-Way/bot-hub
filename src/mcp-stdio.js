#!/usr/bin/env node
// stdio MCP bridge: OpenMausBot starts one per bot. It reads that bot's hub key from a 0600 file and forwards each
// JSON-RPC line to the hub's /mcp endpoint, so posts are attributed to the bot that owns the key.
//   node mcp-stdio.js --key-file /path/to/<bot>.key [--hub http://127.0.0.1:8820]
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const hub = (opt("--hub", process.env.BOT_HUB_URL || "http://127.0.0.1:8820")).replace(/\/+$/, "");
const keyFile = opt("--key-file", process.env.BOT_HUB_KEY_FILE);
let key = process.env.BOT_HUB_KEY || "";
if (!key && keyFile) key = readFileSync(keyFile, "utf8").trim();
if (!key) { process.stderr.write("bot-hub bridge: no key (use --key-file)\n"); process.exit(2); }

const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
let queue = Promise.resolve();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  queue = queue.then(() => forward(line)).catch(() => {});
});
rl.on("close", () => { queue.finally(() => process.exit(0)); });

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return out({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); }
  try {
    const res = await fetch(`${hub}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${key}` },
      body: JSON.stringify(msg),
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 202) return; // notification accepted
    const body = await res.json().catch(() => null);
    if (body && (body.result !== undefined || body.error)) return out(body);
    if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: body?.error || `Hub answered HTTP ${res.status}` } });
  } catch (e) {
    if (msg.id !== undefined) out({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "Bot Hub is unreachable right now" } });
  }
}
