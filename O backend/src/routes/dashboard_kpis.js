"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
    return res.status(403).json({ error: "Forbidden" });
  next();
}

// Run one query; if it fails, that KPI becomes null instead of breaking the dashboard.
async function safe(fn) {
  try { return await fn(); } catch (e) { console.warn("[dashboard_kpis]", e.message); return null; }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addDays(s, n) {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function dayCount(from, to) {
  return Math.round((new Date(to + "T00:00:00Z") - new Date(from + "T00:00:00Z")) / 86400000) + 1;
}

const REVENUE_SQL =
  "SELECT COALESCE(SUM(COALESCE(d.doctor_fee, 0)), 0) AS total " +
  "FROM bookings b JOIN doctors d ON d.id = b.doctor_id " +
  "WHERE d.hospital_id = $1 AND b.status = 'completed' AND b.date >= $2 AND b.date <= $3";

const RECEIVABLES_SQL =
  "SELECT COALESCE(SUM(COALESCE(d.doctor_fee, 0)), 0) AS total, COUNT(DISTINCT b.patient_id) AS accounts " +
  "FROM bookings b JOIN doctors d ON d.id = b.doctor_id " +
  "WHERE d.hospital_id = $1 AND b.status = 'completed' AND b.payment_done = 0 " +
  "AND b.date >= $2 AND b.date <= $3";

const BOOKINGS_SQL =
  "SELECT COUNT(*) AS total, " +
  "COUNT(*) FILTER (WHERE b.status = 'completed') AS completed, " +
  "COUNT(*) FILTER (WHERE b.status = 'unvisited') AS unvisited, " +
  "COUNT(*) FILTER (WHERE b.status = 'confirmed') AS confirmed " +
  "FROM bookings b JOIN doctors d ON d.id = b.doctor_id " +
  "WHERE d.hospital_id = $1 AND b.status <> 'cancelled' AND b.date >= $2 AND b.date <= $3";

const LAB_TAT_SQL =
  "SELECT AVG(EXTRACT(EPOCH FROM (updated_at - ordered_at)) / 60) AS mins " +
  "FROM hospital_lab_orders " +
  "WHERE hospital_id = $1 AND status = 'report_ready' " +
  "AND (ordered_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date";

router.get("/kpis", requireAuth, adminOnly, async (req, res) => {
  try {
    const hospitalId = req.user.role === "admin" ? req.query.hospitalId : req.user.hospitalId;
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });

    let from = req.query.from;
    let to = req.query.to;
    if (!from || !to) {
      const t = (await pool.query(
        "SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM-DD') AS today"
      )).rows[0].today;
      from = from || t;
      to = to || t;
    }
    if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to)
      return res.status(400).json({ error: "Invalid from/to dates" });
    const n = dayCount(from, to);
    if (n > 3660) return res.status(400).json({ error: "Range too large" });

    // Previous period of the same length, right before this one.
    const prevTo = addDays(from, -1);
    const prevFrom = addDays(from, -n);

    const revenue = await safe(async () =>
      Math.round(Number((await pool.query(REVENUE_SQL, [hospitalId, from, to])).rows[0].total)));
    const revenuePrevious = await safe(async () =>
      Math.round(Number((await pool.query(REVENUE_SQL, [hospitalId, prevFrom, prevTo])).rows[0].total)));
    const rec = await safe(async () =>
      (await pool.query(RECEIVABLES_SQL, [hospitalId, from, to])).rows[0]);
    const bk = await safe(async () =>
      (await pool.query(BOOKINGS_SQL, [hospitalId, from, to])).rows[0]);
    const labTatMins = await safe(async () => {
      const m = (await pool.query(LAB_TAT_SQL, [hospitalId, from, to])).rows[0].mins;
      return m === null ? null : Math.round(Number(m));
    });

    res.set("Cache-Control", "no-store");
    res.json({
      revenue,
      revenuePrevious,
      paymentSplit: null,          // no payment-mode data stored yet
      receivables: rec ? Math.round(Number(rec.total)) : null,
      unbilledAccounts: rec ? Number(rec.accounts) : null,
      tpaApproved: null,           // no TPA / claims table yet
      tpaPendingPreAuth: null,
      avgWaitMins: null,           // consultation start time not recorded yet
      dischargesScheduled: null,   // only actual discharges are stored
      dischargesDone: null,
      labTatMins,
      criticalAlerts: null,        // no critical-value flag stored yet
      bookings: bk
        ? { total: Number(bk.total), completed: Number(bk.completed), unvisited: Number(bk.unvisited), confirmed: Number(bk.confirmed) }
        : null,
      from,
      to,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
