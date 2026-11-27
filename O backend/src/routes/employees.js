"use strict";
// /api/employees - the central employee record (hospital_staff) with profile details, photo, certificates and
// "create login later". Module Staff Setup screens keep working as they are; the database triggers link their
// logins to the same hospital_staff row, and this API completes the profile for that same row.
// Every field is optional.

const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const crypto = require("crypto");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { logAccess } = require("../services/audit");
const { ready } = require("../db/staffCentral");
const storage = require("../services/staffStorage");
const emp = require("../services/employees");

const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user.role !== "hospital_admin" && req.user.role !== "admin") return res.status(403).json({ error: "Forbidden" });
  next();
}
const hidOf = req => (req.user.role === "admin" ? (req.query.hospitalId || (req.body || {}).hospitalId) : req.user.hospitalId);
const fail = (res, e) => res.status(e.status || (e.code === "P0001" ? 409 : 500)).json({ error: e.message });
const run = mw => (req, res, next) => mw(req, res, err => err
  ? res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "That file is too large." : err.message })
  : next());

// ---- field handling: everything optional, blank means "not given" ----
const TEXT_FIELDS = {
  name: "name", department: "department", phone: "phone", email: "email", dateOfBirth: "date_of_birth", gender: "gender",
  address: "address", emergencyContactName: "emergency_contact_name", emergencyContactPhone: "emergency_contact_phone",
  employeeId: "employee_id", designation: "designation", qualification: "qualification", experience: "experience",
  joinDate: "join_date", employmentType: "employment_type", reportingManagerId: "reporting_manager_id", notes: "notes",
  bloodGroup: "blood_group", idProofNumber: "id_proof_number",
};
const SHIFTS = ["morning", "afternoon", "evening", "night"];
function clean(v) { if (v === undefined) return undefined; if (v === null) return null; const s = String(v).trim(); return s === "" ? null : s; }
function readFields(b) {
  const out = {};
  for (const [k, col] of Object.entries(TEXT_FIELDS)) if (b[k] !== undefined) out[col] = clean(b[k]);
  if (b.salary !== undefined) { const n = Number(b.salary); out.salary = (b.salary === null || b.salary === "" || !Number.isFinite(n)) ? null : n; }
  if (Array.isArray(b.shifts)) {
    const s = b.shifts.map(x => String(x).toLowerCase()).filter(x => SHIFTS.includes(x));
    out.shifts = s; out.shift = s[0] || null;
  }
  return out;
}
const roleText = r => { const lt = emp.loginTypeOfRole(r); return lt ? emp.HR_ROLE[lt] : String(r).trim().toLowerCase().replace(/\s+/g, "_"); };
const isFalse = v => v === false || v === "false" || v === 0 || v === "0";

const LOGIN_TABLE = { doctor: "doctors", nurse: "nurses", front_office: "front_office_staff", pharmacy: "pharmacy_staff", lab: "hospital_lab_staff" };

async function loadStaff(req, id, client) {
  const hid = hidOf(req);
  const { rows } = await (client || pool).query(
    "SELECT * FROM hospital_staff WHERE id=$1" + (hid ? " AND hospital_id=$2" : "") + (client ? " FOR UPDATE" : ""),
    hid ? [id, hid] : [id]);
  return rows[0] || null;
}
async function fullRow(id) {
  const { rows } = await pool.query(
    `SELECT hs.*, COALESCE(d.code, n.nurse_code, f.code, p.code, l.code) AS login_code, m.name AS reporting_manager_name
       FROM hospital_staff hs
       LEFT JOIN doctors d ON hs.login_type='doctor' AND d.id=hs.login_id
       LEFT JOIN nurses n ON hs.login_type='nurse' AND n.id=hs.login_id
       LEFT JOIN front_office_staff f ON hs.login_type='front_office' AND f.id=hs.login_id
       LEFT JOIN pharmacy_staff p ON hs.login_type='pharmacy' AND p.id=hs.login_id
       LEFT JOIN hospital_lab_staff l ON hs.login_type='lab' AND l.id=hs.login_id
       LEFT JOIN hospital_staff m ON m.id=hs.reporting_manager_id
      WHERE hs.id=$1`, [id]);
  return rows[0] || null;
}
const DOC_COLS = "id, doc_type, file_name, mime_type, size_bytes, verification_status, verified_by, verified_at, note, created_at";

// ---- POST /api/employees : create an employee (login optional) ----
router.post("/", requireAuth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await ready;
    const hid = hidOf(req);
    if (!hid) return res.status(400).json({ error: "hospitalId required" });
    const b = req.body || {};
    const f = readFields(b);
    f.name = clean(b.name) || "Unnamed employee";
    const roleIn = clean(b.role);
    const wantLogin = b.createLogin === true || b.createLogin === "true";
    if (wantLogin && !emp.loginTypeOfRole(roleIn)) return res.status(400).json({ error: "Choose a role (Doctor, Nurse, Front Office, Pharmacist or Lab Technician) to create a login." });
    const dup = await emp.duplicateMessage(hid, { phone: f.phone, email: f.email, employeeId: f.employee_id });
    if (dup) return res.status(409).json({ error: dup });

    f.id = "staff_" + crypto.randomBytes(5).toString("hex");
    f.hospital_id = hid;
    f.role = roleIn ? roleText(roleIn) : "other";
    f.is_active = isFalse(b.isActive) ? 0 : 1;
    const cols = Object.keys(f);
    await client.query("BEGIN");
    await client.query(`INSERT INTO hospital_staff (${cols.join(",")}) VALUES (${cols.map((_, i) => "$" + (i + 1)).join(",")})`, cols.map(c => f[c]));
    let login = null;
    if (wantLogin) {
      const row = (await client.query("SELECT * FROM hospital_staff WHERE id=$1", [f.id])).rows[0];
      login = await emp.createLoginForStaff(client, row, { role: roleIn, password: b.password });
      if (isFalse(b.isActive)) await client.query("UPDATE hospital_staff SET is_active=0 WHERE id=$1", [f.id]);
    }
    await client.query("COMMIT");
    if (login) await emp.afterLoginCommitted(login, req.user.id);
    logAccess(req, { action: "hr.employee_created", resourceType: "staff", resourceId: f.id });
    res.status(201).json({
      employee: await fullRow(f.id),
      login: login ? { type: login.loginType, id: login.loginId, code: login.code, tempPassword: login.tempPassword } : null,
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[employees POST]", e.message);
    fail(res, e);
  } finally { client.release(); }
});

// ---- GET /api/employees/capabilities : is photo / certificate storage connected on this server? ----
router.get("/capabilities", requireAuth, adminOnly, (req, res) => {
  res.json({ storage: !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) });
});

// ---- GET /api/employees/:id : full profile + documents ----
router.get("/:id", requireAuth, adminOnly, async (req, res) => {
  try {
    await ready;
    const own = await loadStaff(req, req.params.id);
    if (!own) return res.status(404).json({ error: "Not found" });
    const docs = (await pool.query(`SELECT ${DOC_COLS} FROM staff_documents WHERE staff_id=$1 ORDER BY created_at`, [own.id])).rows;
    res.json({ employee: await fullRow(own.id), documents: docs });
  } catch (e) { fail(res, e); }
});

// ---- PATCH /api/employees/:id : edit any details, any time ----
router.patch("/:id", requireAuth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await ready;
    const row = await loadStaff(req, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const b = req.body || {};
    const f = readFields(b);
    if (f.name === null || f.name === undefined) delete f.name;           // a name is never blanked out
    if (b.isActive !== undefined) f.is_active = isFalse(b.isActive) ? 0 : 1;
    if (b.role !== undefined && !row.login_id && clean(b.role)) f.role = roleText(clean(b.role));   // a role with a login cannot be moved

    const chk = {};
    if ("phone" in f) chk.phone = f.phone;
    if ("email" in f) chk.email = f.email;
    if ("employee_id" in f) chk.employeeId = f.employee_id;
    const dup = await emp.duplicateMessage(row.hospital_id, chk, { staffId: row.id, loginId: row.login_id });
    if (dup) return res.status(409).json({ error: dup });

    await client.query("BEGIN");
    // name / mobile live on the login account too: update it, so every module shows the same person
    const T = LOGIN_TABLE[row.login_type];
    if (row.login_id && T && (f.name !== undefined || "phone" in f)) {
      const sets = [], vals = [];
      if (f.name !== undefined) { vals.push(f.name); sets.push("name=$" + vals.length); }
      if ("phone" in f) { vals.push(f.phone == null ? (row.login_type === "lab" ? null : "") : f.phone); sets.push("phone=$" + vals.length); }
      vals.push(row.login_id);
      await client.query(`UPDATE ${T} SET ${sets.join(",")} WHERE id=$${vals.length}`, vals);
    }
    const cols = Object.keys(f);
    if (cols.length) {
      await client.query(`UPDATE hospital_staff SET ${cols.map((c, i) => c + "=$" + (i + 1)).join(",")} WHERE id=$${cols.length + 1}`, [...cols.map(c => f[c]), row.id]);
    }
    await client.query("COMMIT");
    if (row.login_type === "doctor") { try { require("./doctors").invalidateDoctorCache(); } catch (_) {} }
    logAccess(req, { action: "hr.employee_updated", resourceType: "staff", resourceId: row.id });
    res.json({ employee: await fullRow(row.id) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[employees PATCH]", e.message);
    fail(res, e);
  } finally { client.release(); }
});

// ---- POST /api/employees/:id/login : create the login later ----
router.post("/:id/login", requireAuth, adminOnly, async (req, res) => {
  const client = await pool.connect();
  try {
    await ready;
    await client.query("BEGIN");
    const row = await loadStaff(req, req.params.id, client);
    if (!row) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    if (row.removed_at) { await client.query("ROLLBACK"); return res.status(400).json({ error: "This employee was terminated." }); }
    const b = req.body || {};
    const login = await emp.createLoginForStaff(client, row, { role: clean(b.role) || row.role, password: b.password });
    await client.query("COMMIT");
    await emp.afterLoginCommitted(login, req.user.id);
    logAccess(req, { action: "hr.employee_login_created", resourceType: "staff", resourceId: row.id });
    res.status(201).json({
      employee: await fullRow(row.id),
      login: { type: login.loginType, id: login.loginId, code: login.code, tempPassword: login.tempPassword },
    });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[employees login]", e.message);
    fail(res, e);
  } finally { client.release(); }
});

// ---- profile photo (kept in Supabase Storage; doctors also get a small copy for the patient app) ----
const imageUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_r, f, cb) => (f.mimetype || "").startsWith("image/") ? cb(null, true) : cb(new Error("Images only")),
});
router.post("/:id/photo", requireAuth, adminOnly, run(imageUpload.single("photo")), async (req, res) => {
  try {
    await ready;
    const row = await loadStaff(req, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!req.file) return res.status(400).json({ error: "Choose a photo" });
    const big = await sharp(req.file.buffer).rotate().resize({ width: 600, withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 72 }).toBuffer();
    const path = `${row.hospital_id}/${row.id}/photo.jpg`;
    await storage.upload(path, big, "image/jpeg");
    await pool.query("UPDATE hospital_staff SET photo_path=$1, photo_updated_at=now() WHERE id=$2", [path, row.id]);
    if (row.login_type === "doctor" && row.login_id) {
      const small = await sharp(req.file.buffer).rotate().resize({ width: 400, withoutEnlargement: true }).flatten({ background: "#ffffff" }).jpeg({ quality: 60 }).toBuffer();
      await pool.query("UPDATE doctors SET photo=$1 WHERE id=$2", ["data:image/jpeg;base64," + small.toString("base64"), row.login_id]);
      try { require("./doctors").invalidateDoctorCache(); } catch (_) {}
    }
    logAccess(req, { action: "hr.employee_photo", resourceType: "staff", resourceId: row.id });
    res.json({ ok: true, photoPath: path });
  } catch (e) { console.error("[employees photo]", e.message); fail(res, e); }
});
router.get("/:id/photo-url", requireAuth, adminOnly, async (req, res) => {
  try {
    const row = await loadStaff(req, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    if (!row.photo_path) return res.json({ url: null });
    res.json({ url: await storage.signedUrl(row.photo_path, 600) });
  } catch (e) { fail(res, e); }
});

// ---- documents: many files per employee, each with a verification status ----
const docUpload = multer({
  storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (_r, f, cb) => ((f.mimetype || "").startsWith("image/") || f.mimetype === "application/pdf") ? cb(null, true) : cb(new Error("Only images and PDF files can be uploaded")),
});
const STATUSES = ["pending", "verified", "rejected"];
const safeName = n => String(n || "file").replace(/[^\w.\-]+/g, "_").slice(-80);

async function loadDoc(req, staffId, docId) {
  const hid = hidOf(req);
  const { rows } = await pool.query(
    "SELECT d.* FROM staff_documents d JOIN hospital_staff s ON s.id=d.staff_id WHERE d.id=$1 AND d.staff_id=$2" + (hid ? " AND s.hospital_id=$3" : ""),
    hid ? [docId, staffId, hid] : [docId, staffId]);
  return rows[0] || null;
}

router.get("/:id/documents", requireAuth, adminOnly, async (req, res) => {
  try {
    const row = await loadStaff(req, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    res.json((await pool.query(`SELECT ${DOC_COLS} FROM staff_documents WHERE staff_id=$1 ORDER BY created_at`, [row.id])).rows);
  } catch (e) { fail(res, e); }
});

router.post("/:id/documents", requireAuth, adminOnly, run(docUpload.array("files", 10)), async (req, res) => {
  try {
    await ready;
    const row = await loadStaff(req, req.params.id);
    if (!row) return res.status(404).json({ error: "Not found" });
    const files = req.files || [];
    if (!files.length) return res.status(400).json({ error: "Choose at least one file" });
    const docType = clean((req.body || {}).docType) || "other";
    const out = [];
    for (const f of files) {
      const id = "sdoc_" + crypto.randomBytes(6).toString("hex");
      const path = `${row.hospital_id}/${row.id}/docs/${id}-${safeName(f.originalname)}`;
      await storage.upload(path, f.buffer, f.mimetype);
      const ins = await pool.query(
        `INSERT INTO staff_documents (id, staff_id, hospital_id, doc_type, file_name, mime_type, size_bytes, storage_path, uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING ${DOC_COLS}`,
        [id, row.id, row.hospital_id, docType, f.originalname || null, f.mimetype, f.size, path, req.user.id || null]);
      out.push(ins.rows[0]);
    }
    logAccess(req, { action: "hr.employee_documents_added", resourceType: "staff", resourceId: row.id });
    res.status(201).json(out);
  } catch (e) { console.error("[employees docs]", e.message); fail(res, e); }
});

router.get("/:id/documents/:docId/url", requireAuth, adminOnly, async (req, res) => {
  try {
    const d = await loadDoc(req, req.params.id, req.params.docId);
    if (!d) return res.status(404).json({ error: "Not found" });
    res.json({ url: await storage.signedUrl(d.storage_path, 300), fileName: d.file_name, mimeType: d.mime_type });
  } catch (e) { fail(res, e); }
});

router.patch("/:id/documents/:docId", requireAuth, adminOnly, async (req, res) => {
  try {
    const d = await loadDoc(req, req.params.id, req.params.docId);
    if (!d) return res.status(404).json({ error: "Not found" });
    const b = req.body || {};
    const sets = [], vals = [];
    if (b.verificationStatus !== undefined) {
      const s = String(b.verificationStatus).toLowerCase();
      if (!STATUSES.includes(s)) return res.status(400).json({ error: "Status must be pending, verified or rejected" });
      vals.push(s); sets.push("verification_status=$" + vals.length);
      vals.push(s === "pending" ? null : (req.user.id || null)); sets.push("verified_by=$" + vals.length);
      sets.push(s === "pending" ? "verified_at=NULL" : "verified_at=now()");
    }
    if (b.note !== undefined) { vals.push(clean(b.note)); sets.push("note=$" + vals.length); }
    if (b.docType !== undefined) { vals.push(clean(b.docType) || "other"); sets.push("doc_type=$" + vals.length); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(d.id);
    const { rows } = await pool.query(`UPDATE staff_documents SET ${sets.join(",")} WHERE id=$${vals.length} RETURNING ${DOC_COLS}`, vals);
    logAccess(req, { action: "hr.employee_document_updated", resourceType: "staff", resourceId: d.staff_id });
    res.json(rows[0]);
  } catch (e) { fail(res, e); }
});

// replace the file of an existing document (verification starts again)
router.put("/:id/documents/:docId", requireAuth, adminOnly, run(docUpload.single("file")), async (req, res) => {
  try {
    await ready;
    const d = await loadDoc(req, req.params.id, req.params.docId);
    if (!d) return res.status(404).json({ error: "Not found" });
    if (!req.file) return res.status(400).json({ error: "Choose a file" });
    const row = await loadStaff(req, req.params.id);
    const path = `${row.hospital_id}/${row.id}/docs/${d.id}-${Date.now()}-${safeName(req.file.originalname)}`;
    await storage.upload(path, req.file.buffer, req.file.mimetype);
    const { rows } = await pool.query(
      `UPDATE staff_documents SET storage_path=$1, file_name=$2, mime_type=$3, size_bytes=$4, verification_status='pending', verified_by=NULL, verified_at=NULL
        WHERE id=$5 RETURNING ${DOC_COLS}`,
      [path, req.file.originalname || null, req.file.mimetype, req.file.size, d.id]);
    await storage.remove(d.storage_path);
    logAccess(req, { action: "hr.employee_document_replaced", resourceType: "staff", resourceId: d.staff_id });
    res.json(rows[0]);
  } catch (e) { console.error("[employees doc replace]", e.message); fail(res, e); }
});

router.delete("/:id/documents/:docId", requireAuth, adminOnly, async (req, res) => {
  try {
    const d = await loadDoc(req, req.params.id, req.params.docId);
    if (!d) return res.status(404).json({ error: "Not found" });
    await pool.query("DELETE FROM staff_documents WHERE id=$1", [d.id]);
    await storage.remove(d.storage_path);
    logAccess(req, { action: "hr.employee_document_deleted", resourceType: "staff", resourceId: d.staff_id });
    res.json({ ok: true });
  } catch (e) { fail(res, e); }
});

module.exports = router;
