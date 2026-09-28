FILE = "src/routes/hr.js"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

old_require = '''function nanoid(n=10) { return randomBytes(n).toString("hex").slice(0,n); }
const router = express.Router();'''
new_require = '''function nanoid(n=10) { return randomBytes(n).toString("hex").slice(0,n); }
const ExcelJS = require("exceljs");
const router = express.Router();'''

if old_require not in content:
    print("ERROR: require anchor not found. No changes made.")
    raise SystemExit(1)
content = content.replace(old_require, new_require, 1)

old_get = '''router.get("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      `SELECT * FROM hospital_staff WHERE hospital_id=$1 ORDER BY role, name ASC`,
      [hospitalId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});'''
new_get = '''router.get("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      `SELECT * FROM hospital_staff WHERE hospital_id=$1 ORDER BY role, name ASC`,
      [hospitalId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /hr/export — download current staff list as Excel
router.get("/export", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });

    const { rows } = await pool.query(
      `SELECT * FROM hospital_staff WHERE hospital_id=$1 ORDER BY role, name ASC`,
      [hospitalId]
    );

    if (rows.length === 0)
      return res.status(404).json({ error: "No staff records found." });

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Staff");
    sheet.columns = [
      { header: "Name", key: "name", width: 22 },
      { header: "Role", key: "role", width: 16 },
      { header: "Department", key: "department", width: 18 },
      { header: "Phone", key: "phone", width: 15 },
      { header: "Shift", key: "shift", width: 20 },
      { header: "Status", key: "status", width: 10 },
      { header: "Salary (₹)", key: "salary", width: 14 },
    ];
    sheet.getRow(1).font = { bold: true };

    rows.forEach((s) => {
      const shifts = Array.isArray(s.shifts) && s.shifts.length ? s.shifts : [s.shift];
      sheet.addRow({
        name: s.name,
        role: (s.role || "").replace(/_/g, " "),
        department: s.department || "",
        phone: s.phone || "",
        shift: shifts.join(", "),
        status: s.is_active ? "Active" : "Inactive",
        salary: s.salary ?? "",
      });
    });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="staff_${timestamp}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[hr/export]", err.message);
    res.status(500).json({ error: err.message });
  }
});'''

if old_get not in content:
    print("ERROR: GET / anchor not found. No changes made.")
    raise SystemExit(1)
content = content.replace(old_get, new_get, 1)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("Success: /hr/export route added.")
