"use strict";
const express = require("express");
const multer = require("multer");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { broadcast } = require("../services/ws");
const { randomBytes } = require("crypto");
const { ready: batchesReady, addBatch } = require("../services/batches");
const { parseSpreadsheet, STD_CATEGORIES } = require("../services/importParser");
const router = express.Router();

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single("file");

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

// Step 1: read the file and return rows for review. Nothing is saved.
router.post("/parse", guard, (req, res) => {
  upload(req, res, async err => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "File is larger than 10 MB" : err.message });
    if (!req.file) return res.status(400).json({ error: "Choose a file to upload" });
    const fname = String(req.file.originalname || "").toLowerCase();
    try {
      if (/\.(xlsx|xls|csv)$/.test(fname)) {
        const out = parseSpreadsheet(req.file.buffer);
        if (!out.rows.length) return res.status(422).json({ error: "No medicine rows were found in the file" });
        return res.json({ fileName: req.file.originalname, ...out });
      }
      if (/\.(pdf|jpg|jpeg|png)$/.test(fname)) return res.status(501).json({ error: "PDF and image import is coming in the next update. Please upload Excel or CSV for now." });
      return res.status(415).json({ error: "Upload a PDF, JPG, PNG, Excel or CSV file" });
    } catch (e) {
      res.status(422).json({ error: e.message });
    }
  });
});

async function resolveCategory(client, hid, raw) {
  const name = String(raw || "").replace(/\s+/g, " ").trim();
  if (!name || name.length > 40 || /[<>]/.test(name)) return null;
  const std = STD_CATEGORIES.find(c => c.toLowerCase() === name.toLowerCase());
  if (std) return std;
  const ex = await client.query("SELECT name FROM pharmacy_med_categories WHERE hospital_id=$1 AND lower(name)=lower($2)", [hid, name]);
  if (ex.rows.length) return ex.rows[0].name;
  const cnt = await client.query("SELECT COUNT(*)::int AS n FROM pharmacy_med_categories WHERE hospital_id=$1", [hid]);
  if (cnt.rows[0].n >= 100) return "Others";
  await client.query("INSERT INTO pharmacy_med_categories (hospital_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING", [hid, name]);
  return name;
}

const numOrNull = v => (v === undefined || v === null || v === "") ? null : Number(v);

async function importRow(client, req, r, defSupplier, invoiceNo) {
  const name = String(r.name || "").replace(/\s+/g, " ").trim();
  if (!name) throw new Error("Medicine name is required");
  if (name.length > 200) throw new Error("Medicine name is too long");
  let qty = numOrNull(r.quantity); if (qty === null) qty = 0;
  if (!Number.isFinite(qty) || qty < 0 || qty > 10000000) throw new Error("Invalid quantity");
  const packIn = numOrNull(r.tabletsPerStrip) > 0 ? numOrNull(r.tabletsPerStrip) : null;
  const spbIn = numOrNull(r.stripsPerBox) > 0 ? Math.round(numOrNull(r.stripsPerBox)) : null;
  const pp = numOrNull(r.purchasePrice), sp = numOrNull(r.sellingPrice);
  if ((pp !== null && !(pp >= 0)) || (sp !== null && !(sp >= 0))) throw new Error("Prices must be 0 or more");
  let gst = numOrNull(r.gstPercent); if (gst !== null && !(gst >= 0 && gst <= 100)) gst = null;
  const expiry = r.expiryDate ? String(r.expiryDate) : null;
  if (expiry && !DATE_RE.test(expiry)) throw new Error("Expiry must be YYYY-MM-DD");
  const batchNo = String(r.batchNo || "").trim() || null;
  const supplier = String(r.supplier || "").trim() || defSupplier || null;
  const by = req.user.pharmacyStaffId || req.user.id || null;

  await client.query("BEGIN");
  const medCat = await resolveCategory(client, req.hid, r.medCategory);
  const cur = await client.query(
    "SELECT * FROM inventory_items WHERE hospital_id=$1 AND category='medicines' AND archived_at IS NULL " +
    "AND lower(regexp_replace(name,'\\s+','','g')) = lower(regexp_replace($2,'\\s+','','g')) FOR UPDATE", [req.hid, name]);
  const note = c => "Imported from invoice: +" + c + " tablets" + (batchNo ? " batch " + batchNo : "") + (expiry ? " exp " + expiry : "") +
    (invoiceNo ? " invoice " + invoiceNo : "") + (supplier ? " from " + supplier : "");

  if (cur.rows.length) {
    const row = cur.rows[0];
    const pack = Number(row.pack_size) || 1;
    if (packIn && packIn !== pack) throw new Error("Tabs/strip (" + packIn + ") does not match this medicine pack size (" + pack + "). Fix the pack size in Edit, or correct the row."); const tablets = Math.round(qty * pack);
    const onHand = Math.round(Number(row.quantity) * pack);
    const newQty = Math.round(((onHand + tablets) / pack) * 1000000) / 1000000;
    await client.query(
      "UPDATE inventory_items SET quantity=$1, batch_no=COALESCE($2,batch_no), expiry_date=COALESCE($3::date,expiry_date), " +
      "selling_price=COALESCE($4,selling_price), purchase_price=COALESCE($5,purchase_price), supplier=COALESCE($6,supplier), " +
      "med_category=COALESCE($7,med_category), gst_percent=COALESCE($8,gst_percent), strips_per_box=COALESCE(strips_per_box,$9), updated_at=now() WHERE id=$10 AND hospital_id=$11",
      [newQty, batchNo, expiry, sp, pp, supplier, medCat, gst, spbIn, row.id, req.hid]);
    if (tablets > 0) {
      await addBatch(client, row.id, req.hid, batchNo, expiry, tablets, supplier);
      await client.query(
        "INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by) VALUES ($1,$2,$3,'in',$4,$5,$6)",
        ["invtx_" + randomBytes(5).toString("hex"), req.hid, row.id, Math.round((tablets / pack) * 1000) / 1000, note(tablets), by]);
    }
    await client.query("COMMIT");
    return "updated";
  }

  const pack = packIn || 1;
  const tablets = Math.round(qty * pack);
  const id = "inv_" + randomBytes(5).toString("hex");
  await client.query(
    "INSERT INTO inventory_items (id, hospital_id, name, category, unit, quantity, min_quantity, purchase_price, supplier, pack_size, batch_no, expiry_date, selling_price, med_category, gst_percent, strips_per_box) " +
    "VALUES ($1,$2,$3,'medicines','tablets',$4,5,$5,$6,$7,$8,$9::date,$10,$11,$12,$13)",
    [id, req.hid, name, tablets / pack, pp, supplier, pack, batchNo, expiry, sp, medCat, gst, spbIn]);
  if (tablets > 0) {
    await addBatch(client, id, req.hid, batchNo, expiry, tablets, supplier);
    await client.query(
      "INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by) VALUES ($1,$2,$3,'in',$4,$5,$6)",
      ["invtx_" + randomBytes(5).toString("hex"), req.hid, id, tablets / pack, note(tablets), by]);
  }
  await client.query("COMMIT");
  return "created";
}

// Step 2: save the rows the staff reviewed. Each row is its own transaction.
router.post("/commit", guard, async (req, res) => {
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error: "No rows to import" });
  if (rows.length > 500) return res.status(400).json({ error: "Import up to 500 rows at a time" });
  const defSupplier = String(body.supplier || "").trim() || null;
  const invoiceNo = String(body.invoiceNo || "").trim() || null;
  const out = { created: 0, updated: 0, errors: [] };
  try { await batchesReady; } catch (_) {}
  for (let i = 0; i < rows.length; i++) {
    const client = await pool.connect();
    try {
      const kind = await importRow(client, req, rows[i] || {}, defSupplier, invoiceNo);
      out[kind]++;
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      out.errors.push({ row: i + 1, name: String((rows[i] && rows[i].name) || ""), error: e.message });
    } finally { client.release(); }
  }
  try { broadcast("hospital_" + req.hid, { type: "pharmacy_update", status: "stock" }); } catch (_) {}
  res.json(out);
});

module.exports = router;