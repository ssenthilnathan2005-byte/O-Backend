const fs = require("fs");
const p = "src/routes/auth.js";
let s = fs.readFileSync(p, "utf8");
const find = 'SELECT * FROM hospitals WHERE login_id=$1';
const n = s.split(find).length - 1;
if (n !== 2) throw new Error("expected 2 matches, found " + n);
s = s.split(find).join('SELECT id, name, admin_user_id, login_id FROM hospitals WHERE login_id=$1');
fs.writeFileSync(p, s, "utf8");
console.log("patched auth.js (2 queries)");
