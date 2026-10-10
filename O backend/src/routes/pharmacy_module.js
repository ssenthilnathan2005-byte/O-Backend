"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { broadcast } = require("../services/ws");
const { randomBytes } = require("crypto");
const router = express.Router();

pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS batch_no TEXT")
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS expiry_date DATE"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS selling_price REAL"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS med_category TEXT"))
  .then(() => pool.query("ALTER TABLE prescriptions ADD COLUMN IF NOT EXISTS payment_mode TEXT"))
  .catch(e => console.warn("[pharmacy_module] migration:", e.message));

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MED_CATEGORIES = ["Tablet", "Capsule", "Syrup/Tonic", "Injection", "Oil", "Ointment/Cream", "Drops", "Powder", "Others"];
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

function scope(req, res, next) {
  const role = req.user.role;
  if (role !== "pharmacy" && role !== "hospital_admin" && role !== "admin")
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
    "SELECT id, name, purchase_price, selling_price, pack_size FROM inventory_items WHERE hospital_id=$1", [hid]);
  const m = {};
  for (const r of rows) m[r.id] = r;
  return m;
}
function parse(s) { try { return JSON.parse(s || "[]"); } catch (_) { return []; } }

// Per-line amounts for one prescription. Uses selling price when set,
// otherwise shares the entered bill amount by tablets.
function lineAmounts(rx, inv) {
  const lines = parse(rx.dispensed_items);
  const totalTabs = lines.reduce((s, l) => s + (Number(l.tablets) || 0), 0);
  const bill = Number(rx.bill_amount) || 0;
  return lines.map(l => {
    const tabs = Number(l.tablets) || 0;
    const it = inv[l.inventoryItemId];
    const pack = Number(it && it.pack_size) || 1;
    const sp = Number(it && it.selling_price) || 0;
    const cp = Number(it && it.purchase_price) || 0;
    let unitPrice, amount, priceSource;
    if (l.unitPrice != null && l.unitPrice !== "" && Number.isFinite(Number(l.unitPrice))) { unitPrice = Number(l.unitPrice); amount = tabs * unitPrice; priceSource = "billed"; }
    else if (sp > 0) { unitPrice = sp / pack; amount = tabs * unitPrice; priceSource = "inventory"; }
    else { amount = totalTabs ? (tabs / totalTabs) * bill : 0; unitPrice = tabs ? amount / tabs : 0; priceSource = "bill-share"; }
    return {
      name: l.inventoryName || l.name, tablets: tabs,
      unitPrice: r2(unitPrice), amount: r2(amount), priceSource,
      cost: r2(tabs * (cp / pack)),
    };
  });
}

// ── Revenue Pharmacy ─────────────────────────────────────────────────────────
router.get("/revenue", guard, async (req, res) => {
  try {
    const rg = await getRange(req);
    if (!rg) return res.status(400).json({ error: "Invalid from/to dates" });
    const inv = await invMap(req.hid);
    const { rows } = await pool.query(
      "SELECT id, bill_amount, payment_mode, dispensed_items, tablets_sold, " +
      "to_char((handed_over_at AT TIME ZONE 'Asia/Kolkata')::date,'YYYY-MM-DD') AS day " +
      "FROM prescriptions WHERE " + HANDED_WHERE, [req.hid, rg[0], rg[1]]);
    let gross = 0, cost = 0, tablets = 0;
    const byPayment = { cash: 0, upi: 0, insurance: 0 };
    const byDay = {};
    for (const r of rows) {
      const bill = Number(r.bill_amount) || 0;
      const c = lineAmounts(r, inv).reduce((s, l) => s + l.cost, 0);
      gross += bill; cost += c; tablets += Number(r.tablets_sold) || 0;
      const pm = ["cash", "upi", "insurance"].includes(r.payment_mode) ? r.payment_mode : "cash";
      byPayment[pm] += bill;
      byDay[r.day] = (byDay[r.day] || 0) + bill;
    }
    const daily = [];
    for (let d = rg[0]; d <= rg[1]; d = addDays(d, 1)) daily.push({ date: d, revenue: r2(byDay[d] || 0) });
    res.set("Cache-Control", "no-store");
    res.json({
      from: rg[0], to: rg[1], prescriptions: rows.length, tabletsSold: tablets,
      grossRevenue: r2(gross), costOfGoods: r2(cost), netMargin: r2(gross - cost),
      netMarginPct: gross > 0 ? r2(((gross - cost) / gross) * 100) : 0,
      byPayment: { cash: r2(byPayment.cash), upi: r2(byPayment.upi), insurance: r2(byPayment.insurance) },
      daily,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Inventory (medicines) ────────────────────────────────────────────────────
router.get("/inventory", guard, async (req, res) => {
  try {
    const t = await todayIST();
    const soon = addDays(t, 30);
    const { rows } = await pool.query(
      "SELECT id, name, unit, quantity, min_quantity, pack_size, purchase_price, selling_price, supplier, location, batch_no, med_category, " +
      "to_char(expiry_date,'YYYY-MM-DD') AS expiry_date, updated_at " +
      "FROM inventory_items WHERE hospital_id=$1 AND category='medicines' ORDER BY name ASC", [req.hid]);
    res.set("Cache-Control", "no-store");
    res.json(rows.map(r => {
      const qty = Number(r.quantity) || 0, pack = Number(r.pack_size) || 1;
      let status = "ok";
      if (r.expiry_date && r.expiry_date < t) status = "expired";
      else if (qty <= 0) status = "out_of_stock";
      else if (qty <= Number(r.min_quantity)) status = "low_stock";
      else if (r.expiry_date && r.expiry_date <= soon) status = "expiring_soon";
      return {
        id: r.id, name: r.name, unit: r.unit, quantity: qty, packSize: pack,
        tabletsAvailable: Math.round(qty * pack), reorderLevel: Number(r.min_quantity),
        purchasePrice: r.purchase_price, sellingPrice: r.selling_price,
        supplier: r.supplier, location: r.location, batchNo: r.batch_no, medCategory: r.med_category || null, expiryDate: r.expiry_date, status,
        updatedAt: r.updated_at,
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
    const medCat = (b.medCategory === undefined || b.medCategory === null || b.medCategory === "") ? null : String(b.medCategory);
    if (medCat !== null && !MED_CATEGORIES.includes(medCat)) return res.status(400).json({ error: "Invalid category" });
    const openTabs = num(b.openingTablets) === null ? 0 : num(b.openingTablets);
    const reorder = num(b.reorderLevel) === null ? 5 : num(b.reorderLevel);
    const pp = num(b.purchasePrice);
    const sp = num(b.sellingPrice);
    if (!Number.isFinite(openTabs) || openTabs < 0 || openTabs > 10000000 || !Number.isFinite(reorder) || reorder < 0)
      return res.status(400).json({ error: "Check opening stock and reorder level" });
    if ((pp !== null && !(pp >= 0)) || (sp !== null && !(sp >= 0)))
      return res.status(400).json({ error: "Prices must be 0 or more" });
    if (b.expiryDate && !DATE_RE.test(b.expiryDate)) return res.status(400).json({ error: "expiryDate must be YYYY-MM-DD" });
    await client.query("BEGIN");
    const dup = await client.query(
      "SELECT 1 FROM inventory_items WHERE hospital_id=$1 AND category='medicines' AND lower(name)=lower($2)", [req.hid, name]);
    if (dup.rows.length) { await client.query("ROLLBACK"); return res.status(409).json({ error: "A medicine with this name already exists" }); }
    const id = "inv_" + randomBytes(5).toString("hex");
    const qty = Math.round((openTabs / pack) * 1000) / 1000;
    await client.query(
      "INSERT INTO inventory_items (id, hospital_id, name, category, unit, quantity, min_quantity, purchase_price, supplier, location, pack_size, batch_no, expiry_date, selling_price, med_category) " +
      "VALUES ($1,$2,$3,'medicines','tablets',$4,$5,$6,$7,$8,$9,$10,$11::date,$12,$13)",
      [id, req.hid, name, qty, reorder, pp, b.supplier || null, b.location || null, pack, b.batchNo || null, b.expiryDate || null, sp, medCat]);
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

router.patch("/inventory/:id/meta", guard, async (req, res) => {
  const client = await pool.connect();
  try {
    const { batchNo, expiryDate, sellingPrice, supplier, location, packSize, medCategory } = req.body || {};
    let newCat = null;
    if (medCategory !== undefined && medCategory !== null && medCategory !== "") {
      if (!MED_CATEGORIES.includes(String(medCategory))) return res.status(400).json({ error: "Invalid category" });
      newCat = String(medCategory);
    }
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
      "pack_size=COALESCE($8,pack_size), quantity=COALESCE($9,quantity), med_category=COALESCE($10,med_category), updated_at=now() " +
      "WHERE id=$5 AND hospital_id=$6",
      [batchNo ?? null, expiryDate ?? null, sellingPrice ?? null, supplier ?? null, req.params.id, req.hid, location ?? null, newPack, newQty, newCat]);
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

router.get("/dispensing-log", guard, async (req, res) => {
  try {
    const rg = await getRange(req);
    if (!rg) return res.status(400).json({ error: "Invalid from/to dates" });
    const q = (req.query.q || "").toString().trim();
    const params = [req.hid, rg[0], rg[1]];
    let extra = "";
    if (q) { params.push("%" + q + "%"); extra = " AND patient_name ILIKE $4"; }
    const { rows } = await pool.query(
      "SELECT id, patient_id, patient_name, doctor_name, items, dispensed_items, status, bill_amount, payment_mode, " +
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
        paymentMode: r.payment_mode || null,
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
    for (const r of rows) {
      const dispensed = parse(r.dispensed_items);
      const doneIdx = new Set(dispensed.filter(l => l.index !== undefined && l.index !== null).map(l => Number(l.index)));
      const doneNames = new Set(dispensed.map(l => String(l.name || "").toLowerCase()));
      parse(r.items).forEach((it, idx) => {
        const name = it.name || "Unknown";
        const tablets = suggestQtyLocal(it);
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
    if (Number(row.quantity) + 1e-6 < units) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "Not enough stock for " + row.name + ": available " + Math.floor(Number(row.quantity) * pack) + ", needed " + qty });
    }

    const why = String(reason || "").trim();
    await client.query("UPDATE inventory_items SET quantity=quantity-$1, updated_at=now() WHERE id=$2", [units, row.id]);
    await client.query(
      "INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by) VALUES ($1,$2,$3,'out',$4,$5,$6)",
      ["invtx_" + randomBytes(5).toString("hex"), req.hid, row.id, units,
       "Stock Update: " + qty + " sold to " + p.patient_name + " (Rx " + p.id + ") deducted after hand over" + (why ? " - " + why : ""),
       req.user.pharmacyStaffId || req.user.id || null]);

    lines.push({ index: idx, name: item.name, inventoryItemId: row.id, inventoryName: row.name,
                 tablets: qty, suggested: qty, reduced: false, reason: why || null, units, lateDeduct: true });
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

router.get("/invoice/:id", guard, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM prescriptions WHERE id=$1 AND hospital_id=$2", [req.params.id, req.hid]);
    if (!rows.length) return res.status(404).json({ error: "Prescription not found" });
    const rx = rows[0];
    const lines = lineAmounts(rx, await invMap(req.hid));
    res.json({
      billNo: rx.bill_no == null ? null : Number(rx.bill_no),
      invoiceNo: rx.bill_no == null ? "Bill pending" : "Bill No: " + rx.bill_no, prescriptionId: rx.id, hospitalName: rx.hospital_name,
      patientId: rx.patient_id, patientName: rx.patient_name, doctorName: rx.doctor_name,
      issuedAt: rx.handed_over_at, paymentMode: rx.payment_mode || null,
      lines: lines.map(l => ({ name: l.name, tablets: l.tablets, unitPrice: l.unitPrice, amount: l.amount })),
      total: rx.bill_amount == null ? null : Number(rx.bill_amount),
      status: rx.status === "handed_over" ? "Billed" : "Pending",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
