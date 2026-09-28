FILE = "src/routes/inward.js"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

old_require = '''const { randomBytes } = require("crypto");'''
new_require = '''const { randomBytes } = require("crypto");
const ExcelJS = require("exceljs");'''

if old_require not in content:
    print("ERROR: require anchor not found. No changes made.")
    raise SystemExit(1)
content = content.replace(old_require, new_require, 1)

old_export = '''module.exports = router;'''
new_export = '''// GET /inward/export?from=YYYY-MM-DD&to=YYYY-MM-DD — download admitted + discharged patients as Excel
router.get("/export", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { from, to } = req.query;
    if (!from || !to) return res.status(400).json({ error: "from and to dates required (YYYY-MM-DD)" });

    const { rows: admitted } = await pool.query(
      `SELECT * FROM inward_patients
        WHERE hospital_id=$1 AND status='admitted'
          AND admitted_at::date >= $2::date AND admitted_at::date <= $3::date
        ORDER BY admitted_at DESC`,
      [hospitalId, from, to]
    );

    const { rows: discharged } = await pool.query(
      `SELECT * FROM inward_patients
        WHERE hospital_id=$1 AND status='discharged'
          AND discharged_at IS NOT NULL
          AND discharged_at::date >= $2::date AND discharged_at::date <= $3::date
        ORDER BY discharged_at DESC`,
      [hospitalId, from, to]
    );

    if (admitted.length === 0 && discharged.length === 0)
      return res.status(404).json({ error: "No inward patient records found for this period." });

    const workbook = new ExcelJS.Workbook();

    const cols = [
      { header: "Patient Name", key: "patient_name", width: 22 },
      { header: "Phone", key: "phone", width: 15 },
      { header: "Age", key: "age", width: 8 },
      { header: "Gender", key: "gender", width: 10 },
      { header: "Ward", key: "ward", width: 16 },
      { header: "Bed", key: "bed_number", width: 10 },
      { header: "Doctor", key: "admitting_doctor_name", width: 20 },
      { header: "Diagnosis", key: "diagnosis", width: 25 },
      { header: "Notes", key: "notes", width: 28 },
      { header: "Admitted At", key: "admitted_at", width: 20 },
      { header: "Discharged At", key: "discharged_at", width: 20 },
      { header: "Days", key: "days", width: 8 },
    ];

    function addSheet(name, rows) {
      const sheet = workbook.addWorksheet(name);
      sheet.columns = cols;
      sheet.getRow(1).font = { bold: true };
      rows.forEach((r) => {
        const admittedAt = new Date(r.admitted_at);
        const endAt = r.discharged_at ? new Date(r.discharged_at) : new Date();
        const days = Math.floor((endAt.getTime() - admittedAt.getTime()) / 86400000);
        sheet.addRow({
          patient_name: r.patient_name,
          phone: r.phone || "",
          age: r.age ?? "",
          gender: r.gender || "",
          ward: r.ward || "",
          bed_number: r.bed_number || "",
          admitting_doctor_name: r.admitting_doctor_name || "",
          diagnosis: r.diagnosis || "",
          notes: r.notes || "",
          admitted_at: r.admitted_at ? new Date(r.admitted_at).toLocaleString() : "",
          discharged_at: r.discharged_at ? new Date(r.discharged_at).toLocaleString() : "",
          days,
        });
      });
    }

    addSheet("Admitted Patients", admitted);
    addSheet("Discharged Patients", discharged);

    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="inward_${from}_to_${to}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error("[inward/export]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;'''

if old_export not in content:
    print("ERROR: module.exports anchor not found. No changes made.")
    raise SystemExit(1)
content = content.replace(old_export, new_export, 1)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("Success: /inward/export route added.")
