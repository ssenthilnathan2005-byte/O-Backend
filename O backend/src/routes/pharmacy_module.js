const respCache = require("../utils/respCache");
"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { hasAnyPerm } = require("./permissions");
const { broadcast } = require("../services/ws");
const { randomBytes } = require("crypto");
const margin = require("../services/margin");
const gstRules = require("../services/gstRules");
const gstAudit = require("../services/gstAudit");
const { ready: batchesReady, takeFromBatches, addBatch } = require("../services/batches");
const router = express.Router();
router.use(respCache);

pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS batch_no TEXT")
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expiry_date DATE"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS selling_price REAL"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS med_category TEXT"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS strips_per_box INTEGER"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS schedule TEXT"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS gst_percent REAL"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS hsn_code TEXT"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS brand_name TEXT"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS other_direct_cost REAL"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purchase_discount_pct REAL"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS purchase_includes_gst BOOLEAN"))
  .then(() => pool.query("CREATE TABLE IF NOT EXISTS pharmacy_med_categories (hospital_id TEXT NOT NULL, name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (hospital_id, name))"))
  .then(() => pool.query("ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS payment_mode TEXT"))
  .catch(e => console.warn("[pharmacy_module] migration:", e.message));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MED_CATEGORIES = ["Tablet", "Capsule", "Syrup/Tonic", "Injection", "Oil", "Ointment/Cream", "Drops", "Powder", "Others"];

// Brand name (e.g. "Dolo" for Paracetamol 500mg). Optional. Returns { value } (null when blank) or { error }.
function cleanBrand(raw) {
  if (raw === undefined || raw === null) return { value: null };
  const v = String(raw).replace(/\s+/g, " ").trim();
  if (!v) return { value: null };
  if (v.length > 100) return { error: "Brand name must be 100 characters or less" };
  if (/[<>]/.test(v)) return { error: "Brand name has invalid characters" };
  return { value: v };
}

// Returns { value } with the canonical category name (null when blank) or { error }.
// A new custom name is saved per hospital so it appears in the dropdown next time.
async function resolveCategory(db, hid, raw) {
  if (raw === undefined || raw === null) return { value: null };
  const name = String(raw).replace(/\s+/g, " ").trim();
  if (!name) return { value: null };
  if (name.length > 40) return { error: "Category name must be 40 characters or less" };
  if (/[<>]/.test(name)) return { error: "Category name has invalid characters" };
  const std = MED_CATEGORIES.find(c => c.toLowerCase() === name.toLowerCase());
  if (std) return { value: std };
  const ex = await db.query("SELECT name FROM pharmacy_med_categories WHERE hospital_id=$1 AND lower(name)=lower($2)", [hid, name]);
  if (ex.rows.length) return { value: ex.rows[0].name };
  const cnt = await db.query("SELECT COUNT(*)::int AS n FROM pharmacy_med_categories WHERE hospital_id=$1", [hid]);
  if (cnt.rows[0].n >= 100) return { error: "Custom category limit reached" };
  await db.query("INSERT INTO pharmacy_med_categories (hospital_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [hid, name]);
  return { value: name };
}
const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
function addDays(s, n) {
  const d = new Date(s + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
async function todayIST() {
  return (await pool.query("SELECT to_char(now() AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS t")).rows[0].t;
}
async function getRange(req) {
  let { from, to } = req.query;
  const t = await todayIST();
  from = from || t; to = to || t;
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) return null;
  if ((new Date(to) - new Date(from)) / 86400000 > 3660) return null;
  return [from, to];
}

async function scope(req, res, next) {
  const role = req.user.role;
  if (role !== "pharmacy" && role !== "hospital_admin" && role !== "admin" && !(await hasAnyPerm(req, ["pharmacy"])))
    return res.status(403).json({ error: "Forbidden" });
  const hid = role === "admin" ? req.query.hospitalId : req.user.hospitalId;
  if (!hid) return res.status(400).json({ error: "hospitalId required" });
  req.hid = hid;
  next();
}
const guard = [requireAuth, scope];

const HANDED_WHERE =
  "hospital_id=$1 AND status='handed_over' AND handed_over_at IS NOT NULL " +
  "AND (handed_over_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date";

async function invMap(hid) {
  const { rows } = await pool.query(
    "SELECT id, name, purchase_price, selling_price, pack_size, gst_percent, other_direct_cost, purchase_discount_pct, purchase_includes_gst FROM inventory_items WHERE hospital_id=$1", [hid]);
  const m = {};
  for (const r of rows) m[r.id] = r;
  return m;
}
function parse(s) { try { return JSON.parse(s || "[]"); } catch (_) { return []; } }

// Per-line amounts for one prescription. Uses selling price when set,
// otherwise shares the entered bill amount by tablets.
function lineAmounts(rx, inv) {
  const lines = parse(rx.dispensed_items);
  const hasBill = rx.bill_amount != null && rx.bill_amount !== "";
  const bill = Number(rx.bill_amount) || 0;
  const isPriced = l => l.unitPrice != null && l.unitPrice !== "" && Number.isFinite(Number(l.unitPrice));
  const pricedSum = lines.reduce((s, l) => s + (isPriced(l) ? (Number(l.tablets) || 0) * Number(l.unitPrice) : 0), 0);
  const unpriced = lines.filter(l => !isPriced(l));
  const unpricedTabs = unpriced.reduce((s, l) => s + (Number(l.tablets) || 0), 0);
  const remainder = Math.max(0, r2(bill - pricedSum));
  let left = remainder, seen = 0;
  return lines.map(l => {
    const tabs = Number(l.tablets) || 0;
    const it = inv[l.inventoryItemId];
    const pack = Number(it && it.pack_size) || 1;
    const sp = Number(it && it.selling_price) || 0;
    const cp = Number(it && it.purchase_price) || 0;
    let unitPrice, amount, priceSource;
    if (isPriced(l)) {
      unitPrice = Number(l.unitPrice); amount = tabs * unitPrice; priceSource = "billed";
    } else if (hasBill) {
      seen++;
      amount = (seen === unpriced.length || !unpricedTabs) ? left : r2(remainder * tabs / unpricedTabs);
      left = r2(left - amount);
      unitPrice = tabs ? amount / tabs : 0; priceSource = "bill-share";
    } else if (sp > 0) {
      unitPrice = sp / pack; amount = tabs * unitPrice; priceSource = "inventory";
    } else {
      unitPrice = 0; amount = 0; priceSource = "none";
    }
    return {
      name: l.inventoryName || l.name, tablets: tabs,
      unitPrice: r2(unitPrice), amount: r2(amount), priceSource,
      cost: r2(tabs * (cp / pack)),
    };
  });
}

// Is this pharmacy GST-registered? Decides whether GST is taken out of revenue (see services/margin.js).
async function isGstRegistered(hid) {
  try {
    const { rows } = await pool.query("SELECT gst_type, gstin FROM pharmacy_gst_profile WHERE hospital_id=$1", [hid]);
    const p = rows[0] || {};
    return (p.gst_type || (p.gstin ? "registered" : "")) === "registered";
  } catch (_) { return false; }
}

// Invoice rates normally include GST, so a medicine counts as "purchase price includes GST" unless it was set to false.
const inclGst = v => v !== false;

// Margin for every medicine line of one handed-over prescription.
// The final bill (after any discount, GST-inclusive) is spread over the lines in proportion to their amounts,
// the same way the tax invoice does it, so the lines always add up to the bill that the Revenue card counts.
function rxMargin(rx, inv, registered) {
  const lines = parse(rx.dispensed_items);
  const la = lineAmounts(rx, inv);
  const bill = Number(rx.bill_amount) || 0;
  const sum = la.reduce((s, l) => s + l.amount, 0);
  const tabs = la.reduce((s, l) => s + l.tablets, 0);
  const out = la.map((l, i) => {
    const raw = lines[i] || {};
    const it = inv[raw.inventoryItemId] || null;
    const pack = Number(it && it.pack_size) || 1;
    const share = sum > 0 ? l.amount / sum : (tabs > 0 ? l.tablets / tabs : 1 / la.length);
    const m = margin.calc({
      revenueGross: bill * share, packs: l.tablets / pack,
      purchase: it && it.purchase_price, purchaseDiscountPct: it && it.purchase_discount_pct, purchaseIncludesGst: inclGst(it && it.purchase_includes_gst),
      otherCost: it && it.other_direct_cost, gstRate: it && it.gst_percent, gstRegistered: registered,
    });
    return {
      key: raw.inventoryItemId || ("name:" + String(l.name || "").toLowerCase()),
      name: l.name || (it && it.name) || "Unknown", tablets: l.tablets, it, pack, m,
    };
  });
  if (!out.length && bill > 0) {
    // billed with no medicine lines (manual charge): all revenue, no cost
    out.push({ key: "manual", name: "Other / manual charges", tablets: 0, it: null, pack: 1,
      m: margin.calc({ revenueGross: bill, packs: 0, otherCost: 0, gstRate: null, gstRegistered: false }) });
  }
  return out;
}

// ── Revenue Pharmacy ─────────────────────────────────────────────────────────
router.get("/revenue", guard, async (req, res) => {
  try {
    const rg = await getRange(req);
    if (!rg) return res.status(400).json({ error: "Invalid from/to dates" });
    const inv = await invMap(req.hid);
    const registered = await isGstRegistered(req.hid);
    const { rows } = await pool.query(
      "SELECT id, bill_amount, payment_mode, dispensed_items, tablets_sold, " +
      "to_char((handed_over_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS day " +
      "FROM prescriptions WHERE " + HANDED_WHERE + " AND ip_billed=false", [req.hid, rg[0], rg[1]]);
    let gross = 0, tablets = 0;
    const all = [];
    const byPayment = { cash: 0, upi: 0, insurance: 0 };
    const byDay = {};
    for (const r of rows) {
      const bill = Number(r.bill_amount) || 0;
      for (const l of rxMargin(r, inv, registered)) all.push(l.m);
      gross += bill; tablets += Number(r.tablets_sold) || 0;
      const pm = ["cash", "upi", "insurance"].includes(r.payment_mode) ? r.payment_mode : "cash";
      byPayment[pm] += bill;
      byDay[r.day] = (byDay[r.day] || 0) + bill;
    }
    const t = margin.present(margin.combine(all));
    const daily = [];
    for (let d = rg[0]; d <= rg[1]; d = addDays(d, 1)) daily.push({ date: d, revenue: r2(byDay[d] || 0) });
    res.set("Cache-Control", "no-store");
    res.json({
      from: rg[0], to: rg[1], prescriptions: rows.length, tabletsSold: tablets,
      // grossRevenue = what customers paid (GST included). Margin is worked out on revenue excluding GST.
      grossRevenue: r2(gross), gstCollected: t.gst, revenueExGst: t.revenue,
      costOfGoods: t.cost, otherCosts: t.otherCost, netMargin: t.profit, netMarginPct: t.marginPct,
      marginKind: t.kind, gstRegistered: registered, gstMissingLines: all.filter(m => m.gstMissing).length,
      byPayment: { cash: r2(byPayment.cash), upi: r2(byPayment.upi), insurance: r2(byPayment.insurance) },
      daily,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Margin details: where the margin on the Revenue card comes from ──────────
// Same prescriptions and the same maths (services/margin.js) as /revenue, split by medicine and by prescription.
router.get("/revenue/margin-details", guard, async (req, res) => {
  try {
    const rg = await getRange(req);
    if (!rg) return res.status(400).json({ error: "Invalid from/to dates" });
    const inv = await invMap(req.hid);
    const registered = await isGstRegistered(req.hid);
    const { rows } = await pool.query(
      "SELECT id, bill_amount, payment_mode, dispensed_items, tablets_sold, " +
      "to_char((handed_over_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS day " +
      "FROM prescriptions WHERE " + HANDED_WHERE + " AND ip_billed=false ORDER BY handed_over_at DESC", [req.hid, rg[0], rg[1]]);
    const items = new Map();
    const rxList = [];
    const every = [];
    for (const r of rows) {
      const ls = rxMargin(r, inv, registered);
      for (const l of ls) {
        let e = items.get(l.key);
        if (!e) { e = { name: l.name, tablets: 0, prescriptions: 0, it: l.it, pack: l.pack, parts: [] }; items.set(l.key, e); }
        e.tablets += l.tablets; e.prescriptions += 1; e.parts.push(l.m); every.push(l.m);
      }
      const rm = margin.present(margin.combine(ls.map(l => l.m)));
      rxList.push({ id: r.id, day: r.day, payment: r.payment_mode || "cash", medicines: ls.length,
        billed: rm.billed, revenue: rm.revenue, cost: rm.cost, otherCost: rm.otherCost, margin: rm.profit });
    }
    const total = margin.present(margin.combine(every));
    const list = Array.from(items.values()).map(e => {
      const c = margin.combine(e.parts), p = margin.present(c);
      const it = e.it;
      const cpt = it && Number(it.purchase_price) > 0
        ? margin.calc({ packs: 1, purchase: it.purchase_price, purchaseDiscountPct: it.purchase_discount_pct, purchaseIncludesGst: inclGst(it.purchase_includes_gst), gstRate: it.gst_percent, gstRegistered: registered }).cost / e.pack
        : null;
      let issue = null;
      if (e.it === null && e.name === "Other / manual charges") issue = null;
      else if (!c.hasPurchase) issue = "no_cost_price";
      else if (p.revenue <= 0) issue = "no_revenue";
      else if (p.profit < 0) issue = "below_cost";
      return {
        name: e.name, tablets: e.tablets, prescriptions: e.prescriptions,
        billed: p.billed, gst: p.gst, revenue: p.revenue, cost: p.cost, otherCost: p.otherCost,
        margin: p.profit, marginPct: p.marginPct, markupPct: p.markupPct, kind: p.kind, gstMissing: p.gstMissing,
        soldPerTablet: e.tablets > 0 ? r2(p.revenue / e.tablets) : null,
        costPerTablet: cpt === null ? null : r2(cpt), issue,
      };
    }).sort((a, b) => a.margin - b.margin);
    res.set("Cache-Control", "no-store");
    res.json({
      from: rg[0], to: rg[1], gstRegistered: registered,
      summary: {
        grossRevenue: total.billed, gstCollected: total.gst, revenueExGst: total.revenue,
        costOfGoods: total.cost, otherCosts: total.otherCost, netMargin: total.profit,
        netMarginPct: total.marginPct, markupPct: total.markupPct, marginKind: total.kind,
        prescriptions: rows.length, lossMedicines: list.filter(x => x.margin < 0).length,
        missingCostPrice: list.filter(x => x.issue === "no_cost_price").length,
        otherCostMissingMedicines: list.filter(x => x.kind === "gross").length,
        gstMissingMedicines: registered ? list.filter(x => x.gstMissing).length : 0,
      },
      medicines: list, prescriptions: rxList.slice(0, 200),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Inventory (medicines) ────────────────────────────────────────────────────
router.get("/inventory", guard, async (req, res) => {
  try {
    await batchesReady;
    const t = await todayIST();
    const soon = addDays(t, 30);
    const { rows } = await pool.query(
      "SELECT id, name, unit, quantity, min_quantity, pack_size, purchase_price, selling_price, supplier, location, batch_no, med_category, strips_per_box, pack_unit, schedule, gst_percent, hsn_code, brand_name, other_direct_cost, purchase_discount_pct, purchase_includes_gst, " +
      "to_char(expiry_date,'YYYY-MM-DD') AS expiry_date, updated_at " +
      "FROM inventory_items WHERE hospital_id=$1 AND category='medicines' AND archived_at IS NULL ORDER BY name ASC", [req.hid]);
    const bq = await pool.query(
      "SELECT item_id, batch_no, to_char(expiry_date,'YYYY-MM-DD') AS expiry_date, tablets, supplier FROM inventory_batches " +
      "WHERE hospital_id=$1 AND tablets>0 ORDER BY expiry_date ASC NULLS LAST, received_at ASC", [req.hid]);
    const registered = await isGstRegistered(req.hid);
    const byItem = {};
    for (const b of bq.rows) (byItem[b.item_id] = byItem[b.item_id] || []).push({ batchNo: b.batch_no, expiryDate: b.expiry_date, tablets: Number(b.tablets), supplier: b.supplier });
    res.set("Cache-Control", "no-store");
    res.json(rows.map(r => {
      const qty = Number(r.quantity) || 0, pack = Number(r.pack_size) || 1;
      const total = Math.round(qty * pack);
      const batches = byItem[r.id] || [];
      const sum = batches.reduce((s, b) => s + b.tablets, 0);
      if (total > sum) batches.push({ batchNo: null, expiryDate: null, tablets: total - sum, supplier: null });
      const dated = batches.filter(b => b.expiryDate);
      const exps = dated.length ? dated.map(b => b.expiryDate) : (r.expiry_date ? [r.expiry_date] : []);
      let status = "ok";
      if (exps.some(e => e < t)) status = "expired";
      else if (qty <= 0) status = "out_of_stock";
      else if (qty <= Number(r.min_quantity)) status = "low_stock";
      else if (exps.some(e => e <= soon)) status = "expiring_soon";
      return {
        id: r.id, name: r.name, brandName: r.brand_name || null, unit: r.unit, quantity: qty, packSize: pack, packUnit: r.pack_unit || null,
        tabletsAvailable: total, reorderLevel: Number(r.min_quantity),
        purchasePrice: r.purchase_price, sellingPrice: r.selling_price, stripsPerBox: r.strips_per_box, tabletsPerBox: r.strips_per_box ? r.strips_per_box * pack : null, schedule: r.schedule || "none", gstPercent: r.gst_percent, hsnCode: r.hsn_code || null, breakdown: breakdownOf(qty * pack, pack, r.strips_per_box),
        supplier: r.supplier, location: r.location, batchNo: r.batch_no, medCategory: r.med_category || null,
        expiryDate: dated.length ? dated[0].expiryDate : r.expiry_date, batches, status,
        updatedAt: r.updated_at,
        otherDirectCost: r.other_direct_cost == null ? null : Number(r.other_direct_cost),
        purchaseDiscountPct: r.purchase_discount_pct == null ? null : Number(r.purchase_discount_pct),
        purchaseIncludesGst: inclGst(r.purchase_includes_gst),
        // margin on one pack at MRP, same maths as the Revenue card. null when there is no purchase price to compare with.
        margin: (() => {
          if (!(Number(r.purchase_price) > 0)) return null;
          const m = margin.present(margin.calc({
            revenueGross: Number(r.selling_price) || 0, packs: 1, purchase: r.purchase_price, purchaseDiscountPct: r.purchase_discount_pct, purchaseIncludesGst: inclGst(r.purchase_includes_gst),
            otherCost: r.other_direct_cost, gstRate: r.gst_percent, gstRegistered: registered,
          }));
          return { amount: m.profit, pct: m.marginPct, markupPct: m.markupPct, kind: m.kind, gstMissing: m.gstMissing, revenue: m.revenue, cost: m.cost, otherCost: m.otherCost };
        })(),
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Add a new medicine (pharmacy staff / admin) ──
router.post("/inventory", guard, async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const num = v => (v === undefined || v === null || v === "") ? null : Number(v);
    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ error: "Medicine name is required" });
    const pack = num(b.packSize) > 0 ? num(b.packSize) : 1;
    const openTabs = num(b.openingTablets) === null ? 0 : num(b.openingTablets);
    const reorder = num(b.reorderLevel) === null ? 5 : num(b.reorderLevel);
    const pp = num(b.purchasePrice);
    const sp = num(b.sellingPrice);
    if (!Number.isFinite(openTabs) || openTabs < 0 || openTabs > 10000000 || !Number.isFinite(reorder) || reorder < 0)
      return res.status(400).json({ error: "Check opening stock and reorder level" });
    if ((pp !== null && !(pp >= 0)) || (sp !== null && !(sp >= 0)))
      return res.status(400).json({ error: "Prices must be 0 or more" });
    if (b.expiryDate && !DATE_RE.test(b.expiryDate)) return res.status(400).json({ error: "expiryDate must be YYYY-MM-DD" });
    const br = cleanBrand(b.brandName);
    if (br.error) return res.status(400).json({ error: br.error });
    await client.query("BEGIN");
    const dup = await client.query(
      "SELECT 1 FROM inventory_items WHERE hospital_id=$1 AND category='medicines' AND archived_at IS NULL AND lower(name)=lower($2)", [req.hid, name]);
    if (dup.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: "A medicine with this name already exists" }); }
    const cr = await resolveCategory(client, req.hid, b.medCategory);
    if (cr.error) { await client.query("ROLLBACK"); return res.status(400).json({ error: cr.error }); }
    const medCat = cr.value;
    const id = "inv_" + randomBytes(5).toString("hex");
    const qty = Math.round((openTabs / pack) * 1000) / 1000;
    await client.query(
      "INSERT INTO inventory_items (id, hospital_id, name, category, unit, quantity, min_quantity, purchase_price, supplier, location, pack_size, batch_no, expiry_date, selling_price, med_category, brand_name) " +
      "VALUES ($1,$2,$3,'medicines','tablets',$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13,$14)",
      [id, req.hid, name, qty, reorder, pp, b.supplier || null, b.location || null, pack, b.batchNo || null, b.expiryDate || null, sp, medCat, br.value]);
    if (qty > 0) {
      await client.query(
        "INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by) VALUES ($1,$2,$3,'in',$4,$5,$6)",
        ["invtx_" + randomBytes(5).toString("hex"), req.hid, id, qty,
         "Opening stock: " + openTabs + " tablets (new medicine added)", req.user.pharmacyStaffId || req.user.id || null]);
    }
    await client.query("COMMIT");
    try { broadcast("hospital_" + req.hid, { type: "pharmacy_update", status: "stock" }); } catch (_) {}
    res.status(201).json({ ok: true, id });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Remove a medicine: archived, not deleted, so old bills keep their cost data.
router.delete("/inventory/:id", guard, async (req, res) => {
  const client = await pool.connect();
  try {
    const why = String((req.body && req.body.reason) || "").trim();
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT id, quantity, pack_size FROM inventory_items WHERE id=$1 AND hospital_id=$2 AND category='medicines' AND archived_at IS NULL FOR UPDATE",
      [req.params.id, req.hid]);
    if (!cur.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Medicine not found" }); }
    const row = cur.rows[0];
    const qty = Number(row.quantity) || 0;
    const pack = Number(row.pack_size) || 1;
    const tabs = Math.round(qty * pack);
    await client.query("UPDATE inventory_items SET quantity=0, archived_at=now(), updated_at=now() WHERE id=$1", [row.id]);
    await client.query("UPDATE inventory_batches SET tablets=0 WHERE item_id=$1", [row.id]);
    if (qty > 0) {
      await client.query(
        "INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by) VALUES ($1,$2,$3,'out',$4,$5,$6)",
        ["invtx_" + randomBytes(5).toString("hex"), req.hid, row.id, qty,
         "Removed from inventory: " + tabs + " tablets written off" + (why ? " - " + why : ""),
         req.user.pharmacyStaffId || req.user.id || null]);
    }
    await client.query("COMMIT");
    try { broadcast("hospital_" + req.hid, { type: "pharmacy_update", status: "stock" }); } catch (_) {}
    res.json({ ok: true, removedTablets: tabs });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.get("/inventory-categories", guard, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT name FROM pharmacy_med_categories WHERE hospital_id=$1 ORDER BY lower(name)", [req.hid]);
    res.set("Cache-Control", "no-store");
    res.json([...MED_CATEGORIES, ...rows.map(r => r.name)]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.patch("/inventory/:id/meta", guard, async (req, res) => {
  const client = await pool.connect();
  try {
    const { batchNo, expiryDate, sellingPrice, supplier, location, packSize, medCategory } = req.body || {};
    // brandName: only touched when the key is sent; an empty string clears it
    const brandGiven = Object.prototype.hasOwnProperty.call(req.body || {}, "brandName");
    const br = cleanBrand(brandGiven ? req.body.brandName : undefined);
    if (br.error) return res.status(400).json({ error: br.error });
    if (expiryDate && !DATE_RE.test(expiryDate)) return res.status(400).json({ error: "expiryDate must be YYYY-MM-DD" });
    if (sellingPrice != null && !(Number(sellingPrice) >= 0)) return res.status(400).json({ error: "Invalid sellingPrice" });
    let newPack = null;
    if (packSize !== undefined && packSize !== null && packSize !== "") {
      newPack = Number(packSize);
      if (!Number.isInteger(newPack) || newPack < 1 || newPack > 100000)
        return res.status(400).json({ error: "Tablets per pack must be a whole number of 1 or more" });
    }
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT quantity, pack_size FROM inventory_items WHERE id=$1 AND hospital_id=$2 FOR UPDATE", [req.params.id, req.hid]);
    if (!cur.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Item not found" }); }
    const cr = await resolveCategory(client, req.hid, medCategory);
    if (cr.error) { await client.query("ROLLBACK"); return res.status(400).json({ error: cr.error }); }
    const newCat = cr.value;
    const oldPack = Number(cur.rows[0].pack_size) || 1;
    let newQty = null;
    if (newPack !== null && newPack !== oldPack) {
      // keep the total tablet count the same when the pack size changes
      const tablets = Number(cur.rows[0].quantity) * oldPack;
      newQty = Math.round((tablets / newPack) * 1000000) / 1000000;
    }
    await client.query(
      "UPDATE inventory_items SET batch_no=COALESCE($1,batch_no), expiry_date=COALESCE($2::date,expiry_date), " +
      "selling_price=COALESCE($3,selling_price), supplier=COALESCE($4,supplier), location=COALESCE($7,location), " +
      "pack_size=COALESCE($8,pack_size), quantity=COALESCE($9,quantity), med_category=COALESCE($10,med_category), brand_name=CASE WHEN $11::boolean THEN $12::text ELSE brand_name END, updated_at=now() " +
      "WHERE id=$5 AND hospital_id=$6",
      [batchNo ?? null, expiryDate ?? null, sellingPrice ?? null, supplier ?? null, req.params.id, req.hid, location ?? null, newPack, newQty, newCat, brandGiven, br.value]);
    await client.query("COMMIT");
    try { broadcast("hospital_" + req.hid, { type: "pharmacy_update", status: "stock" }); } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── Medicine Buying by Patient (dispensing log) ──────────────────────────────
// ── Update stock (pharmacy staff / admin): add received stock or correct the count ──
router.post("/inventory/:id/stock", guard, async (req, res) => {
  const client = await pool.connect();
  try {
    const { mode, tablets, reason } = req.body || {};
    const n = Number(tablets);
    if (!["add", "set"].includes(mode)) { return res.status(400).json({ error: "mode must be add or set" }); }
    if (!Number.isFinite(n) || n < 0 || n > 10000000 || (mode === "add" && n <= 0)) {
      return res.status(400).json({ error: "Enter a valid number of tablets" });
    }
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT * FROM inventory_items WHERE id=$1 AND hospital_id=$2 AND category='medicines' FOR UPDATE",
      [req.params.id, req.hid]);
    if (!cur.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Item not found" }); }
    const row = cur.rows[0];
    const pack = Number(row.pack_size) || 1;
    const oldQty = Number(row.quantity) || 0;
    const newQty = mode === "add" ? oldQty + n / pack : n / pack;
    const finalQty = Math.round(newQty * 1000) / 1000;
    const delta = Math.round((finalQty - oldQty) * 1000) / 1000;
    if (delta === 0) { await client.query("ROLLBACK"); return res.status(400).json({ error: "No change in stock" }); }
    const why = String(reason || "").trim();
    if (delta < 0 && !why) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Reason is required when reducing stock" }); }
    if (delta < 0) await takeFromBatches(client, row.id, Math.round(-delta * pack), { untrackedFirst: true });
    await client.query("UPDATE inventory_items SET quantity=$1, updated_at=now() WHERE id=$2", [finalQty, row.id]);
    const label = mode === "add"
      ? "Stock received: +" + n + " tablets"
      : "Stock count corrected: " + Math.round(oldQty * pack) + " -> " + n + " tablets";
    await client.query(
      "INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      ["invtx_" + randomBytes(5).toString("hex"), req.hid, row.id, delta > 0 ? "in" : "out", Math.abs(delta),
       label + (why ? " - " + why : ""), req.user.pharmacyStaffId || req.user.id || null]);
    await client.query("COMMIT");
    try { broadcast("hospital_" + req.hid, { type: "pharmacy_update", status: "stock" }); } catch (_) {}
    res.json({ ok: true, quantity: finalQty, tabletsAvailable: Math.round(finalQty * pack) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Stock history for one medicine (read-only)
router.get("/inventory/:id/history", guard, async (req, res) => {
  try {
    const own = await pool.query(
      "SELECT id FROM inventory_items WHERE id=$1 AND hospital_id=$2 AND category='medicines'",
      [req.params.id, req.hid]);
    if (!own.rows.length) return res.status(404).json({ error: "Item not found" });
    const { rows } = await pool.query(
      "SELECT id, type, quantity, reason, created_by, created_at FROM inventory_transactions WHERE item_id=$1 AND hospital_id=$2 ORDER BY created_at DESC LIMIT 200",
      [req.params.id, req.hid]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
const SCHEDULES = ["none", "H", "H1", "X"];
function breakdownOf(tablets, pack, spb) {
  const t = Math.max(0, Math.round(Number(tablets) || 0));
  const per = Number(pack) >= 1 ? Number(pack) : 1;
  const perBox = spb ? per * Number(spb) : 0;
  if (!perBox) return { boxes: 0, strips: Math.floor(t / per), tablets: t % per };
  return { boxes: Math.floor(t / perBox), strips: Math.floor((t % perBox) / per), tablets: t % per };
}

// ── Set how a medicine is packed and priced (strip = one pack) ──
router.post("/inventory/:id/packing", guard, async (req, res) => {
  const client = await pool.connect();
  try {
    const b = req.body || {};
    const has = v => !(v === undefined || v === null || v === "");
    const tps = Number(b.tabletsPerStrip), spb = Number(b.stripsPerBox), mrp = Number(b.mrpStrip);
    if (!Number.isInteger(tps) || tps < 1 || tps > 100000) return res.status(400).json({ error: "Tablets per strip must be a whole number of 1 or more" });
    if (!Number.isInteger(spb) || spb < 1 || spb > 100000) return res.status(400).json({ error: "Strips per box must be a whole number of 1 or more" });
    if (!has(b.mrpStrip) || !(mrp >= 0)) return res.status(400).json({ error: "MRP per strip is required" });
    let pp = null;
    if (has(b.purchaseBox)) {
      const pb = Number(b.purchaseBox);
      if (!(pb >= 0)) return res.status(400).json({ error: "Invalid purchase price per box" });
      pp = pb / spb;
    }
    let sched = null;
    if (has(b.schedule)) {
      sched = SCHEDULES.find(x => x.toLowerCase() === String(b.schedule).trim().toLowerCase());
      if (!sched) return res.status(400).json({ error: "Schedule must be none, H, H1 or X" });
    }
    let reorder = null;
    if (has(b.reorderLevel)) {
      reorder = Number(b.reorderLevel);
      if (!(reorder >= 0 && reorder <= 10000000)) return res.status(400).json({ error: "Reorder level must be 0 or more" });
    }
    let hsnGiven = false, hsn = null;
    if (b.hsnCode !== undefined) {
      hsnGiven = true;
      const h = String(b.hsnCode === null ? "" : b.hsnCode).replace(/[\s.]/g, "");
      if (h !== "" && !/^[0-9]{4,8}$/.test(h)) return res.status(400).json({ error: "HSN code must be 4 to 8 digits" });
      hsn = h === "" ? null : h;
    }
    let gst = null;
    if (has(b.gstPercent)) {
      gst = Number(b.gstPercent);
      if (!(gst >= 0 && gst <= 40)) return res.status(400).json({ error: "GST percent must be between 0 and 40" });
    }
    // Optional cost fields: when the key is sent, blank clears it
    const ocGiven = Object.prototype.hasOwnProperty.call(b, "otherDirectCost");
    const pdGiven = Object.prototype.hasOwnProperty.call(b, "purchaseDiscountPct");
    let oc = null, pd = null;
    if (ocGiven && has(b.otherDirectCost)) {
      oc = Number(b.otherDirectCost);
      if (!(oc >= 0 && oc <= 10000000)) return res.status(400).json({ error: "Other direct cost must be 0 or more" });
    }
    if (pdGiven && has(b.purchaseDiscountPct)) {
      pd = Number(b.purchaseDiscountPct);
      if (!(pd >= 0 && pd <= 100)) return res.status(400).json({ error: "Purchase discount must be between 0 and 100" });
    }
    const piGiven = Object.prototype.hasOwnProperty.call(b, "purchaseIncludesGst");
    let pi = null;
    if (piGiven) {
      if (b.purchaseIncludesGst !== true && b.purchaseIncludesGst !== false) return res.status(400).json({ error: "purchaseIncludesGst must be true or false" });
      pi = b.purchaseIncludesGst;
    }
    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT name, quantity, pack_size, gst_percent, hsn_code FROM inventory_items WHERE id=$1 AND hospital_id=$2 AND category='medicines' FOR UPDATE",
      [req.params.id, req.hid]);
    if (!cur.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Medicine not found" }); }
    // GST % change: compare with the HSN rule. A change away from a clear rule needs a reason, and every change is audited.
    const oldGst = cur.rows[0].gst_percent == null ? null : Number(cur.rows[0].gst_percent);
    const effHsn = hsnGiven ? hsn : cur.rows[0].hsn_code;
    const rule = gstRules.lookup(effHsn);
    const gstChanged = has(b.gstPercent) && oldGst !== gst;
    const gstReason = String(b.gstReason == null ? "" : b.gstReason).replace(/\s+/g, " ").trim().slice(0, 300);
    if (gstChanged && rule.status === "ok" && gst !== rule.rate && !gstReason) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "GST " + gst + "% differs from the standard " + rule.rate + "% for HSN " + rule.hsn + ". Enter a reason for the change.", needsReason: true, suggestedRate: rule.rate });
    }
    const oldPack = Number(cur.rows[0].pack_size) || 1;
    const tablets = Math.round(Number(cur.rows[0].quantity) * oldPack);
    const newQty = Math.round((tablets / tps) * 1000000) / 1000000;
    await client.query(
      "UPDATE inventory_items SET pack_size=$1, strips_per_box=$2, quantity=$3, selling_price=$4, " +
      "purchase_price=COALESCE($5,purchase_price), schedule=COALESCE($6,schedule), gst_percent=COALESCE($7,gst_percent), min_quantity=COALESCE($8,min_quantity), hsn_code=CASE WHEN $11::boolean THEN $12::text ELSE hsn_code END, " +
      "other_direct_cost=CASE WHEN $13::boolean THEN $14::real ELSE other_direct_cost END, " +
      "purchase_discount_pct=CASE WHEN $15::boolean THEN $16::real ELSE purchase_discount_pct END, " +
      "purchase_includes_gst=CASE WHEN $17::boolean THEN $18::boolean ELSE purchase_includes_gst END, updated_at=now() " +
      "WHERE id=$9 AND hospital_id=$10",
      [tps, spb, newQty, mrp, pp, sched, gst, reorder, req.params.id, req.hid, hsnGiven, hsn, ocGiven, oc, pdGiven, pd, piGiven, pi]);
    if (gstChanged) {
      await gstAudit.record(client, req, {
        itemId: req.params.id, itemName: cur.rows[0].name, hsn: effHsn, oldRate: oldGst, newRate: gst, suggested: rule.rate, status: rule.status,
        source: rule.status === "ok" && gst === rule.rate ? "auto" : "manual", reason: gstReason,
      });
    }
    await client.query("COMMIT");
    try { broadcast("hospital_" + req.hid, { type: "pharmacy_update", status: "stock" }); } catch (_) {}
    res.json({ ok: true, tabletsAvailable: tablets, breakdown: breakdownOf(tablets, tps, spb) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// ── GST by HSN: lookup, review of missing / different rates, bulk fix, history ──
router.get("/gst/lookup", guard, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(gstRules.lookup(req.query.hsn, req.query.date));
});

router.get("/gst/review", guard, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, brand_name, hsn_code, gst_percent FROM inventory_items WHERE hospital_id=$1 AND category='medicines' AND archived_at IS NULL ORDER BY name ASC", [req.hid]);
    const missing = [], different = [];
    let withRate = 0;
    for (const r of rows) {
      const rule = gstRules.lookup(r.hsn_code);
      const cur = r.gst_percent == null ? null : Number(r.gst_percent);
      const base = { id: r.id, name: r.name, brandName: r.brand_name || null, hsn: r.hsn_code || null, status: rule.status, suggestedRate: rule.status === "ok" ? rule.rate : null, message: rule.message, note: rule.note };
      if (cur === null) missing.push(base);
      else { withRate++; if (rule.status === "ok" && cur !== rule.rate) different.push(Object.assign(base, { currentRate: cur })); }
    }
    res.set("Cache-Control", "no-store");
    res.json({
      counts: { total: rows.length, withRate, missing: missing.length, missingFixable: missing.filter(m => m.status === "ok").length,
        missingManual: missing.filter(m => m.status !== "ok").length, different: different.length },
      missing: missing.slice(0, 500), different: different.slice(0, 500),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Applies the HSN rule rate to the chosen medicines, all or nothing. Only clear rules (status ok) are applied; the rest are reported, never guessed.
router.post("/gst/bulk-apply", guard, async (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? Array.from(new Set(req.body.ids.map(String))).slice(0, 500) : [];
  const kind = req.body && req.body.kind === "different" ? "different" : "missing";
  if (!ids.length) return res.status(400).json({ error: "Select at least one medicine" });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const updated = [], skipped = [];
    for (const id of ids) {
      const { rows } = await client.query("SELECT id, name, hsn_code, gst_percent FROM inventory_items WHERE id=$1 AND hospital_id=$2 AND category='medicines' AND archived_at IS NULL FOR UPDATE", [id, req.hid]);
      if (!rows.length) { skipped.push({ id, reason: "Medicine not found" }); continue; }
      const r = rows[0];
      const cur = r.gst_percent == null ? null : Number(r.gst_percent);
      const rule = gstRules.lookup(r.hsn_code);
      if (rule.status !== "ok") { skipped.push({ id, name: r.name, reason: rule.message }); continue; }
      if (kind === "missing" && cur !== null) { skipped.push({ id, name: r.name, reason: "GST % is already set" }); continue; }
      if (kind === "different" && (cur === null || cur === rule.rate)) { skipped.push({ id, name: r.name, reason: "Already matches the rule" }); continue; }
      await client.query("UPDATE inventory_items SET gst_percent=$1, updated_at=now() WHERE id=$2 AND hospital_id=$3", [rule.rate, id, req.hid]);
      await gstAudit.record(client, req, { itemId: id, itemName: r.name, hsn: r.hsn_code, oldRate: cur, newRate: rule.rate, suggested: rule.rate, status: rule.status,
        source: "bulk", reason: (kind === "missing" ? "Filled missing GST from HSN rule" : "Aligned to HSN rule") + " (" + rule.source + ", from " + rule.effectiveFrom + ")" });
      updated.push({ id, name: r.name, rate: rule.rate });
    }
    await client.query("COMMIT");
    try { broadcast("hospital_" + req.hid, { type: "pharmacy_update", status: "stock" }); } catch (_) {}
    res.json({ ok: true, updated: updated.length, skipped });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.get("/inventory/:id/gst-history", guard, async (req, res) => {
  try {
    await gstAudit.ready;
    const { rows } = await pool.query(
      "SELECT old_rate, new_rate, suggested_rate, rule_status, source, reason, changed_by, changed_by_role, changed_at FROM gst_rate_audit WHERE hospital_id=$1 AND item_id=$2 ORDER BY changed_at DESC LIMIT 20",
      [req.hid, req.params.id]);
    res.set("Cache-Control", "no-store");
    res.json(rows.map(r => ({ oldRate: r.old_rate == null ? null : Number(r.old_rate), newRate: r.new_rate == null ? null : Number(r.new_rate),
      suggestedRate: r.suggested_rate == null ? null : Number(r.suggested_rate), ruleStatus: r.rule_status, source: r.source, reason: r.reason,
      changedBy: r.changed_by, role: r.changed_by_role, at: r.changed_at })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Receive stock as boxes / strips / loose tablets, with batch and expiry ──
router.post("/inventory/:id/receive", guard, async (req, res) => {
  const client = await pool.connect();
  try {
    await batchesReady;
    const b = req.body || {};
    const n = v => (v === undefined || v === null || v === "") ? 0 : Number(v);
    const boxes = n(b.boxes), strips = n(b.strips), loose = n(b.tablets);
    if (![boxes, strips, loose].every(x => Number.isInteger(x) && x >= 0 && x <= 10000000))
      return res.status(400).json({ error: "Boxes, strips and tablets must be whole numbers" });
    const batchNo = String(b.batchNo || "").trim();
    if (!batchNo) return res.status(400).json({ error: "Batch number is required" });
    const expiry = String(b.expiryDate || "");
    if (!DATE_RE.test(expiry)) return res.status(400).json({ error: "Expiry date is required (YYYY-MM-DD)" });
    if (expiry <= await todayIST()) return res.status(400).json({ error: "This batch is already expired" });
    const has = v => !(v === undefined || v === null || v === "");
    const mrp = has(b.mrpStrip) ? Number(b.mrpStrip) : null;
    if (mrp !== null && !(mrp >= 0)) return res.status(400).json({ error: "Invalid MRP" });
    const pbox = has(b.purchaseBox) ? Number(b.purchaseBox) : null;
    if (pbox !== null && !(pbox >= 0)) return res.status(400).json({ error: "Invalid purchase price per box" });

    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT * FROM inventory_items WHERE id=$1 AND hospital_id=$2 AND category='medicines' FOR UPDATE",
      [req.params.id, req.hid]);
    if (!cur.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Medicine not found" }); }
    const row = cur.rows[0];
    const pack = Number(row.pack_size) || 1;
    const spb = Number(row.strips_per_box) || 0;
    if (!spb) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Set tablets per strip and strips per box first" }); }
    const total = boxes * spb * pack + strips * pack + loose;
    if (total <= 0) { await client.query("ROLLBACK"); return res.status(400).json({ error: "Enter how many boxes, strips or tablets were received" }); }
    const onHand = Math.round(Number(row.quantity) * pack);
    const newQty = Math.round(((onHand + total) / pack) * 1000000) / 1000000;
    const pp = pbox === null ? null : pbox / spb;
    const sup = b.supplier ? String(b.supplier).trim() : null;
    await client.query(
      "UPDATE inventory_items SET quantity=$1, batch_no=$2, expiry_date=$3::date, selling_price=COALESCE($4,selling_price), " +
      "purchase_price=COALESCE($5,purchase_price), supplier=COALESCE($6,supplier), updated_at=now() WHERE id=$7 AND hospital_id=$8",
      [newQty, batchNo, expiry, mrp, pp, sup, row.id, req.hid]);
    await addBatch(client, row.id, req.hid, batchNo, expiry, total, sup);
    const note = "Stock received: +" + total + " tablets (" + boxes + " box, " + strips + " strip, " + loose + " tablet) batch " + batchNo +
      " exp " + expiry + (b.invoiceNo ? " invoice " + String(b.invoiceNo).trim() : "") + (sup ? " from " + sup : "");
    await client.query(
      "INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by) VALUES ($1,$2,$3,'in',$4,$5,$6)",
      ["invtx_" + randomBytes(5).toString("hex"), req.hid, row.id, Math.round((total / pack) * 1000) / 1000, note,
       req.user.pharmacyStaffId || req.user.id || null]);
    await client.query("COMMIT");
    try { broadcast("hospital_" + req.hid, { type: "pharmacy_update", status: "stock" }); } catch (_) {}
    res.json({ ok: true, added: total, tabletsAvailable: onHand + total, breakdown: breakdownOf(onHand + total, pack, spb) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

router.get("/dispensing-log", guard, async (req, res) => {
  try {
    const rg = await getRange(req);
    if (!rg) return res.status(400).json({ error: "Invalid from/to dates" });
    const q = (req.query.q || "").toString().trim();
    const params = [req.hid, rg[0], rg[1]];
    let extra = "";
    if (q) { params.push("%" + q + "%"); extra = " AND patient_name ILIKE $4"; }
    const { rows } = await pool.query(
      "SELECT id, patient_id, patient_name, doctor_name, items, dispensed_items, status, bill_amount, payment_mode, ip_billed, " +
      "COALESCE(handed_over_at, packed_at, created_at) AS ts FROM prescriptions " +
      "WHERE hospital_id=$1 AND status IN ('packed','ready','handed_over') " +
      "AND (COALESCE(handed_over_at, packed_at, created_at) AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date" +
      extra + " ORDER BY ts DESC LIMIT 500", params);
    res.set("Cache-Control", "no-store");
    res.json(rows.map(r => {
      const items = parse(r.items);
      const disp = parse(r.dispensed_items);
      const meds = disp.length
        ? disp.map(l => ({ name: l.inventoryName || l.name, tablets: l.tablets, dosage: (items[l.index] || {}).dosage || null }))
        : items.map(i => ({ name: i.name, tablets: null, dosage: i.dosage || null }));
      return {
        prescriptionId: r.id, patientId: r.patient_id, patientName: r.patient_name, doctorName: r.doctor_name,
        medicines: meds, billAmount: r.bill_amount == null ? null : Number(r.bill_amount),
        paymentMode: r.ip_billed ? null : (r.payment_mode || null), chargedToIpBill: r.ip_billed === true,
        billStatus: r.status === "handed_over" ? "Billed" : "Pending",
        status: r.status, timestamp: r.ts,
      };
    }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Medicine Sold (per medicine: today / week / month) ───────────────────────
router.get("/medicines-sold", guard, async (req, res) => {
  try {
    const t = await todayIST();
    const weekStart = addDays(t, -6);
    const monthStart = t.slice(0, 8) + "01";
    const from = weekStart < monthStart ? weekStart : monthStart;
    const inv = await invMap(req.hid);
    const { rows } = await pool.query(
      "SELECT id, bill_amount, dispensed_items, " +
      "to_char((handed_over_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS day " +
      "FROM prescriptions WHERE " + HANDED_WHERE, [req.hid, from, t]);
    const agg = {};
    for (const r of rows) {
      for (const l of lineAmounts(r, inv)) {
        const a = agg[l.name] || (agg[l.name] = {
          name: l.name, unitsToday: 0, unitsWeek: 0, unitsMonth: 0,
          revenueToday: 0, revenueWeek: 0, revenueMonth: 0, unitPrice: 0, priceSource: l.priceSource });
        if (r.day === t) { a.unitsToday += l.tablets; a.revenueToday += l.amount; }
        if (r.day >= weekStart) { a.unitsWeek += l.tablets; a.revenueWeek += l.amount; }
        if (r.day >= monthStart) { a.unitsMonth += l.tablets; a.revenueMonth += l.amount; }
        if (l.unitPrice) a.unitPrice = l.unitPrice;
      }
    }
    res.set("Cache-Control", "no-store");
    res.json(Object.values(agg).map(a => ({
      ...a, revenueToday: r2(a.revenueToday), revenueWeek: r2(a.revenueWeek), revenueMonth: r2(a.revenueMonth),
    })).sort((x, y) => y.revenueMonth - x.revenueMonth));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Itemized invoice for one prescription ────────────────────────────────────
// ---- Stock Update: medicines sold on a day vs what is already deducted from stock ----
function suggestQtyLocal(item) {
  const dm = /([\d.]+)\s*(tablet|capsule)/i.exec(item.dosage || "");
  const perDose = dm ? parseFloat(dm[1]) : 1;
  const times = ["Morning", "Afternoon", "Evening"].filter(t => (item.instructions || "").includes(t)).length || 1;
  const du = /([\d.]+)\s*(day|week)/i.exec(item.duration || "");
  const days = du ? Math.ceil(parseFloat(du[1]) * (du[2].toLowerCase() === "week" ? 7 : 1)) : 1;
  return Math.max(1, Math.ceil(perDose * times * days));
}

router.get("/stock-pending", guard, async (req, res) => {
  try {
    const day = DATE_RE.test(String(req.query.date || "")) ? String(req.query.date) : await todayIST();
    const { rows } = await pool.query(
      "SELECT id, patient_name, items, dispensed_items FROM prescriptions WHERE " + HANDED_WHERE,
      [req.hid, day, day]);
    const agg = {};
    const pending = [];
    const invRows = (await pool.query("SELECT name, pack_size, med_category FROM inventory_items WHERE hospital_id=$1 AND category='medicines' AND archived_at IS NULL", [req.hid])).rows;
    const matchPackItem = nm => {
      const n = String(nm || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const base = n.replace(/\s*\d+(\.\d+)?\s*(mg|ml|g|mcg)\b.*$/, '').trim();
      return invRows.find(i => String(i.name).toLowerCase().trim() === n) || invRows.find(i => { const m = String(i.name).toLowerCase().trim(); return base.length > 2 && (m.includes(base) || base.includes(m)); }) || null;
    };
    for (const r of rows) {
      const dispensed = parse(r.dispensed_items);
      const doneIdx = new Set(dispensed.filter(l => l.index !== undefined && l.index !== null).map(l => Number(l.index)));
      const doneNames = new Set(dispensed.map(l => String(l.name || "").toLowerCase()));
      parse(r.items).forEach((it, idx) => {
        const name = it.name || "Unknown";
        let tablets = suggestQtyLocal(it);
        const mi = matchPackItem(name);
        if (mi && mi.med_category && mi.med_category !== 'Tablet' && mi.med_category !== 'Capsule') {
          const packsQty = Number(it.quantity) > 0 ? Math.max(1, Math.round(Number(it.quantity))) : 1;
          tablets = packsQty * (Number(mi.pack_size) || 1);
        }
        const done = doneIdx.has(idx) || doneNames.has(name.toLowerCase());
        const a = agg[name] || (agg[name] = { name, soldTablets: 0, deductedTablets: 0, pendingTablets: 0, pendingLines: 0 });
        a.soldTablets += tablets;
        if (done) {
          a.deductedTablets += tablets;
        } else {
          a.pendingTablets += tablets;
          a.pendingLines += 1;
          pending.push({ rxId: r.id, patient: r.patient_name, index: idx, name, tablets });
        }
      });
    }
    res.set("Cache-Control", "no-store");
    res.json({
      date: day,
      medicines: Object.values(agg).sort((x, y) => y.pendingTablets - x.pendingTablets),
      pending,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post("/stock-deduct", guard, async (req, res) => {
  const client = await pool.connect();
  try {
    const { rxId, index, inventoryItemId, tablets, reason } = req.body || {};
    const idx = Number(index);
    const qty = Math.round(Number(tablets));
    if (!rxId || !inventoryItemId || !Number.isInteger(idx) || idx < 0)
      return res.status(400).json({ error: "rxId, index and inventoryItemId are required" });
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1000000)
      return res.status(400).json({ error: "Enter a valid number of tablets" });

    await client.query("BEGIN");
    const cur = await client.query(
      "SELECT * FROM prescriptions WHERE id=$1 AND hospital_id=$2 AND status='handed_over' FOR UPDATE",
      [rxId, req.hid]);
    if (!cur.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Handed-over prescription not found" }); }
    const p = cur.rows[0];
    const item = parse(p.items)[idx];
    if (!item) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Medicine line not found" }); }
    const lines = parse(p.dispensed_items);
    const itemName = String(item.name || "").toLowerCase();
    const already = lines.some(l =>
      (l.index !== undefined && l.index !== null && Number(l.index) === idx) ||
      String(l.name || "").toLowerCase() === itemName);
    if (already) { await client.query("ROLLBACK"); return res.status(409).json({ error: "Already deducted from stock" }); }

    const inv = await client.query(
      "SELECT * FROM inventory_items WHERE id=$1 AND hospital_id=$2 AND category='medicines' FOR UPDATE",
      [inventoryItemId, req.hid]);
    if (!inv.rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Stock item not found" }); }
    const row = inv.rows[0];
    const pack = Number(row.pack_size) || 1;
    const units = Math.round((qty / pack) * 1000) / 1000;
    const mcat = String(row.med_category || '').trim();
    if (mcat && mcat !== 'Tablet' && mcat !== 'Capsule' && qty % pack !== 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: row.name + ' is sold in whole ' + (row.pack_unit || 'bottle') + 's only.' });
    }
    if (Number(row.quantity) + 1e-6 < units) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Not enough stock for " + row.name + ": available " + Math.floor(Number(row.quantity) * pack) + ", needed " + qty });
    }

    const why = String(reason || "").trim();
    const usedBatches = await takeFromBatches(client, row.id, qty);
    await client.query("UPDATE inventory_items SET quantity=quantity-$1, updated_at=now() WHERE id=$2", [units, row.id]);
    await client.query(
      "INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by) VALUES ($1,$2,$3,'out',$4,$5,$6)",
      ["invtx_" + randomBytes(5).toString("hex"), req.hid, row.id, units,
       "Stock Update: " + qty + " sold to " + p.patient_name + " (Rx " + p.id + ") deducted after hand over" + (why ? " - " + why : ""),
       req.user.pharmacyStaffId || req.user.id || null]);

    lines.push({ index: idx, name: item.name, inventoryItemId: row.id, inventoryName: row.name,
                 tablets: qty, suggested: qty, reduced: false, reason: why || null, units, lateDeduct: true, batches: usedBatches });
    await client.query(
      "UPDATE prescriptions SET dispensed_items=$1, tablets_sold=COALESCE(tablets_sold,0)+$2 WHERE id=$3",
      [JSON.stringify(lines), qty, p.id]);
    await client.query("COMMIT");
    try { broadcast("hospital_" + req.hid, { type: "pharmacy_update", status: "stock" }); } catch (_) {}
    res.json({ ok: true, name: row.name, tabletsAvailable: Math.round((Number(row.quantity) - units) * pack) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

// Medicines bought outside stock, saved by the pharmacist at hand over (name, qty, rate).
function manualLinesOf(rx) {
  let arr = [];
  try { arr = rx.manual_items ? JSON.parse(rx.manual_items) : []; } catch (_) {}
  if (!Array.isArray(arr)) return [];
  return arr.map(m => {
    const q = Number(m.quantity) || 0, pr = Number(m.unitPrice) || 0;
    return { name: String(m.name || "Medicine"), tablets: q, unitPrice: r2(pr), amount: r2(q * pr), priceSource: "manual" };
  });
}

// Late stock deductions (Stock Update) only move stock. They must never change the patient's bill.
function billRx(rx) {
  const all = parse(rx.dispensed_items);
  if (!all.some(l => l && l.lateDeduct)) return rx;
  const rest = all.filter(l => !(l && l.lateDeduct));
  let hasManual = false;
  try { hasManual = JSON.parse(rx.manual_items || "[]").length > 0; } catch (_) {}
  if (!rest.length && !hasManual) return rx;
  return Object.assign({}, rx, { dispensed_items: JSON.stringify(rest) });
}

// Invoice lines, each with the dosage / timing note the doctor wrote for that medicine.
function invoiceLines(rx, inv) {
  const src = billRx(rx);
  const dl = parse(src.dispensed_items);
  let items = [];
  try { items = JSON.parse(rx.items || "[]"); } catch (_) {}
  if (!Array.isArray(items)) items = [];
  const noteOf = it => it ? [it.dosage, String(it.instructions || "").trim(), it.duration].filter(Boolean).join(" \u00b7 ") : "";
  const stock = lineAmounts(src, inv).map((l, i) => {
    const ix = dl[i] && dl[i].index;
    return Object.assign({}, l, { note: (ix === undefined || ix === null) ? "" : noteOf(items[Number(ix)]) });
  });
  const manual = manualLinesOf(rx).map(m => Object.assign({}, m, { note: noteOf(items.find(x => x && x.name === m.name)) }));
  return stock.concat(manual);
}

// Makes invoice lines add up to the saved bill total by adding one adjustment line.
function withAdjustment(lines, billAmount) {
  if (billAmount == null || billAmount === "") return lines;
  const total = Number(billAmount);
  if (!Number.isFinite(total)) return lines;
  const sum = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const diff = r2(total - sum);
  if (Math.abs(diff) < 0.01) return lines;
  return lines.concat([{
    name: diff > 0 ? "Other / manual charges" : "Discount / adjustment",
    tablets: 1, unitPrice: diff, amount: diff, priceSource: "adjustment",
  }]);
}

// Tax-invoice data for pharmacy bills: per-medicine HSN and GST %, seller details and a once-per-bill invoice number.
const __normName = s => String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
const __baseName = s => __normName(s).replace(/\s*\(.*$/, "");
const ensureBillInvTable = () => pool.query("CREATE TABLE IF NOT EXISTS pharmacy_bill_invoice (hospital_id TEXT NOT NULL, rx_id TEXT NOT NULL, invoice_no TEXT NOT NULL, issued_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (hospital_id, rx_id), UNIQUE (hospital_id, invoice_no))");
async function billInvoiceNo(hid, rxId) {
  await ensureInvTables(); await ensureBillInvTable();
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [hid + ":" + rxId]);
    const ex = await c.query("SELECT invoice_no FROM pharmacy_bill_invoice WHERE hospital_id=$1 AND rx_id=$2", [hid, rxId]);
    if (ex.rows[0]) { await c.query("COMMIT"); return ex.rows[0].invoice_no; }
    const fy = invFy();
    const n = await c.query("INSERT INTO pharmacy_invoice_counter (hospital_id, fy, last_seq) VALUES ($1,$2,1) ON CONFLICT (hospital_id, fy) DO UPDATE SET last_seq = pharmacy_invoice_counter.last_seq + 1 RETURNING last_seq", [hid, fy]);
    const no = "INV/" + fy + "/" + String(n.rows[0].last_seq).padStart(5, "0");
    await c.query("INSERT INTO pharmacy_bill_invoice (hospital_id, rx_id, invoice_no) VALUES ($1,$2,$3)", [hid, rxId, no]);
    await c.query("COMMIT");
    return no;
  } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
}
async function sendTax(rx, res, obj) {
  try {
    const hid = rx.hospital_id;
    const prof = await gstProfileFor(hid);
    obj.gstType = prof.gstType || "";
    obj.seller = { name: prof.name || "", address: prof.address || "", gstin: prof.gstin || "", drugLicence: prof.drugLicence || "" };
    if (prof.gstType === "registered") {
      // Same state -> CGST + SGST, different state -> IGST. Only a valid buyer GSTIN (staff-entered) can make a sale inter-state.
      const buyerRaw = String((res.locals && res.locals.buyerGstin) || "").trim().toUpperCase();
      const sp = gstRules.supplyType(prof.gstin, buyerRaw);
      obj.supplyType = sp.supply; obj.buyerGstin = sp.buyerValid ? buyerRaw : ""; obj.buyerStateCode = sp.buyerState; obj.buyerGstinInvalid = !sp.buyerValid;
      const it = await pool.query("SELECT name, hsn_code, gst_percent FROM inventory_items WHERE hospital_id=$1", [hid]);
      const byName = new Map(), byBase = new Map();
      const put = (m, k, r) => { const o = m.get(k); if (!o || (!o.hsn_code && r.hsn_code)) m.set(k, r); };
      for (const r of it.rows) { put(byName, __normName(r.name), r); put(byBase, __baseName(r.name), r); }
      obj.lines = (obj.lines || []).map(l => {
        if (l.name === "Other / manual charges" || l.name === "Discount / adjustment") return Object.assign({}, l, { adjustment: true, hsn: null, gstPercent: 0 });
        const m = byName.get(__normName(l.name)) || byBase.get(__baseName(l.name));
        return Object.assign({}, l, { hsn: m && m.hsn_code ? String(m.hsn_code) : null, gstPercent: m && m.gst_percent != null ? Number(m.gst_percent) : null });
      });
      const complete = obj.lines.every(l => l.adjustment || (l.hsn && l.gstPercent != null));
      const legacy = (Number(obj.cgstPct) || 0) + (Number(obj.sgstPct) || 0) > 0;
      if (complete && !legacy && prof.gstin && rx.status === "handed_over" && rx.bill_no != null && obj.lines.length) obj.taxInvoiceNo = await billInvoiceNo(hid, String(rx.id));
    }
  } catch (e) { console.warn("[pharmacy] tax invoice data:", e.message); }
  res.json(obj);
}

router.get("/invoice/:id", guard, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM prescriptions WHERE id=$1 AND hospital_id=$2", [req.params.id, req.hid]);
    if (!rows.length) return res.status(404).json({ error: "Prescription not found" });
    const rx = rows[0];
    const lines = invoiceLines(rx, await invMap(req.hid));
    res.locals.buyerGstin = req.query.buyerGstin || "";
    await sendTax(rx, res, {
      billNo: rx.bill_no == null ? null : Number(rx.bill_no),
      invoiceNo: rx.bill_no == null ? "Bill pending" : "Bill No: " + rx.bill_no, prescriptionId: rx.id, hospitalName: rx.hospital_name,
      patientId: rx.patient_id, patientName: rx.patient_name, doctorName: rx.doctor_name,
      issuedAt: rx.handed_over_at, paymentMode: rx.payment_mode || null,
      lines: withAdjustment(lines, rx.bill_subtotal != null ? rx.bill_subtotal : rx.bill_amount).map(l => ({ name: l.name, tablets: l.tablets, unitPrice: l.unitPrice, amount: l.amount, manual: l.priceSource === "manual", note: l.note || "" })),
      total: rx.bill_amount == null ? null : Number(rx.bill_amount),
      subtotal: rx.bill_subtotal == null ? null : Number(rx.bill_subtotal),
      discountPct: Number(rx.discount_pct) || 0, discountAmount: Number(rx.discount_amount) || 0,
      gstEnabled: !!rx.gst_enabled, cgstPct: Number(rx.cgst_pct) || 0, sgstPct: Number(rx.sgst_pct) || 0,
      cgstAmount: Number(rx.cgst_amount) || 0, sgstAmount: Number(rx.sgst_amount) || 0,
      status: rx.status === "handed_over" ? "Billed" : "Pending",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /pharmacy-module/my-invoice/:id - the patient's own pharmacy bill (read only).
// Only for the patient's own prescription, and only once the pharmacy has marked it given and billed it.
const { requireAuth: __patientAuth } = require("../middleware/auth");
router.get("/my-invoice/:id", __patientAuth, async (req, res) => {
  if (!req.user || req.user.role !== "patient") return res.status(403).json({ error: "Forbidden" });
  try {
    const { rows } = await pool.query(
      "SELECT * FROM prescriptions WHERE id=$1 AND patient_id=$2 AND status='handed_over'",
      [req.params.id, req.user.id]);
    if (!rows.length || rows[0].bill_no == null) return res.status(404).json({ error: "Bill not available yet" });
    const rx = rows[0];
    const lines = invoiceLines(rx, await invMap(rx.hospital_id));
    res.set("Cache-Control", "no-store");
    await sendTax(rx, res, {
      billNo: Number(rx.bill_no),
      invoiceNo: "Bill No: " + rx.bill_no, prescriptionId: rx.id, hospitalName: rx.hospital_name,
      patientId: rx.patient_id, patientName: rx.patient_name, doctorName: rx.doctor_name,
      issuedAt: rx.handed_over_at, paymentMode: rx.payment_mode || null,
      lines: withAdjustment(lines, rx.bill_subtotal != null ? rx.bill_subtotal : rx.bill_amount).map(l => ({ name: l.name, tablets: l.tablets, unitPrice: l.unitPrice, amount: l.amount, manual: l.priceSource === "manual", note: l.note || "" })),
      total: rx.bill_amount == null ? null : Number(rx.bill_amount),
      subtotal: rx.bill_subtotal == null ? null : Number(rx.bill_subtotal),
      discountPct: Number(rx.discount_pct) || 0, discountAmount: Number(rx.discount_amount) || 0,
      gstEnabled: !!rx.gst_enabled, cgstPct: Number(rx.cgst_pct) || 0, sgstPct: Number(rx.sgst_pct) || 0,
      cgstAmount: Number(rx.cgst_amount) || 0, sgstAmount: Number(rx.sgst_amount) || 0,
      status: "Billed",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── GST Invoice: sales grouped by medicine + batch for a date range ──
const ensureGstTable = (() => {
  let done = null;
  return () => {
    if (!done) done = pool.query(
      "CREATE TABLE IF NOT EXISTS pharmacy_gst_profile (hospital_id TEXT PRIMARY KEY, gstin TEXT, address TEXT, drug_licence TEXT, default_hsn TEXT, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()); ALTER TABLE pharmacy_gst_profile ADD COLUMN IF NOT EXISTS gst_type TEXT; ALTER TABLE pharmacy_gst_profile ADD COLUMN IF NOT EXISTS company_name TEXT"
    ).catch(err => { done = null; throw err; });
    return done;
  };
})();
ensureGstTable().catch(err => console.warn("[pharmacy] gst profile table:", err.message));

async function gstProfileFor(hid) {
  await ensureGstTable();
  await pool.query("ALTER TABLE pharmacy_gst_profile ADD COLUMN IF NOT EXISTS company_name TEXT");
  const h = await pool.query("SELECT name, address, phone FROM hospitals WHERE id=$1", [hid]);
  const p = await pool.query("SELECT gstin, address, drug_licence, default_hsn, gst_type, company_name FROM pharmacy_gst_profile WHERE hospital_id=$1", [hid]);
  const hr = h.rows[0] || {}, pr = p.rows[0] || {};
  return { name: pr.company_name || hr.name || "", companyName: pr.company_name || "", address: pr.address || hr.address || "", phone: hr.phone || "",
           gstin: pr.gstin || "", drugLicence: pr.drug_licence || "", defaultHsn: pr.default_hsn || "3004", gstType: pr.gst_type || (pr.gstin ? "registered" : "") };
}

router.get("/gst-profile", guard, async (req, res) => {
  try { res.json(await gstProfileFor(req.hid)); } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put("/gst-type", guard, async (req, res) => {
  try {
    await ensureGstTable();
    const t = String((req.body || {}).gstType || "");
    if (t !== "registered" && t !== "none") return res.status(400).json({ error: "gstType must be registered or none" });
    await pool.query("INSERT INTO pharmacy_gst_profile (hospital_id, gst_type, updated_at) VALUES ($1,$2,now()) ON CONFLICT (hospital_id) DO UPDATE SET gst_type=EXCLUDED.gst_type, updated_at=now()", [req.hid, t]);
    res.json(await gstProfileFor(req.hid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put("/gst-profile", guard, async (req, res) => {
  try {
    await ensureGstTable();
    const b = req.body || {};
    const gstin = String(b.gstin || "").trim().toUpperCase();
    await pool.query("ALTER TABLE pharmacy_gst_profile ADD COLUMN IF NOT EXISTS company_name TEXT");
    const hsn = String(b.defaultHsn || "").trim();
    if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(gstin))
      return res.status(400).json({ error: "GSTIN must be 15 characters, like 29ABCDE1234F1Z5" });
    if (hsn && !/^[0-9]{4,8}$/.test(hsn)) return res.status(400).json({ error: "HSN code must be 4 to 8 digits" });
    await pool.query(
      "INSERT INTO pharmacy_gst_profile (hospital_id, gstin, address, drug_licence, default_hsn, company_name, updated_at) VALUES ($1,$2,$3,$4,$5,$6,now()) " +
      "ON CONFLICT (hospital_id) DO UPDATE SET gstin=EXCLUDED.gstin, address=EXCLUDED.address, drug_licence=EXCLUDED.drug_licence, default_hsn=EXCLUDED.default_hsn, company_name=COALESCE(EXCLUDED.company_name, pharmacy_gst_profile.company_name), updated_at=now()",
      [req.hid, gstin || null, String(b.address || "").trim() || null, String(b.drugLicence || "").trim() || null, hsn || null, String(b.companyName || "").trim().slice(0, 120) || null]);
    res.json(await gstProfileFor(req.hid));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Sequential tax-invoice numbers: INV/<fy>/<5 digits>, consecutive per hospital, restarting each April.
const invFy = () => { const d = new Date(Date.now() + 5.5 * 3600 * 1000); const y = d.getUTCFullYear(); const s = d.getUTCMonth() >= 3 ? y : y - 1; return String(s).slice(2) + "-" + String(s + 1).slice(2); };
const ensureInvTables = () => pool.query("CREATE TABLE IF NOT EXISTS pharmacy_invoice_counter (hospital_id TEXT NOT NULL, fy TEXT NOT NULL, last_seq INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (hospital_id, fy))")
  .then(() => pool.query("CREATE TABLE IF NOT EXISTS pharmacy_invoice_register (hospital_id TEXT NOT NULL, invoice_no TEXT NOT NULL, from_date DATE NOT NULL, to_date DATE NOT NULL, bills INTEGER, total NUMERIC(14,2), issued_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (hospital_id, invoice_no))"));
router.post("/gst-invoice-no", guard, async (req, res) => {
  const b = req.body || {};
  if (!DATE_RE.test(String(b.from || "")) || !DATE_RE.test(String(b.to || ""))) return res.status(400).json({ error: "Invalid from/to dates" });
  const total = Number(b.total), bills = Number(b.bills);
  if (!isFinite(total)) return res.status(400).json({ error: "Invalid total" });
  const billsN = isFinite(bills) ? Math.round(bills) : -1;
  try {
    await ensureInvTables();
    const ex = await pool.query("SELECT invoice_no FROM pharmacy_invoice_register WHERE hospital_id=$1 AND from_date=$2 AND to_date=$3 AND total=$4 AND COALESCE(bills,-1)=$5 ORDER BY issued_at DESC LIMIT 1",
      [req.hid, b.from, b.to, total.toFixed(2), billsN]);
    if (ex.rows[0]) return res.json({ invoiceNo: ex.rows[0].invoice_no, reused: true });
    const fy = invFy();
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      const n = await c.query("INSERT INTO pharmacy_invoice_counter (hospital_id, fy, last_seq) VALUES ($1,$2,1) ON CONFLICT (hospital_id, fy) DO UPDATE SET last_seq = pharmacy_invoice_counter.last_seq + 1 RETURNING last_seq", [req.hid, fy]);
      const no = "INV/" + fy + "/" + String(n.rows[0].last_seq).padStart(5, "0");
      await c.query("INSERT INTO pharmacy_invoice_register (hospital_id, invoice_no, from_date, to_date, bills, total) VALUES ($1,$2,$3,$4,$5,$6)", [req.hid, no, b.from, b.to, billsN < 0 ? null : billsN, total.toFixed(2)]);
      await c.query("COMMIT");
      res.json({ invoiceNo: no, reused: false });
    } catch (e) { await c.query("ROLLBACK").catch(() => {}); throw e; } finally { c.release(); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get("/gst-report", guard, async (req, res) => {
  try {
    const rg = await getRange(req);
    if (!rg) return res.status(400).json({ error: "Invalid from/to dates" });
    const { rows } = await pool.query(
      "SELECT * FROM prescriptions WHERE hospital_id=$1 AND status='handed_over' " +
      "AND (handed_over_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $2::date AND $3::date ORDER BY handed_over_at ASC LIMIT 5000",
      [req.hid, rg[0], rg[1]]);
    const items = await pool.query(
      "SELECT id, name, selling_price, purchase_price, supplier, pack_size, med_category, pack_unit, hsn_code, gst_percent FROM inventory_items WHERE hospital_id=$1", [req.hid]);
    const gbq = await pool.query("SELECT item_id, batch_no, supplier, to_char(received_at,'YYYY-MM-DD') AS received FROM inventory_batches WHERE hospital_id=$1 ORDER BY received_at ASC", [req.hid]);
    const bInfo = {};
    for (const x of gbq.rows) bInfo[x.item_id + "|" + x.batch_no] = x;
    const inv = {};
    for (const r of items.rows) inv[r.id] = r;
    const groups = new Map();
    const billNos = [];
    for (const rx of rows) {
      if (rx.bill_no != null) billNos.push(Number(rx.bill_no));
      const disp = parse(rx.dispensed_items);
      const base = Object.assign({}, rx, { bill_amount: rx.bill_subtotal != null ? rx.bill_subtotal : rx.bill_amount });
      const amts = lineAmounts(base, inv);
      const dPct = Math.min(100, Math.max(0, Number(rx.discount_pct) || 0));
      disp.forEach((l, i) => {
        const a = amts[i];
        if (!a || !(a.tablets > 0)) return;
        const it = inv[l.inventoryItemId] || {};
        const pack = Number(it.pack_size) || 1;
        const cat = String(it.med_category || "");
        const packaged = pack > 1 && cat !== "" && cat !== "Tablet" && cat !== "Capsule";
        const div = packaged ? pack : 1;
        const unit = packaged ? (it.pack_unit || "pack") : "tab";
        const mrpUnit = Number(it.selling_price) > 0 ? (Number(it.selling_price) / pack) * div : 0;
        const bs = (Array.isArray(l.batches) ? l.batches : []).filter(b => Number(b.tablets) > 0);
        const parts = bs.length ? bs : [{ batchNo: null, expiry: null, tablets: a.tablets }];
        const psum = parts.reduce((s, b) => s + Number(b.tablets), 0);
        let leftT = a.tablets, leftA = a.amount;
        parts.forEach((b, k) => {
          const last = k === parts.length - 1;
          const t = last ? leftT : r2(a.tablets * Number(b.tablets) / psum);
          const amt = last ? leftA : r2(a.amount * Number(b.tablets) / psum);
          leftT = r2(leftT - t); leftA = r2(leftA - amt);
          const key = [l.inventoryItemId || a.name, b.batchNo || "", b.expiry || ""].join("|");
          const g = groups.get(key) || { name: a.name, hsn: it.hsn_code || null, gstPct: it.gst_percent == null ? null : Number(it.gst_percent), batchNo: b.batchNo || null, expiryDate: b.expiry || null, unit, qty: 0, billed: 0, billDisc: 0, mrpValue: 0, bills: new Set(), purchUnit: (Number(it.purchase_price) > 0 ? (Number(it.purchase_price) / pack) * div : 0), info: bInfo[(l.inventoryItemId || "") + "|" + (b.batchNo || "")] || {} };
          if (rx.bill_no != null) g.bills.add(Number(rx.bill_no));
          const q = t / div;
          g.qty += q; g.billed += amt; g.billDisc += r2(amt * dPct / 100);
          g.mrpValue += mrpUnit > 0 ? Math.max(r2(mrpUnit * q), amt) : amt;
          groups.set(key, g);
        });
      });
    }
    const out = Array.from(groups.values()).map(g => {
      const taxable = r2(g.billed - g.billDisc);
      const gross = r2(g.mrpValue);
      return { name: g.name, hsn: g.hsn, gstPercent: g.gstPct, batchNo: g.batchNo, expiryDate: g.expiryDate, unit: g.unit,
               qty: Math.round(g.qty * 1000) / 1000, mrp: g.qty > 0 ? r2(gross / g.qty) : 0,
               gross, discount: r2(gross - taxable), taxable, billNos: Array.from(g.bills).sort((x, y) => x - y), supplier: g.info.supplier || null, purchasedOn: g.info.received || null, purchaseRate: r2(g.purchUnit) };
    }).sort((x, y) => x.name.localeCompare(y.name) || String(x.expiryDate || "").localeCompare(String(y.expiryDate || "")));
    res.set("Cache-Control", "no-store");
    res.json({ from: rg[0], to: rg[1], bills: rows.length,
      billNoFrom: billNos.length ? Math.min(...billNos) : null, billNoTo: billNos.length ? Math.max(...billNos) : null,
      profile: await gstProfileFor(req.hid), rows: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
