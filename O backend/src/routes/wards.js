"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { randomBytes } = require("crypto");
function nanoid(n=10) { return randomBytes(n).toString("hex").slice(0,n); }
const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
    return res.status(403).json({ error: "Forbidden" });
  next();
}

// Auto-create wards table
pool.query(`
  CREATE TABLE IF NOT EXISTS wards (
    id          TEXT PRIMARY KEY,
    hospital_id TEXT NOT NULL,
    name        TEXT NOT NULL,
    type        TEXT NOT NULL DEFAULT 'general',
    total_beds  INTEGER NOT NULL DEFAULT 10,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS beds (
    id          TEXT PRIMARY KEY,
    hospital_id TEXT NOT NULL,
    ward_id     TEXT NOT NULL REFERENCES wards(id) ON DELETE CASCADE,
    bed_number  TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'available'
                CHECK(status IN ('available','occupied','maintenance')),
    patient_name TEXT,
    inward_id   TEXT,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_wards_hospital ON wards(hospital_id);
  CREATE INDEX IF NOT EXISTS idx_beds_ward ON beds(ward_id);
  CREATE INDEX IF NOT EXISTS idx_beds_hospital ON beds(hospital_id);
`).catch(e => console.warn("[wards] migration:", e.message));

// GET /wards — list wards with bed counts
router.get("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows: wards } = await pool.query(
      `SELECT w.*,
        COUNT(b.id) FILTER (WHERE b.status='available') AS available_beds,
        COUNT(b.id) FILTER (WHERE b.status='occupied')  AS occupied_beds,
        COUNT(b.id) FILTER (WHERE b.status='maintenance') AS maintenance_beds,
        COUNT(b.id) AS total_beds_actual
       FROM wards w
       LEFT JOIN beds b ON b.ward_id = w.id
       WHERE w.hospital_id=$1
       GROUP BY w.id ORDER BY w.created_at ASC`,
      [hospitalId]
    );
    res.json(wards);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /wards — create ward
router.post("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { name, type, totalBeds } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const wardId = `ward_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO wards (id, hospital_id, name, type, total_beds)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [wardId, hospitalId, name, type || "general", totalBeds || 10]
    );
    // Auto-create beds
    const n = Number(totalBeds) || 10;
    for (let i = 1; i <= n; i++) {
      await pool.query(
        `INSERT INTO beds (id, hospital_id, ward_id, bed_number)
         VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [`bed_${nanoid(10)}`, hospitalId, wardId, `${rows[0].name.slice(0,2).toUpperCase()}-${String(i).padStart(2,"0")}`]
      );
    }
    res.status(201).json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /wards/:wardId/beds
router.get("/:wardId/beds", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    const { rows } = await pool.query(
      `SELECT b.*,
              ip.patient_name  AS occupant_name,
              ip.phone         AS occupant_phone,
              ip.age           AS occupant_age,
              ip.gender        AS occupant_gender,
              ip.admitting_doctor_name AS occupant_doctor,
              ip.diagnosis     AS occupant_diagnosis,
              ip.notes         AS occupant_notes,
              ip.admitted_at   AS occupant_admitted_at
       FROM beds b
       LEFT JOIN inward_patients ip ON ip.id = b.inward_id
       WHERE b.ward_id=$1 AND b.hospital_id=$2
       ORDER BY b.bed_number ASC`,
      [req.params.wardId, hospitalId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /wards/:wardId/beds/:bedId/occupy — admit a patient into this bed
router.post("/:wardId/beds/:bedId/occupy", requireAuth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const {
      patientName, phone, age, gender,
      admittingDoctorId, admittingDoctorName, diagnosis, notes,
    } = req.body;
    if (!patientName) return res.status(400).json({ error: "patientName required" });

    await client.query("BEGIN");

    const { rows: bedRows } = await client.query(
      `SELECT b.*, w.name AS ward_name FROM beds b
       JOIN wards w ON w.id = b.ward_id
       WHERE b.id=$1 AND b.ward_id=$2 AND b.hospital_id=$3 FOR UPDATE`,
      [req.params.bedId, req.params.wardId, hospitalId]
    );
    if (!bedRows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Bed not found" }); }
    const bed = bedRows[0];
    if (bed.status === "occupied") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Bed already occupied" }); }

    const { randomBytes } = require("crypto");
    const inwardId = `inward_${randomBytes(10).toString("hex").slice(0,10)}`;
    await client.query(
      `INSERT INTO inward_patients
         (id, hospital_id, patient_name, phone, age, gender, ward, bed_number,
          admitting_doctor_id, admitting_doctor_name, diagnosis, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [inwardId, hospitalId, patientName, phone || null, age || null, gender || null,
       bed.ward_name, bed.bed_number, admittingDoctorId || null, admittingDoctorName || null,
       diagnosis || null, notes || null]
    );

    const { rows: updated } = await client.query(
      `UPDATE beds SET status='occupied', patient_name=$1, inward_id=$2, updated_at=now()
       WHERE id=$3 RETURNING *`,
      [patientName, inwardId, bed.id]
    );

    await client.query("COMMIT");
    res.status(201).json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// PATCH /wards/:wardId/beds/:bedId/vacate — discharge patient, bed goes to maintenance
router.patch("/:wardId/beds/:bedId/vacate", requireAuth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    await client.query("BEGIN");

    const { rows: bedRows } = await client.query(
      `SELECT * FROM beds WHERE id=$1 AND ward_id=$2 AND hospital_id=$3 FOR UPDATE`,
      [req.params.bedId, req.params.wardId, hospitalId]
    );
    if (!bedRows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Bed not found" }); }
    const bed = bedRows[0];

    if (bed.inward_id) {
      await client.query(
        `UPDATE inward_patients SET status='discharged', discharged_at=now()
         WHERE id=$1 AND hospital_id=$2`,
        [bed.inward_id, hospitalId]
      );
    }

    const { rows: updated } = await client.query(
      `UPDATE beds SET status='maintenance', patient_name=NULL, inward_id=NULL, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [bed.id]
    );

    await client.query("COMMIT");
    res.json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// PATCH /wards/:wardId/beds/:bedId/ready — mark a maintenance bed available again
router.patch("/:wardId/beds/:bedId/ready", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { rows } = await pool.query(
      `UPDATE beds SET status='available', updated_at=now()
       WHERE id=$1 AND ward_id=$2 AND hospital_id=$3 AND status='maintenance' RETURNING *`,
      [req.params.bedId, req.params.wardId, hospitalId]
    );
    if (!rows.length) return res.status(404).json({ error: "Bed not found or not in maintenance" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /wards/:wardId
router.delete("/:wardId", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    await pool.query(`DELETE FROM wards WHERE id=$1 AND hospital_id=$2`, [req.params.wardId, hospitalId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
