// Outbound wake webhooks: the hub POSTs a JSON mention note to a URL the bot's owner provided
// (any HTTPS incoming-webhook or an n8n/Zapier/Make-style catch hook), plus an optional auth header.
// Secrets live only in data/wake-webhooks.json (0600), never in the database or in logs.
import { existsSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

const FORBIDDEN_HEADERS = new Set([
  "host", "connection", "content-length", "content-type", "transfer-encoding", "te", "trailer",
  "upgrade", "keep-alive", "expect", "cookie", "cookie2", "set-cookie",
]);

const MAX_URL = 2000;
const MAX_HEADER = 64;
const MAX_VALUE = 500;
const TIMEOUT_MS = 20_000;

export const allowLocalWebhooks = () => process.env.BOT_HUB_WEBHOOK_ALLOW_LOCAL === "1";

export function redactUrl(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "") || "/";
    const parts = path.split("/").filter(Boolean);
    const shown = parts.length ? "/" + parts[0] + (parts.length > 1 ? "/…" : "") : "/";
    return `${u.protocol}//${u.host}${shown}`;
  } catch {
    return "(set)";
  }
}

export function publicHook(entry) {
  if (!entry?.url) return null;
  return { set: true, url: redactUrl(entry.url), header: entry.header || null };
}

function isPrivateIp(ip) {
  if (!ip) return true;
  const v = String(ip).replace(/^::ffff:/, "");
  if (isIP(v) === 0) return true;
  if (isIP(v) === 6) {
    const low = v.toLowerCase();
    if (low === "::1" || low === "::") return true;
    if (low.startsWith("fc") || low.startsWith("fd") || low.startsWith("fe80")) return true;
    return false;
  }
  const n = v.split(".").map((x) => Number(x));
  const a = (n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3];
  const u = a >>> 0;
  const inRange = (base, bits) => (u >>> (32 - bits)) === (base >>> (32 - bits));
  if (n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] === 224 || n[0] === 255) return true;
  if (n[0] === 169 && n[1] === 254) return true;
  if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true;
  if (n[0] === 192 && n[1] === 168) return true;
  if (n[0] === 100 && n[1] >= 64 && n[1] <= 127) return true; // CGNAT / many VPNs
  if (n[0] === 198 && (n[1] === 18 || n[1] === 19)) return true;
  return false;
}

export function parseHookInput({ url, header, value } = {}) {
  url = String(url ?? "").trim();
  if (!url) throw httpError(400, "Paste the incoming-webhook URL your bot platform gave you");
  if (url.length > MAX_URL) throw httpError(400, "That URL is too long");
  let u;
  try { u = new URL(url); } catch { throw httpError(400, "That doesn't look like a URL"); }
  const localOk = allowLocalWebhooks() && (u.hostname === "127.0.0.1" || u.hostname === "localhost");
  if (u.protocol === "http:") {
    if (!localOk) throw httpError(400, "Wake webhooks must be HTTPS URLs");
  } else if (u.protocol !== "https:") throw httpError(400, "Wake webhooks must be HTTPS URLs");
  if (u.username || u.password) throw httpError(400, "Don't put a username or password in the URL; use the optional auth header instead");
  if (u.hostname === "localhost" && !localOk) throw httpError(400, "That URL isn't allowed");
  if (isIP(u.hostname) && isPrivateIp(u.hostname) && !localOk) throw httpError(400, "That URL isn't allowed");

  header = header == null || header === "" ? null : String(header).trim();
  value = value == null || value === "" ? null : String(value);
  if (header) {
    if (!/^[A-Za-z0-9-]{1,64}$/.test(header) || header.length > MAX_HEADER) throw httpError(400, "Header name: letters, numbers and dashes only");
    if (FORBIDDEN_HEADERS.has(header.toLowerCase()) || header.toLowerCase() === "content-type" || header.toLowerCase() === "content-length" || header.toLowerCase() === "host") {
      throw httpError(400, "That header name can't be used here");
    }
    if (value == null) throw httpError(400, "Add the header value, or clear the header name");
    if (String(value).length > MAX_VALUE) throw httpError(400, "That header value is too long");
  } else value = null;
  return { url: u.toString(), header, value };
}

async function assertPublicHost(url) {
  const u = new URL(url);
  if (allowLocalWebhooks() && (u.hostname === "127.0.0.1" || u.hostname === "localhost")) return;
  if (isIP(u.hostname)) {
    if (isPrivateIp(u.hostname)) throw httpError(400, "That URL isn't allowed");
    return;
  }
  let addrs;
  try { addrs = await lookup(u.hostname, { all: true, verbatim: true }); }
  catch { throw httpError(400, "Couldn't resolve that webhook host"); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw httpError(400, "That URL isn't allowed");
}

export class WakeWebhooks {
  constructor(dataDir, { fetchImpl = fetch, lookupHost = assertPublicHost } = {}) {
    this.file = join(dataDir, "wake-webhooks.json");
    this.fetchImpl = fetchImpl;
    this.lookupHost = lookupHost;
  }
  all() {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : {}; } catch { return {}; }
  }
  save(data) {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch {}
  }
  get(memberId) { return this.all()[String(memberId)] ?? null; }
  public(memberId) { return publicHook(this.get(memberId)); }

  async set(memberId, input) {
    const parsed = parseHookInput(input);
    await this.lookupHost(parsed.url);
    const data = this.all();
    data[String(memberId)] = parsed;
    this.save(data);
    return publicHook(parsed);
  }
  clear(memberId) {
    const data = this.all();
    if (!(String(memberId) in data)) return { set: false };
    delete data[String(memberId)];
    this.save(data);
    return { set: false };
  }

  /** POST the mention note. Returns { status: "replied"|"delivered"|"http N"|"error", reply?, detail? }. Never throws for a failed delivery. */
  async deliver(hook, body) {
    if (!hook?.url) return { status: "skipped", detail: "no webhook" };
    const headers = { "content-type": "application/json", "user-agent": "bot-hub" };
    if (hook.header && hook.value != null) headers[hook.header] = hook.value;
    let res;
    try {
      res = await this.fetchImpl(hook.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      const detail = e?.name === "TimeoutError" || e?.name === "AbortError" ? "timed out" : "could not reach the webhook";
      return { status: "error", detail };
    }
    const raw = await res.text().catch(() => "");
    if (res.status < 200 || res.status >= 300) return { status: `http ${res.status}`, detail: raw.slice(0, 120) };
    const reply = parseReply(raw);
    if (reply) return { status: "replied", reply };
    return { status: "delivered" };
  }
}

function parseReply(raw) {
  const t = String(raw ?? "").trim();
  if (!t || /^NO_REPLY\b/i.test(t)) return null;
  try {
    const j = JSON.parse(t);
    const text = j.reply ?? j.text ?? j.message ?? null;
    if (typeof text === "string" && text.trim() && !/^NO_REPLY\b/i.test(text.trim())) return text.trim();
    return null;
  } catch {
    // plain text body is treated as a reply only if it doesn't look like HTML or an empty JSON ack
    if (t.startsWith("<") || t === "ok" || t === "OK" || t === "{}" || t === "true") return null;
    if (t.length > 8000) return t.slice(0, 8000);
    return t;
  }
}

export { parseReply, isPrivateIp, assertPublicHost, TIMEOUT_MS };
