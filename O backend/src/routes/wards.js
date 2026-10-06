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

// ─── Cleaning-time helpers ────────────────────────────────────────────────
// Stored status value stays 'maintenance' (the UI shows it as "Cleaning").
// Priority for the cleaning duration: bed override > ward default > hospital default (30 min fallback).
const DEFAULT_CLEANING_MINUTES = 30;
const MAX_CLEANING_MINUTES = 60 * 24 * 30; // 30 days

function parseMinutes(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_CLEANING_MINUTES) return null;
  return n;
}

function hospitalIdOf(req) {
  return req.user.role === "admin"
    ? ((req.body && req.body.hospitalId) || req.query.hospitalId)
    : req.user.hospitalId;
}

// Beds whose cleaning end time has passed become available. The status is
// derived from the stored cleaning_ends_at, so it is correct after refresh,
// logout or a server restart (no background job needed).
async function releaseExpired(db, hospitalId) {
  await db.query(
    `UPDATE beds SET status='available', updated_at=now()
     WHERE hospital_id=$1 AND status='maintenance'
       AND cleaning_ends_at IS NOT NULL AND cleaning_ends_at <= now()`,
    [hospitalId]
  );
}

async function effectiveCleaningMinutes(db, bedId, wardId, hospitalId) {
  const { rows } = await db.query(
    `SELECT COALESCE(
              b.cleaning_override_minutes,
              w.cleaning_minutes,
              (SELECT default_minutes FROM hospital_cleaning_settings WHERE hospital_id=$3),
              $4
            ) AS minutes
     FROM beds b JOIN wards w ON w.id = b.ward_id
     WHERE b.id=$1 AND b.ward_id=$2`,
    [bedId, wardId, hospitalId, DEFAULT_CLEANING_MINUTES]
  );
  return rows.length ? Number(rows[0].minutes) : DEFAULT_CLEANING_MINUTES;
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

  -- Cleaning timer
  CREATE TABLE IF NOT EXISTS hospital_cleaning_settings (
    hospital_id     TEXT PRIMARY KEY,
    default_minutes INTEGER NOT NULL DEFAULT 30,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  ALTER TABLE wards ADD COLUMN IF NOT EXISTS cleaning_minutes INTEGER;
  ALTER TABLE beds  ADD COLUMN IF NOT EXISTS cleaning_override_minutes INTEGER;
  ALTER TABLE beds  ADD COLUMN IF NOT EXISTS cleaning_started_at TIMESTAMPTZ;
  ALTER TABLE beds  ADD COLUMN IF NOT EXISTS cleaning_ends_at TIMESTAMPTZ;
  ALTER TABLE beds  ADD COLUMN IF NOT EXISTS cleaning_duration_minutes INTEGER;
  -- Beds already in cleaning before this feature get a timer based on when they entered cleaning
  UPDATE beds SET cleaning_started_at = updated_at,
                  cleaning_duration_minutes = 30,
                  cleaning_ends_at = updated_at + interval '30 minutes'
  WHERE status='maintenance' AND cleaning_ends_at IS NULL;
`).catch(e => console.warn("[wards] migration:", e.message));

// GET /wards/cleaning-settings — hospital default cleaning time
router.get("/cleaning-settings", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = hospitalIdOf(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const { rows } = await pool.query(
      `SELECT default_minutes FROM hospital_cleaning_settings WHERE hospital_id=$1`, [hospitalId]
    );
    res.json({ defaultMinutes: rows.length ? rows[0].default_minutes : DEFAULT_CLEANING_MINUTES });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /wards/cleaning-settings — set hospital default { minutes }
router.put("/cleaning-settings", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = hospitalIdOf(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    const minutes = parseMinutes(req.body.minutes);
    if (!minutes) return res.status(400).json({ error: "minutes must be a whole number between 1 and 43200" });
    await pool.query(
      `INSERT INTO hospital_cleaning_settings (hospital_id, default_minutes)
       VALUES ($1,$2)
       ON CONFLICT (hospital_id) DO UPDATE SET default_minutes=$2, updated_at=now()`,
      [hospitalId, minutes]
    );
    res.json({ defaultMinutes: minutes });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /wards — list wards with bed counts
router.get("/", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    await releaseExpired(pool, hospitalId);
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

// PATCH /wards/:wardId/cleaning-time — ward default { minutes } (minutes: null = use hospital default)
router.patch("/:wardId/cleaning-time", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = hospitalIdOf(req);
    let minutes = null;
    if (req.body.minutes !== null && req.body.minutes !== undefined) {
      minutes = parseMinutes(req.body.minutes);
      if (!minutes) return res.status(400).json({ error: "minutes must be a whole number between 1 and 43200" });
    }
    const { rows } = await pool.query(
      `UPDATE wards SET cleaning_minutes=$1 WHERE id=$2 AND hospital_id=$3 RETURNING *`,
      [minutes, req.params.wardId, hospitalId]
    );
    if (!rows.length) return res.status(404).json({ error: "Ward not found" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /wards/:wardId/beds
router.get("/:wardId/beds", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    await releaseExpired(pool, hospitalId);
    const { rows } = await pool.query(
      `SELECT b.*,
              now() AS server_now,
              COALESCE(b.cleaning_override_minutes, w.cleaning_minutes, hs.default_minutes, ${DEFAULT_CLEANING_MINUTES}) AS effective_cleaning_minutes,
              CASE WHEN b.cleaning_override_minutes IS NOT NULL THEN 'bed'
                   WHEN w.cleaning_minutes IS NOT NULL THEN 'ward'
                   ELSE 'hospital' END AS cleaning_source,
              ip.patient_name  AS occupant_name,
              ip.phone         AS occupant_phone,
              ip.age           AS occupant_age,
              ip.gender        AS occupant_gender,
              ip.admitting_doctor_name AS occupant_doctor,
              ip.diagnosis     AS occupant_diagnosis,
              ip.notes         AS occupant_notes,
              ip.admitted_at   AS occupant_admitted_at
       FROM beds b
       JOIN wards w ON w.id = b.ward_id
       LEFT JOIN hospital_cleaning_settings hs ON hs.hospital_id = b.hospital_id
       LEFT JOIN inward_patients ip ON ip.id = b.inward_id
       WHERE b.ward_id=$1 AND b.hospital_id=$2
       ORDER BY b.bed_number ASC`,
      [req.params.wardId, hospitalId]
    );
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /wards/:wardId/beds/:bedId/cleaning-time — individual bed override { minutes } (null = follow ward/hospital default)
// Applies from the next discharge; it does not change a cleaning timer that is already running.
router.patch("/:wardId/beds/:bedId/cleaning-time", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = hospitalIdOf(req);
    let minutes = null;
    if (req.body.minutes !== null && req.body.minutes !== undefined) {
      minutes = parseMinutes(req.body.minutes);
      if (!minutes) return res.status(400).json({ error: "minutes must be a whole number between 1 and 43200" });
    }
    const { rows } = await pool.query(
      `UPDATE beds SET cleaning_override_minutes=$1, updated_at=now()
       WHERE id=$2 AND ward_id=$3 AND hospital_id=$4 RETURNING *`,
      [minutes, req.params.bedId, req.params.wardId, hospitalId]
    );
    if (!rows.length) return res.status(404).json({ error: "Bed not found" });
    res.json(rows[0]);
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

    // Free any bed whose cleaning time has already ended
    await releaseExpired(client, hospitalId);

    const { rows: bedRows } = await client.query(
      `SELECT b.*, w.name AS ward_name FROM beds b
       JOIN wards w ON w.id = b.ward_id
       WHERE b.id=$1 AND b.ward_id=$2 AND b.hospital_id=$3 FOR UPDATE`,
      [req.params.bedId, req.params.wardId, hospitalId]
    );
    if (!bedRows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Bed not found" }); }
    const bed = bedRows[0];
    if (bed.status === "occupied") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Bed already occupied" }); }
    // Only Available beds can be assigned; a bed in Cleaning cannot
    if (bed.status !== "available") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Bed is being cleaned and is not available yet" }); }

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
      `UPDATE beds SET status='occupied', patient_name=$1, inward_id=$2,
              cleaning_started_at=NULL, cleaning_ends_at=NULL, cleaning_duration_minutes=NULL,
              updated_at=now()
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

// PATCH /wards/:wardId/beds/:bedId/vacate — discharge patient, bed goes Occupied -> Cleaning and the timer starts
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
    if (bed.status !== "occupied") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Only an occupied bed can be discharged" }); }

    if (bed.inward_id) {
      await client.query(
        `UPDATE inward_patients SET status='discharged', discharged_at=now()
         WHERE id=$1 AND hospital_id=$2`,
        [bed.inward_id, hospitalId]
      );
    }

    const minutes = await effectiveCleaningMinutes(client, bed.id, req.params.wardId, hospitalId);

    const { rows: updated } = await client.query(
      `UPDATE beds SET status='maintenance', patient_name=NULL, inward_id=NULL,
              cleaning_started_at=now(),
              cleaning_duration_minutes=$2::int,
              cleaning_ends_at=now() + make_interval(mins => $2::int),
              updated_at=now()
       WHERE id=$1 RETURNING *`,
      [bed.id, minutes]
    );

    await client.query("COMMIT");
    res.json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});

// PATCH /wards/:wardId/beds/:bedId/ready — cleaning completed early: Cleaning -> Available, timer stops
router.patch("/:wardId/beds/:bedId/ready", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const { rows } = await pool.query(
      `UPDATE beds SET status='available',
              cleaning_started_at=NULL, cleaning_ends_at=NULL, cleaning_duration_minutes=NULL,
              updated_at=now()
       WHERE id=$1 AND ward_id=$2 AND hospital_id=$3 AND status='maintenance' RETURNING *`,
      [req.params.bedId, req.params.wardId, hospitalId]
    );
    if (!rows.length) return res.status(404).json({ error: "Bed not found or not being cleaned" });
    res.json(rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /wards/:wardId/beds/:bedId/extend — add more cleaning time { minutes }; bed stays in Cleaning
router.patch("/:wardId/beds/:bedId/extend", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = hospitalIdOf(req);
    const minutes = parseMinutes(req.body.minutes);
    if (!minutes) return res.status(400).json({ error: "minutes must be a whole number between 1 and 43200" });
    await releaseExpired(pool, hospitalId);
    const { rows } = await pool.query(
      `UPDATE beds SET cleaning_ends_at = cleaning_ends_at + make_interval(mins => $4::int),
              cleaning_duration_minutes = COALESCE(cleaning_duration_minutes, 0) + $4::int,
              updated_at=now()
       WHERE id=$1 AND ward_id=$2 AND hospital_id=$3 AND status='maintenance'
         AND cleaning_ends_at IS NOT NULL RETURNING *`,
      [req.params.bedId, req.params.wardId, hospitalId, minutes]
    );
    if (!rows.length) return res.status(404).json({ error: "Bed is not being cleaned" });
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
