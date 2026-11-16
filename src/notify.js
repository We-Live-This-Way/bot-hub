// Phone notifications for join requests through ntfy.sh. The topic is the only "secret" (anyone who knows it can read
// the pushes), so it lives in data/ntfy.json (0600), is shown only to the admin, and pushes carry no keys or claim codes.
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const SERVER = "https://ntfy.sh";
const MIN_GAP_MS = 60_000;          // at most one join-request push a minute
import { PUBLIC_URL } from "./hub.js";

export class Notifier {
  constructor(dataDir, log = console.log) { this.file = join(dataDir, "ntfy.json"); this.log = log; this.last = 0; this.skipped = 0; }
  topic() {
    try { const t = JSON.parse(readFileSync(this.file, "utf8")).topic; if (/^[A-Za-z0-9_-]{24,64}$/.test(t)) return t; } catch {}
    return this.rotate();
  }
  rotate() {
    const topic = `bothub-${randomBytes(24).toString("base64url")}`;
    writeFileSync(`${this.file}.tmp`, JSON.stringify({ topic, createdAt: new Date().toISOString() }, null, 2) + "\n", { mode: 0o600 });
    renameSync(`${this.file}.tmp`, this.file);
    return topic;
  }
  links() {
    const t = this.topic();
    return { app: `ntfy://ntfy.sh/${t}`, web: `${SERVER}/${t}` };
  }
  async push({ title, body, tags = "robot", click = `${PUBLIC_URL}/`, priority = "default" }) {
    const res = await fetch(`${SERVER}/${this.topic()}`, {
      method: "POST", body: String(body).slice(0, 400),
      headers: { Title: String(title).replace(/[^\x20-\x7E]/g, "").slice(0, 120), Tags: tags, Click: click, Priority: priority, "content-type": "text/plain; charset=utf-8" },
      signal: AbortSignal.timeout(10_000),
    });
    return res.status;
  }
  /** A new (real, non-honeypot) join request. Fire and forget; rate limited, extras are counted into the next push. */
  joinRequest(name, platform) {
    const now = Date.now();
    if (now - this.last < MIN_GAP_MS) { this.skipped++; this.log("ntfy: join push skipped (rate limit)"); return; }
    this.last = now;
    const more = this.skipped ? ` (+${this.skipped} more since the last alert)` : "";
    this.skipped = 0;
    const who = String(name).replace(/[\r\n]+/g, " ").slice(0, 40);
    const type = platform ? String(platform).replace(/[\r\n]+/g, " ").slice(0, 30) : "unknown type";
    this.push({ title: "Hub join request", body: `${who} (${type}) wants to join${more}`, tags: "robot,wave", click: `${PUBLIC_URL}/#requests` })
      .then((s) => this.log(`ntfy: join push ${s}`), (e) => this.log(`ntfy: join push failed (${e.code || e.name})`));
  }
  test() { return this.push({ title: "Hub test ping", body: "Bot Hub phone notifications are working.", tags: "white_check_mark" }); }
}
