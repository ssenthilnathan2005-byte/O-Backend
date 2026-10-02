const fs = require("fs");

function rep(src, find, repl, label) {
  const i = src.indexOf(find);
  if (i === -1) throw new Error("NOT FOUND: " + label);
  return src.slice(0, i) + repl + src.slice(i + find.length);
}

// ---------- 1. db/init.js ----------
let p = "src/db/init.js";
let s = fs.readFileSync(p, "utf8");
if (!s.includes("pharmacy_staff ADD COLUMN IF NOT EXISTS password")) {
  const f = '"ALTER TABLE pharmacy_staff ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 1",';
  s = rep(s, f, f +
    '\n  "ALTER TABLE pharmacy_staff ADD COLUMN IF NOT EXISTS password TEXT",' +
    '\n  "ALTER TABLE pharmacy_staff ADD COLUMN IF NOT EXISTS first_login INTEGER NOT NULL DEFAULT 0",',
    "init.js migration");
  fs.writeFileSync(p, s, "utf8");
  console.log("patched", p);
} else console.log("skip", p);

// ---------- 2. routes/auth.js ----------
p = "src/routes/auth.js";
s = fs.readFileSync(p, "utf8");
if (!s.includes("checkPharmacyPassword")) {
  const startIdx = s.lastIndexOf("router.post(", s.indexOf('"/pharmacy/login"'));
  const adminRoute = s.lastIndexOf("router.post(", s.indexOf('"/admin/login"'));
  const endIdx = s.lastIndexOf("//", adminRoute); // start of the "Admin login" comment line
  if (startIdx === -1 || adminRoute === -1 || endIdx <= startIdx) throw new Error("auth.js block not located");

  const newBlock = `// Pharmacy staff password check (legacy staff without a password use their phone as a temporary one)
async function checkPharmacyPassword(staff, pw) {
  if (staff.password) return bcrypt.compare(String(pw), staff.password);
  return String(pw).trim() === String(staff.phone || "").trim();
}

function pharmacyPayload(staff) {
  return {
    id: "ph_" + staff.code,
    code: staff.code,
    pharmacyStaffId: staff.id,
    hospitalId: staff.hospital_id,
    hospitalName: staff.hospital_name,
    role: "pharmacy",
  };
}

router.post(
  "/pharmacy/login",
  [body("code").trim().notEmpty(), body("password").notEmpty()],
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const { code, password } = req.body;
      const { rows: staffRows } = await pool.query(
        "SELECT ps.*, h.name AS hospital_name, h.plan AS hospital_plan FROM pharmacy_staff ps JOIN hospitals h ON h.id = ps.hospital_id WHERE UPPER(ps.code)=UPPER($1)",
        [String(code || "").trim()]
      );
      const staff = staffRows[0];

      if (!staff || staff.is_active === 0) {
        return res.status(401).json({ error: "Invalid access code. Please check with your admin." });
      }
      if (!(await checkPharmacyPassword(staff, password))) {
        return res.status(401).json({ error: "Incorrect password." });
      }
      if (!staff.password || staff.first_login === 1) {
        return res.json({ firstLogin: true });
      }

      const payload = pharmacyPayload(staff);
      return res.json({ token: sign(payload), user: payload });
    } catch (err) {
      console.error("[auth pharmacy/login]", err.message);
      return res.status(500).json({ error: err.message });
    }
  }
);

router.post("/pharmacy/set-password", async (req, res) => {
  try {
    const { code, currentPassword, newPassword } = req.body;
    if (!code || !currentPassword || !newPassword)
      return res.status(400).json({ error: "code, currentPassword and newPassword are required" });
    if (String(newPassword).length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (String(newPassword) === String(currentPassword))
      return res.status(400).json({ error: "New password must be different from the current one" });

    const { rows } = await pool.query(
      "SELECT ps.*, h.name AS hospital_name FROM pharmacy_staff ps JOIN hospitals h ON h.id = ps.hospital_id WHERE UPPER(ps.code)=UPPER($1)",
      [String(code).trim()]
    );
    const staff = rows[0];
    if (!staff || staff.is_active === 0) return res.status(401).json({ error: "Invalid access code" });
    if (!(await checkPharmacyPassword(staff, currentPassword)))
      return res.status(401).json({ error: "Current password is incorrect" });

    const hash = await bcrypt.hash(String(newPassword), 10);
    await pool.query("UPDATE pharmacy_staff SET password=$1, first_login=0 WHERE id=$2", [hash, staff.id]);

    const payload = pharmacyPayload(staff);
    return res.json({ token: sign(payload), user: payload });
  } catch (err) {
    console.error("[auth pharmacy/set-password]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

`;
  s = s.slice(0, startIdx) + newBlock + s.slice(endIdx);
  fs.writeFileSync(p, s, "utf8");
  console.log("patched", p);
} else console.log("skip", p);

// ---------- 3. routes/pharmacy.js ----------
p = "src/routes/pharmacy.js";
s = fs.readFileSync(p, "utf8");
if (!s.includes("passwordHash")) {
  s = rep(s, 'const { randomBytes } = require("crypto");',
    'const { randomBytes } = require("crypto");\nconst bcrypt = require("bcrypt");', "bcrypt require");

  s = rep(s, "const { name, phone, hospitalId } = req.body;",
    'const { name, phone, hospitalId, password } = req.body;\n' +
    '    if (!password || String(password).length < 6)\n' +
    '      return res.status(400).json({ error: "Password must be at least 6 characters" });\n' +
    '    const passwordHash = await bcrypt.hash(String(password), 10);', "staff body");

  s = rep(s,
    '"INSERT INTO pharmacy_staff (id, hospital_id, code, name, phone) VALUES ($1,$2,$3,$4,$5) RETURNING *",',
    '"INSERT INTO pharmacy_staff (id, hospital_id, code, name, phone, password) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, phone, code, is_active, created_at",',
    "insert sql");
  s = rep(s, "[id, hospitalId, code, name, phone]", "[id, hospitalId, code, name, phone, passwordHash]", "insert params");

  const resetRoute = `// PATCH reset pharmacy staff password (admin / hospital-admin)
router.patch("/staff/:id/password", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password || String(password).length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    const hash = await bcrypt.hash(String(password), 10);
    let result;
    if (req.user.role === "hospital_admin") {
      result = await pool.query(
        "UPDATE pharmacy_staff SET password=$1, first_login=0 WHERE id=$2 AND hospital_id=$3 RETURNING id",
        [hash, req.params.id, req.user.hospitalId]
      );
    } else {
      result = await pool.query(
        "UPDATE pharmacy_staff SET password=$1, first_login=0 WHERE id=$2 RETURNING id",
        [hash, req.params.id]
      );
    }
    if (!result.rows.length) return res.status(404).json({ error: "Staff not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

`;
  const k = s.lastIndexOf("module.exports = router;");
  s = s.slice(0, k) + resetRoute + s.slice(k);
  fs.writeFileSync(p, s, "utf8");
  console.log("patched", p);
} else console.log("skip", p);
