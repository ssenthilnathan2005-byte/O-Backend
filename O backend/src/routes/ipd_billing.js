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
  ALTER TABLE inward_patients ADD COLUMN IF NOT EXISTS discount_type TEXT NOT NULL DEFAULT 'amount';
  ALTER TABLE inward_patients ADD COLUMN IF NOT EXISTS cgst_rate NUMERIC(5,2) NOT NULL DEFAULT 0;
  ALTER TABLE inward_patients ADD COLUMN IF NOT EXISTS sgst_rate NUMERIC(5,2) NOT NULL DEFAULT 0;
  ALTER TABLE inward_patients ADD COLUMN IF NOT EXISTS invoice_no TEXT;
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

pool.query(`
  CREATE TABLE IF NOT EXISTS ipd_bill_audit (
    id          TEXT PRIMARY KEY,
    inward_id   TEXT NOT NULL,
    hospital_id TEXT NOT NULL,
    action      TEXT NOT NULL,
    detail      JSONB,
    reason      TEXT,
    by_user     TEXT,
    by_role     TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_ipdaudit_inward ON ipd_bill_audit(inward_id);
`).catch((e) => console.warn("[ipd_billing] audit migration:", e.message));

pool.query(`
  CREATE TABLE IF NOT EXISTS ipd_transfers (
    id             TEXT PRIMARY KEY,
    inward_id      TEXT NOT NULL,
    hospital_id    TEXT NOT NULL,
    from_ward      TEXT,
    from_bed       TEXT,
    to_ward        TEXT NOT NULL,
    to_bed         TEXT NOT NULL,
    to_rate        NUMERIC(10,2) NOT NULL DEFAULT 0,
    reason         TEXT,
    by_user        TEXT,
    by_role        TEXT,
    transferred_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_ipdtr_inward ON ipd_transfers(inward_id);
  CREATE OR REPLACE FUNCTION ipd_bed_segments(p_id TEXT)
  RETURNS TABLE(seg_no INT, seg_ward TEXT, seg_rate NUMERIC, seg_start DATE, seg_days INT)
  LANGUAGE sql STABLE AS $fn$
    WITH ip AS (
      SELECT i.hospital_id, i.ward AS cur_ward, i.bed_rate,
             (i.admitted_at AT TIME ZONE 'Asia/Kolkata')::date AS a,
             (COALESCE(i.discharged_at, now()) AT TIME ZONE 'Asia/Kolkata')::date AS e
        FROM inward_patients i WHERE i.id = p_id
    ),
    tr AS (
      SELECT t.to_ward, t.to_rate, t.from_ward,
             (t.transferred_at AT TIME ZONE 'Asia/Kolkata')::date AS d,
             (row_number() OVER (ORDER BY t.transferred_at, t.id))::int AS n
        FROM ipd_transfers t WHERE t.inward_id = p_id
    ),
    seg AS (
      SELECT 0 AS sn,
             COALESCE((SELECT x.from_ward FROM tr x WHERE x.n = 1), ip.cur_ward) AS sw,
             COALESCE(ip.bed_rate,
                      (SELECT w.daily_rate FROM wards w WHERE w.hospital_id = ip.hospital_id AND w.name = ip.cur_ward LIMIT 1),
                      0)::numeric AS sr,
             ip.a AS sd,
             COALESCE((SELECT x.d FROM tr x WHERE x.n = 1), ip.e + 1) AS nd
        FROM ip
      UNION ALL
      SELECT t.n, t.to_ward, t.to_rate::numeric, t.d,
             COALESCE((SELECT x.d FROM tr x WHERE x.n = t.n + 1), (SELECT ip2.e + 1 FROM ip ip2))
        FROM tr t
    )
    SELECT sn, sw, sr, sd, GREATEST(nd - sd, 0)::int FROM seg ORDER BY sn
  $fn$;
`).catch((e) => console.warn("[ipd_billing] transfer migration:", e.message));


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
  let invoiceNo = stay.invoice_no || null;
  if (!invoiceNo && stay.status === "discharged") {
    const d = new Date(stay.discharged_at || Date.now()).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }).replace(/-/g, "");
    invoiceNo = "IPD-" + d + "-" + randomBytes(2).toString("hex").toUpperCase();
    const up = await db.query(
      "UPDATE inward_patients SET invoice_no=$1 WHERE id=$2 AND invoice_no IS NULL RETURNING invoice_no", [invoiceNo, stay.id]);
    if (!up.rows.length) {
      const cur = await db.query("SELECT invoice_no FROM inward_patients WHERE id=$1", [stay.id]);
      invoiceNo = cur.rows[0] && cur.rows[0].invoice_no;
    }
  }
  const { rows: hosp } = await db.query("SELECT name, address, phone FROM hospitals WHERE id=$1", [stay.hospital_id]);
  const { rows: items } = await db.query(
    "SELECT * FROM ipd_bill_items WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]);
  const { rows: pays } = await db.query(
    "SELECT * FROM ipd_payments WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]);
  const { rows: segRows } = await db.query(
    "SELECT seg_no, seg_ward, seg_rate, seg_start::text AS seg_start, seg_days FROM ipd_bed_segments($1) ORDER BY seg_no", [stay.id]);
  const moved = segRows.length > 1;
  const segments = moved ? segRows.filter((s) => Number(s.seg_days) > 0).map((s) => ({
    ward: s.seg_ward, rate: num(s.seg_rate), days: Number(s.seg_days), from: s.seg_start,
    amount: money(num(s.seg_rate) * Number(s.seg_days)),
  })) : [];
  if (moved) rate = num(segRows[segRows.length - 1].seg_rate);
  const bedCharge = moved ? money(segments.reduce((s, x) => s + x.amount, 0)) : money(rate * stay.days);
  const itemsTotal = money(items.reduce((s, i) => s + num(i.amount), 0));
  const subtotal = money(bedCharge + itemsTotal);
  const discountType = stay.discount_type === "percent" ? "percent" : "amount";
  const discountValue = money(stay.bill_discount);
  const discount = discountType === "percent"
    ? money(Math.min(subtotal, (subtotal * Math.min(discountValue, 100)) / 100))
    : Math.min(discountValue, subtotal);
  const taxable = money(subtotal - discount);
  const cgstRate = num(stay.cgst_rate);
  const sgstRate = num(stay.sgst_rate);
  const cgst = money((taxable * cgstRate) / 100);
  const sgst = money((taxable * sgstRate) / 100);
  const total = money(taxable + cgst + sgst);
  const paid = money(pays.reduce((s, p) => s + (p.kind === "refund" ? -num(p.amount) : num(p.amount)), 0));
  return {
    inwardId: stay.id, hospitalId: stay.hospital_id, patientName: stay.patient_name, phone: stay.phone,
    ward: stay.ward, bedNumber: stay.bed_number, doctor: stay.admitting_doctor_name,
    invoiceNo, hospitalName: hosp[0]?.name || null, hospitalAddress: hosp[0]?.address || null, hospitalPhone: hosp[0]?.phone || null,
    status: stay.status, admittedAt: stay.admitted_at, dischargedAt: stay.discharged_at,
    days: stay.days, bedRate: rate, bedCharge, segments,
    items: items.map((i) => ({ ...i, qty: num(i.qty), unit_price: num(i.unit_price), amount: num(i.amount) })),
    payments: pays.map((p) => ({ ...p, amount: num(p.amount) })),
    itemsTotal, subtotal, discount, discountType, discountValue, taxable, cgstRate, sgstRate, cgst, sgst, total, paid, balance: money(total - paid),
  };
}

// Bill lock: once discharged, only the hospital admin may change a bill, and must say why.
// opts.always = require a reason and log even before discharge (used for removing payments).
async function guardEdit(req, res, stay, action, detail, opts) {
  const o = opts || {};
  const discharged = stay.status === "discharged";
  if (!discharged && !o.always) return true;
  const isAdmin = req.user.role === "hospital_admin" || req.user.role === "admin";
  if (discharged && !isAdmin) {
    res.status(403).json({ error: "This bill is closed. Only the hospital admin can change it after discharge." });
    return false;
  }
  const reason = String((req.body && req.body.reason) || (req.query && req.query.reason) || "").trim().slice(0, 300);
  if (reason.length < 3) {
    res.status(400).json({ error: "Please give a reason for this change (at least 3 characters).", reasonRequired: true });
    return false;
  }
  await pool.query(
    "INSERT INTO ipd_bill_audit (id, inward_id, hospital_id, action, detail, reason, by_user, by_role) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8)",
    [nid("iba_"), stay.id, stay.hospital_id, action, JSON.stringify(detail || {}), reason, req.user.id, req.user.role]);
  return true;
}

// GET /ipd-billing/summary — collections and outstanding balances for the hospital
router.get("/summary", requireAuth, staff, async (req, res) => {
  try {
    const hid = hospitalOf(req);
    if (!hid) return res.status(400).json({ error: "hospitalId required" });
    const net = "CASE WHEN kind='refund' THEN -amount ELSE amount END";
    const { rows: c } = await pool.query(
      `SELECT
         COALESCE(SUM(${net}) FILTER (WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date), 0) AS today,
         COALESCE(SUM(${net}) FILTER (WHERE date_trunc('month', created_at AT TIME ZONE 'Asia/Kolkata') = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')), 0) AS month
         FROM ipd_payments WHERE hospital_id=$1`, [hid]);
    const { rows: st } = await pool.query(
      `WITH s AS (
         SELECT ip.id, ip.patient_name, ip.phone, ip.ward, ip.bed_number, ip.status, ip.discharged_at, ip.bill_discount, ip.discount_type, ip.cgst_rate, ip.sgst_rate,
                CASE WHEN EXISTS (SELECT 1 FROM ipd_transfers tt WHERE tt.inward_id=ip.id) THEN COALESCE((SELECT SUM(g.seg_rate * g.seg_days) FROM ipd_bed_segments(ip.id) g), 0) ELSE COALESCE(ip.bed_rate, (SELECT w.daily_rate FROM wards w WHERE w.hospital_id=ip.hospital_id AND w.name=ip.ward LIMIT 1), 0)
                * (((COALESCE(ip.discharged_at, now()) AT TIME ZONE 'Asia/Kolkata')::date - (ip.admitted_at AT TIME ZONE 'Asia/Kolkata')::date) + 1) END AS bed,
                COALESCE((SELECT SUM(amount) FROM ipd_bill_items i WHERE i.inward_id=ip.id), 0) AS items,
                COALESCE((SELECT SUM(CASE WHEN p.kind='refund' THEN -p.amount ELSE p.amount END) FROM ipd_payments p WHERE p.inward_id=ip.id), 0) AS paid
           FROM inward_patients ip WHERE ip.hospital_id=$1),
       b AS (SELECT s.*, (bed + items) AS sub,
                    CASE WHEN discount_type = 'percent'
                         THEN ROUND(LEAST(bed + items, (bed + items) * LEAST(bill_discount, 100) / 100), 2)
                         ELSE LEAST(bill_discount, bed + items) END AS disc
               FROM s),
       f AS (SELECT b.*, (sub - disc) + ROUND((sub - disc) * cgst_rate / 100, 2)
                              + ROUND((sub - disc) * sgst_rate / 100, 2) AS tot
               FROM b)
       SELECT id, patient_name, phone, ward, bed_number, status, discharged_at, tot AS total, paid, tot - paid AS balance FROM f WHERE tot - paid > 0
        ORDER BY (status='discharged') DESC, 10 DESC LIMIT 50`, [hid]);
    res.set("Cache-Control", "no-store");
    res.json({
      collectedToday: money(c[0].today), collectedMonth: money(c[0].month),
      outstandingTotal: money(st.reduce((a, r) => a + num(r.balance), 0)),
      outstanding: st.map((r) => ({
        inwardId: r.id, patientName: r.patient_name, phone: r.phone, ward: r.ward, bedNumber: r.bed_number,
        status: r.status, dischargedAt: r.discharged_at, total: money(r.total), paid: money(r.paid), balance: money(r.balance),
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /ipd-billing/report?from=YYYY-MM-DD&to=YYYY-MM-DD — IPD money collected per day (net of refunds), for the Billing page
router.get("/report", requireAuth, staff, async (req, res) => {
  try {
    const hid = hospitalOf(req);
    if (!hid) return res.status(400).json({ error: "hospitalId required" });
    const isYmd = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
    const from = isYmd(req.query.from) ? req.query.from : null;
    const to = isYmd(req.query.to) ? req.query.to : null;
    const net = "CASE WHEN kind='refund' THEN -amount ELSE amount END";
    const day = "(created_at AT TIME ZONE 'Asia/Kolkata')::date";
    const { rows } = await pool.query(
      `SELECT to_char(${day}, 'YYYY-MM-DD') AS day,
              COALESCE(SUM(${net}), 0) AS amount,
              COALESCE(SUM(amount) FILTER (WHERE kind='refund'), 0) AS refunds,
              COUNT(DISTINCT inward_id) AS patients
         FROM ipd_payments
        WHERE hospital_id=$1
          AND ($2::date IS NULL OR ${day} >= $2::date)
          AND ($3::date IS NULL OR ${day} <= $3::date)
        GROUP BY 1 ORDER BY 1`, [hid, from, to]);
    const { rows: pt } = await pool.query(
      `SELECT COUNT(DISTINCT inward_id) AS patients
         FROM ipd_payments
        WHERE hospital_id=$1
          AND ($2::date IS NULL OR ${day} >= $2::date)
          AND ($3::date IS NULL OR ${day} <= $3::date)`, [hid, from, to]);
    res.set("Cache-Control", "no-store");
    res.json({
      collected: money(rows.reduce((a, r) => a + num(r.amount), 0)),
      refunds: money(rows.reduce((a, r) => a + num(r.refunds), 0)),
      patients: Number(pt[0].patients) || 0,
      perDay: rows.map((r) => ({ date: r.day, amount: money(r.amount), patients: Number(r.patients) || 0 })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// GET /ipd-billing/my/:inwardId — the patient's own bill (read only)
router.get("/my/:inwardId", requireAuth, async (req, res) => {
  if (req.user.role !== "patient") return res.status(403).json({ error: "Forbidden" });
  try {
    const { rows: u } = await pool.query("SELECT phone FROM users WHERE id=$1", [req.user.id]);
    const last10 = String((u[0] && u[0].phone) || req.user.phone || "").replace(/\D/g, "").slice(-10);
    const { rows } = await pool.query(
      `SELECT id, hospital_id FROM inward_patients
        WHERE id=$1 AND (patient_user_id=$2
           OR ($3::text <> '' AND right(regexp_replace(COALESCE(phone,''), '\\D', '', 'g'), 10) = $3))`,
      [req.params.inwardId, req.user.id, last10]);
    if (!rows.length) return res.status(404).json({ error: "Bill not found" });
    const stay = await loadStay(pool, rows[0].id, rows[0].hospital_id);
    res.set("Cache-Control", "no-store");
    res.json(await buildBill(pool, stay));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
    if (!(await guardEdit(req, res, stay, "settings", { bedRate: (req.body || {}).bedRate, discount: (req.body || {}).discount, discountType: (req.body || {}).discountType, cgstRate: (req.body || {}).cgstRate, sgstRate: (req.body || {}).sgstRate }))) return;
    const b = req.body || {};
    if (b.bedRate !== undefined) {
      const r = Number(b.bedRate);
      if (!(r >= 0)) return res.status(400).json({ error: "Enter a valid bed rate" });
      const tr = await pool.query(
        "UPDATE ipd_transfers SET to_rate=$1 WHERE id=(SELECT id FROM ipd_transfers WHERE inward_id=$2 ORDER BY transferred_at DESC, id DESC LIMIT 1) RETURNING id",
        [money(r), stay.id]);
      if (!tr.rows.length) await pool.query("UPDATE inward_patients SET bed_rate=$1 WHERE id=$2", [money(r), stay.id]);
    }
    if (b.discount !== undefined || b.discountType !== undefined) {
      const type = b.discountType === "percent" ? "percent"
        : b.discountType === "amount" ? "amount"
        : (stay.discount_type === "percent" ? "percent" : "amount");
      const d = b.discount !== undefined ? Number(b.discount) : num(stay.bill_discount);
      if (!(d >= 0)) return res.status(400).json({ error: "Enter a valid discount" });
      if (type === "percent" && d > 100) return res.status(400).json({ error: "Percentage discount cannot be more than 100" });
      await pool.query("UPDATE inward_patients SET bill_discount=$1, discount_type=$2 WHERE id=$3", [money(d), type, stay.id]);
    }
    for (const [key, col] of [["cgstRate", "cgst_rate"], ["sgstRate", "sgst_rate"]]) {
      if (b[key] !== undefined) {
        const r = Number(b[key]);
        if (!(r >= 0 && r <= 100)) return res.status(400).json({ error: "Enter a tax rate between 0 and 100" });
        await pool.query("UPDATE inward_patients SET " + col + "=$1 WHERE id=$2", [money(r), stay.id]);
      }
    }
    res.json(await buildBill(pool, await loadStay(pool, stay.id, stay.hospital_id)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /ipd-billing/:inwardId/items — add a charge
router.post("/:inwardId/items", requireAuth, staff, async (req, res) => {
  try {
    const stay = await loadStay(pool, req.params.inwardId, hospitalOf(req));
    if (!stay) return res.status(404).json({ error: "Admission not found" });
    if (!(await guardEdit(req, res, stay, "item_add", { description: (req.body || {}).description, qty: (req.body || {}).qty, unitPrice: (req.body || {}).unitPrice }))) return;
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
    if (!(await guardEdit(req, res, stay, "item_remove", { itemId: req.params.itemId }))) return;
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
    if (kind === "refund") {
      const { rows: pr } = await pool.query(
        "SELECT COALESCE(SUM(CASE WHEN kind='refund' THEN -amount ELSE amount END), 0) AS net FROM ipd_payments WHERE inward_id=$1", [stay.id]);
      if (amt > num(pr[0].net)) return res.status(400).json({ error: "Refund is more than the patient has paid (net paid: Rs. " + num(pr[0].net) + ")." });
      if (!(await guardEdit(req, res, stay, "refund", { amount: amt, mode }))) return;
    }
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
    if (!(await guardEdit(req, res, stay, "payment_remove", { paymentId: req.params.paymentId }, { always: true }))) return;
    await pool.query("DELETE FROM ipd_payments WHERE id=$1 AND inward_id=$2", [req.params.paymentId, stay.id]);
    res.json(await buildBill(pool, stay));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Used by the discharge checks (inward.js, wards.js) and the Beds & Wards screens.
router.billStatus = async (db, inwardId, hospitalId) => {
  const stay = await loadStay(db, inwardId, hospitalId);
  if (!stay) return null;
  const b = await buildBill(db, stay);
  return { total: b.total, paid: b.paid, balance: b.balance, isPaid: b.balance <= 0.009 };
};

module.exports = router;
