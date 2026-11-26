"use strict";
// Hospital activity feed (audit log): who changed what, with before/after values.
// Fire-and-forget for callers: a logging failure must never break the request it is logging,
// but every entry is retried and saved to the database (table hospital_activity), never kept only in memory.
const crypto = require("crypto");
const { pool } = require("../db/init");

let tableReady = null;
function ensureTable() {
  if (!tableReady) {
    tableReady = pool.query(`
      CREATE TABLE IF NOT EXISTS hospital_activity (
        id          TEXT PRIMARY KEY,
        at          TIMESTAMPTZ NOT NULL DEFAULT now(),
        hospital_id TEXT NOT NULL,
        actor_id    TEXT,
        actor_role  TEXT,
        actor_name  TEXT,
        category    TEXT NOT NULL,
        action      TEXT NOT NULL,
        entity_type TEXT,
        entity_id   TEXT,
        entity_name TEXT,
        summary     TEXT NOT NULL,
        changes     JSONB
      );
      CREATE INDEX IF NOT EXISTS idx_hact_hospital_at ON hospital_activity(hospital_id, at DESC);
      CREATE INDEX IF NOT EXISTS idx_hact_hospital_cat ON hospital_activity(hospital_id, category, at DESC);
      CREATE INDEX IF NOT EXISTS idx_hact_hospital_role ON hospital_activity(hospital_id, actor_role, at DESC);
    `).catch((e) => { tableReady = null; throw e; });
  }
  return tableReady;
}

const ROLE_LABEL = {
  doctor: "Doctor", nurse: "Nurse", front_office: "Front office", pharmacy: "Pharmacy",
  pharmacy_staff: "Pharmacy", hospital_lab: "Lab", hospital_admin: "Hospital admin", admin: "Platform admin",
};
const STAFF_TABLES = [
  ["doctorId", "doctors"], ["nurseId", "nurses"], ["frontOfficeStaffId", "front_office_staff"],
  ["pharmacyStaffId", "pharmacy_staff"], ["labStaffId", "hospital_lab_staff"],
];

// Who is acting: name and hospital. Doctor/front-office/pharmacy/lab tokens carry no name or hospital, so look them up.
const actorCache = new Map();
async function resolveActor(u) {
  u = u || {};
  const key = [u.role, u.doctorId || u.nurseId || u.frontOfficeStaffId || u.pharmacyStaffId || u.labStaffId || u.id, u.hospitalId].join("|");
  const hit = actorCache.get(key);
  if (hit && Date.now() - hit.t < 10 * 60 * 1000) return hit.v;
  let name = null;
  let hospitalId = u.hospitalId || null;
  for (const [field, table] of STAFF_TABLES) {
    if (!u[field]) continue;
    try {
      const { rows } = await pool.query("SELECT name, hospital_id FROM " + table + " WHERE id=$1", [u[field]]);
      if (rows[0]) {
        name = rows[0].name || null;
        if (!hospitalId) hospitalId = rows[0].hospital_id || null;
        if (field === "doctorId" && name && !/^dr\.?\s/i.test(name)) name = "Dr. " + name;
      }
    } catch (_) { /* fall through */ }
    break;
  }
  if (!name) name = u.name || ROLE_LABEL[u.role] || "Staff";
  const v = { name, hospitalId };
  if (hospitalId) {
    if (actorCache.size > 500) actorCache.clear();
    actorCache.set(key, { t: Date.now(), v });
  }
  return v;
}
async function resolveActorName(u) { return (await resolveActor(u)).name; }

function notifyLive(hospitalId) {
  // Only a tiny "something changed" ping goes over the socket; the admin screen then re-reads
  // the data through the authenticated API, so no activity details are ever broadcast.
  try { require("./ws").broadcast("activity_" + hospitalId, { type: "activity" }); } catch (_) { /* ignore */ }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Saves one activity row (3 tries). Resolves true when saved. */
async function record(e) {
  const row = {
    id: "act_" + crypto.randomBytes(8).toString("hex"),
    hospitalId: e.hospitalId,
    actorId: e.actorId || null, actorRole: e.actorRole || null, actorName: e.actorName || null,
    category: e.category || "general", action: e.action || "activity",
    entityType: e.entityType || null, entityId: e.entityId == null ? null : String(e.entityId), entityName: e.entityName || null,
    summary: e.summary, changes: e.changes && e.changes.length ? JSON.stringify(e.changes) : null,
  };
  if (!row.hospitalId || !row.summary) return false;
  if (!require("./activityImportance").shouldRecord(row.action, e.changes)) return false; // Activity Monitor keeps important changes only
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ensureTable();
      await pool.query(
        `INSERT INTO hospital_activity (id, hospital_id, actor_id, actor_role, actor_name, category, action, entity_type, entity_id, entity_name, summary, changes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [row.id, row.hospitalId, row.actorId, row.actorRole, row.actorName, row.category, row.action,
         row.entityType, row.entityId, row.entityName, row.summary, row.changes]);
      notifyLive(row.hospitalId);
      return true;
    } catch (err) { lastErr = err; await sleep(250 * attempt); }
  }
  console.error("[activity] NOT RECORDED after 3 tries:", row.action, "-", lastErr && lastErr.message);
  return false;
}

/** logActivity(req, { hospitalId, category, action, entityType, entityId, entityName, summary, changes:[{field,label,from,to}] }) */
function logActivity(req, o) {
  const u = (req && req.user) || {};
  (async () => {
    const actor = await resolveActor(u);
    const hid = o.hospitalId || actor.hospitalId;
    if (!hid) return;
    const name = o.actorName || actor.name;
    const summary = typeof o.summary === "function" ? o.summary(name) : o.summary;
    await record({
      hospitalId: hid, actorId: u.id || u.doctorId || null, actorRole: u.role || null, actorName: name,
      category: o.category, action: o.action, entityType: o.entityType, entityId: o.entityId, entityName: o.entityName,
      summary, changes: o.changes,
    });
  })().catch((e) => console.warn("[activity] not recorded:", e.message));
}

// ── Helpers to describe changes in plain words ───────────────────────────────
function parseJson(v) {
  if (!v) return null;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch (_) { return null; }
}
function fmtTime(v) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v == null ? "" : v).trim());
  if (!m) return String(v == null ? "" : v);
  let h = Number(m[1]);
  const ap = h >= 12 ? "PM" : "AM";
  h = h % 12 || 12;
  return h + ":" + m[2] + " " + ap;
}
function range(e) { return e && e.start && e.end ? fmtTime(e.start) + " to " + fmtTime(e.end) : "not set"; }
function cap(s) { s = String(s || ""); return s.charAt(0).toUpperCase() + s.slice(1); }

function describeDoctorChanges(b, a) {
  const out = [];
  const push = (field, label, from, to) => {
    const f = from == null || from === "" ? "not set" : String(from);
    const t = to == null || to === "" ? "not set" : String(to);
    if (f !== t) out.push({ field, label, from: f, to: t });
  };
  const bc = parseJson(b.schedule_config) || {};
  const ac = parseJson(a.schedule_config) || {};
  for (const day of ["weekday", "weekend"]) {
    const bd = bc[day] || {}, ad = ac[day] || {};
    const sessions = Array.from(new Set(Object.keys(bd).concat(Object.keys(ad))));
    for (const s of sessions) {
      const be = bd[s], ae = ad[s];
      push("timing:" + day + ":" + s, cap(day) + " " + s + " timing", range(be), range(ae));
      push("tokens:" + day + ":" + s, cap(day) + " " + s + " tokens", be && be.count, ae && ae.count);
    }
  }
  if (!out.some((c) => c.field.indexOf("timing:") === 0)) {
    const bs = parseJson(b.session_timings) || {}, as = parseJson(a.session_timings) || {};
    for (const s of Array.from(new Set(Object.keys(bs).concat(Object.keys(as))))) {
      push("timing:" + s, cap(s) + " timing", range(bs[s]), range(as[s]));
    }
  }
  push("tokens_per_session", "Default tokens per session", b.tokens_per_session, a.tokens_per_session);
  push("doctor_fee", "Consultation fee", b.doctor_fee == null ? null : "\u20b9" + b.doctor_fee, a.doctor_fee == null ? null : "\u20b9" + a.doctor_fee);
  push("is_available", "Availability", b.is_available === 1 ? "Available" : "Not available", a.is_available === 1 ? "Available" : "Not available");
  push("sessions", "Sessions offered", String(b.sessions || "").split(",").filter(Boolean).map(cap).join(", "), String(a.sessions || "").split(",").filter(Boolean).map(cap).join(", "));
  push("avg_minutes_per_patient", "Minutes per patient", b.avg_minutes_per_patient, a.avg_minutes_per_patient);
  push("walk_in_interval", "Walk-in interval", b.walk_in_interval, a.walk_in_interval);
  push("specialty", "Specialty", b.specialty, a.specialty);
  push("name", "Name", b.name, a.name);
  return out;
}

function logDoctorChange(req, before, after) {
  const changes = describeDoctorChanges(before, after);
  if (!changes.length) return;
  const docName = /^dr\.?\s/i.test(after.name || "") ? after.name : "Dr. " + after.name;
  logActivity(req, {
    hospitalId: after.hospital_id,
    category: "doctor",
    action: "doctor.profile_updated",
    entityType: "doctor", entityId: after.id, entityName: docName,
    changes,
    summary: (actor) => {
      const own = req.user && req.user.doctorId === after.id;
      const who = own ? docName : actor;
      const what = own ? "" : " for " + docName;
      if (changes.length === 1) return who + " changed " + changes[0].label + what + " from " + changes[0].from + " to " + changes[0].to;
      return who + " updated " + changes.length + " settings" + what;
    },
  });
}


module.exports = { logActivity, record, resolveActor, resolveActorName, notifyLive, describeDoctorChanges, logDoctorChange, fmtTime, ROLE_LABEL };
