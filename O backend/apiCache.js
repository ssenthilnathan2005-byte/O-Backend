"use strict";
// Short-lived server-side cache for read-only (GET) JSON responses.
//  - Cuts repeated Supabase queries when many app screens refresh every 10s.
//  - Every cached entry is keyed per login token, so users never see each other's data.
//  - ANY write request (POST/PUT/PATCH/DELETE) clears the whole cache immediately,
//    so new bookings / status changes show up right away.
const crypto = require("crypto");

const MAX_BYTES = 40 * 1024 * 1024; // total cache size cap (40 MB)
const MAX_ENTRY = 5 * 1024 * 1024;  // never cache a single response bigger than this

const store = new Map(); // key -> { body, t, size }
let totalBytes = 0;
let version = 0;
let hits = 0;
let misses = 0;

function bump() {
  version++;
  store.clear();
  totalBytes = 0;
}

// Mount BEFORE all /api routers: clears the cache around every write request.
function invalidateOnWrite(req, res, next) {
  const m = req.method;
  if (m !== "GET" && m !== "HEAD" && m !== "OPTIONS") {
    bump();               // before the write runs
    res.on("finish", bump); // and again after it finished
  }
  next();
}

function put(key, body) {
  const size = Buffer.byteLength(body);
  if (size > MAX_ENTRY) return;
  const old = store.get(key);
  if (old) { totalBytes -= old.size; store.delete(key); }
  store.set(key, { body, t: Date.now(), size });
  totalBytes += size;
  for (const k of store.keys()) {            // evict oldest first
    if (totalBytes <= MAX_BYTES) break;
    totalBytes -= store.get(k).size;
    store.delete(k);
  }
}

// cacheGet(ttlMs, filter?) -> middleware. Only successful (200) JSON GET responses are cached.
function cacheGet(ttlMs, filter) {
  return function (req, res, next) {
    if (req.method !== "GET") return next();
    if (filter && !filter(req)) return next();

    const key = crypto
      .createHash("md5")
      .update((req.headers.authorization || "") + "\n" + (req.headers.cookie || "") + "\n" + req.originalUrl)
      .digest("hex");

    const hit = store.get(key);
    if (hit && Date.now() - hit.t < ttlMs) {
      hits++;
      res.set("Cache-Control", "no-store");
      res.set("X-Cache", "HIT");
      res.set("Content-Type", "application/json; charset=utf-8");
      return res.send(hit.body);
    }

    misses++;
    const startVersion = version;
    const origJson = res.json.bind(res);
    res.json = function (body) {
      if (res.statusCode === 200 && startVersion === version) {
        let str;
        try { str = JSON.stringify(body); } catch (_) { str = undefined; }
        if (typeof str === "string") {
          put(key, str);
          res.set("Content-Type", "application/json; charset=utf-8");
          return res.send(str);
        }
      }
      return origJson(body);
    };
    next();
  };
}

// Log hit/miss counts every 10 minutes (visible with: pm2 logs)
setInterval(() => {
  if (hits + misses > 0) {
    console.log("[apiCache] last 10 min: hits=" + hits + " misses=" + misses + " size=" + Math.round(totalBytes / 1024) + "KB");
  }
  hits = 0;
  misses = 0;
}, 10 * 60 * 1000).unref();

module.exports = { invalidateOnWrite, cacheGet, bump };
