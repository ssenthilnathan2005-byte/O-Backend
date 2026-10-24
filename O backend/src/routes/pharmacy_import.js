"use strict";
const express = require("express");
const multer = require("multer");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { broadcast } = require("../services/ws");
const { randomBytes } = require("crypto");
const { ready: batchesReady, addBatch } = require("../services/batches");
const { STD_CATEGORIES } = require("../services/importParser");
const { parseImport } = require("../services/universalImport");
const { parsePdfImport } = require("../services/pdfImport");
const { applyGst } = require("../services/gstRules");
const withGst = o => { if (o && Array.isArray(o.rows)) o.rows.forEach(r => { try { applyGst(r); } catch (e) { /* keep the row as parsed */ } }); return o; };
const { parseImageImport } = require("../services/imageImport");
const { evaluateRow, categoryLabels, exactKey, looseKey } = require("../services/packaging");
const router = express.Router();

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } }).single("file");

// One row per saved import, used to warn when the same invoice is imported twice.
const ready = pool.query(
  "CREATE TABLE IF NOT EXISTS pharmacy_imports (id TEXT PRIMARY KEY, hospital_id TEXT NOT NULL, invoice_no TEXT, supplier TEXT, " +
  "created_count INTEGER NOT NULL DEFAULT 0, updated_count INTEGER NOT NULL DEFAULT 0, skipped_count INTEGER NOT NULL DEFAULT 0, " +
  "created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now())")
  .then(() => pool.query("CREATE INDEX IF NOT EXISTS idx_pharm_imports_inv ON pharmacy_imports(hospital_id, invoice_no)"))
  .then(() => pool.query("ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS hsn_code TEXT"))
  .catch(e => console.warn("[pharmacy_import] migration:", e.message));

const istToday = () => new Date(Date.now() + 330 * 60 * 1000).toISOString().slice(0, 10);

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
        const out = parseImport(req.file.buffer, req.file.originalname);
        if (!out.rows.length) return res.status(422).json({ error: "No medicine rows were found in the file" });
        return res.json({ fileName: req.file.originalname, ...withGst(out) });
      }
      if (/\.pdf$/.test(fname)) {
        const out = await parsePdfImport(req.file.buffer);
        if (!out.rows.length) return res.status(422).json({ error: "No medicine rows were found in the PDF" });
        return res.json({ fileName: req.file.originalname, ...withGst(out) });
      }
      if (/\.(jpg|jpeg|png)$/.test(fname)) {
        const out = await parseImageImport(req.file.buffer);
        return res.json({ fileName: req.file.originalname, ...withGst(out) });
      }
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

// Existing medicines, used to match rows by name and to suggest "similar" names.
async function loadContext(db, hid) {
  const { rows } = await db.query(
    "SELECT id, name, pack_size, strips_per_box, selling_price, med_category, pack_unit, hsn_code FROM inventory_items " +
    "WHERE hospital_id=$1 AND category='medicines' AND archived_at IS NULL", [hid]);
  const byKey = new Map(), similar = new Map();
  for (const r of rows) {
    byKey.set(exactKey(r.name), r);
    const lk = looseKey(r.name);
    if (lk && !similar.has(lk)) similar.set(lk, r.name);
  }
  return { byKey, similar };
}
function similarFor(ctx, name) {
  const ek = exactKey(name);
  if (ctx.byKey.has(ek)) return null;
  const s = ctx.similar.get(looseKey(name));
  return s && exactKey(s) !== ek ? s : null;
}
async function findDuplicate(db, hid, invoiceNo, supplier) {
  if (!invoiceNo) return null;
  const r = await db.query(
    "SELECT created_at FROM pharmacy_imports WHERE hospital_id=$1 AND lower(invoice_no)=lower($2) AND lower(COALESCE(supplier,''))=lower($3) " +
    "ORDER BY created_at DESC LIMIT 1", [hid, invoiceNo, supplier || ""]);
  return r.rows[0] || null;
}

const cleanHsn = v => { const t = String(v == null ? "" : v).trim().replace(/\.0+$/, "").replace(/[\s.\-]/g, ""); return /^[0-9]{4,8}$/.test(t) ? t : null; };
function hsnCheck(r, ex) {
  const typed = String(r.hsn == null ? "" : r.hsn).trim();
  const clean = cleanHsn(typed);
  const saved = ex && ex.hsn_code ? String(ex.hsn_code) : "";
  if (typed && !clean) return { state: "invalid", saved, issue: { level: "warn", code: "hsn_invalid", msg: "HSN must be 4 to 8 digits. It will not be saved." } };
  if (!clean && !saved) return { state: "missing", saved, issue: { level: "warn", code: "hsn_missing", msg: "HSN code missing. Add it before this medicine is used on a GST invoice." } };
  if (!clean) return { state: "keep", saved };
  if (!saved) return { state: "new", saved };
  if (clean === saved) return { state: "same", saved };
  return { state: "conflict", saved, issue: { level: "warn", code: "hsn_conflict", msg: "HSN differs from the saved " + saved + ". The saved code is kept unless you tick Replace." } };
}

// Step 1b: dry run. Same checks as the save, nothing is written.
router.post("/validate", guard, async (req, res) => {
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error: "No rows to check" });
  if (rows.length > 500) return res.status(400).json({ error: "Import up to 500 rows at a time" });
  try {
    await ready;
    const ctx = await loadContext(pool, req.hid);
    const today = istToday();
    const invoiceNo = String(body.invoiceNo || "").trim();
    const supplier = String(body.supplier || "").trim();
    const dup = await findDuplicate(pool, req.hid, invoiceNo, supplier);
    const out = rows.map(r => {
      r = r || {};
      const ex = ctx.byKey.get(exactKey(r.name)) || null;
      const ev = evaluateRow(r, ex, today, { allowNoBatchExpiry: r.allowNoBatchExpiry === true, similar: similarFor(ctx, r.name) });
      const h = hsnCheck(r, ex);
      return { status: h.issue && ev.status === "ready" ? "attention" : ev.status, issues: h.issue ? ev.issues.concat([h.issue]) : ev.issues, preview: ev.preview, existing: !!ex, hsn: h.state, savedHsn: h.saved || null };
    });
    res.json({ rows: out, duplicate: dup ? { importedAt: dup.created_at } : null });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Saves one row. Rows that are held or blocked are rolled back and reported, never guessed.
async function importRow(client, req, r, defSupplier, invoiceNo, today) {
  const name = String(r.name || "").replace(/\s+/g, " ").trim();
  const batchNo = String(r.batchNo || "").trim() || null;
  const expiry = r.expiryDate ? String(r.expiryDate) : null;
  const supplier = String(r.supplier || "").trim() || defSupplier || null;
  const by = req.user.pharmacyStaffId || req.user.id || null;
  const gstRaw = numOrNull(r.gstPercent);
  const gst = gstRaw !== null && gstRaw >= 0 && gstRaw <= 100 ? gstRaw : null;
  const hsnNew = cleanHsn(r.hsn);
  const hsnReplace = r.hsnReplace === true;

  await client.query("BEGIN");
  const cur = await client.query(
    "SELECT * FROM inventory_items WHERE hospital_id=$1 AND category='medicines' AND archived_at IS NULL " +
    "AND lower(regexp_replace(name,'\\s+','','g')) = lower(regexp_replace($2,'\\s+','','g')) FOR UPDATE", [req.hid, name]);
  const row = cur.rows[0] || null;

  const ev = evaluateRow(r, row, today, { allowNoBatchExpiry: r.allowNoBatchExpiry === true });
  if (ev.status === "held" || ev.status === "blocked") {
    await client.query("ROLLBACK");
    return { skipped: ev };
  }
  const R = ev.resolved;
  const medCat = await resolveCategory(client, req.hid, r.medCategory);

  const L = categoryLabels(R.category);
  const fmt = n => String(Math.round(n * 1000) / 1000);
  const packName = Math.abs(R.packs - 1) < 1e-9 ? R.packWord : R.packWord + "s";
  const note = "Imported from invoice: +" + fmt(R.packs) + " " + packName +
    (R.unitsPerPack > 1 ? " (" + R.unitsPerPack + " " + L.baseShort + "/" + R.packWord + ")" : "") +
    (R.kind === "box" ? " [" + fmt(Number(r.quantity)) + " box]" : "") +
    (batchNo ? " batch " + batchNo : "") + (expiry ? " exp " + expiry : "") +
    (invoiceNo ? " invoice " + invoiceNo : "") + (supplier ? " from " + supplier : "") +
    (!batchNo || !expiry ? " [saved without batch/expiry - override by " + (by || "staff") + "]" : "");

  const pack = R.unitsPerPack;
  if (row) {
    const onHand = Math.round(Number(row.quantity) * pack);
    const newQty = Math.round(((onHand + R.tablets) / pack) * 1000000) / 1000000;
    await client.query(
      "UPDATE inventory_items SET quantity=$1, batch_no=COALESCE($2,batch_no), expiry_date=COALESCE($3::date,expiry_date), " +
      "selling_price=COALESCE($4,selling_price), purchase_price=COALESCE($5,purchase_price), supplier=COALESCE($6,supplier), " +
      "med_category=COALESCE($7,med_category), gst_percent=COALESCE($8,gst_percent), strips_per_box=COALESCE(strips_per_box,$9), " +
      "pack_unit=COALESCE(pack_unit,$10), hsn_code=CASE WHEN $13::text IS NULL THEN hsn_code WHEN hsn_code IS NULL OR hsn_code='' THEN $13::text WHEN $14::boolean THEN $13::text ELSE hsn_code END, updated_at=now() WHERE id=$11 AND hospital_id=$12",
      [newQty, batchNo, expiry, R.sellingPerPack, R.purchasePerPack, supplier, medCat, gst, R.packsPerBox, R.packWord, row.id, req.hid, hsnNew, hsnReplace]);
    await addBatch(client, row.id, req.hid, batchNo, expiry, R.tablets, supplier);
    await client.query(
      "INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by) VALUES ($1,$2,$3,'in',$4,$5,$6)",
      ["invtx_" + randomBytes(5).toString("hex"), req.hid, row.id, Math.round((R.tablets / pack) * 1000) / 1000, note, by]);
    await client.query("COMMIT");
    return { kind: "updated" };
  }

  const id = "inv_" + randomBytes(5).toString("hex");
  await client.query(
    "INSERT INTO inventory_items (id, hospital_id, name, category, unit, quantity, min_quantity, purchase_price, supplier, pack_size, batch_no, expiry_date, selling_price, med_category, gst_percent, strips_per_box, pack_unit, hsn_code) " +
    "VALUES ($1,$2,$3,'medicines','tablets',$4,5,$5,$6,$7,$8,$9::date,$10,$11,$12,$13,$14,$15)",
    [id, req.hid, name, R.tablets / pack, R.purchasePerPack, supplier, pack, batchNo, expiry, R.sellingPerPack, medCat, gst, R.packsPerBox, R.packWord, hsnNew]);
  await addBatch(client, id, req.hid, batchNo, expiry, R.tablets, supplier);
  await client.query(
    "INSERT INTO inventory_transactions (id, hospital_id, item_id, type, quantity, reason, created_by) VALUES ($1,$2,$3,'in',$4,$5,$6)",
    ["invtx_" + randomBytes(5).toString("hex"), req.hid, id, R.tablets / pack, note, by]);
  await client.query("COMMIT");
  return { kind: "created" };
}

// Step 2: save the rows the staff reviewed. Each row is its own transaction.
router.post("/commit", guard, async (req, res) => {
  const body = req.body || {};
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || !rows.length) return res.status(400).json({ error: "No rows to import" });
  if (rows.length > 500) return res.status(400).json({ error: "Import up to 500 rows at a time" });
  const defSupplier = String(body.supplier || "").trim() || null;
  const invoiceNo = String(body.invoiceNo || "").trim() || null;
  const out = { created: 0, updated: 0, skipped: [], errors: [] };
  try { await batchesReady; await ready; } catch (_) {}
  const today = istToday();
  try {
    const dup = await findDuplicate(pool, req.hid, invoiceNo, defSupplier);
    if (dup && body.confirmDuplicate !== true)
      return res.status(409).json({
        error: "Invoice " + invoiceNo + " was already imported on " + new Date(dup.created_at).toISOString().slice(0, 10) +
          ". Tick \"Import again\" if you really want to add it again.",
        duplicate: true,
      });
  } catch (_) {}
  for (let i = 0; i < rows.length; i++) {
    const client = await pool.connect();
    const r = rows[i] || {};
    try {
      const done = await importRow(client, req, r, defSupplier, invoiceNo, today);
      if (done.kind) out[done.kind]++;
      else out.skipped.push({
        row: i + 1, name: String(r.name || ""), status: done.skipped.status,
        reasons: done.skipped.issues.filter(x => x.level !== "warn").map(x => x.msg),
      });
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      out.errors.push({ row: i + 1, name: String(r.name || ""), error: e.message });
    } finally { client.release(); }
  }
  if (out.created + out.updated > 0) {
    try {
      await pool.query(
        "INSERT INTO pharmacy_imports (id, hospital_id, invoice_no, supplier, created_count, updated_count, skipped_count, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        ["imp_" + randomBytes(5).toString("hex"), req.hid, invoiceNo, defSupplier, out.created, out.updated,
          out.skipped.length + out.errors.length, req.user.pharmacyStaffId || req.user.id || null]);
    } catch (e) { console.warn("[pharmacy_import] log:", e.message); }
  }
  try { broadcast("hospital_" + req.hid, { type: "pharmacy_update", status: "stock" }); } catch (_) {}
  res.json(out);
});

module.exports = router;
