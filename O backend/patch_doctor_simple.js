const fs = require("fs");
const p = "src/routes/auth.js";
let s = fs.readFileSync(p, "utf8");
const i = s.indexOf('"/doctor/login"');
if (i === -1) throw new Error("doctor login not found");
let block = s.slice(i, i + 2500);
const j = block.indexOf("Pharmacy staff login");
if (j !== -1) block = block.slice(0, j);
const rest = s.slice(i + block.length);

let b = block
  .replace('body("phone").trim().notEmpty()', 'body("password").notEmpty()')
  .replace("const { code, phone } = req.body;", "const { code, password } = req.body;\n      const phone = password; // password is stored in doctors.phone")
  .replace("Incorrect password. Use your registered phone number.", "Incorrect password.");

if (b === block) throw new Error("nothing changed");
fs.writeFileSync(p, s.slice(0, i) + b + rest, "utf8");
console.log("patched doctor login");
