adminRouter.get("/", async (req, res) => {
  try {
    const hospitalId = hospitalOf(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      "SELECT id, nurse_code, name, phone, is_active, first_login, created_at FROM nurses WHERE hospital_id=$1 AND is_active=1 ORDER BY created_at DESC",
      [hospitalId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post("/", async (req, res) => {
  try {
    const hospitalId = hospitalOf(req);
    const name = String((req.body && req.body.name) || "").trim();
    const phone = String((req.body && req.body.phone) || "").trim();
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    if (!name || !phone) return res.status(400).json({ error: "Name and contact number are required" });
    if (!/^[0-9+\-\s]{7,15}$/.test(phone)) return res.status(400).json({ error: "Enter a valid contact number" });

    const tempPassword = pick(PW_CHARS, 10);
    const hash = await bcrypt.hash(tempPassword, 10);
    const id = "nu_" + crypto.randomBytes(8).toString("hex");
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = "NUR-" + pick(CODE_CHARS, 6);
      try {
        const { rows } = await pool.query(
          "INSERT INTO nurses (id, hospital_id, nurse_code, name, phone, password, first_login) VALUES ($1,$2,$3,$4,$5,$6,1) RETURNING id, nurse_code, name, phone, is_active, first_login, created_at",
          [id, hospitalId, code, name, phone, hash]
        );
        return res.status(201).json({ ...rows[0], tempPassword });
      } catch (e) {
        if (e.code === "23505") continue;
        throw e;
      }
    }
    return res.status(500).json({ error: "Could not generate a unique Nurse ID, please try again" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
adminRouter.post("/:id/reset-password", async (req, res) => {
  try {
    const tempPassword = pick(PW_CHARS, 10);
    const hash = await bcrypt.hash(tempPassword, 10);
    const params = [hash, req.params.id];
    let sql = "UPDATE nurses SET password=$1, first_login=1 WHERE id=$2 AND is_active=1";
    if (req.user.role === "hospital_admin") { sql += " AND hospital_id=$3"; params.push(req.user.hospitalId); }
    sql += " RETURNING id, nurse_code, name";
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ error: "Nurse not found" });
    res.json({ ...rows[0], tempPassword });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

adminRouter.delete("/:id", async (req, res) => {
  try {
    const params = [req.params.id];
    let sql = "UPDATE nurses SET is_active=0 WHERE id=$1";
    if (req.user.role === "hospital_admin") { sql += " AND hospital_id=$2"; params.push(req.user.hospitalId); }
    sql += " RETURNING id";
    const { rows } = await pool.query(sql, params);
    if (!rows.length) return res.status(404).json({ error: "Nurse not found" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
const authRouter = express.Router();
const BAD = "Invalid Nurse ID or password.";

function payload(n) {
  return {
    id: "nu_" + n.nurse_code,
    nurseId: n.id,
    code: n.nurse_code,
    name: n.name,
    hospitalId: n.hospital_id,
    hospitalName: n.hospital_name,
    role: "nurse",
  };
}
async function findNurse(code) {
  const { rows } = await pool.query(
    "SELECT n.*, h.name AS hospital_name FROM nurses n JOIN hospitals h ON h.id = n.hospital_id WHERE UPPER(n.nurse_code)=UPPER($1)",
    [String(code || "").trim()]
  );
  return rows[0];
}

authRouter.post("/login", async (req, res) => {
  try {
    const { code, password } = req.body || {};
    if (!code || !password) return res.status(400).json({ error: "Nurse ID and password are required" });
    const n = await findNurse(code);
    if (!n || n.is_active === 0 || !(await bcrypt.compare(String(password), n.password)))
      return res.status(401).json({ error: BAD });
    if (n.first_login === 1) return res.json({ firstLogin: true });
    const p = payload(n);
    return res.json({ token: sign(p), user: p });
  } catch (err) {
    console.error("[nurse login]", err.message);
    res.status(500).json({ error: "Login failed" });
  }
});

authRouter.post("/set-password", async (req, res) => {
  try {
    const { code, currentPassword, newPassword } = req.body || {};
    if (!code || !currentPassword || !newPassword)
      return res.status(400).json({ error: "code, currentPassword and newPassword are required" });
    if (String(newPassword).length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    if (String(newPassword) === String(currentPassword))
      return res.status(400).json({ error: "New password must be different from the temporary one" });
    const n = await findNurse(code);
    if (!n || n.is_active === 0 || !(await bcrypt.compare(String(currentPassword), n.password)))
      return res.status(401).json({ error: BAD });
    const hash = await bcrypt.hash(String(newPassword), 10);
    await pool.query("UPDATE nurses SET password=$1, first_login=0 WHERE id=$2", [hash, n.id]);
    const p = payload(n);
    return res.json({ token: sign(p), user: p });
  } catch (err) {
    console.error("[nurse set-password]", err.message);
    res.status(500).json({ error: "Could not set password" });
  }
});

module.exports = { adminRouter, authRouter };
pool.query(
  "CREATE TABLE IF NOT EXISTS nurses (" +
  "id TEXT PRIMARY KEY, " +
  "hospital_id TEXT NOT NULL REFERENCES hospitals(id) ON DELETE CASCADE, " +
  "nurse_code TEXT UNIQUE NOT NULL, " +
  "name TEXT NOT NULL, " +
  "phone TEXT NOT NULL, " +
  "password TEXT NOT NULL, " +
  "first_login INTEGER NOT NULL DEFAULT 1, " +
  "is_active INTEGER NOT NULL DEFAULT 1, " +
  "created_at TIMESTAMPTZ NOT NULL DEFAULT now())"
).catch((e) => console.error("[nurses] table init failed:", e.message));