"use strict";
// Centralized employee management - database side. Safe to run on every start (everything is idempotent).
//  * extra HR columns + staff_documents table
//  * duplicate guard (same hospital: mobile / email / employee id) on every login table and on direct HR edits
//  * newly created pharmacy logins must change their password on first login (nurse / lab / front office already do)
//  * default department when a login is created from a module (Laboratory, Pharmacy, Front Office, Nursing)
// It adds triggers next to the existing hr_ai / hr_au / hr_ad / hr_staff_* ones and never replaces them.

const { pool } = require("./init");

const FN_PHONE_KEY = String.raw`
CREATE OR REPLACE FUNCTION public.staff_phone_key(p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(regexp_replace(COALESCE(p,''), '\D', '', 'g')) >= 7
              THEN right(regexp_replace(p, '\D', '', 'g'), 10) ELSE NULL END
$$`;

// Returns a human readable message when the details clash with an existing person, otherwise NULL.
// skip_staff: the HR row being edited. skip_login: the login id of the person being edited/created.
// app.link_staff (set by the API inside a transaction): an HR-only row that is being given a login right now.
const FN_DUP = String.raw`
CREATE OR REPLACE FUNCTION public.staff_dup_message(h text, ph text, em text, eid text, skip_staff text, skip_login text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  k text := public.staff_phone_key(ph);
  e text := NULLIF(lower(btrim(COALESCE(em,''))), '');
  i text := NULLIF(lower(btrim(COALESCE(eid,''))), '');
  link text := NULLIF(current_setting('app.link_staff', true), '');
  v text;
BEGIN
  IF k IS NOT NULL THEN
    SELECT name INTO v FROM hospital_staff
     WHERE hospital_id = h AND removed_at IS NULL AND public.staff_phone_key(phone) = k
       AND id IS DISTINCT FROM skip_staff AND id IS DISTINCT FROM link
       AND (skip_login IS NULL OR login_id IS DISTINCT FROM skip_login) LIMIT 1;
    IF v IS NOT NULL THEN RETURN 'This mobile number already belongs to ' || v || ' in HR/Staff. Open that employee instead of adding a new one.'; END IF;
    SELECT name INTO v FROM doctors
     WHERE hospital_id = h AND COALESCE(is_active,1) = 1 AND code NOT LIKE '%~%'
       AND public.staff_phone_key(phone) = k AND id IS DISTINCT FROM skip_login LIMIT 1;
    IF v IS NOT NULL THEN RETURN 'This mobile number already belongs to doctor ' || v || '.'; END IF;
  END IF;
  IF e IS NOT NULL THEN
    SELECT name INTO v FROM hospital_staff
     WHERE hospital_id = h AND removed_at IS NULL AND lower(btrim(COALESCE(email,''))) = e
       AND id IS DISTINCT FROM skip_staff AND id IS DISTINCT FROM link LIMIT 1;
    IF v IS NOT NULL THEN RETURN 'This email already belongs to ' || v || ' in HR/Staff.'; END IF;
  END IF;
  IF i IS NOT NULL THEN
    SELECT name INTO v FROM hospital_staff
     WHERE hospital_id = h AND removed_at IS NULL AND lower(btrim(COALESCE(employee_id,''))) = i
       AND id IS DISTINCT FROM skip_staff AND id IS DISTINCT FROM link LIMIT 1;
    IF v IS NOT NULL THEN RETURN 'Employee ID ' || btrim(eid) || ' is already used by ' || v || '.'; END IF;
  END IF;
  RETURN NULL;
END $$`;

// BEFORE INSERT on nurses / front_office_staff / pharmacy_staff / hospital_lab_staff.
// (Doctors are checked in the doctors route, because the replace-doctor flow briefly writes a password into doctors.phone.)
const FN_LOGIN_GUARD = String.raw`
CREATE OR REPLACE FUNCTION public.staff_login_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE msg text;
BEGIN
  BEGIN
    msg := public.staff_dup_message(NEW.hospital_id, NEW.phone, NULL, NULL, NULL, NEW.id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'staff_login_guard: %', SQLERRM; msg := NULL;
  END;
  IF msg IS NOT NULL THEN RAISE EXCEPTION '%', msg; END IF;
  RETURN NEW;
END $$`;

// BEFORE INSERT / UPDATE on hospital_staff: only direct edits (trigger depth 1), only when mobile / email / employee id change.
const FN_HR_GUARD = String.raw`
CREATE OR REPLACE FUNCTION public.staff_hr_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE msg text;
BEGIN
  IF pg_trigger_depth() > 1 OR NEW.removed_at IS NOT NULL THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.phone IS NOT DISTINCT FROM OLD.phone AND NEW.email IS NOT DISTINCT FROM OLD.email
       AND NEW.employee_id IS NOT DISTINCT FROM OLD.employee_id THEN RETURN NEW; END IF;
  END IF;
  BEGIN
    msg := public.staff_dup_message(NEW.hospital_id, NEW.phone, NEW.email, NEW.employee_id, NEW.id, NEW.login_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'staff_hr_guard: %', SQLERRM; msg := NULL;
  END;
  IF msg IS NOT NULL THEN RAISE EXCEPTION '%', msg; END IF;
  RETURN NEW;
END $$`;

const FN_PHARMACY_FIRST = String.raw`
CREATE OR REPLACE FUNCTION public.staff_pharmacy_first_login() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.first_login := 1;
  RETURN NEW;
END $$`;

const FN_DEFAULTS = String.raw`
CREATE OR REPLACE FUNCTION public.staff_login_defaults() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t text; dep text;
BEGIN
  IF TG_TABLE_NAME = 'nurses' THEN t := 'nurse'; dep := 'Nursing';
  ELSIF TG_TABLE_NAME = 'front_office_staff' THEN t := 'front_office'; dep := 'Front Office';
  ELSIF TG_TABLE_NAME = 'pharmacy_staff' THEN t := 'pharmacy'; dep := 'Pharmacy';
  ELSE t := 'lab'; dep := 'Laboratory';
  END IF;
  UPDATE hospital_staff SET department = COALESCE(NULLIF(btrim(department), ''), dep)
   WHERE login_type = t AND login_id = NEW.id;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RAISE WARNING 'staff_login_defaults: %', SQLERRM; RETURN NEW;
END $$`;

function trig(table, name, timing, fn) {
  return `DO $do$ BEGIN IF to_regclass('public.${table}') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS ${name} ON public.${table};
    CREATE TRIGGER ${name} ${timing} ON public.${table} FOR EACH ROW EXECUTE FUNCTION public.${fn}();
  END IF; END $do$`;
}

const LOGIN_TABLES = ["nurses", "front_office_staff", "pharmacy_staff", "hospital_lab_staff"];

const STEPS = [
  // 1. columns + documents
  ...["gender", "designation", "qualification", "experience", "employment_type", "reporting_manager_id", "photo_path"]
    .map(c => `ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS ${c} TEXT`),
  "ALTER TABLE hospital_staff ADD COLUMN IF NOT EXISTS photo_updated_at TIMESTAMPTZ",
  `CREATE TABLE IF NOT EXISTS staff_documents (
     id TEXT PRIMARY KEY,
     staff_id TEXT NOT NULL REFERENCES hospital_staff(id) ON DELETE CASCADE,
     hospital_id TEXT NOT NULL,
     doc_type TEXT NOT NULL DEFAULT 'other',
     file_name TEXT, mime_type TEXT, size_bytes INTEGER,
     storage_path TEXT NOT NULL,
     verification_status TEXT NOT NULL DEFAULT 'pending',
     verified_by TEXT, verified_at TIMESTAMPTZ, note TEXT, uploaded_by TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
  "CREATE INDEX IF NOT EXISTS idx_staff_docs_staff ON staff_documents(staff_id)",
  // 2. functions
  FN_PHONE_KEY, FN_DUP, FN_LOGIN_GUARD, FN_HR_GUARD, FN_PHARMACY_FIRST, FN_DEFAULTS,
  // 3. triggers (names sort after the existing hr_* triggers where order matters)
  ...LOGIN_TABLES.map(t => trig(t, "staff_login_guard_t", "BEFORE INSERT", "staff_login_guard")),
  trig("hospital_staff", "staff_hr_guard_t", "BEFORE INSERT OR UPDATE", "staff_hr_guard"),
  trig("pharmacy_staff", "staff_pharmacy_first_t", "BEFORE INSERT", "staff_pharmacy_first_login"),
  ...LOGIN_TABLES.map(t => trig(t, "hr_ai_defaults", "AFTER INSERT", "staff_login_defaults")),
];

const ready = (async () => {
  for (const sql of STEPS) {
    try { await pool.query(sql); }
    catch (e) { console.warn("[staff-central] step failed:", e.message, "::", sql.replace(/\s+/g, " ").slice(0, 90)); }
  }
  console.log("[staff-central] ready");
})();

module.exports = { ready };
