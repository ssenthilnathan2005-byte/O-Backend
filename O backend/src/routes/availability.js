"use strict";
// Doctor Availability / Break Management.
//   POST /api/availability/start     doctor starts a break
//   POST /api/availability/extend    doctor extends the current break
//   POST /api/availability/resume    doctor manually resumes consultation
//   GET  /api/availability/doctor/:doctorId   current state (public: patients need it)
//   GET  /api/availability/history/:doctorId  audit history (doctor / hospital admin / front office / admin)
// The database clock is the single source of truth for every timestamp.
// Nothing here ever touches tokens, queue order or bookings.
const express = require("express");
const crypto = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { broadcast } = require("../services/ws");
const { sendPushToBooking } = require("../services/push");
const L = require("../services/availabilityLogic");

const router = express.Router();
const SESSIONS = ["morning", "afternoon", "evening"];
const todayIST = () => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
const hex = (n) => crypto.randomBytes(n).toString("hex");
const httpErr = (status, message, extra) => Object.assign(new Error(message), { status }, extra || {});

// ── Snapshot (always read with the DB clock) ─────────────────────────────────
async function loadSnapshot(doctorId, q = pool) {
  const { rows } = await q.query(
    `SELECT da.*, clock_timestamp() AS db_now
       FROM (SELECT $1::text AS req_id) d
       LEFT JOIN doctor_availability da ON da.doctor_id = d.req_id`,
    [doctorId]
  );
  const row = rows[0] || null;
  const nowMs = row && row.db_now ? new Date(row.db_now).getTime() : Date.now();
  return L.toSnapshot(doctorId, row, nowMs);
}

// ── Push to patients who are still waiting for this doctor today ─────────────
async function pushToWaitingPatients(ev) {
  const { rows } = await pool.query(
    `SELECT b.id, b.patient_id, b.for_user_id, b.doctor_name
       FROM bookings b
       LEFT JOIN token_states ts ON ts.session_id = b.session_id
      WHERE b.doctor_id=$1 AND b.date=$2 AND b.status='confirmed'
        AND (ts.session_id IS NULL OR ts.is_closed=0)
      LIMIT 500`,
    [ev.doctorId, todayIST()]
  );
  if (!rows.length) return;
  const msg = L.buildMessage(ev.action, {
    doctorName: ev.doctorName, reason: ev.snapshot.reason ?? ev.lastReason, expectedReturnAt: ev.snapshot.expectedReturnAt,
  });
  const payload = { title: msg.title, body: msg.body, data: { tag: "doctor-availability-" + ev.doctorId, event: ev.action, doctorId: ev.doctorId } };
  for (let i = 0; i < rows.length; i += 10) {
    await Promise.all(rows.slice(i, i + 10).map((b) => sendPushToBooking(b, payload).catch(() => {})));
  }
}

// ── Everything that happens AFTER the change is safely committed ─────────────
async function afterChange(ev) {
  try {
    const so = ev.action === "resume" ? "seeing_patients"
      : ev.snapshot.reason === "emergency" ? "attending_emergency" : "short_break";
    await pool.query("UPDATE doctors SET status_override=$1 WHERE id=$2", [so, ev.doctorId]);
    try { require("./doctors").invalidateDoctorCache(); } catch (_) {}
  } catch (e) { console.error("[availability] status_override sync failed:", e.message); }

  try {
    const payload = { type: "availability_update", availability: ev.snapshot, event: { id: ev.logId, action: ev.action } };
    const today = todayIST();
    for (const s of SESSIONS) broadcast(`${ev.doctorId}_${today}_${s}`, payload);
    broadcast(`avail_doctor_${ev.doctorId}`, payload);
    if (ev.hospitalId) broadcast(`avail_hospital_${ev.hospitalId}`, payload);
  } catch (e) { console.error("[availability] broadcast failed:", e.message); }

  pushToWaitingPatients(ev).catch((e) => console.error("[availability] push failed:", e.message));
}

// ── Doctor-only auth ─────────────────────────────────────────────────────────
function requireDoctorSelf(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "doctor" || !req.user.doctorId)
      return res.status(403).json({ error: "Only the doctor can change their availability." });
    next();
  });
}

// ── The one transition routine (start / extend / resume) ─────────────────────
async function runTransition(req, action) {
  const doctorId = req.user.doctorId;
  const body = req.body || {};
  const key = body.idempotencyKey ? doctorId + ":" + String(body.idempotencyKey).slice(0, 100) : null;

  let v = { ok: true };
  if (action === "start") v = L.validateStart(body);
  else if (action === "extend") v = L.validateExtend(body);
  if (!v.ok) throw httpErr(400, v.error);

  const client = await pool.connect();
  let began = false;
  try {
    await client.query("BEGIN"); began = true;
    const dRow = (await client.query("SELECT hospital_id, name FROM doctors WHERE id=$1", [doctorId])).rows[0];
    if (!dRow) throw httpErr(404, "Doctor not found");

    await client.query("INSERT INTO doctor_availability (doctor_id) VALUES ($1) ON CONFLICT (doctor_id) DO NOTHING", [doctorId]);
    // Row lock: two devices acting at the same moment are serialised here.
    const cur = (await client.query("SELECT * FROM doctor_availability WHERE doctor_id=$1 FOR UPDATE", [doctorId])).rows[0];

    if (key) {
      const dup = await client.query("SELECT 1 FROM doctor_availability_log WHERE idempotency_key=$1", [key]);
      if (dup.rows.length) { // same request replayed (double tap / retry): no second event, no second notification
        await client.query("COMMIT"); began = false;
        return { duplicate: true, availability: await loadSnapshot(doctorId) };
      }
    }
    if (body.expectedVersion !== undefined && body.expectedVersion !== null && Number(body.expectedVersion) !== cur.version)
      throw httpErr(409, "Your status was changed from another device. Showing the latest.", { withSnapshot: true });
    const bad = L.checkTransition(cur.status, action);
    if (bad) throw httpErr(bad.status, bad.error, { withSnapshot: true });

    const logId = "dal_" + hex(8);
    let breakId = cur.break_id;
    let lastBreak = null;
    let logArgs;

    if (action === "start") {
      breakId = "brk_" + hex(6);
      const up = (await client.query(
        `UPDATE doctor_availability
            SET status='on_break', break_id=$2, reason=$3, custom_reason=$4,
                started_at=clock_timestamp(),
                expected_return_at=clock_timestamp() + make_interval(mins => $5::int),
                overdue_notified_at=NULL, version=version+1, updated_by=$1, updated_at=clock_timestamp()
          WHERE doctor_id=$1 RETURNING *`,
        [doctorId, breakId, v.reason, v.customReason, v.minutes]
      )).rows[0];
      logArgs = { reason: v.reason, custom: v.customReason, minutes: v.minutes, started: up.started_at, expected: up.expected_return_at, actual: null, dur: null };
    } else if (action === "extend") {
      const up = (await client.query(
        `UPDATE doctor_availability
            SET expected_return_at = GREATEST(COALESCE(expected_return_at, clock_timestamp()), clock_timestamp())
                                     + make_interval(mins => $2::int),
                overdue_notified_at=NULL, version=version+1, updated_by=$1, updated_at=clock_timestamp()
          WHERE doctor_id=$1 RETURNING *`,
        [doctorId, v.minutes]
      )).rows[0];
      logArgs = { reason: cur.reason, custom: cur.custom_reason, minutes: v.minutes, started: up.started_at, expected: up.expected_return_at, actual: null, dur: null };
    } else { // resume
      const up = (await client.query(
        `UPDATE doctor_availability
            SET status='available', break_id=NULL, reason=NULL, custom_reason=NULL,
                started_at=NULL, expected_return_at=NULL, overdue_notified_at=NULL,
                version=version+1, updated_by=$1, updated_at=clock_timestamp()
          WHERE doctor_id=$1 RETURNING *, clock_timestamp() AS resumed_at`,
        [doctorId]
      )).rows[0];
      const dur = Math.max(0, Math.round((new Date(up.resumed_at) - new Date(cur.started_at)) / 1000));
      logArgs = { reason: cur.reason, custom: cur.custom_reason, minutes: null, started: cur.started_at, expected: cur.expected_return_at, actual: up.resumed_at, dur };
      lastBreak = { reason: cur.reason, customReason: cur.custom_reason, startedAt: new Date(cur.started_at).toISOString(), resumedAt: new Date(up.resumed_at).toISOString(), durationSeconds: dur };
    }

    await client.query(
      `INSERT INTO doctor_availability_log
         (id, doctor_id, hospital_id, break_id, action, reason, custom_reason, minutes,
          started_at, expected_return_at, actual_return_at, duration_seconds, actor_id, actor_role, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [logId, doctorId, dRow.hospital_id, breakId, action, logArgs.reason, logArgs.custom, logArgs.minutes,
       logArgs.started, logArgs.expected, logArgs.actual, logArgs.dur, doctorId, "doctor", key]
    );
    await client.query("COMMIT"); began = false;

    const snapshot = await loadSnapshot(doctorId);
    afterChange({ action, doctorId, hospitalId: dRow.hospital_id, doctorName: dRow.name, snapshot, logId, lastReason: cur.reason }).catch(() => {});
    return { availability: snapshot, lastBreak };
  } catch (err) {
    if (began) { try { await client.query("ROLLBACK"); } catch (_) {} }
    throw err;
  } finally {
    client.release();
  }
}

function transitionRoute(action) {
  return async (req, res) => {
    try {
      res.json(await runTransition(req, action));
    } catch (err) {
      const status = err.status || 500;
      const out = { error: status === 500 ? "Could not update availability. Please try again." : err.message };
      if (status === 500) console.error("[availability " + action + "]", err.message);
      if (err.withSnapshot) { try { out.availability = await loadSnapshot(req.user.doctorId); } catch (_) {} }
      res.status(status).json(out);
    }
  };
}
router.post("/start",  requireDoctorSelf, transitionRoute("start"));
router.post("/extend", requireDoctorSelf, transitionRoute("extend"));
router.post("/resume", requireDoctorSelf, transitionRoute("resume"));

// ── Public read: patients' live tracking and doctor lists ────────────────────
router.get("/doctor/:doctorId", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    res.json({ availability: await loadSnapshot(req.params.doctorId) });
  } catch (err) {
    console.error("[availability GET]", err.message);
    res.status(500).json({ error: "Could not load availability" });
  }
});

// ── Audit history ────────────────────────────────────────────────────────────
router.get("/history/:doctorId", requireAuth, async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const u = req.user;
    const { rows: d } = await pool.query("SELECT hospital_id FROM doctors WHERE id=$1", [req.params.doctorId]);
    if (!d[0]) return res.status(404).json({ error: "Doctor not found" });
    const ok = u.role === "admin"
      || (u.role === "doctor" && u.doctorId === req.params.doctorId)
      || ((u.role === "hospital_admin" || u.role === "front_office") && u.hospitalId === d[0].hospital_id);
    if (!ok) return res.status(403).json({ error: "Not allowed" });
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const { rows } = await pool.query(
      `SELECT id, break_id, action, reason, custom_reason, minutes, started_at, expected_return_at,
              actual_return_at, duration_seconds, actor_role, at
         FROM doctor_availability_log WHERE doctor_id=$1 ORDER BY at DESC LIMIT $2`,
      [req.params.doctorId, limit]
    );
    res.json({ history: rows });
  } catch (err) {
    console.error("[availability history]", err.message);
    res.status(500).json({ error: "Could not load history" });
  }
});

// ── "Doctor has not returned" — runs once a minute, notifies once per overdue break ──
async function checkOverdue() {
  const { rows } = await pool.query(
    `UPDATE doctor_availability SET overdue_notified_at = clock_timestamp()
      WHERE status='on_break' AND expected_return_at IS NOT NULL
        AND expected_return_at < clock_timestamp() AND overdue_notified_at IS NULL
      RETURNING doctor_id, break_id, reason, custom_reason, started_at, expected_return_at`
  );
  for (const r of rows) {
    try {
      const d = (await pool.query("SELECT hospital_id, name FROM doctors WHERE id=$1", [r.doctor_id])).rows[0];
      if (!d) continue;
      const logId = "dal_" + hex(8);
      await pool.query(
        `INSERT INTO doctor_availability_log (id, doctor_id, hospital_id, break_id, action, reason, custom_reason, started_at, expected_return_at, actor_role)
         VALUES ($1,$2,$3,$4,'overdue',$5,$6,$7,$8,'system')`,
        [logId, r.doctor_id, d.hospital_id, r.break_id, r.reason, r.custom_reason, r.started_at, r.expected_return_at]
      );
      const snapshot = await loadSnapshot(r.doctor_id);
      const payload = { type: "availability_update", availability: snapshot, event: { id: logId, action: "overdue" } };
      const today = todayIST();
      for (const s of SESSIONS) broadcast(`${r.doctor_id}_${today}_${s}`, payload);
      broadcast(`avail_doctor_${r.doctor_id}`, payload);
      if (d.hospital_id) broadcast(`avail_hospital_${d.hospital_id}`, payload);
      pushToWaitingPatients({ action: "overdue", doctorId: r.doctor_id, doctorName: d.name, snapshot, lastReason: r.reason })
        .catch((e) => console.error("[availability] overdue push failed:", e.message));
    } catch (e) { console.error("[availability] overdue handling failed:", e.message); }
  }
}
if (!global.__availabilityOverdueTimer) {
  global.__availabilityOverdueTimer = setInterval(() => {
    checkOverdue().catch((e) => console.error("[availability] overdue check failed:", e.message));
  }, 60 * 1000);
  global.__availabilityOverdueTimer.unref();
}

module.exports = router;
