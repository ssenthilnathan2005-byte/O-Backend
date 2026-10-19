"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { requirePerm, requireAnyPerm } = require("./permissions");
const { randomBytes } = require("crypto");
const ExcelJS = require("exceljs");
function nanoid(n=10) { return randomBytes(n).toString("hex").slice(0,n); }
const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
    return res.status(403).json({ error: "Forbidden" });
  next();
}

router.get("/", requireAuth, requirePerm("ipd"), async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      `SELECT * FROM inward_patients WHERE hospital_id=$1 ORDER BY admitted_at DESC`,
      [hospitalId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post("/", requireAuth, requirePerm("ipd"), async (req, res) => {
  const client = await pool.connect();
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { patientName, phone, age, gender, bedId,
            admittingDoctorId, admittingDoctorName, diagnosis, notes, admittedAt } = req.body;
    const name = String(patientName || "").trim();
    if (!name || !hospitalId) return res.status(400).json({ error: "patientName required" });
    if (!bedId) return res.status(400).json({ error: "Choose a bed from the list" });
    const ageN = (age === undefined || age === null || age === "") ? null : Number(age);
    if (ageN !== null && !(Number.isInteger(ageN) && ageN >= 0 && ageN <= 130))
      return res.status(400).json({ error: "Enter a valid age" });

    await client.query("BEGIN");
    const { rows: bedRows } = await client.query(
      `SELECT b.*, w.name AS ward_name FROM beds b JOIN wards w ON w.id = b.ward_id
        WHERE b.id=$1 AND b.hospital_id=$2 FOR UPDATE OF b`, [bedId, hospitalId]);
    if (!bedRows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Bed not found" }); }
    const bed = bedRows[0];
    const held = bed.reserved_booking_id && bed.reserved_until && new Date(bed.reserved_until) > new Date();
    if (bed.status !== "available" || held) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "That bed is not available now. Choose another bed." });
    }
    if (phone) {
      const dup = await client.query(
        "SELECT 1 FROM inward_patients WHERE hospital_id=$1 AND status='admitted' AND phone=$2 AND lower(patient_name)=lower($3) LIMIT 1",
        [hospitalId, phone, name]);
      if (dup.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: "This patient is already admitted." }); }
    }
    let docId = null, docName = admittingDoctorName || null;
    if (admittingDoctorId) {
      const d = await client.query("SELECT id, name FROM doctors WHERE id=$1 AND hospital_id=$2", [admittingDoctorId, hospitalId]);
      if (!d.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Doctor not found" }); }
      docId = d.rows[0].id; docName = d.rows[0].name;
    }
    const id = `inward_${nanoid(10)}`;
    const { rows } = await client.query(
      `INSERT INTO inward_patients
         (id, hospital_id, patient_name, phone, age, gender, ward, bed_number,
          admitting_doctor_id, admitting_doctor_name, diagnosis, notes, admitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
         CASE WHEN $13::timestamptz IS NULL
                OR ($13::timestamptz AT TIME ZONE 'Asia/Kolkata')::date >= (now() AT TIME ZONE 'Asia/Kolkata')::date
              THEN now() ELSE $13::timestamptz END)
       RETURNING *`,
      [id, hospitalId, name, phone || null, ageN, gender || null, bed.ward_name, bed.bed_number,
       docId, docName, diagnosis || null, notes || null, admittedAt || null]);
    await client.query(
      `UPDATE beds SET status='occupied', patient_name=$1, inward_id=$2,
              cleaning_started_at=NULL, cleaning_ends_at=NULL, cleaning_duration_minutes=NULL, updated_at=now()
        WHERE id=$3`, [name, id, bed.id]);
    await client.query("COMMIT");
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});
router.patch("/:id", requireAuth, requirePerm("ipd"), async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const b = req.body || {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const isAdmin = req.user.role === "hospital_admin" || req.user.role === "admin";
    const { rows: cur } = await pool.query("SELECT * FROM inward_patients WHERE id=$1 AND hospital_id=$2", [req.params.id, hospitalId]);
    if (!cur.length) return res.status(404).json({ error: "Not found" });
    const p = cur[0];
    const same = (a, c) => String(a || "").trim().toLowerCase() === String(c || "").trim().toLowerCase();
    if ((has("ward") && !same(b.ward, p.ward)) || (has("bedNumber") && !same(b.bedNumber, p.bed_number)))
      return res.status(400).json({ error: "The ward or bed cannot be changed from this form, because the bed list would go out of step." });

    const sets = [], vals = [];
    const add = (col, val) => { vals.push(val); sets.push(col + "=$" + vals.length); };
    if (has("diagnosis")) add("diagnosis", b.diagnosis || null);
    if (has("notes")) add("notes", b.notes || null);
    if (has("admittingDoctorId")) add("admitting_doctor_id", b.admittingDoctorId || null);
    if (has("admittingDoctorName")) add("admitting_doctor_name", b.admittingDoctorName || null);
    if (has("admittedAt") && b.admittedAt && p.status === "admitted") {
      const d = new Date(b.admittedAt);
      const unchanged = isNaN(d.getTime()) || d.toISOString().slice(0, 10) === new Date(p.admitted_at).toISOString().slice(0, 10);
      if (!unchanged) {
        if (!isAdmin) return res.status(403).json({ error: "Only the hospital admin can change the admission date." });
        if (d.getTime() > Date.now()) return res.status(400).json({ error: "The admission date cannot be in the future." });
        add("admitted_at", d.toISOString());
      }
    }
    if (!sets.length) return res.json(p);
    vals.push(p.id);
    const { rows } = await pool.query(
      "UPDATE inward_patients SET " + sets.join(", ") + " WHERE id=$" + vals.length + " RETURNING *", vals);
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});
router.patch("/:id/discharge", requireAuth, requirePerm("ipd"), async (req, res) => {
  const client = await pool.connect();
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    await client.query("BEGIN");
    const { rows: cur } = await client.query(
      "SELECT id, status FROM inward_patients WHERE id=$1 AND hospital_id=$2 FOR UPDATE",
      [req.params.id, hospitalId]
    );
    if (!cur.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    if (cur[0].status !== "admitted") { await client.query("ROLLBACK"); return res.status(409).json({ error: "This patient is already discharged" }); }
    const { rows } = await client.query(
      `UPDATE inward_patients SET status='discharged', discharged_at=now()
       WHERE id=$1 RETURNING *`,
      [cur[0].id]
    );
    // Free the bed: occupied -> cleaning (same rules as the ward screen's vacate)
    const { rows: bed } = await client.query(
      "SELECT id, ward_id FROM beds WHERE inward_id=$1 AND hospital_id=$2 FOR UPDATE",
      [cur[0].id, hospitalId]
    );
    if (bed.length) {
      const { rows: m } = await client.query(
        `SELECT COALESCE(b.cleaning_override_minutes, w.cleaning_minutes,
                  (SELECT default_minutes FROM hospital_cleaning_settings WHERE hospital_id=$3), 30) AS minutes
           FROM beds b JOIN wards w ON w.id=b.ward_id WHERE b.id=$1 AND b.ward_id=$2`,
        [bed[0].id, bed[0].ward_id, hospitalId]
      );
      const minutes = m.length ? Number(m[0].minutes) : 30;
      await client.query(
        `UPDATE beds SET status='maintenance', patient_name=NULL, inward_id=NULL,
                cleaning_started_at=now(), cleaning_duration_minutes=$2::int,
                cleaning_ends_at=now() + make_interval(mins => $2::int), updated_at=now()
          WHERE id=$1`,
        [bed[0].id, minutes]
      );
    }
    await client.query("COMMIT");
    res.json(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});
// GET /inward/export?from=YYYY-MM-DD&to=YYYY-MM-DD — download admitted + discharged patients as Excel
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

    // Latest vitals reading per patient (blank if none recorded)
    const allIds = [...admitted, ...discharged].map((p) => p.id);
    let latestVitalsMap = {};
    if (allIds.length > 0) {
      const placeholders = allIds.map((_, i) => `$${i + 1}`).join(",");
      const { rows: vitalsRows } = await pool.query(
        `SELECT DISTINCT ON (patient_id) patient_id, temperature, pulse, bp_systolic, bp_diastolic, spo2, recorded_at
           FROM hospital_nursing_vitals
          WHERE patient_id IN (${placeholders})
          ORDER BY patient_id, recorded_at DESC`,
        allIds
      );
      for (const v of vitalsRows) latestVitalsMap[v.patient_id] = v;
    }

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
      { header: "Temp (°F)", key: "temperature", width: 10 },
      { header: "Pulse (bpm)", key: "pulse", width: 12 },
      { header: "BP", key: "bp", width: 10 },
      { header: "SpO2 (%)", key: "spo2", width: 10 },
      { header: "Vitals Recorded At", key: "vitals_recorded_at", width: 20 },
    ];

    function addSheet(name, rows) {
      const sheet = workbook.addWorksheet(name);
      sheet.columns = cols;
      sheet.getRow(1).font = { bold: true };
      rows.forEach((r) => {
        const admittedAt = new Date(r.admitted_at);
        const endAt = r.discharged_at ? new Date(r.discharged_at) : new Date();
        const days = Math.floor((endAt.getTime() - admittedAt.getTime()) / 86400000);
        const v = latestVitalsMap[r.id];
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
          temperature: v?.temperature ?? "",
          pulse: v?.pulse ?? "",
          bp: (v?.bp_systolic != null && v?.bp_diastolic != null) ? `${v.bp_systolic}/${v.bp_diastolic}` : "",
          spo2: v?.spo2 ?? "",
          vitals_recorded_at: v?.recorded_at ? new Date(v.recorded_at).toLocaleString() : "",
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

module.exports = router;
