"use strict";
const jwt = require("jsonwebtoken");

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET === "fallback_dev_secret") {
  if (process.env.NODE_ENV === "production") {
    console.error("[FATAL] JWT_SECRET is not set! Set it in Railway environment variables.");
    process.exit(1);
  } else {
    console.warn("[AUTH] WARNING: Using fallback JWT secret. Set JWT_SECRET in .env");
  }
}

const JWT_SECRET = SECRET || "fallback_dev_secret";

const _docActive = new Map();
const _staffActive = new Map();
const _STAFF_TABLES = { nurseId: "nurses", frontOfficeStaffId: "front_office_staff", pharmacyStaffId: "pharmacy_staff", labStaffId: "hospital_lab_staff" };
function staffActiveCheck(req, res, next) {
  const u = req.user;
  if (!u) return next();
  const field = Object.keys(_STAFF_TABLES).find((f) => u[f]);
  if (!field) return next();
  const table = _STAFF_TABLES[field];
  const deny = () => res.status(401).json({ error: "Session ended. Please log in again." });
  const key = table + ":" + u[field];
  const hit = _staffActive.get(key);
  if (hit && Date.now() - hit.t < 15000) return hit.ok ? next() : deny();
  const { pool } = require("../db/init");
  pool.query("SELECT is_active FROM " + table + " WHERE id=$1", [u[field]]).then(
    (r) => {
      const ok = !!r.rows[0] && r.rows[0].is_active !== 0;
      _staffActive.set(key, { ok, t: Date.now() });
      return ok ? next() : deny();
    },
    (e) => { console.warn("[auth] staff active check:", e.message); next(); }
  );
}

function doctorActiveCheck(req, res, next) {
  const u = req.user;
  if (!u || u.role !== "doctor" || !u.doctorId) return next();
  const deny = () => res.status(401).json({ error: "Session ended. Please log in again." });
  const hit = _docActive.get(u.doctorId);
  if (hit && Date.now() - hit.t < 15000) return hit.ok ? next() : deny();
  const { pool } = require("../db/init");
  pool.query("SELECT is_active FROM doctors WHERE id=$1", [u.doctorId]).then(
    (r) => {
      const ok = !!r.rows[0] && r.rows[0].is_active !== 0;
      _docActive.set(u.doctorId, { ok, t: Date.now() });
      return ok ? next() : deny();
    },
    (e) => { console.warn("[auth] doctor active check:", e.message); next(); }
  );
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    doctorActiveCheck(req, res, () => staffActiveCheck(req, res, next));
  } catch (err) {
    if (err.name === "TokenExpiredError")
      return res.status(401).json({ error: "Session expired. Please log in again." });
    return res.status(401).json({ error: "Invalid token. Please log in again." });
  }
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "admin")
      return res.status(403).json({ error: "Admin access required" });
    next();
  });
}

function requireDoctor(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "doctor")
      return res.status(403).json({ error: "Doctor access required" });
    next();
  });
}

function requireDoctorOrAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "doctor" && req.user.role !== "admin")
      return res.status(403).json({ error: "Doctor or admin access required" });
    next();
  });
}

function requirePharmacy(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "pharmacy")
      return res.status(403).json({ error: "Pharmacy staff access required" });
    next();
  });
}

function requirePharmacyOrAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== "pharmacy" && req.user.role !== "admin")
      return res.status(403).json({ error: "Pharmacy or admin access required" });
    next();
  });
}


function requireAdminOrHospitalAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === "admin" || req.user.role === "hospital_admin") return next();
    return res.status(403).json({ error: "Admin or Hospital Admin access required" });
  });
}
module.exports = {
  requireAuth, requireAdmin, requireDoctor, requireDoctorOrAdmin, requireAdminOrHospitalAdmin,
  requirePharmacy, requirePharmacyOrAdmin,
};
