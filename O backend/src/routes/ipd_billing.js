"use strict";
// IPD billing (staff side): one bill per admission.
// Bed charge = bed rate x calendar days stayed (IST). Staff add items, take payments, set discount.
const express = require("express");
const { randomBytes } = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { requireAnyPerm } = require("./permissions");

const router = express.Router();
const nid = (p) => p + randomBytes(6).toString("hex");
const staff = requireAnyPerm("billing", "ipd");
const CATEGORIES = ["procedure", "test", "medicine", "doctor_visit", "room_service", "other"];
const MODES = ["cash", "upi", "card", "bank", "insurance", "other"];

pool.query(`
  ALTER TABLE inward_patients ADD COLUMN IF NOT EXISTS bed_rate NUMERIC(10,2);
  ALTER TABLE inward_patients ADD COLUMN IF NOT EXISTS bill_discount NUMERIC(10,2) NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS ipd_bill_items (
    id          TEXT PRIMARY KEY,
    inward_id   TEXT NOT NULL,
    hospital_id TEXT NOT NULL,
    category    TEXT NOT NULL DEFAULT 'other',
    description TEXT NOT NULL,
    qty         NUMERIC(10,2) NOT NULL DEFAULT 1,
    unit_price  NUMERIC(10,2) NOT NULL DEFAULT 0,
    amount      NUMERIC(12,2) NOT NULL DEFAULT 0,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_ipdbi_inward ON ipd_bill_items(inward_id);
  CREATE TABLE IF NOT EXISTS ipd_payments (
    id          TEXT PRIMARY KEY,
    inward_id   TEXT NOT NULL,
    hospital_id TEXT NOT NULL,
    amount      NUMERIC(12,2) NOT NULL,
    kind        TEXT NOT NULL DEFAULT 'payment' CHECK(kind IN ('advance','payment','refund')),
    mode        TEXT NOT NULL DEFAULT 'cash',
    note        TEXT,
    received_by TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_ipdpay_inward ON ipd_payments(inward_id);
`).catch((e) => console.warn("[ipd_billing] migration:", e.message));

const num = (v) => Number(v) || 0;
const money = (v) => Math.round(num(v) * 100) / 100;
const hospitalOf = (req) =>
  req.user.role === "admin" ? (req.body?.hospitalId || req.query.hospitalId) : req.user.hospitalId;

// Load the admission (scoped to the staff member's hospital).
async function loadStay(db, inwardId, hospitalId) {
  const { rows } = await db.query(
    `SELECT ip.*,
            (((COALESCE(ip.discharged_at, now()) AT TIME ZONE 'Asia/Kolkata')::date
              - (ip.admitted_at AT TIME ZONE 'Asia/Kolkata')::date) + 1)::int AS days,
            COALESCE((SELECT w.daily_rate FROM wards w WHERE w.hospital_id=ip.hospital_id AND w.name=ip.ward LIMIT 1), 0) AS ward_rate
       FROM inward_patients ip WHERE ip.id=$1 AND ip.hospital_id=$2`, [inwardId, hospitalId]);
  return rows[0] || null;
}

// Build the full bill. Bed rate is frozen on the stay the first time it is billed.
async function buildBill(db, stay) {
  let rate = stay.bed_rate;
  if (rate === null || rate === undefined) {
    rate = num(stay.ward_rate);
    if (rate > 0) await db.query("UPDATE inward_patients SET bed_rate=$1 WHERE id=$2", [rate, stay.id]);
  }
  rate = num(rate);
  const { rows: items } = await db.query(
    "SELECT * FROM ipd_bill_items WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]);
  const { rows: pays } = await db.query(
    "SELECT * FROM ipd_payments WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]);
  const bedCharge = money(rate * stay.days);
  const itemsTotal = money(items.reduce((s, i) => s + num(i.amount), 0));
  const subtotal = money(bedCharge + itemsTotal);
  const discount = Math.min(money(stay.bill_discount), subtotal);
  const total = money(subtotal - discount);
  const paid = money(pays.reduce((s, p) => s + (p.kind === "refund" ? -num(p.amount) : num(p.amount)), 0));
  return {
    inwardId: stay.id, hospitalId: stay.hospital_id, patientName: stay.patient_name, phone: stay.phone,
    ward: stay.ward, bedNumber: stay.bed_number, doctor: stay.admitting_doctor_name,
    status: stay.status, admittedAt: stay.admitted_at, dischargedAt: stay.discharged_at,
    days: stay.days, bedRate: rate, bedCharge,
    items: items.map((i) => ({ ...i, qty: num(i.qty), unit_price: num(i.unit_price), amount: num(i.amount) })),
    payments: pays.map((p) => ({ ...p, amount: num(p.amount) })),
    itemsTotal, subtotal, discount, total, paid, balance: money(total - paid),
  };
}

// GET /ipd-billing — admissions with running totals (current first)
router.get("/", requireAuth, staff, async (req, res) => {
  try {
    const hid = hospitalOf(req);
    if (!hid) return res.status(400).json({ error: "hospitalId required" });
    const status = req.query.status === "discharged" ? "discharged" : req.query.status === "all" ? null : "admitted";
    const { rows } = await pool.query(
      `SELECT id FROM inward_patients WHERE hospital_id=$1 AND ($2::text IS NULL OR status=$2)
        ORDER BY admitted_at DESC LIMIT 200`, [hid, status]);
    const out = [];
    for (const r of rows) {
      const stay = await loadStay(pool, r.id, hid);
      const b = await buildBill(pool, stay);
      out.push({
        inwardId: b.inwardId, patientName: b.patientName, phone: b.phone, ward: b.ward, bedNumber: b.bedNumber,
        status: b.status, admittedAt: b.admittedAt, dischargedAt: b.dischargedAt, days: b.days,
        total: b.total, paid: b.paid, balance: b.balance,
      });
    }
    res.set("Cache-Control", "no-store");
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /ipd-billing/:inwardId — full bill
router.get("/:inwardId", requireAuth, staff, async (req, res) => {
  try {
    const stay = await loadStay(pool, req.params.inwardId, hospitalOf(req));
    if (!stay) return res.status(404).json({ error: "Admission not found" });
    res.set("Cache-Control", "no-store");
    res.json(await buildBill(pool, stay));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PATCH /ipd-billing/:inwardId/settings — bed rate override and discount
router.patch("/:inwardId/settings", requireAuth, staff, async (req, res) => {
  try {
    const stay = await loadStay(pool, req.params.inwardId, hospitalOf(req));
    if (!stay) return res.status(404).json({ error: "Admission not found" });
    const b = req.body || {};
    if (b.bedRate !== undefined) {
      const r = Number(b.bedRate);
      if (!(r >= 0)) return res.status(400).json({ error: "Enter a valid bed rate" });
      await pool.query("UPDATE inward_patients SET bed_rate=$1 WHERE id=$2", [money(r), stay.id]);
    }
    if (b.discount !== undefined) {
      const d = Number(b.discount);
      if (!(d >= 0)) return res.status(400).json({ error: "Enter a valid discount" });
      await pool.query("UPDATE inward_patients SET bill_discount=$1 WHERE id=$2", [money(d), stay.id]);
    }
    res.json(await buildBill(pool, await loadStay(pool, stay.id, stay.hospital_id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /ipd-billing/:inwardId/items — add a charge
router.post("/:inwardId/items", requireAuth, staff, async (req, res) => {
  try {
    const stay = await loadStay(pool, req.params.inwardId, hospitalOf(req));
    if (!stay) return res.status(404).json({ error: "Admission not found" });
    const b = req.body || {};
    const desc = String(b.description || "").trim().slice(0, 200);
    const qty = b.qty === undefined || b.qty === "" ? 1 : Number(b.qty);
    const price = Number(b.unitPrice);
    if (!desc) return res.status(400).json({ error: "Description is required" });
    if (!(qty > 0)) return res.status(400).json({ error: "Enter a valid quantity" });
    if (!(price >= 0)) return res.status(400).json({ error: "Enter a valid price" });
    const cat = CATEGORIES.includes(b.category) ? b.category : "other";
    await pool.query(
      `INSERT INTO ipd_bill_items (id, inward_id, hospital_id, category, description, qty, unit_price, amount, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [nid("ibi_"), stay.id, stay.hospital_id, cat, desc, qty, money(price), money(qty * price), req.user.id]);
    res.status(201).json(await buildBill(pool, stay));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /ipd-billing/:inwardId/items/:itemId
router.delete("/:inwardId/items/:itemId", requireAuth, staff, async (req, res) => {
  try {
    const stay = await loadStay(pool, req.params.inwardId, hospitalOf(req));
    if (!stay) return res.status(404).json({ error: "Admission not found" });
    await pool.query("DELETE FROM ipd_bill_items WHERE id=$1 AND inward_id=$2", [req.params.itemId, stay.id]);
    res.json(await buildBill(pool, stay));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /ipd-billing/:inwardId/payments — advance, payment or refund
router.post("/:inwardId/payments", requireAuth, staff, async (req, res) => {
  try {
    const stay = await loadStay(pool, req.params.inwardId, hospitalOf(req));
    if (!stay) return res.status(404).json({ error: "Admission not found" });
    const b = req.body || {};
    const amt = Number(b.amount);
    if (!(amt > 0)) return res.status(400).json({ error: "Enter a valid amount" });
    const kind = ["advance", "payment", "refund"].includes(b.kind) ? b.kind : "payment";
    const mode = MODES.includes(b.mode) ? b.mode : "cash";
    await pool.query(
      `INSERT INTO ipd_payments (id, inward_id, hospital_id, amount, kind, mode, note, received_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [nid("ipy_"), stay.id, stay.hospital_id, money(amt), kind, mode,
       b.note ? String(b.note).slice(0, 200) : null, req.user.id]);
    res.status(201).json(await buildBill(pool, stay));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// DELETE /ipd-billing/:inwardId/payments/:paymentId — hospital admin only (corrections)
router.delete("/:inwardId/payments/:paymentId", requireAuth, staff, async (req, res) => {
  try {
    if (req.user.role !== "hospital_admin" && req.user.role !== "admin")
      return res.status(403).json({ error: "Only the hospital admin can remove a payment" });
    const stay = await loadStay(pool, req.params.inwardId, hospitalOf(req));
    if (!stay) return res.status(404).json({ error: "Admission not found" });
    await pool.query("DELETE FROM ipd_payments WHERE id=$1 AND inward_id=$2", [req.params.paymentId, stay.id]);
    res.json(await buildBill(pool, stay));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
