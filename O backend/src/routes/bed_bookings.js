"use strict";
// IPD bed booking: patients request a bed online, staff confirm + reserve a
// specific bed, then admit the patient into it (creates the inward record).
const express = require("express");
const { randomBytes } = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { requireAnyPerm } = require("./permissions");
const { validateRequiredIndianPhone } = require("../utils/phone");
const { sendPushToPatient } = require("../services/push");

const router = express.Router();
const nid = (p) => p + randomBytes(6).toString("hex");
const staffPerm = requireAnyPerm("ipd", "beds_wards");
const DEFAULT_HOLD_HOURS = 24;
const ACTIVE = ["requested", "confirmed"];

pool.query(`
  CREATE TABLE IF NOT EXISTS bed_bookings (
    id              TEXT PRIMARY KEY,
    hospital_id     TEXT NOT NULL,
    patient_user_id TEXT NOT NULL,
    patient_name    TEXT NOT NULL,
    phone           TEXT NOT NULL,
    age             INTEGER,
    gender          TEXT,
    ward_id         TEXT,
    ward_name       TEXT,
    bed_id          TEXT,
    bed_number      TEXT,
    doctor_id       TEXT,
    doctor_name     TEXT,
    reason          TEXT,
    expected_admit_at TIMESTAMPTZ,
    status          TEXT NOT NULL DEFAULT 'requested'
                    CHECK(status IN ('requested','confirmed','admitted','cancelled','rejected','expired')),
    staff_note      TEXT,
    reserved_until  TIMESTAMPTZ,
    inward_id       TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_bedbk_hospital ON bed_bookings(hospital_id, status);
  CREATE INDEX IF NOT EXISTS idx_bedbk_patient ON bed_bookings(patient_user_id);
  ALTER TABLE beds ADD COLUMN IF NOT EXISTS reserved_booking_id TEXT;
  ALTER TABLE beds ADD COLUMN IF NOT EXISTS reserved_until TIMESTAMPTZ;
  ALTER TABLE wards ADD COLUMN IF NOT EXISTS daily_rate NUMERIC(10,2) NOT NULL DEFAULT 0;
  ALTER TABLE inward_patients ADD COLUMN IF NOT EXISTS bed_booking_id TEXT;
  ALTER TABLE inward_patients ADD COLUMN IF NOT EXISTS patient_user_id TEXT;
`).catch((e) => console.warn("[bed_bookings] migration:", e.message));

// Release reservations whose hold time has passed.
async function expireHolds(db, hospitalId) {
  const { rows } = await db.query(
    `UPDATE bed_bookings SET status='expired', updated_at=now()
      WHERE hospital_id=$1 AND status='confirmed' AND reserved_until IS NOT NULL AND reserved_until <= now()
      RETURNING id`, [hospitalId]);
  await db.query(
    `UPDATE beds SET reserved_booking_id=NULL, reserved_until=NULL
      WHERE hospital_id=$1 AND reserved_booking_id IS NOT NULL
        AND (reserved_until IS NULL OR reserved_until <= now())`, [hospitalId]);
  await db.query(
    `UPDATE beds SET status='available', updated_at=now()
      WHERE hospital_id=$1 AND status='maintenance' AND cleaning_ends_at IS NOT NULL AND cleaning_ends_at <= now()`,
    [hospitalId]);
  return rows.length;
}

const hospitalOfStaff = (req) =>
  req.user.role === "admin" ? (req.body.hospitalId || req.query.hospitalId) : req.user.hospitalId;

function push(userId, title, body) {
  sendPushToPatient(userId, { title, body, data: { tag: "bed-booking" } }).catch(() => {});
}

// ───────────────────────── PATIENT ─────────────────────────

// GET /bed-bookings/availability/:hospitalId — wards with free beds + daily rate
router.get("/availability/:hospitalId", requireAuth, async (req, res) => {
  try {
    await expireHolds(pool, req.params.hospitalId);
    const { rows } = await pool.query(
      `SELECT w.id, w.name, w.type, w.daily_rate,
              COUNT(b.id) FILTER (WHERE b.status='available' AND b.reserved_booking_id IS NULL) AS available_beds,
              COUNT(b.id) AS total_beds
         FROM wards w LEFT JOIN beds b ON b.ward_id = w.id
        WHERE w.hospital_id=$1 GROUP BY w.id ORDER BY w.created_at ASC`,
      [req.params.hospitalId]);
    res.json(rows.map((r) => ({
      id: r.id, name: r.name, type: r.type, dailyRate: Number(r.daily_rate),
      availableBeds: Number(r.available_beds), totalBeds: Number(r.total_beds),
    })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /bed-bookings — patient requests a bed
router.post("/", requireAuth, async (req, res) => {
  if (req.user.role !== "patient") return res.status(403).json({ error: "Only patients can book a bed" });
  try {
    const b = req.body || {};
    const name = String(b.patientName || "").trim();
    if (!b.hospitalId || !b.wardId) return res.status(400).json({ error: "hospitalId and wardId are required" });
    if (!name) return res.status(400).json({ error: "Patient name is required" });
    const ph = validateRequiredIndianPhone(b.phone);
    if (!ph.ok) return res.status(400).json({ error: ph.error });
    const age = b.age === undefined || b.age === null || b.age === "" ? null : Number(b.age);
    if (age !== null && !(Number.isInteger(age) && age >= 0 && age <= 130))
      return res.status(400).json({ error: "Enter a valid age" });
    let expected = null;
    if (b.expectedAdmitAt) {
      expected = new Date(b.expectedAdmitAt);
      if (isNaN(expected.getTime())) return res.status(400).json({ error: "Invalid admission date" });
    }

    const { rows: w } = await pool.query(
      "SELECT id, name FROM wards WHERE id=$1 AND hospital_id=$2", [b.wardId, b.hospitalId]);
    if (!w.length) return res.status(404).json({ error: "Ward not found" });

    let doctorId = null, doctorName = null;
    if (b.doctorId) {
      const { rows: d } = await pool.query(
        "SELECT id, name FROM doctors WHERE id=$1 AND hospital_id=$2", [b.doctorId, b.hospitalId]);
      if (d.length) { doctorId = d[0].id; doctorName = d[0].name; }
    }

    const { rows: dup } = await pool.query(
      `SELECT 1 FROM bed_bookings WHERE patient_user_id=$1 AND hospital_id=$2
          AND lower(patient_name)=lower($3) AND status = ANY($4) LIMIT 1`,
      [req.user.id, b.hospitalId, name, ACTIVE]);
    if (dup.length) return res.status(409).json({ error: "You already have an active bed request for this patient at this hospital." });

    const id = nid("bbk_");
    const { rows } = await pool.query(
      `INSERT INTO bed_bookings (id, hospital_id, patient_user_id, patient_name, phone, age, gender,
              ward_id, ward_name, doctor_id, doctor_name, reason, expected_admit_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [id, b.hospitalId, req.user.id, name, ph.phone, age, b.gender || null,
       w[0].id, w[0].name, doctorId, doctorName, b.reason ? String(b.reason).slice(0, 500) : null, expected]);
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /bed-bookings/mine
router.get("/mine", requireAuth, async (req, res) => {
  try {
    const { rows: ids } = await pool.query(
      "SELECT DISTINCT hospital_id FROM bed_bookings WHERE patient_user_id=$1", [req.user.id]);
    for (const r of ids) await expireHolds(pool, r.hospital_id);
    const { rows } = await pool.query(
      `SELECT bb.*, h.name AS hospital_name FROM bed_bookings bb
         LEFT JOIN hospitals h ON h.id = bb.hospital_id
        WHERE bb.patient_user_id=$1 ORDER BY bb.created_at DESC`, [req.user.id]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /bed-bookings/my-stays — the patient's own admissions (current + past) with bed allocation.
// Matches admissions made from an online booking (patient_user_id) and walk-in admissions
// recorded with the patient's registered mobile number.
router.get("/my-stays", requireAuth, async (req, res) => {
  if (req.user.role !== "patient") return res.status(403).json({ error: "Forbidden" });
  try {
    const { rows: u } = await pool.query("SELECT phone FROM users WHERE id=$1", [req.user.id]);
    const last10 = String((u[0] && u[0].phone) || req.user.phone || "").replace(/\D/g, "").slice(-10);
    const { rows } = await pool.query(
      `SELECT ip.id, ip.hospital_id, h.name AS hospital_name, ip.patient_name, ip.ward, ip.bed_number,
              ip.admitting_doctor_name, ip.diagnosis, ip.status, ip.admitted_at, ip.discharged_at, ip.bed_booking_id,
              COALESCE((SELECT w.daily_rate FROM wards w WHERE w.hospital_id=ip.hospital_id AND w.name=ip.ward LIMIT 1), 0) AS daily_rate
         FROM inward_patients ip
         LEFT JOIN hospitals h ON h.id = ip.hospital_id
        WHERE ip.patient_user_id = $1
           OR ($2::text <> '' AND right(regexp_replace(COALESCE(ip.phone,''), '\\D', '', 'g'), 10) = $2)
        ORDER BY ip.admitted_at DESC`,
      [req.user.id, last10]);
    res.set("Cache-Control", "no-store");
    res.json(rows.map((r) => ({ ...r, daily_rate: Number(r.daily_rate) })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /bed-bookings/:id/cancel — patient cancels own request
router.patch("/:id/cancel", requireAuth, async (req, res) => {
  if (req.user.role !== "patient") return next404(res);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM bed_bookings WHERE id=$1 AND patient_user_id=$2 FOR UPDATE`, [req.params.id, req.user.id]);
    if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Booking not found" }); }
    if (!ACTIVE.includes(rows[0].status)) { await client.query("ROLLBACK"); return res.status(409).json({ error: "This booking can no longer be cancelled" }); }
    await client.query(
      `UPDATE beds SET reserved_booking_id=NULL, reserved_until=NULL WHERE reserved_booking_id=$1`, [rows[0].id]);
    const { rows: up } = await client.query(
      `UPDATE bed_bookings SET status='cancelled', updated_at=now() WHERE id=$1 RETURNING *`, [rows[0].id]);
    await client.query("COMMIT");
    res.json(up[0]);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});
function next404(res) { return res.status(403).json({ error: "Forbidden" }); }

// ───────────────────────── STAFF ─────────────────────────

// GET /bed-bookings/hospital?status=requested,confirmed
router.get("/hospital", requireAuth, staffPerm, async (req, res) => {
  try {
    const hospitalId = hospitalOfStaff(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    await expireHolds(pool, hospitalId);
    const statuses = String(req.query.status || "requested,confirmed").split(",").filter(Boolean);
    const { rows } = await pool.query(
      `SELECT * FROM bed_bookings WHERE hospital_id=$1 AND status = ANY($2)
        ORDER BY CASE status WHEN 'requested' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, created_at DESC`,
      [hospitalId, statuses]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /bed-bookings/free-beds?wardId= — beds staff can assign
router.get("/free-beds", requireAuth, staffPerm, async (req, res) => {
  try {
    const hospitalId = hospitalOfStaff(req);
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    await expireHolds(pool, hospitalId);
    const params = [hospitalId];
    let extra = "";
    if (req.query.wardId) { params.push(req.query.wardId); extra = " AND b.ward_id=$2"; }
    const { rows } = await pool.query(
      `SELECT b.id AS bed_id, b.bed_number, w.id AS ward_id, w.name AS ward_name
         FROM beds b JOIN wards w ON w.id=b.ward_id
        WHERE b.hospital_id=$1 AND b.status='available' AND b.reserved_booking_id IS NULL${extra}
        ORDER BY w.name, length(b.bed_number), b.bed_number`, params);
    res.set("Cache-Control", "no-store");
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /bed-bookings/:id/confirm { bedId, holdHours? } — reserve a bed
router.patch("/:id/confirm", requireAuth, staffPerm, async (req, res) => {
  const client = await pool.connect();
  try {
    const hospitalId = hospitalOfStaff(req);
    const { bedId, staffNote } = req.body || {};
    const hold = Number(req.body && req.body.holdHours) || DEFAULT_HOLD_HOURS;
    if (!bedId) return res.status(400).json({ error: "Choose a bed" });
    if (!(hold >= 1 && hold <= 168)) return res.status(400).json({ error: "holdHours must be between 1 and 168" });

    await client.query("BEGIN");
    await expireHolds(client, hospitalId);
    const { rows: bk } = await client.query(
      "SELECT * FROM bed_bookings WHERE id=$1 AND hospital_id=$2 FOR UPDATE", [req.params.id, hospitalId]);
    if (!bk.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Booking not found" }); }
    if (!ACTIVE.includes(bk[0].status)) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Booking is " + bk[0].status }); }

    const { rows: bed } = await client.query(
      `SELECT b.*, w.name AS ward_name FROM beds b JOIN wards w ON w.id=b.ward_id
        WHERE b.id=$1 AND b.hospital_id=$2 FOR UPDATE OF b`, [bedId, hospitalId]);
    if (!bed.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Bed not found" }); }
    const sameHold = bed[0].reserved_booking_id === bk[0].id;
    if (bed[0].status !== "available" || (bed[0].reserved_booking_id && !sameHold)) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "That bed is not available. Choose another bed." });
    }

    // free a previously reserved bed if staff changed it
    await client.query("UPDATE beds SET reserved_booking_id=NULL, reserved_until=NULL WHERE reserved_booking_id=$1 AND id<>$2", [bk[0].id, bed[0].id]);
    await client.query(
      "UPDATE beds SET reserved_booking_id=$1, reserved_until=now() + make_interval(hours => $2::int), updated_at=now() WHERE id=$3",
      [bk[0].id, hold, bed[0].id]);
    const { rows: up } = await client.query(
      `UPDATE bed_bookings SET status='confirmed', ward_id=$1, ward_name=$2, bed_id=$3, bed_number=$4,
              staff_note=COALESCE($5, staff_note), reserved_until=now() + make_interval(hours => $6::int), updated_at=now()
        WHERE id=$7 RETURNING *`,
      [bed[0].ward_id, bed[0].ward_name, bed[0].id, bed[0].bed_number, staffNote || null, hold, bk[0].id]);
    await client.query("COMMIT");
    push(bk[0].patient_user_id, "Bed confirmed", `Your bed ${bed[0].bed_number} (${bed[0].ward_name}) is reserved for ${hold} hours.`);
    res.json(up[0]);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// PATCH /bed-bookings/:id/reject { reason }
router.patch("/:id/reject", requireAuth, staffPerm, async (req, res) => {
  const client = await pool.connect();
  try {
    const hospitalId = hospitalOfStaff(req);
    await client.query("BEGIN");
    const { rows: bk } = await client.query(
      "SELECT * FROM bed_bookings WHERE id=$1 AND hospital_id=$2 FOR UPDATE", [req.params.id, hospitalId]);
    if (!bk.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Booking not found" }); }
    if (!ACTIVE.includes(bk[0].status)) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Booking is " + bk[0].status }); }
    await client.query("UPDATE beds SET reserved_booking_id=NULL, reserved_until=NULL WHERE reserved_booking_id=$1", [bk[0].id]);
    const { rows: up } = await client.query(
      "UPDATE bed_bookings SET status='rejected', staff_note=$1, updated_at=now() WHERE id=$2 RETURNING *",
      [req.body && req.body.reason ? String(req.body.reason).slice(0, 300) : null, bk[0].id]);
    await client.query("COMMIT");
    push(bk[0].patient_user_id, "Bed request declined", "The hospital could not allot a bed. Please contact them or try another ward.");
    res.json(up[0]);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// POST /bed-bookings/:id/admit — patient arrived: create IPD admission in the reserved bed
router.post("/:id/admit", requireAuth, staffPerm, async (req, res) => {
  const client = await pool.connect();
  try {
    const hospitalId = hospitalOfStaff(req);
    await client.query("BEGIN");
    const { rows: bk } = await client.query(
      "SELECT * FROM bed_bookings WHERE id=$1 AND hospital_id=$2 FOR UPDATE", [req.params.id, hospitalId]);
    if (!bk.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Booking not found" }); }
    const k = bk[0];
    if (k.status !== "confirmed" || !k.bed_id) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Confirm a bed before admitting" }); }

    const { rows: bed } = await client.query(
      `SELECT b.*, w.name AS ward_name FROM beds b JOIN wards w ON w.id=b.ward_id
        WHERE b.id=$1 AND b.hospital_id=$2 FOR UPDATE OF b`, [k.bed_id, hospitalId]);
    if (!bed.length || bed[0].status !== "available" || bed[0].reserved_booking_id !== k.id) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Reserved bed is no longer available. Confirm another bed." });
    }
    const inwardId = "inward_" + randomBytes(5).toString("hex");
    await client.query(
      `INSERT INTO inward_patients (id, hospital_id, patient_name, phone, age, gender, ward, bed_number,
              admitting_doctor_id, admitting_doctor_name, diagnosis, notes, bed_booking_id, patient_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [inwardId, hospitalId, k.patient_name, k.phone, k.age, k.gender, bed[0].ward_name, bed[0].bed_number,
       k.doctor_id, k.doctor_name, (req.body && req.body.diagnosis) || k.reason || null, k.staff_note, k.id, k.patient_user_id]);
    await client.query(
      `UPDATE beds SET status='occupied', patient_name=$1, inward_id=$2, reserved_booking_id=NULL, reserved_until=NULL,
              cleaning_started_at=NULL, cleaning_ends_at=NULL, cleaning_duration_minutes=NULL, updated_at=now()
        WHERE id=$3`, [k.patient_name, inwardId, bed[0].id]);
    const { rows: up } = await client.query(
      "UPDATE bed_bookings SET status='admitted', inward_id=$1, updated_at=now() WHERE id=$2 RETURNING *", [inwardId, k.id]);
    await client.query("COMMIT");
    push(k.patient_user_id, "Admitted", `You have been admitted to ${bed[0].ward_name}, bed ${bed[0].bed_number}.`);
    res.status(201).json({ booking: up[0], inwardId });
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// PATCH /bed-bookings/ward-rate/:wardId { dailyRate } — hospital admin sets bed charge per day (used by billing)
router.patch("/ward-rate/:wardId", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
      return res.status(403).json({ error: "Forbidden" });
    const hospitalId = hospitalOfStaff(req);
    const rate = Number(req.body && req.body.dailyRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 10000000) return res.status(400).json({ error: "Enter a valid daily rate" });
    const { rows } = await pool.query(
      "UPDATE wards SET daily_rate=$1 WHERE id=$2 AND hospital_id=$3 RETURNING id, name, daily_rate",
      [rate, req.params.wardId, hospitalId]);
    if (!rows.length) return res.status(404).json({ error: "Ward not found" });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
