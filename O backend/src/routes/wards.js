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
      `SELECT * FROM beds WHERE ward_id=$1 AND hospital_id=$2 ORDER BY bed_number ASC`,
      [req.params.wardId, hospitalId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /wards/:wardId/beds/:bedId — update bed status
router.patch("/:wardId/beds/:bedId", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { status, patientName, inwardId } = req.body;
    const { rows } = await pool.query(
      `UPDATE beds SET status=$1, patient_name=$2, inward_id=$3, updated_at=now()
       WHERE id=$4 AND hospital_id=$5 RETURNING *`,
      [status, patientName || null, inwardId || null, req.params.bedId, hospitalId]
    );
    if (!rows.length) return res.status(404).json({ error: "Not found" });
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
