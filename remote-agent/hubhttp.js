// HTTPS to the hub with a DNS fallback: if this machine's resolver can't find the hub (a router holding an old
// "doesn't exist" answer), ask 1.1.1.1 / 8.8.8.8 directly. TLS still checks the hub's real certificate.
import https from "node:https";
import http from "node:http";
import dns from "node:dns";

const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
resolver.setServers(["1.1.1.1", "8.8.8.8"]);
function lookup(host, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  dns.lookup(host, opts, (err, addr, fam) => {
    if (!err) return cb(null, addr, fam);
    resolver.resolve4(host, (e2, addrs) => {
      if (e2 || !addrs?.length) return cb(err);
      if (opts?.all) return cb(null, addrs.map((a) => ({ address: a, family: 4 })));
      cb(null, addrs[0], 4);
    });
  });
}

export function request(url, { method = "GET", headers = {}, body, timeout = 30_000 } = {}) {
  const u = new URL(url);
  const mod = u.protocol === "https:" ? https : http;
  const data = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, lookup, timeout, headers: { accept: "application/json", ...(data ? { "content-type": "application/json", "content-length": Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}
