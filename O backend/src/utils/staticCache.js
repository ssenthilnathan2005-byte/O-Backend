const _sc = new Map();
const _TTL = 300000, _MAX = 500;
function staticCache(req, res, next) {
  if (req.method !== "GET") return next();
  const key = (req.headers.authorization || "") + "|" + req.originalUrl;
  const hit = _sc.get(key);
  if (hit && hit.exp > Date.now()) return res.status(200).json(hit.body);
  const orig = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode === 200) {
      if (_sc.size >= _MAX) _sc.delete(_sc.keys().next().value);
      _sc.set(key, { exp: Date.now() + _TTL, body });
    }
    return orig(body);
  };
  next();
}
module.exports = staticCache;
