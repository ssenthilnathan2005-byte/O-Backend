"use strict";
// One place that knows how an HR employee record and a login account are tied together.
// The database triggers (hr_ai / hr_au / hr_ad / hr_staff_*) already keep name, phone and active status in step;
// this service adds: duplicate checks, "create the login later" for an existing HR row, and defaults.

const bcrypt = require("bcrypt");
const crypto = require("crypto");
const { pool } = require("../db/init");
const { issueCode } = require("./loginCodes");
const { syncPassword } = require("./passwordSync");

// HR role text (any spelling) -> login table family
const ROLE_TO_LOGIN = {
  doctor: "doctor",
  nurse: "nurse",
  front_office: "front_office", receptionist: "front_office", front_desk: "front_office", frontoffice: "front_office", fo: "front_office",
  pharmacy: "pharmacy", pharmacist: "pharmacy",
  lab: "lab", lab_technician: "lab", lab_staff: "lab", lab_technologist: "lab",
};
// login family -> role text written to hospital_staff (same values the existing triggers use)
const HR_ROLE = { doctor: "doctor", nurse: "nurse", front_office: "receptionist", pharmacy: "pharmacist", lab: "lab_technician" };
const DEFAULT_DEPT = { doctor: null, nurse: "Nursing", front_office: "Front Office", pharmacy: "Pharmacy", lab: "Laboratory" };
const NEEDS_PHONE = { nurse: "Nurse", front_office: "Front Office", pharmacy: "Pharmacist" };

const loginTypeOfRole = role => ROLE_TO_LOGIN[String(role || "").trim().toLowerCase().replace(/[\s-]+/g, "_")] || null;

// Message when this mobile / email / employee id belongs to someone else in the hospital, otherwise null.
// Fails open: if the database function is not installed yet, nothing is blocked.
async function duplicateMessage(hospitalId, d, skip) {
  try {
    d = d || {}; skip = skip || {};
    const { rows } = await pool.query(
      "SELECT public.staff_dup_message($1,$2,$3,$4,$5,$6) AS m",
      [hospitalId, d.phone || null, d.email || null, d.employeeId || null, skip.staffId || null, skip.loginId || null]);
    return (rows[0] && rows[0].m) || null;
  } catch (e) { console.warn("[employees] duplicateMessage:", e.message); return null; }
}

const TEMP_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
const tempPassword = () => Array.from({ length: 10 }, () => TEMP_CHARS[crypto.randomInt(TEMP_CHARS.length)]).join("");
const rid = (p) => p + crypto.randomBytes(8).toString("hex");

// Gives an EXISTING hr employee (row passed in, already locked/loaded) a login account, inside the caller's transaction (client).
// Returns { loginType, loginId, code, tempPassword|null }. Throws Error with .status for user-facing problems.
async function createLoginForStaff(client, staff, opts) {
  opts = opts || {};
  const loginType = loginTypeOfRole(opts.role || staff.role);
  if (!loginType) { const e = new Error("Choose a role (Doctor, Nurse, Front Office, Pharmacist or Lab Technician) to create a login."); e.status = 400; throw e; }
  if (staff.login_id) { const e = new Error("This employee already has a login."); e.status = 409; throw e; }
  const hid = staff.hospital_id;
  const name = String(staff.name || "").trim() || "Employee";
  const phone = String(staff.phone || "").trim();
  if (NEEDS_PHONE[loginType] && !phone) {
    const e = new Error("Add a mobile number to this employee first - it is needed for a " + NEEDS_PHONE[loginType] + " login."); e.status = 400; throw e;
  }
  let plain = String(opts.password || "").trim();
  if (plain && plain.length < 6) { const e = new Error("Password must be at least 6 characters."); e.status = 400; throw e; }
  let generated = null;
  if (!plain) { plain = tempPassword(); generated = plain; }
  const hash = await bcrypt.hash(plain, 10);

  // Lets the duplicate guard know this HR-only row is the same person (so its own mobile number is not a clash).
  await client.query("SELECT set_config('app.link_staff', $1, true)", [staff.id]);

  let loginId, code;
  for (let attempt = 0; attempt < 6; attempt++) {
    code = await issueCode(hid, loginType);
    await client.query("SAVEPOINT login_try");
    try {
      if (loginType === "nurse") {
        loginId = rid("nu_");
        await client.query("INSERT INTO nurses (id, hospital_id, nurse_code, name, phone, password, first_login) VALUES ($1,$2,$3,$4,$5,$6,1)", [loginId, hid, code, name, phone, hash]);
      } else if (loginType === "front_office") {
        loginId = rid("fos_");
        await client.query("INSERT INTO front_office_staff (id, hospital_id, code, name, phone, password, first_login) VALUES ($1,$2,$3,$4,$5,$6,1)", [loginId, hid, code, name, phone, hash]);
      } else if (loginType === "pharmacy") {
        loginId = rid("ps_");
        await client.query("INSERT INTO pharmacy_staff (id, hospital_id, code, name, phone, password, first_login) VALUES ($1,$2,$3,$4,$5,$6,1)", [loginId, hid, code, name, phone, hash]);
      } else if (loginType === "lab") {
        loginId = rid("hls_");
        await client.query("INSERT INTO hospital_lab_staff (id, hospital_id, code, name, phone, password) VALUES ($1,$2,$3,$4,$5,$6)", [loginId, hid, code, name, phone || null, hash]);
      } else {
        // doctor: same safe defaults as Hospital Admin > Doctors > Add Doctor; fee, sessions and timings are set later on the Doctors page
        loginId = "d_" + Date.now() + Math.floor(Math.random() * 90 + 10);
        const spec = String(staff.department || staff.designation || "").trim() || "General Practitioner (GP)";
        await client.query(
          `INSERT INTO doctors (id, hospital_id, code, name, specialty, phone, bio, price, consultation_fee, tokens_per_session, sessions, is_available, years_of_experience, education)
           VALUES ($1,$2,$3,$4,$5,$6,'',10,10,20,'morning,afternoon',1,$7,$8)`,
          [loginId, hid, code, name, spec, phone, String(staff.experience || ""), String(staff.qualification || "")]);
        await client.query("UPDATE doctors SET password=$1 WHERE id=$2", [plain, loginId]);
      }
      await client.query("RELEASE SAVEPOINT login_try");
      break;
    } catch (e) {
      if (e.code === "23505" && attempt < 5) { await client.query("ROLLBACK TO SAVEPOINT login_try"); loginId = null; continue; }
      throw e;
    }
  }
  if (!loginId) { const e = new Error("Could not generate a unique login code, please try again."); e.status = 500; throw e; }

  // The existing hr_ai trigger just created a second HR row for this new login. Keep the ORIGINAL employee row
  // (it carries the documents, salary history and attendance) and remove the trigger's copy.
  const dupes = (await client.query("SELECT id FROM hospital_staff WHERE login_type=$1 AND login_id=$2 AND id<>$3", [loginType, loginId, staff.id])).rows;
  for (const d of dupes) {
    await client.query("UPDATE hospital_staff SET login_type=NULL, login_id=NULL WHERE id=$1", [d.id]);
    await client.query("DELETE FROM hospital_staff WHERE id=$1", [d.id]);
  }
  await client.query(
    `UPDATE hospital_staff SET login_type=$1, login_id=$2, role=$3, is_active=1,
            department = COALESCE(NULLIF(btrim(department),''), $4)
      WHERE id=$5`,
    [loginType, loginId, HR_ROLE[loginType], DEFAULT_DEPT[loginType], staff.id]);

  return { loginType, loginId, code, tempPassword: generated, plain, hospitalId: hid };
}

// After COMMIT: put the password into the Password Management vault (it never throws).
async function afterLoginCommitted(info, actorId) {
  await syncPassword({ type: info.loginType, id: info.loginId, hospitalId: info.hospitalId, plain: info.plain, action: "create", actorId: actorId || null });
  if (info.loginType === "doctor") { try { require("../routes/doctors").invalidateDoctorCache(); } catch (_) {} }
}

module.exports = { duplicateMessage, createLoginForStaff, afterLoginCommitted, loginTypeOfRole, HR_ROLE, ROLE_TO_LOGIN };
