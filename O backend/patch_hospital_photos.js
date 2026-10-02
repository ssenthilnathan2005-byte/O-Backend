const fs = require("fs");
const p = "src/routes/hospitals.js";
let s = fs.readFileSync(p, "utf8");
if (s.includes("photoEndpoint")) throw new Error("already patched");

function once(find, repl, label) {
  const i = s.indexOf(find);
  if (i === -1) throw new Error("NOT FOUND: " + label);
  s = s.slice(0, i) + repl + s.slice(i + find.length);
}

// 1. helpers + in-memory photo cache
once(`const router = express.Router();`, `const router = express.Router();
const crypto = require("crypto");

// Photos live as base64 text in hospitals.photo_data. Lists never read that column;
// they only get a short version hash and a URL that serves the image separately.
const PHOTO_COLS = "CASE WHEN photo_data IS NOT NULL AND photo_data <> '' THEN left(md5(photo_data),10) END AS photo_v";
function hasPhoto(r) { return !!(r.photo_v || r.photo_data); }
function photoEndpoint(r, req) {
  const v = r.photo_v || crypto.createHash("md5").update(r.photo_data, "utf8").digest("hex").slice(0, 10);
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host  = req.headers["x-forwarded-host"] || req.headers.host || "";
  return proto + "://" + host + req.baseUrl + "/" + r.id + "/photo?v=" + v;
}
const photoMem = new Map(); // hospital id -> { v, type, buf }
`, "router");

// 2. list query: no photo_data
once(`photo_url, photo_data, is_free, has_pharmacy, plan, rate_per_token FROM hospitals ORDER BY name ASC`,
     `photo_url, " + PHOTO_COLS + ", is_free, has_pharmacy, plan, rate_per_token FROM hospitals ORDER BY name ASC`,
     "list query");

// 3. photo conditions + url building
once(`if (includePhoto && r.photo_data) {`, `if (includePhoto && hasPhoto(r)) {`, "row2hospital condition");
once(`if (r.photo_data) {`, `if (hasPhoto(r)) {`, "list condition");
const before = s.split("photoUrl = r.photo_data;").length - 1;
if (before !== 2) throw new Error("expected 2 photoUrl assignments, found " + before);
s = s.split("photoUrl = r.photo_data;").join("photoUrl = photoEndpoint(r, req);");

// 4. GET /:id: no SELECT *, no cache wipe
const re = /const \{ rows \} = await pool\.query\("SELECT \* FROM hospitals WHERE id=\$1", \[req\.params\.id\]\);(\s*)if \(!rows\[0\]\) return res\.status\(404\)\.json\(\{ error: "Hospital not found" \}\);(\s*)invalidateHospitalCache\(\);/;
const m = re.exec(s);
if (!m) throw new Error("NOT FOUND: GET /:id block");
const repl = 'const { rows } = await pool.query("SELECT id, name, area, address, phone, rating, gradient, photo_url, " + PHOTO_COLS + ", is_free, has_pharmacy, plan, rate_per_token FROM hospitals WHERE id=$1", [req.params.id]);' +
  m[1] + 'if (!rows[0]) return res.status(404).json({ error: "Hospital not found" });';
s = s.slice(0, m.index) + repl + s.slice(m.index + m[0].length);

// 5. uploads clear the caches
const upd = 'await pool.query("UPDATE hospitals SET photo_data=$1, photo_url=NULL WHERE id=$2", [base64, req.params.id]);';
const n = s.split(upd).length - 1;
if (n < 1) throw new Error("NOT FOUND: upload UPDATE");
s = s.split(upd).join(upd + " photoMem.delete(req.params.id); invalidateHospitalCache();");

// 6. photo endpoint
once(`router.get("/:id", async (req, res) => {`, `// GET one hospital photo: read from Supabase once, then served from memory + browser cache
router.get("/:id/photo", async (req, res) => {
  try {
    const wantV = req.query.v ? String(req.query.v) : null;
    let entry = photoMem.get(req.params.id);
    if (!entry || (wantV && entry.v !== wantV)) {
      const { rows } = await pool.query("SELECT photo_data FROM hospitals WHERE id=$1", [req.params.id]);
      const raw = rows[0] && rows[0].photo_data;
      const mm = raw && /^data:([^;,]+);base64,([\\s\\S]*)$/.exec(raw);
      if (!mm) return res.status(404).end();
      const v = crypto.createHash("md5").update(raw, "utf8").digest("hex").slice(0, 10);
      entry = { v, type: mm[1], buf: Buffer.from(mm[2], "base64") };
      photoMem.set(req.params.id, entry);
    }
    if (req.headers["if-none-match"] === '"' + entry.v + '"') return res.status(304).end();
    res.set("Content-Type", entry.type);
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    res.set("ETag", '"' + entry.v + '"');
    res.send(entry.buf);
  } catch (err) {
    console.error("[hospitals photo GET]", err.message);
    res.status(500).end();
  }
});

router.get("/:id", async (req, res) => {`, "insert endpoint");

fs.writeFileSync(p, s, "utf8");
console.log("patched hospitals.js (" + n + " upload route(s) updated)");
