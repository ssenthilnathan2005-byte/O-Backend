const fs = require("fs");
const p = "src/routes/hospitals.js";
let s = fs.readFileSync(p, "utf8");

// 1. only reload the photo when it isn't in memory
const old1 = "if (!entry || (wantV && entry.v !== wantV)) {";
if (s.split(old1).length - 1 !== 1) throw new Error("photo reload condition not found");
s = s.replace(old1, "if (!entry) {");

// 2. create + edit: select only needed columns
const cols = '"SELECT id, name, area, address, phone, rating, gradient, photo_url, login_id, " + PHOTO_COLS + ", is_free, has_pharmacy, plan, rate_per_token FROM hospitals WHERE id=$1"';
const a = 'await pool.query("SELECT * FROM hospitals WHERE id=$1", [id]);';
const b = 'const { rows } = await pool.query("SELECT * FROM hospitals WHERE id=$1", [req.params.id]);';
if (s.split(a).length - 1 !== 1) throw new Error("create query: expected 1 match");
if (s.split(b).length - 1 !== 1) throw new Error("edit query: expected 1 match");
s = s.replace(a, "await pool.query(" + cols + ", [id]);");
s = s.replace(b, "const { rows } = await pool.query(" + cols + ", [req.params.id]);");

fs.writeFileSync(p, s, "utf8");
console.log("patched hospitals.js");
