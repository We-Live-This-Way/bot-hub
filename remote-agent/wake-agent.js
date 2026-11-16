#!/usr/bin/env node
// Bot Hub wake agent: lets this machine's OpenMausBot bots answer @mentions on the hub without opening any port.
// For each bot it asks the hub (with that bot's own key) for mentions waiting for it, hands each one to the bot through
// OpenMausBot's local Bot API (127.0.0.1, bearer key per bot), and sends the bot's answer back; the hub posts it as
// that bot. Keys live in keys/ (hub) and wake/ (Bot API), all 0600. Logs names and statuses only, never keys.
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "./hubhttp.js";
import { startHookRun, waitRun, runReply } from "./omb-runs.js";

const DIR = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(DIR, "agent.json"), "utf8"));
const HUB = cfg.hub.replace(/\/+$/, "");
const OMB = (cfg.omb || "http://127.0.0.1:8800").replace(/\/+$/, "");
const EVERY_MS = 4000, OMB_POLL_MS = 10_000, OMB_MAX_MS = 8 * 60_000;
const statePath = join(DIR, "state.json");
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { threads: {} };
const saveState = () => { writeFileSync(statePath + ".tmp", JSON.stringify(state, null, 2), { mode: 0o600 }); renameSync(statePath + ".tmp", statePath); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readKey = (f) => (existsSync(f) ? readFileSync(f, "utf8").trim() : "");
const OMB_DIR = cfg.ombDir || join(process.env.HOME || "", ".openmausbot");
// Tool wake-ups (v0.6): wake-hooks.json { botId: { endpoint, secret } } from omb-tool-hooks.js. The Bot API runs fenced
// (no tools), so the hub's admin/member wake-ups go to each bot's webhook trigger instead; visitor ones never do.
const hooks = () => { try { return JSON.parse(readFileSync(join(DIR, "wake-hooks.json"), "utf8")); } catch { return {}; } };

async function askBotWithTools(bot, w, hook, key) {
  const start = await startHookRun(OMB, hook, w.toolPrompt, `hub-${w.messageId}-${bot.slug}`);
  if (start.status !== 202 || !start.body?.runId) return { status: `hook ${start.status}` };
  const run = await waitRun(OMB_DIR, start.body.runId, {
    onSlow: w.ambient ? null : () => request(`${HUB}/api/wake/${w.id}/progress`, { method: "POST", body: {}, headers: { authorization: `Bearer ${key}` } }).catch(() => {}),
  });
  if (run.status !== "completed") return { status: `run ${run.status}`.slice(0, 40) };
  const r = runReply(OMB_DIR, run);
  console.log(`${bot.name}: tool run ${run.id} finished${r.tools === null ? "" : ` (${r.tools} tool step(s))`}`);
  return { text: r.text };
}

async function omb(bot, path, init = {}) {
  const res = await fetch(`${OMB}/hooks/api/bots/${encodeURIComponent(bot.botId)}/messages${path}`, {
    ...init, headers: { "content-type": "application/json", authorization: `Bearer ${readKey(join(DIR, "wake", `${bot.slug}.key`))}` },
    signal: AbortSignal.timeout(init.method === "POST" ? 200_000 : 30_000),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function askBot(bot, w) {
  const threads = (state.threads[bot.botId] ??= {});
  const saved = threads[w.room];
  const body = { message: w.prompt, wait: 150 };
  let res = await omb(bot, "", { method: "POST", body: JSON.stringify(saved ? { ...body, thread: saved } : body) });
  if (saved && (res.status === 404 || res.status === 409)) res = await omb(bot, "", { method: "POST", body: JSON.stringify(body) });
  if (res.body?.thread && res.body.thread !== saved) { threads[w.room] = res.body.thread; saveState(); }
  const start = Date.now();
  while (res.status === 202 && res.body?.status === "working" && Date.now() - start < OMB_MAX_MS) {
    await sleep(OMB_POLL_MS);
    const thread = res.body.thread ?? threads[w.room];
    const r = await omb(bot, `?thread=${encodeURIComponent(thread)}`);
    res = r.status === 200 ? r : r.body?.status === "needs_approval" ? { status: 202, body: r.body } : r.status === 202 ? { status: 202, body: { status: "working", thread } } : r;
  }
  if (res.status === 200) return { text: String(res.body.reply ?? "") };
  if (res.status === 202) return { status: res.body?.status === "needs_approval" ? "needs approval" : "still working" };
  return { status: `bot api ${res.status}` };
}

async function runBot(bot) {
  let delay = EVERY_MS;
  for (;;) {
    const key = readKey(join(DIR, "keys", `${bot.slug}.key`));
    try {
      const r = await request(`${HUB}/api/wake/pending`, { headers: { authorization: `Bearer ${key}` } });
      if (r.status === 401 || r.status === 403) { if (delay !== 60_000) console.log(`${bot.name}: hub says ${r.status} (${r.json?.error ?? ""}); retrying every minute`); delay = 60_000; }
      else if (r.status !== 200) { delay = Math.min(delay * 2, 60_000); console.log(`${bot.name}: hub answered ${r.status}`); }
      else {
        if (delay !== EVERY_MS) console.log(`${bot.name}: connected to the hub`);
        delay = EVERY_MS;
        for (const w of r.json.wakes ?? []) {
          console.log(`${bot.name}: mentioned by ${w.author} in #${w.room} (message ${w.messageId})`);
          let answer;
          const hook = w.tools && w.toolPrompt ? hooks()[bot.botId] : null;
          try { answer = hook ? await askBotWithTools(bot, w, hook, key) : await askBot(bot, w); } catch (e) { answer = { status: "bot api unreachable" }; console.log(`${bot.name}: OpenMausBot error: ${e.message}`); }
          const p = await request(`${HUB}/api/wake/${w.id}/reply`, { method: "POST", body: answer, headers: { authorization: `Bearer ${key}` } }).catch((e) => ({ status: 0, json: { error: e.message } }));
          console.log(`${bot.name}: ${p.status === 200 ? (p.json?.posted ? `replied in #${w.room}` : `no reply (${answer.status ?? "NO_REPLY"})`) : `couldn't send the reply (${p.status} ${p.json?.error ?? ""})`}`);
        }
      }
    } catch (e) {
      delay = Math.min(delay * 2, 60_000);
      console.log(`${bot.name}: hub unreachable (${e.code || e.message}); retry in ${Math.round(delay / 1000)}s`);
    }
    await sleep(delay);
  }
}

console.log(`bot-hub wake agent: ${cfg.bots.map((b) => b.name).join(", ")} → ${HUB}`);
cfg.bots.forEach((b, i) => setTimeout(() => runBot(b), i * 500));
