"use strict";
// Central audit recorder. One middleware, mounted once in index.js, watches every change (POST/PUT/PATCH/DELETE)
// that a logged-in hospital staff member makes anywhere in the API. When the request succeeds it saves an entry
// in hospital_activity (who, role, what, which record, before -> after, exact time).
//
//  * Routes with a rule below get a precise description and, where possible, a before -> after comparison.
//  * Any other change by staff is still recorded by the generic fallback, so nothing is silently missed.
//  * Doctor profile edits keep using logDoctorChange (services/activity.js), so the rule for them is "skip".
const jwt = require("jsonwebtoken");
const { pool } = require("../db/init");
const { JWT_SECRET } = require("../utils/secrets");
const activity = require("./activity");

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const STAFF_ROLES = new Set(["doctor", "nurse", "front_office", "pharmacy", "pharmacy_staff", "hospital_lab", "hospital_admin"]);

// Never recorded: logins, background pings, scans/previews and read-style POSTs.
const SKIP = /^\/(auth|push|chat|voice|activity|my-modules|abdm|enquiries|family-members|payments|app-version|dashboard|pharmacy-stats)(\/|$)|\/(login|logout|set-password|search|lookup|preview|parse|extract|scan|validate|check|transcribe|suggest|calculate|heartbeat|ping|refresh|ocr)(\/|$)|\/regulate$/i;

// ── small helpers ────────────────────────────────────────────────────────────
const safe = (fn, dflt = null) => { try { const v = fn(); return v === undefined ? dflt : v; } catch (_) { return dflt; } };
const pick = (o, keys) => {
  for (const k of keys) { const v = o && o[k]; if (v != null && String(v).trim() !== "") return String(v).trim(); }
  return null;
};
const PATIENT_KEYS = ["patientName", "patient_name", "name", "fullName"];
const WORDS = { spo2: "SpO2", cgst: "CGST", sgst: "SGST", gst: "GST", uhid: "UHID", mrp: "MRP", hsn: "HSN", ipd: "IPD", opd: "OPD", id: "ID", mg: "mg", bp: "BP" };

function humanize(k) {
  const s = String(k).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  const out = s.split(/\s+/).map((w) => WORDS[w] || w).join(" ");
  return out.charAt(0).toUpperCase() + out.slice(1);
}
function dt(d) {
  return new Date(d).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}
const MONEY = /(price|amount|fee|salary|charge|cost|mrp|balance|total|rate)/i;
const PERCENT_WORDS = /(percent|pct|%)/i;
function fv(k, v) {
  if (v == null || v === "") return "not set";
  if (v instanceof Date) return dt(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.length + (v.length === 1 ? " item" : " items");
  if (typeof v === "object") return "updated";
  let s = String(v);
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return dt(s);
  if (/^data:/.test(s) || s.length > 400) return "(updated)";
  if (s.length > 140) s = s.slice(0, 137) + "...";
  if (k && MONEY.test(k) && !PERCENT_WORDS.test(k) && /^-?\d+(\.\d+)?$/.test(s)) return "\u20b9" + s;
  return s;
}

// ── before/after comparison ──────────────────────────────────────────────────
const NOISE_COL = /^(_.*|id|created_at|updated_at|.*_id|hospital_id|password.*|.*_hash|.*token.*|latitude|longitude|version|search_text|packed_at|ready_at|handed_over_at|first_login)$/i;
function same(x, y) {
  if (x === "") x = null;
  if (y === "") y = null;
  if (x == null || y == null) return x === y;
  if (x instanceof Date || y instanceof Date) return new Date(x).getTime() === new Date(y).getTime();
  if (typeof x === "object" || typeof y === "object") return JSON.stringify(x) === JSON.stringify(y);
  const nx = Number(x), ny = Number(y);
  if (Number.isFinite(nx) && Number.isFinite(ny)) return nx === ny;
  return String(x) === String(y);
}
function diffRows(b, a, o) {
  o = o || {};
  const out = [];
  for (const k of Object.keys(a)) {
    if (o.only ? !o.only.includes(k) : NOISE_COL.test(k)) continue;
    if (o.ignore && o.ignore.includes(k)) continue;
    if (!(k in b)) continue;
    if (same(b[k], a[k])) continue;
    out.push({ field: k, label: (o.labels && o.labels[k]) || humanize(k), from: fv(k, b[k]), to: fv(k, a[k]) });
  }
  return out;
}

// Plain list of what was entered (used for new records and actions): label -> value, never secrets.
const SECRET_KEY = /pass|pwd|secret|token|otp|cvv|image|photo|signature|base64|dataurl/i;
function autoDetails(body, skipKeys) {
  const out = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (out.length >= 10) break;
    if (SECRET_KEY.test(k) || (skipKeys && skipKeys.includes(k)) || /(^id$|Id$|_id$)/.test(k)) continue;
    if (v == null || v === "" || typeof v === "function") continue;
    if (typeof v === "object" && !Array.isArray(v)) continue;
    if (typeof v === "string" && v.length > 400) continue;
    out.push({ field: k, label: humanize(k), from: null, to: fv(k, v) });
  }
  return out;
}
const detail = (label, value, field) => (value == null || value === "" ? null : { field: field || label, label, from: null, to: String(value) });
const compact = (arr) => arr.filter(Boolean);

function vitalsList(v) {
  return compact([
    v.sys != null && v.dia != null && (v.sys !== "" || v.dia !== "") ? detail("Blood pressure", v.sys + "/" + v.dia + " mmHg", "bp") : null,
    detail("Pulse", v.pulse != null && v.pulse !== "" ? v.pulse + " bpm" : null),
    detail("Temperature", v.temp != null && v.temp !== "" ? v.temp + " \u00b0F" : null),
    detail("SpO2", v.spo2 != null && v.spo2 !== "" ? v.spo2 + " %" : null),
    detail("Respiratory rate", v.rr != null && v.rr !== "" ? v.rr + " /min" : null),
    detail("Weight", v.wt != null && v.wt !== "" ? v.wt + " kg" : null),
    detail("Blood glucose", v.glu != null && v.glu !== "" ? v.glu + " mg/dL" : null),
  ]);
}
const vitalsFromBody = (b) => vitalsList({ sys: b.bpSystolic, dia: b.bpDiastolic, pulse: b.pulse, temp: b.temperature, spo2: b.spo2, rr: b.respRate, wt: b.weight, glu: b.bloodGlucose });
const vitalsFromRow = (r) => vitalsList({ sys: r.bp_systolic, dia: r.bp_diastolic, pulse: r.pulse, temp: r.temperature, spo2: r.spo2, rr: r.resp_rate, wt: r.weight, glu: r.blood_glucose });

// ── rule table ───────────────────────────────────────────────────────────────
// R(method, pathRegex, options). The path is relative to /api (for example /nursing/vitals).
//   cat      category shown in the filters (string or function)      action   machine name of the action
//   ent      kind of record affected                                  name     (ctx) => name of the record / patient
//   text     what happened, after the actor's name (string or (ctx, name) => string)
//   snap     async (ctx) => row loaded BEFORE the change (and again AFTER when after:true)
//   diff     compare before/after rows (true or { only, ignore, labels })   noun  word used in "changed X of <noun> NAME"
//   keepText always use text, even when a comparison exists               details  (ctx) => [{label,to}] shown under the entry
//   skip     do not record this route                                     when  (ctx) => false to skip
const rules = [];
function R(method, re, o) { rules.push(Object.assign({ method, re }, o)); }
function matchRule(method, p) {
  for (const r of rules) {
    if (r.method !== method) continue;
    const m = r.re.exec(p);
    if (m) return { rule: r, params: m.slice(1) };
  }
  return null;
}
const getRow = async (table, id) => {
  if (id == null || id === "") return null;
  const { rows } = await pool.query("SELECT * FROM " + table + " WHERE id=$1 LIMIT 1", [id]);
  return rows[0] || null;
};
const row = (table, idx) => async (c) => getRow(table, c.params[idx || 0]);
const bedSnap = async (c) => {
  const b = await getRow("beds", c.params[1]);
  if (b) { const w = await getRow("wards", b.ward_id || c.params[0]); b._ward = w ? w.name : null; }
  return b;
};
const pn = (c) => pick(c.body, PATIENT_KEYS) || pick(c.resBody, ["patientName", "patient_name"]);
const bedText = (c) => {
  const r = c.after || c.before || {};
  return "bed " + (r.bed_number || "") + (r._ward ? " in " + r._ward : "");
};

// Doctors: profile edits are recorded by logDoctorChange, so skip here to avoid duplicates.
R("PATCH", /^\/doctors\/[^/]+$/, { skip: true });
R("POST", /^\/doctors$/, { cat: "doctor", action: "doctor.created", ent: "doctor", name: (c) => pick(c.body, ["name"]) || pick(c.resBody, ["name"]), text: (c, n) => "added doctor " + (n || ""), details: (c) => autoDetails(c.body, ["password", "phone"]) });
R("DELETE", /^\/doctors\/([^/]+)$/, { cat: "doctor", action: "doctor.removed", ent: "doctor", snap: row("doctors"), name: (c) => c.before && c.before.name, text: (c, n) => "removed doctor " + (n || ""), details: () => [] });
R("POST", /^\/doctors\/([^/]+)\/reset-password$/, { cat: "doctor", action: "doctor.password_reset", ent: "doctor", snap: row("doctors"), name: (c) => c.before && c.before.name, text: (c, n) => "reset the password of doctor " + (n || ""), details: () => [] });

// Nursing
R("POST", /^\/nursing\/vitals$/, { cat: "nursing", action: "nursing.vitals_recorded", ent: "patient", name: (c) => pick(c.body, ["patientName"]), text: (c, n) => "recorded vitals for " + (n || "a patient"), details: (c) => vitalsFromBody(c.body) });
R("DELETE", /^\/nursing\/vitals\/([^/]+)$/, { cat: "nursing", action: "nursing.vitals_deleted", ent: "patient", snap: row("hospital_nursing_vitals"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "deleted a vitals record of " + (n || "a patient"), details: (c) => (c.before ? vitalsFromRow(c.before) : []) });
R("POST", /^\/nursing\/notes$/, { cat: "nursing", action: "nursing.note_added", ent: "patient", name: (c) => pick(c.body, ["patientName"]), text: (c, n) => "added a nursing note for " + (n || "a patient"), details: (c) => compact([detail("Note", String(c.body.note || "").slice(0, 300)), detail("Shift", c.body.shift)]) });
R("DELETE", /^\/nursing\/notes\/([^/]+)$/, { cat: "nursing", action: "nursing.note_deleted", ent: "patient", snap: row("hospital_nursing_notes"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "deleted a nursing note of " + (n || "a patient"), details: (c) => (c.before ? compact([detail("Note", String(c.before.note || "").slice(0, 300))]) : []) });
R("POST", /^\/front-office\/bookings\/([^/]+)\/vitals$/, { cat: "front_desk", action: "front_desk.vitals_recorded", ent: "patient", snap: row("bookings"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "recorded vitals for " + (n || "a patient"), details: (c) => vitalsFromBody(c.body).length ? vitalsFromBody(c.body) : autoDetails(c.body) });
R("POST", /^\/doctor-vitals\/booking\/([^/]+)$/, { cat: (c) => (c.u.role === "doctor" ? "doctor" : c.u.role === "nurse" ? "nursing" : "front_desk"), action: "vitals.recorded", ent: "patient", snap: row("bookings"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "recorded vitals for " + (n || "a patient"), details: (c) => autoDetails(c.body) });
R("PUT", /^\/doctor-vitals\/config$/, { cat: "doctor", action: "doctor.vitals_config_changed", text: "changed the vitals settings", details: (c) => autoDetails(c.body) });

// Nurse logins (HR)
R("POST", /^\/nurses$/, { cat: "hr", action: "hr.nurse_login_created", ent: "nurse", name: (c) => pick(c.body, ["name"]) || pick(c.resBody, ["name"]), text: (c, n) => "created a nurse login" + (n ? " for " + n : ""), details: (c) => autoDetails(c.body) });
R("POST", /^\/nurses\/([^/]+)\/reset-password$/, { cat: "hr", action: "hr.nurse_password_reset", ent: "nurse", snap: row("nurses"), name: (c) => c.before && c.before.name, text: (c, n) => "reset the password of nurse " + (n || ""), details: () => [] });
R("DELETE", /^\/nurses\/([^/]+)$/, { cat: "hr", action: "hr.nurse_login_removed", ent: "nurse", snap: row("nurses"), name: (c) => c.before && c.before.name, text: (c, n) => "removed the nurse login of " + (n || ""), details: () => [] });

// Wards and beds
R("POST", /^\/wards$/, { cat: "wards", action: "wards.ward_created", ent: "ward", name: (c) => pick(c.body, ["name"]) || pick(c.resBody, ["name"]), text: (c, n) => "created ward " + (n || ""), details: (c) => autoDetails(c.body) });
R("PATCH", /^\/wards\/([^/]+)$/, { cat: "wards", action: "wards.ward_updated", ent: "ward", snap: row("wards"), after: true, diff: true, noun: "ward", name: (c) => (c.after || c.before || {}).name, text: (n) => "updated a ward" });
R("DELETE", /^\/wards\/([^/]+)$/, { cat: "wards", action: "wards.ward_deleted", ent: "ward", snap: row("wards"), name: (c) => c.before && c.before.name, text: (c, n) => "deleted ward " + (n || ""), details: () => [] });
R("POST", /^\/wards\/([^/]+)\/beds$/, { cat: "wards", action: "wards.beds_added", ent: "ward", snap: row("wards"), name: (c) => c.before && c.before.name, text: (c, n) => "added beds to ward " + (n || ""), details: (c) => autoDetails(c.body) });
R("PATCH", /^\/wards\/([^/]+)\/beds\/([^/]+)$/, { cat: "wards", action: "wards.bed_updated", ent: "bed", snap: bedSnap, after: true, diff: true, noun: "bed", name: (c) => { const r = c.after || c.before || {}; return (r.bed_number || "") + (r._ward ? " (" + r._ward + ")" : ""); }, text: () => "updated a bed" });
R("DELETE", /^\/wards\/([^/]+)\/beds\/([^/]+)$/, { cat: "wards", action: "wards.bed_deleted", ent: "bed", snap: bedSnap, name: (c) => c.before && c.before.bed_number, text: (c) => "deleted " + bedText(c), details: () => [] });
R("POST", /^\/wards\/([^/]+)\/beds\/([^/]+)\/occupy$/, { cat: "wards", action: "wards.bed_occupied", ent: "bed", snap: bedSnap, after: true, diff: { only: ["status", "patient_name"] }, keepText: true, name: (c) => (c.after || c.before || {}).patient_name, text: (c, n) => "marked " + bedText(c) + " as occupied" + (n ? " by " + n : "") });
R("PATCH", /^\/wards\/([^/]+)\/beds\/([^/]+)\/vacate$/, { cat: "wards", action: "wards.bed_vacated", ent: "bed", snap: bedSnap, after: true, diff: { only: ["status", "patient_name"] }, keepText: true, name: (c) => c.before && c.before.patient_name, text: (c, n) => "vacated " + bedText(c) + (n ? " (patient " + n + ")" : "") });
R("PATCH", /^\/wards\/([^/]+)\/beds\/([^/]+)\/ready$/, { cat: "wards", action: "wards.bed_ready", ent: "bed", snap: bedSnap, after: true, diff: { only: ["status"] }, keepText: true, name: (c) => c.before && c.before.bed_number, text: (c) => "marked " + bedText(c) + " as ready" });
R("PATCH", /^\/wards\/([^/]+)\/beds\/([^/]+)\/extend$/, { cat: "wards", action: "wards.bed_cleaning_extended", ent: "bed", snap: bedSnap, name: (c) => c.before && c.before.bed_number, text: (c) => "extended the cleaning time of " + bedText(c), details: (c) => autoDetails(c.body) });
R("PATCH", /^\/wards\/([^/]+)\/beds\/([^/]+)\/cleaning-time$/, { cat: "wards", action: "wards.bed_cleaning_time", ent: "bed", snap: bedSnap, name: (c) => c.before && c.before.bed_number, text: (c) => "changed the cleaning time of " + bedText(c), details: (c) => autoDetails(c.body) });
R("PATCH", /^\/wards\/([^/]+)\/cleaning-time$/, { cat: "wards", action: "wards.ward_cleaning_time", ent: "ward", snap: row("wards"), name: (c) => c.before && c.before.name, text: (c, n) => "changed the cleaning time of ward " + (n || ""), details: (c) => autoDetails(c.body) });
R("PUT", /^\/wards\/cleaning-settings$/, { cat: "wards", action: "wards.cleaning_settings", text: "changed the bed cleaning settings", details: (c) => autoDetails(c.body) });

// Inpatients (IPD), bed requests, billing, maternity
R("POST", /^\/inward$/, { cat: "wards", action: "ipd.admitted", ent: "patient", name: pn, text: (c, n) => "admitted " + (n || "a patient") + " as an inpatient", details: (c) => compact([detail("Bed", pick(c.resBody, ["bed_number", "bedNumber"])), detail("Ward", pick(c.resBody, ["ward"])), detail("Doctor", c.body.admittingDoctorName), detail("Diagnosis", c.body.diagnosis)]) });
R("PATCH", /^\/inward\/([^/]+)\/discharge$/, { cat: "wards", action: "ipd.discharged", ent: "patient", snap: row("inward_patients"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "discharged " + (n || "a patient"), details: (c) => compact([detail("Ward", c.before && c.before.ward), detail("Bed", c.before && c.before.bed_number)]) });
R("POST", /^\/inward\/([^/]+)\/transfer$/, { cat: "wards", action: "ipd.transferred", ent: "patient", snap: row("inward_patients"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "transferred " + (n || "a patient") + " to another bed", details: (c) => compact([detail("From", c.before && ((c.before.ward || "") + " " + (c.before.bed_number || "")).trim()), detail("Reason", c.body.reason), detail("Daily rate", c.body.rate != null && c.body.rate !== "" ? "\u20b9" + c.body.rate : null)]) });
R("PATCH", /^\/inward\/([^/]+)$/, { cat: "wards", action: "ipd.updated", ent: "patient", snap: row("inward_patients"), after: true, diff: true, noun: "inpatient", name: (c) => (c.after || c.before || {}).patient_name, text: () => "updated an inpatient record" });
R("POST", /^\/front-office\/admit$/, { cat: "front_desk", action: "ipd.admitted", ent: "patient", name: pn, text: (c, n) => "admitted " + (n || "a patient") + " as an inpatient", details: (c) => compact([detail("Doctor", c.body.admittingDoctorName), detail("Diagnosis", c.body.diagnosis)]) });
R("POST", /^\/bed-bookings$/, { cat: "wards", action: "bed.requested", ent: "patient", name: pn, text: (c, n) => "created a bed request for " + (n || "a patient"), details: (c) => autoDetails(c.body) });
R("PATCH", /^\/bed-bookings\/([^/]+)\/(cancel|confirm|reject)$/, { cat: "wards", action: "bed.request_changed", ent: "patient", snap: row("bed_bookings"), name: (c) => c.before && c.before.patient_name, text: (c, n) => { const w = /\/(cancel|confirm|reject)$/.exec(c.path)[1]; return ({ cancel: "cancelled", confirm: "confirmed", reject: "rejected" })[w] + " the bed request of " + (n || "a patient"); }, details: (c) => compact([detail("Ward", c.before && c.before.ward_name), detail("Bed", c.before && c.before.bed_number), detail("Note", c.body.staffNote || c.body.note || c.body.reason)]) });
R("POST", /^\/bed-bookings\/([^/]+)\/admit$/, { cat: "wards", action: "bed.request_admitted", ent: "patient", snap: row("bed_bookings"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "admitted " + (n || "a patient") + " from a bed request", details: (c) => compact([detail("Ward", c.before && c.before.ward_name), detail("Bed", c.before && c.before.bed_number)]) });
R("PATCH", /^\/bed-bookings\/ward-rate\/([^/]+)$/, { cat: "wards", action: "bed.ward_rate_changed", ent: "ward", snap: row("wards"), name: (c) => c.before && c.before.name, text: (c, n) => "changed the bed charges of ward " + (n || ""), details: (c) => autoDetails(c.body) });
R("PATCH", /^\/ipd-billing\/([^/]+)\/settings$/, { cat: "wards", action: "ipd.bill_settings", ent: "patient", snap: row("inward_patients"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "changed the bill settings (discount / tax) of " + (n || "a patient"), details: (c) => autoDetails(c.body) });
R("POST", /^\/ipd-billing\/([^/]+)\/items$/, { cat: "wards", action: "ipd.bill_item_added", ent: "patient", snap: row("inward_patients"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "added a bill item for " + (n || "a patient"), details: (c) => autoDetails(c.body) });
R("DELETE", /^\/ipd-billing\/([^/]+)\/items\/([^/]+)$/, { cat: "wards", action: "ipd.bill_item_removed", ent: "patient", snap: row("inward_patients"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "removed a bill item of " + (n || "a patient"), details: () => [] });
R("POST", /^\/ipd-billing\/([^/]+)\/payments$/, { cat: "wards", action: "ipd.payment_recorded", ent: "patient", snap: row("inward_patients"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "recorded a payment" + (c.body.amount != null && c.body.amount !== "" ? " of \u20b9" + c.body.amount : "") + " for " + (n || "a patient"), details: (c) => autoDetails(c.body) });
R("DELETE", /^\/ipd-billing\/([^/]+)\/payments\/([^/]+)$/, { cat: "wards", action: "ipd.payment_removed", ent: "patient", snap: row("inward_patients"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "removed a payment of " + (n || "a patient"), details: () => [] });
R("POST", /^\/maternity\/([^/]+)$/, { cat: "wards", action: "ipd.maternity_record", ent: "patient", snap: row("inward_patients"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "updated the maternity record of " + (n || "a patient"), details: (c) => autoDetails(c.body) });
R("POST", /^\/maternity-obs\/([^/]+)$/, { cat: "wards", action: "ipd.maternity_obs", ent: "patient", snap: row("inward_patients"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "added a maternity observation for " + (n || "a patient"), details: (c) => autoDetails(c.body) });
R("DELETE", /^\/maternity-obs\/entry\/([^/]+)$/, { cat: "wards", action: "ipd.maternity_obs_removed", text: "removed a maternity observation", details: () => [] });

// Front desk
R("POST", /^\/bookings$/, { cat: "front_desk", action: "booking.created", ent: "patient", name: pn, text: (c, n) => "created a booking for " + (n || "a patient"), details: (c) => compact([detail("Doctor", c.body.doctorName), detail("Session", c.body.session), detail("Date", c.body.date), detail("Token", pick(c.resBody, ["token_number", "tokenNumber"]))]) });
const bookingNameRule = (re, action, word) => R("POST", re, { cat: "front_desk", action, ent: "patient", snap: row("bookings"), name: (c) => c.before && c.before.patient_name, text: (c, n) => word + " " + (n || "a patient"), details: (c) => compact([detail("Token", c.before && c.before.token_number), detail("Session", c.before && c.before.session), detail("Doctor", c.before && c.before.doctor_name)]) });
bookingNameRule(/^\/front-office\/bookings\/([^/]+)\/check-in$/, "front_desk.checked_in", "checked in");
bookingNameRule(/^\/front-office\/bookings\/([^/]+)\/undo-check-in$/, "front_desk.check_in_undone", "undid the check-in of");
bookingNameRule(/^\/front-office\/bookings\/([^/]+)\/no-show$/, "front_desk.no_show", "marked as no-show:");
bookingNameRule(/^\/front-office\/bookings\/([^/]+)\/reopen$/, "front_desk.reopened", "reopened the booking of");
R("POST", /^\/front-office\/bookings\/([^/]+)\/fee$/, { cat: "front_desk", action: "front_desk.fee_collected", ent: "patient", snap: row("bookings"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "recorded the consultation fee" + (c.body.amount != null && c.body.amount !== "" ? " \u20b9" + c.body.amount : "") + " for " + (n || "a patient"), details: (c) => autoDetails(c.body) });
R("POST", /^\/front-office\/walkin$/, { cat: "front_desk", action: "front_desk.walkin", ent: "patient", name: pn, text: (c, n) => "booked a walk-in token for " + (n || "a patient"), details: (c) => autoDetails(c.body) });
R("POST", /^\/front-office\/claim-code$/, { cat: "front_desk", action: "front_desk.claim_code", text: "used a patient claim code", details: () => [] });
R("POST", /^\/front-office\/staff$/, { cat: "hr", action: "hr.front_office_created", ent: "front_office", name: (c) => pick(c.body, ["name"]) || pick(c.resBody, ["name"]), text: (c, n) => "created a front office login" + (n ? " for " + n : ""), details: (c) => autoDetails(c.body) });
R("PATCH", /^\/front-office\/staff\/([^/]+)$/, { cat: "hr", action: "hr.front_office_updated", ent: "front_office", snap: row("front_office_staff"), after: true, diff: true, noun: "front office login", name: (c) => (c.after || c.before || {}).name, text: () => "updated a front office login" });
R("DELETE", /^\/front-office\/staff\/([^/]+)$/, { cat: "hr", action: "hr.front_office_removed", ent: "front_office", snap: row("front_office_staff"), name: (c) => c.before && c.before.name, text: (c, n) => "removed the front office login of " + (n || ""), details: () => [] });

// Bookings and tokens (doctor / front desk)
R("PATCH", /^\/bookings\/([^/]+)\/status$/, { cat: (c) => (c.u.role === "doctor" ? "doctor" : "front_desk"), action: "booking.status_changed", ent: "patient", snap: row("bookings"), after: true, diff: { only: ["status"] }, noun: "booking", name: (c) => (c.after || c.before || {}).patient_name, text: (c, n) => "changed the booking status of " + (n || "a patient") });
R("POST", /^\/bookings\/([^/]+)\/mark-late$/, { cat: "front_desk", action: "booking.marked_late", ent: "patient", snap: row("bookings"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "marked " + (n || "a patient") + " as late", details: () => [] });
const TOKEN_TEXT = { complete: "completed a token", skip: "skipped a token", "complete-skipped": "completed a skipped token", close: "closed a session", "priority-slot": "added a priority slot" };
R("POST", /^\/tokens\/([^/]+)\/(complete|skip|complete-skipped|close|priority-slot)$/, { cat: "doctor", action: "tokens.action", text: (c) => (TOKEN_TEXT[c.params[1]] || "changed the token queue") + (c.body.tokenNumber ? " (token " + c.body.tokenNumber + ")" : ""), details: (c) => autoDetails(c.body) });
R("POST", /^\/tokens\/cancel-session$/, { cat: "doctor", action: "tokens.session_cancelled", text: "cancelled a session", details: (c) => autoDetails(c.body) });
R("POST", /^\/availability\/(start|extend|resume)$/, { cat: "doctor", action: "doctor.availability", text: (c) => ({ start: "started a break", extend: "extended the break", resume: "resumed consultation" })[c.params[0]], details: (c) => compact([detail("Reason", c.body.reason || c.body.customReason), detail("Minutes", c.body.minutes)]) });

// Prescriptions and pharmacy
const rxCat = (c) => (c.u.role === "doctor" ? "doctor" : c.u.role === "nurse" ? "nursing" : "pharmacy");
R("POST", /^\/(?:pharmacy|prescriptions)$/, { cat: rxCat, action: "rx.created", ent: "patient", name: pn, text: (c, n) => "wrote a prescription for " + (n || "a patient"), details: (c) => compact([detail("Medicines", Array.isArray(c.body.items) ? c.body.items.length + " items" : null), detail("Diagnosis", c.body.diagnosis), detail("Notes", c.body.notes)]) });
R("POST", /^\/(?:pharmacy|prescriptions)\/inward\/([^/]+)$/, { cat: rxCat, action: "rx.created_ipd", ent: "patient", snap: row("inward_patients", 0), name: (c) => (c.before && c.before.patient_name), text: (c, n) => "wrote an inpatient prescription for " + (n || "a patient"), details: (c) => compact([detail("Doctor", c.body.doctorName), detail("Medicines", Array.isArray(c.body.items) ? c.body.items.length + " items" : null), detail("Diagnosis", c.body.diagnosis)]) });
R("PATCH", /^\/(?:pharmacy|prescriptions)\/prescriptions\/([^/]+)\/status$/, { cat: "pharmacy", action: "rx.status_changed", ent: "patient", snap: row("prescriptions"), after: true, diff: { only: ["status"] }, noun: "prescription", name: (c) => (c.after || c.before || {}).patient_name, text: (c, n) => "changed the prescription status of " + (n || "a patient") });
R("POST", /^\/(?:pharmacy|prescriptions)\/staff$/, { cat: "hr", action: "hr.pharmacy_created", ent: "pharmacy_staff", name: (c) => pick(c.body, ["name"]) || pick(c.resBody, ["name"]), text: (c, n) => "created a pharmacy login" + (n ? " for " + n : ""), details: (c) => autoDetails(c.body) });
R("DELETE", /^\/(?:pharmacy|prescriptions)\/staff\/([^/]+)$/, { cat: "hr", action: "hr.pharmacy_removed", ent: "pharmacy_staff", snap: row("pharmacy_staff"), name: (c) => c.before && c.before.name, text: (c, n) => "removed the pharmacy login of " + (n || ""), details: () => [] });
R("PATCH", /^\/(?:pharmacy|prescriptions)\/staff\/([^/]+)\/password$/, { cat: "hr", action: "hr.pharmacy_password", ent: "pharmacy_staff", snap: row("pharmacy_staff"), name: (c) => c.before && c.before.name, text: (c, n) => "changed the password of pharmacy login " + (n || ""), details: () => [] });
R("POST", /^\/prescription-presets$/, { cat: "doctor", action: "doctor.preset_created", ent: "preset", name: (c) => pick(c.body, ["name", "title", "label"]), text: (c, n) => "created a prescription preset" + (n ? " " + n : ""), details: (c) => autoDetails(c.body) });
R("PATCH", /^\/prescription-presets\/([^/]+)$/, { cat: "doctor", action: "doctor.preset_updated", ent: "preset", snap: row("prescription_presets"), after: true, diff: true, noun: "prescription preset", name: (c) => (c.after || c.before || {}).name, text: () => "updated a prescription preset" });
R("DELETE", /^\/prescription-presets\/([^/]+)$/, { cat: "doctor", action: "doctor.preset_deleted", ent: "preset", snap: row("prescription_presets"), name: (c) => c.before && c.before.name, text: (c, n) => "deleted a prescription preset" + (n ? " " + n : ""), details: () => [] });

// Laboratory
R("POST", /^\/hospital-lab\/tests$/, { cat: "lab", action: "lab.test_created", ent: "lab_test", name: (c) => pick(c.body, ["name"]) || pick(c.resBody, ["name"]), text: (c, n) => "added lab test " + (n || ""), details: (c) => autoDetails(c.body) });
R("DELETE", /^\/hospital-lab\/tests\/([^/]+)$/, { cat: "lab", action: "lab.test_deleted", ent: "lab_test", snap: row("hospital_lab_tests"), name: (c) => c.before && c.before.name, text: (c, n) => "deleted lab test " + (n || ""), details: () => [] });
R("POST", /^\/hospital-lab\/orders$/, { cat: "lab", action: "lab.order_created", ent: "patient", name: (c) => pick(c.body, ["patientName"]) || pick(c.resBody, ["patient_name"]), text: (c, n) => "created a lab order for " + (n || "a patient"), details: (c) => compact([detail("Test", c.body.testName || pick(c.resBody, ["test_name"])), detail("Priority", c.body.priority), detail("Notes", c.body.notes)]) });
const labOrderRule = { cat: "lab", action: "lab.order_updated", ent: "patient", snap: row("hospital_lab_orders"), after: true, diff: { only: ["status", "result_value", "priority", "notes", "report_url"], labels: { report_url: "Report", result_value: "Result" } }, noun: "lab order", name: (c) => (c.after || c.before || {}).patient_name, text: () => "updated a lab order" };
R("PATCH", /^\/hospital-lab\/orders\/([^/]+)$/, labOrderRule);
R("PATCH", /^\/hospital-lab-staff\/orders\/([^/]+)$/, labOrderRule);
R("POST", /^\/hospital-lab-staff\/inpatients\/([^/]+)\/orders$/, { cat: "lab", action: "lab.inpatient_order", ent: "patient", snap: row("inward_patients"), name: (c) => c.before && c.before.patient_name, text: (c, n) => "created a lab order for inpatient " + (n || ""), details: (c) => autoDetails(c.body) });
R("PATCH", /^\/hospital-lab\/toggle$/, { cat: "lab", action: "lab.toggle", text: "changed the online lab booking setting", details: (c) => autoDetails(c.body) });
R("POST", /^\/hospital-lab-staff\/staff$/, { cat: "hr", action: "hr.lab_created", ent: "lab_staff", name: (c) => pick(c.body, ["name"]) || pick(c.resBody, ["name"]), text: (c, n) => "created a lab login" + (n ? " for " + n : ""), details: (c) => autoDetails(c.body) });
R("DELETE", /^\/hospital-lab-staff\/staff\/([^/]+)$/, { cat: "hr", action: "hr.lab_removed", ent: "lab_staff", snap: row("hospital_lab_staff"), name: (c) => c.before && c.before.name, text: (c, n) => "removed the lab login of " + (n || ""), details: () => [] });
R("PATCH", /^\/hospital-lab-staff\/staff\/([^/]+)\/password$/, { cat: "hr", action: "hr.lab_password", ent: "lab_staff", snap: row("hospital_lab_staff"), name: (c) => c.before && c.before.name, text: (c, n) => "changed the password of lab login " + (n || ""), details: () => [] });

// Inventory
R("POST", /^\/inventory$/, { cat: "inventory", action: "inventory.item_created", ent: "inventory_item", name: (c) => pick(c.body, ["name"]) || pick(c.resBody, ["name"]), text: (c, n) => "added inventory item " + (n || ""), details: (c) => autoDetails(c.body) });
R("PATCH", /^\/inventory\/([^/]+)$/, { cat: "inventory", action: "inventory.item_updated", ent: "inventory_item", snap: row("inventory_items"), after: true, diff: true, noun: "inventory item", name: (c) => (c.after || c.before || {}).name, text: () => "updated an inventory item" });
R("POST", /^\/inventory\/([^/]+)\/transaction$/, { cat: "inventory", action: "inventory.stock_moved", ent: "inventory_item", snap: row("inventory_items"), after: true, diff: { only: ["quantity"] }, keepText: true, name: (c) => (c.after || c.before || {}).name, text: (c, n) => (c.body.type === "in" ? "added stock to " : "removed stock from ") + (n || "an item") + " (" + Math.abs(Number(c.body.quantity) || 0) + ")" + (c.body.reason ? " - " + c.body.reason : "") });
R("DELETE", /^\/inventory\/([^/]+)$/, { cat: "inventory", action: "inventory.item_deleted", ent: "inventory_item", snap: row("inventory_items"), name: (c) => c.before && c.before.name, text: (c, n) => "deleted inventory item " + (n || ""), details: () => [] });

// HR / staff
R("POST", /^\/hr$/, { cat: "hr", action: "hr.staff_created", ent: "staff", name: (c) => pick(c.body, ["name"]) || pick(c.resBody, ["name"]), text: (c, n) => "added staff member " + (n || ""), details: (c) => autoDetails(c.body) });
R("PATCH", /^\/hr\/([^/]+)$/, { cat: "hr", action: "hr.staff_updated", ent: "staff", snap: row("hospital_staff"), after: true, diff: true, noun: "staff member", name: (c) => (c.after || c.before || {}).name, text: () => "updated a staff member" });
R("DELETE", /^\/hr\/([^/]+)$/, { cat: "hr", action: "hr.staff_removed", ent: "staff", snap: row("hospital_staff"), name: (c) => c.before && c.before.name, text: (c, n) => "removed staff member " + (n || ""), details: () => [] });
R("POST", /^\/hr\/replace-doctor$/, { cat: "hr", action: "hr.doctor_replaced", ent: "doctor", snap: async (c) => getRow("doctors", c.body.doctorId), name: (c) => c.body.name, text: (c, n) => "replaced doctor " + ((c.before && c.before.name) || "") + " with " + (n || "a new doctor"), details: (c) => compact([detail("Reason", c.body.reason), detail("Date", c.body.date)]) });
R("POST", /^\/hr\/terminate-doctor$/, { cat: "hr", action: "hr.doctor_terminated", ent: "doctor", snap: async (c) => getRow("doctors", c.body.doctorId), name: (c) => c.before && c.before.name, text: (c, n) => "terminated doctor " + (n || ""), details: (c) => compact([detail("Reason", c.body.reason), detail("Date", c.body.date)]) });
R("POST", /^\/hr\/terminate-login$/, { cat: "hr", action: "hr.login_terminated", ent: "staff", text: "terminated a staff login", details: (c) => compact([detail("Reason", c.body.reason), detail("Date", c.body.date)]) });
R("POST", /^\/hr\/salary-paid$/, { cat: "hr", action: "hr.salary_paid", ent: "staff", snap: async (c) => getRow("hospital_staff", c.body.staffId), name: (c) => c.before && c.before.name, text: (c, n) => (c.body.paid ? "marked salary as paid for " : "marked salary as unpaid for ") + (n || "a staff member") + (c.body.month ? " (" + c.body.month + ")" : ""), details: () => [] });
R("POST", /^\/staff-attendance\/save$/, { cat: "hr", action: "hr.attendance_saved", text: (c) => "saved staff attendance" + (c.body.date ? " for " + c.body.date : ""), details: () => [] });


// Pharmacy stock (medicines live in inventory_items) and pharmacy settings
const medName = (c) => (c.after || c.before || {}).name;
R("POST", /^\/pharmacy-module\/inventory$/, { cat: "pharmacy", action: "pharmacy.medicine_added", ent: "medicine", name: (c) => pick(c.body, ["name", "medicineName"]) || pick(c.resBody, ["name"]), text: (c, n) => "added medicine " + (n || "") + " to pharmacy stock", details: (c) => autoDetails(c.body) });
R("DELETE", /^\/pharmacy-module\/inventory\/([^/]+)$/, { cat: "pharmacy", action: "pharmacy.medicine_removed", ent: "medicine", snap: row("inventory_items"), name: (c) => c.before && c.before.name, text: (c, n) => "removed medicine " + (n || "") + " from pharmacy stock", details: (c) => (c.before ? compact([detail("Stock", c.before.quantity)]) : []) });
R("PATCH", /^\/pharmacy-module\/inventory\/([^/]+)\/meta$/, { cat: "pharmacy", action: "pharmacy.medicine_updated", ent: "medicine", snap: row("inventory_items"), after: true, diff: { only: ["batch_no", "expiry_date"] }, noun: "medicine", name: medName, text: () => "updated a medicine" });
R("POST", /^\/pharmacy-module\/inventory\/([^/]+)\/stock$/, { cat: "pharmacy", action: "pharmacy.stock_corrected", ent: "medicine", snap: row("inventory_items"), after: true, diff: { only: ["quantity"] }, keepText: true, name: medName, text: (c, n) => "corrected the stock count of " + (n || "a medicine") });
R("POST", /^\/pharmacy-module\/inventory\/([^/]+)\/receive$/, { cat: "pharmacy", action: "pharmacy.stock_received", ent: "medicine", snap: row("inventory_items"), after: true, diff: { only: ["quantity", "batch_no", "expiry_date", "selling_price"] }, keepText: true, name: medName, text: (c, n) => "received stock of " + (n || "a medicine") });
R("POST", /^\/pharmacy-module\/inventory\/([^/]+)\/packing$/, { cat: "pharmacy", action: "pharmacy.packing_changed", ent: "medicine", snap: row("inventory_items"), after: true, diff: { only: ["pack_size", "strips_per_box", "quantity", "selling_price"] }, keepText: true, name: medName, text: (c, n) => "changed the packing details of " + (n || "a medicine") });
R("POST", /^\/pharmacy-module\/stock-deduct$/, { cat: "pharmacy", action: "pharmacy.dispensed", ent: "prescription", name: (c) => pick(c.body, ["patientName"]), text: "dispensed medicines and deducted the stock", details: (c) => autoDetails(c.body) });
R("POST", /^\/pharmacy-module\/gst-invoice-no$/, { cat: "pharmacy", action: "pharmacy.gst_invoice", text: "generated a GST invoice number", details: (c) => compact([detail("From", c.body.from), detail("To", c.body.to)]) });
R("PUT", /^\/pharmacy-module\/gst-(type|profile)$/, { cat: "pharmacy", action: "pharmacy.gst_settings", text: (c) => "changed the pharmacy GST " + c.params[0], details: (c) => autoDetails(c.body) });
R("POST", /^\/pharmacy-import\/commit$/, { cat: "pharmacy", action: "pharmacy.invoice_imported", text: "imported a supplier invoice into pharmacy stock", details: (c) => compact([detail("Supplier", c.body.supplier), detail("Invoice no.", c.body.invoiceNo), detail("Items", Array.isArray(c.body.items) ? c.body.items.length : null)]) });
R("PUT", /^\/doctor\/follow-up\/([^/]+)$/, { cat: "doctor", action: "doctor.follow_up", text: "updated a follow-up", details: (c) => autoDetails(c.body) });

// Hospital settings
R("PATCH", /^\/hospitals\/([^/]+)$/, { cat: "general", action: "hospital.settings_updated", ent: "hospital", snap: row("hospitals"), after: true, diff: true, noun: "hospital settings", name: (c) => (c.after || c.before || {}).name, text: () => "updated the hospital settings" });
R("PATCH", /^\/hospitals\/([^/]+)\/(modules|pharmacy-toggle|intake-config|website)$/, { cat: "general", action: "hospital.settings_changed", ent: "hospital", text: (c) => "changed the hospital " + c.params[1].replace(/-/g, " ") + " settings", details: (c) => autoDetails(c.body) });
R("POST", /^\/hospitals\/([^/]+)\/photo(?:-base64)?$/, { cat: "general", action: "hospital.photo", ent: "hospital", text: "updated the hospital photo", details: () => [] });

// Permissions and passwords
R("PUT", /^\/permissions\/([^/]+)$/, {
  cat: "hr", action: "hr.permissions_changed", ent: "role",
  snap: async (c) => { const { rows } = await pool.query("SELECT modules FROM hospital_role_permissions WHERE hospital_id=$1 AND role=$2", [c.hid || c.u.hospitalId, c.params[0]]); return rows[0] ? { modules: rows[0].modules } : { modules: [] }; },
  after: true,
  name: (c) => humanize(c.params[0]),
  text: (c, n) => "changed the permissions of " + n,
  details: (c) => {
    const toArr = (m) => { try { const v = typeof m === "string" ? JSON.parse(m) : m; return Array.isArray(v) ? v.map(String) : []; } catch (_) { return []; } };
    const b = toArr(c.before && c.before.modules), a = toArr(c.after && c.after.modules);
    const added = a.filter((x) => !b.includes(x)).map(humanize), removed = b.filter((x) => !a.includes(x)).map(humanize);
    return compact([added.length ? { field: "added", label: "Allowed", from: "not allowed", to: added.join(", ") } : null, removed.length ? { field: "removed", label: "Removed", from: removed.join(", "), to: "not allowed" } : null]);
  },
  needChanges: true,
});
const PW_TABLE = { doctor: "doctors", nurse: "nurses", front_office: "front_office_staff", lab: "hospital_lab_staff", pharmacy: "pharmacy_staff" };
const PW_LABEL = { doctor: "doctor", nurse: "nurse", front_office: "front office", lab: "lab", pharmacy: "pharmacy" };
const pwSnap = async (c) => (PW_TABLE[c.params[0]] ? getRow(PW_TABLE[c.params[0]], c.params[1]) : null);
for (const base of ["password-management", "staff-management"]) {
  R("POST", new RegExp("^\\/" + base + "\\/([^/]+)\\/([^/]+)\\/show$"), { cat: "hr", action: "hr.password_viewed", ent: "login", snap: pwSnap, name: (c) => c.before && c.before.name, text: (c, n) => "viewed the password of " + (PW_LABEL[c.params[0]] || "staff") + " login " + (n || ""), details: () => [] });
  R("POST", new RegExp("^\\/" + base + "\\/([^/]+)\\/([^/]+)\\/change$"), { cat: "hr", action: "hr.password_changed", ent: "login", snap: pwSnap, name: (c) => c.before && c.before.name, text: (c, n) => "changed the password of " + (PW_LABEL[c.params[0]] || "staff") + " login " + (n || ""), details: () => [] });
}
R("POST", /^\/staff-management\/([^/]+)$/, { cat: "hr", action: "hr.login_created", ent: "login", name: (c) => pick(c.body, ["name"]) || pick(c.resBody, ["name"]), text: (c, n) => "created a " + (PW_LABEL[c.params[0]] || "staff") + " login" + (n ? " for " + n : ""), details: (c) => autoDetails(c.body) });
R("POST", /^\/doctor-account\/password$/, { cat: "doctor", action: "doctor.password_changed", text: "changed their own password", details: () => [] });
R("POST", /^\/doctor-account\/password\/show$/, { cat: "doctor", action: "doctor.password_viewed", text: "viewed their own password", details: () => [] });

// ── fallback for any change without a rule above ─────────────────────────────
const CAT_BY_SEG = {
  nursing: "nursing", nurses: "hr", wards: "wards", inward: "wards", "ipd-billing": "wards", "bed-bookings": "wards", maternity: "wards", "maternity-obs": "wards",
  "front-office": "front_desk", bookings: "front_desk", tokens: "doctor", doctors: "doctor", doctor: "doctor", "doctor-vitals": "doctor", "doctor-account": "doctor",
  "prescription-presets": "doctor", availability: "doctor", prescriptions: "pharmacy", pharmacy: "pharmacy", "pharmacy-module": "pharmacy", "pharmacy-import": "pharmacy",
  "pharmacy-owner": "pharmacy", "hospital-lab": "lab", "hospital-lab-staff": "lab", labs: "lab", inventory: "inventory", hr: "hr", "staff-attendance": "hr",
  "staff-management": "hr", "password-management": "hr", permissions: "hr",
};
const MODULE_LABEL = {
  nursing: "Nursing", nurses: "Nurse logins", wards: "Wards and beds", inward: "IPD / Inward", "ipd-billing": "IPD billing", "bed-bookings": "Bed requests", "front-office": "Front desk",
  bookings: "Bookings", tokens: "Token control", doctors: "Doctors", doctor: "Doctor login", "doctor-vitals": "Vitals", prescriptions: "Prescriptions", pharmacy: "Pharmacy",
  "pharmacy-module": "Pharmacy", "pharmacy-import": "Pharmacy import", "pharmacy-owner": "Pharmacy", "hospital-lab": "Laboratory", "hospital-lab-staff": "Laboratory", labs: "Laboratory",
  inventory: "Inventory", hr: "HR / Staff", "staff-attendance": "Attendance", "staff-management": "Staff management", "password-management": "Password management", permissions: "Permissions",
  hospitals: "Hospital settings", hospital: "Hospital settings", ambulance: "Ambulance", availability: "Doctor availability", "prescription-presets": "Prescription presets",
};
const isIdSeg = (s) => /\d/.test(s) || /^[a-z]+_[a-z0-9]{6,}$/i.test(s);
function buildGeneric(c, who) {
  const segs = c.path.split("/").filter(Boolean);
  const mod = segs[0] || "";
  const keep = segs.filter((s) => !isIdSeg(s));
  const rest = keep.slice(1).map((s) => humanize(s).toLowerCase()).join(" ");
  const verb = { POST: "performed", PUT: "updated", PATCH: "updated", DELETE: "deleted" }[c.method] || "changed";
  const label = MODULE_LABEL[mod] || humanize(mod || "system");
  const name = pick(c.body, PATIENT_KEYS) || pick(c.resBody, ["patientName", "patient_name"]);
  const what = rest ? "\"" + rest + "\"" : "a record";
  return {
    category: CAT_BY_SEG[mod] || "general",
    action: "api." + c.method.toLowerCase() + "." + keep.join("."),
    entityType: null, entityId: segs.find(isIdSeg) || null, entityName: name,
    summary: who + " " + verb + " " + what + " in " + label + (name ? " for " + name : ""),
    changes: autoDetails(c.body),
  };
}

function buildFromRule(c, r, who) {
  if (r.when && !safe(() => r.when(c), true)) return null;
  const name = r.name ? safe(() => r.name(c), null) : null;
  const both = !!(c.before && c.after);
  let changes = [];
  let phrase = null;
  if (r.diff && both) {
    changes = diffRows(c.before, c.after, r.diff === true ? {} : r.diff);
    if (!changes.length && !r.keepText) return null; // nothing actually changed
    if (!r.keepText) {
      const noun = r.noun || "record";
      phrase = changes.length === 1
        ? "changed " + changes[0].label + " of " + noun + (name ? " " + name : "") + " from " + changes[0].from + " to " + changes[0].to
        : "updated " + changes.length + " details of " + noun + (name ? " " + name : "");
    }
  } else if (r.details) {
    changes = safe(() => r.details(c), []) || [];
  } else if (r.diff) {
    changes = autoDetails(c.body);
  }
  if (r.needChanges && !changes.length) return null;
  if (phrase == null) phrase = typeof r.text === "function" ? safe(() => r.text(c, name), "made a change") : (r.text || "made a change");
  const cat = typeof r.cat === "function" ? safe(() => r.cat(c), "general") : (r.cat || "general");
  return {
    category: cat, action: r.action, entityType: r.ent || null,
    entityId: c.params[c.params.length - 1] || pick(c.resBody, ["id"]) || null,
    entityName: name, summary: who + " " + String(phrase).replace(/\s+/g, " ").trim(), changes,
  };
}

async function finalize(c) {
  const actor = await activity.resolveActor(c.u);
  const hid = actor.hospitalId;
  if (!hid) return;
  c.hid = hid;
  const r = c.rule;
  if (r && r.after && r.snap) { try { c.after = await r.snap(c); } catch (_) { c.after = null; } }
  // Never describe a record that belongs to another hospital.
  for (const k of ["before", "after"]) if (c[k] && c[k].hospital_id && String(c[k].hospital_id) !== String(hid)) c[k] = null;
  const out = r ? buildFromRule(c, r, actor.name) : buildGeneric(c, actor.name);
  if (!out) return;
  await activity.record(Object.assign({ hospitalId: hid, actorId: c.u.id || c.u.doctorId || null, actorRole: c.u.role, actorName: actor.name }, out));
}

function decodeActor(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  try {
    const d = jwt.verify(h.slice(7).trim(), JWT_SECRET);
    if (!d || d.purpose || !STAFF_ROLES.has(d.role)) return null;
    return d;
  } catch (_) { return null; }
}

/** Express middleware. Mount once, before the routes: app.use("/api", activityRecorder()). */
function activityRecorder() {
  return function recordActivityMiddleware(req, res, next) {
    let ctx = null;
    try {
      if (!MUTATING.has(req.method)) return next();
      const p = (req.path || "/").replace(/\/+$/, "") || "/";
      if (SKIP.test(p)) return next();
      const u = decodeActor(req);
      if (!u) return next();
      const hit = matchRule(req.method, p);
      if (hit && hit.rule.skip) return next();
      ctx = {
        u, method: req.method, path: p, params: hit ? hit.params : [], rule: hit ? hit.rule : null,
        body: Object.assign({}, req.body && typeof req.body === "object" ? req.body : {}),
        query: Object.assign({}, req.query), before: null, after: null, resBody: null, hid: null,
      };
      const origJson = res.json.bind(res);
      res.json = function (b) { ctx.resBody = b; return origJson(b); };
      res.on("finish", () => {
        if (res.statusCode >= 400) return;
        finalize(ctx).catch((e) => console.warn("[activity] auto-log failed:", e.message));
      });
      if (ctx.rule && ctx.rule.snap) {
        Promise.resolve().then(() => ctx.rule.snap(ctx)).then((r) => { ctx.before = r || null; }, () => { ctx.before = null; }).then(() => next());
        return;
      }
    } catch (e) { console.warn("[activity] recorder setup failed:", e.message); }
    return next();
  };
}

module.exports = { activityRecorder, matchRule, buildFromRule, buildGeneric, diffRows, autoDetails, rules };
