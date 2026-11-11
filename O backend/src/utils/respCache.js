const cache = new Map();
const TTL = 300000, MAX = 800;
let gov = null;
try { gov = require("./egressGov"); } catch (e) {}
let jwt = null, secret = null;
try { jwt = require("jsonwebtoken"); secret = require("./secrets").JWT_SECRET; } catch (e) {}
function tokenOk(req) {
  if (!jwt || !secret) return true;
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return true;
  try { jwt.verify(h.slice(7).trim(), secret); return true; } catch (e) { return false; }
}
let hits = 0, misses = 0, clears = 0, ver = 0;
setInterval(() => {
  console.log(`[respCache] hits=${hits} misses=${misses} clears=${clears} size=${cache.size}`);
  hits = 0; misses = 0; clears = 0;
}, 300000).unref();
function respCache(req, res, next) {
  if (req._rc) return next();
  req._rc = true;
  if (req.method !== "GET") {
    cache.clear(); ver++; clears++;
    res.on("finish", () => { cache.clear(); ver++; clears++; });
    return next();
  }
  if (!tokenOk(req)) return next();
  const lvl = gov ? gov.level() : 0;
  const key = (req.headers.authorization || "") + "|" + (req.headers.cookie || "") + "|" + req.originalUrl;
  const hit = cache.get(key);
  if (hit && (hit.exp > Date.now() || lvl === 2)) {
    hits++;
    res.set("X-Cache", hit.exp > Date.now() ? "HIT" : "STALE");
    return res.status(200).json(hit.body);
  }
  misses++;
  res.set("X-Cache", "MISS");
  const v = ver;
  const orig = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200 && v === ver) {
      if (cache.size >= MAX) cache.delete(cache.keys().next().value);
      cache.set(key, { exp: Date.now() + (req.cacheTtl || TTL) * (lvl === 1 ? 4 : 1), body });
    }
    return orig(body);
  };
  next();
}
respCache.clearAll = () => { cache.clear(); ver++; clears++; };
module.exports = respCache;
