// Tiny Redis client for Upstash's REST API (what Vercel's "Upstash for Redis" gives you).
// No packages needed. Without the env vars it falls back to an in-memory store,
// which is only for running on your own computer and in tests.

// Vercel may add a custom prefix (e.g. STORAGE_KV_REST_API_URL), so also accept any name ending like this.
const findEnv = (...ends) => {
  for (const e of ends) if (process.env[e]) return process.env[e];
  for (const [k, v] of Object.entries(process.env)) if (v && ends.some((e) => k.endsWith("_" + e)) && !/READ_ONLY/.test(k)) return v;
  return undefined;
};
const URL_ = findEnv("KV_REST_API_URL", "UPSTASH_REDIS_REST_URL");
const TOKEN = findEnv("KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_TOKEN");

export const hasDatabase = () => Boolean(URL_ && TOKEN);

// ---- in-memory fallback -------------------------------------------------
const mem = new Map(); // key -> { v, exp }
function memGet(k) {
  const e = mem.get(k);
  if (!e) return undefined;
  if (e.exp && e.exp < Date.now()) { mem.delete(k); return undefined; }
  return e.v;
}
function memCmd([c, ...a]) {
  c = String(c).toUpperCase();
  switch (c) {
    case "GET": { const v = memGet(a[0]); return typeof v === "string" ? v : null; }
    case "SET": {
      let exp = null, nx = false;
      for (let i = 2; i < a.length; i++) {
        const o = String(a[i]).toUpperCase();
        if (o === "EX") exp = Date.now() + Number(a[++i]) * 1000;
        else if (o === "NX") nx = true;
      }
      if (nx && memGet(a[0]) !== undefined) return null;
      mem.set(a[0], { v: String(a[1]), exp });
      return "OK";
    }
    case "DEL": { let n = 0; for (const k of a) if (mem.delete(k)) n++; return n; }
    case "HSET": {
      const h = memGet(a[0]) || {}; let n = 0;
      for (let i = 1; i < a.length; i += 2) { if (!(a[i] in h)) n++; h[a[i]] = String(a[i + 1]); }
      mem.set(a[0], { v: h, exp: null }); return n;
    }
    case "HGET": { const h = memGet(a[0]); return h && a[1] in h ? h[a[1]] : null; }
    case "HGETALL": {
      const h = memGet(a[0]) || {};
      return Object.entries(h).flat();
    }
    case "HDEL": { const h = memGet(a[0]) || {}; let n = 0; for (const f of a.slice(1)) if (f in h) { delete h[f]; n++; } return n; }
    case "EXPIRE": { const e = mem.get(a[0]); if (!e) return 0; e.exp = Date.now() + Number(a[1]) * 1000; return 1; }
    case "INCR": { const v = Number(memGet(a[0]) || 0) + 1; mem.set(a[0], { v: String(v), exp: mem.get(a[0])?.exp || null }); return v; }
    case "LPUSH": { const l = memGet(a[0]) || []; for (const x of a.slice(1)) l.unshift(String(x)); mem.set(a[0], { v: l, exp: null }); return l.length; }
    case "LRANGE": {
      const l = memGet(a[0]) || []; const s = Number(a[1]); let e = Number(a[2]);
      if (e < 0) e = l.length + e;
      return l.slice(s, e + 1);
    }
    case "LTRIM": {
      const l = memGet(a[0]) || []; const s = Number(a[1]); let e = Number(a[2]);
      if (e < 0) e = l.length + e;
      mem.set(a[0], { v: l.slice(s, e + 1), exp: null }); return "OK";
    }
    default: throw new Error("memory store does not support " + c);
  }
}
export function resetMemory() { mem.clear(); }

// ---- public API ----------------------------------------------------------
export async function redis(...cmd) {
  if (!hasDatabase()) return memCmd(cmd.map(String));
  const res = await fetch(URL_, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmd.map(String)),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error("db: " + (json.error || res.status));
  return json.result;
}

export async function pipeline(cmds) {
  if (!cmds.length) return [];
  if (!hasDatabase()) return cmds.map((c) => memCmd(c.map(String)));
  const res = await fetch(URL_.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(cmds.map((c) => c.map(String))),
  });
  const json = await res.json().catch(() => []);
  if (!res.ok || !Array.isArray(json)) throw new Error("db pipeline: " + res.status);
  return json.map((r) => (r && "result" in r ? r.result : null));
}

// JSON helpers
export async function getJSON(key, fallback = null) {
  const v = await redis("GET", key);
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
export async function setJSON(key, value, ttlSeconds) {
  return ttlSeconds ? redis("SET", key, JSON.stringify(value), "EX", ttlSeconds) : redis("SET", key, JSON.stringify(value));
}
export async function hgetallJSON(key) {
  const flat = (await redis("HGETALL", key)) || [];
  const out = {};
  for (let i = 0; i < flat.length; i += 2) {
    try { out[flat[i]] = JSON.parse(flat[i + 1]); } catch { /* skip bad row */ }
  }
  return out;
}
