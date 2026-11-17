"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAdmin, requireAuth } = require("../middleware/auth");

const router = express.Router();

router.get("/", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT id, name, email, created_at FROM users WHERE role='patient' ORDER BY created_at DESC LIMIT 500"
    );
    res.json(rows.map(r => ({ id: r.id, name: r.name, email: r.email || "", createdAt: r.created_at })));
  } catch (err) {
    console.error("[patients GET /]", err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── PATCH /api/patients/profile — save name, phone, age ──────────────────────
const { sendPushToPatient } = require("../services/push");
let phoneReqReady = null;
function ensurePhoneReq() {
  if (!phoneReqReady) phoneReqReady = pool.query("CREATE TABLE IF NOT EXISTS phone_share_requests (id TEXT PRIMARY KEY, requester_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, phone TEXT NOT NULL, relation TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at TIMESTAMPTZ NOT NULL DEFAULT now(), decided_at TIMESTAMPTZ)");
  return phoneReqReady;
}
router.get("/phone-requests", requireAuth, async (req, res) => {
  try {
    await ensurePhoneReq();
    const { rows } = await pool.query("SELECT r.id, r.relation, r.created_at, u.name AS requester_name FROM phone_share_requests r JOIN users u ON u.id=r.requester_id WHERE r.owner_id=$1 AND r.status='pending' ORDER BY r.created_at DESC", [req.user.id]);
    return res.json({ requests: rows });
  } catch (err) {
    console.error("[phone-requests] list error:", err.message);
    return res.status(500).json({ error: "Failed to load requests" });
  }
});
router.post("/phone-requests/:id/decide", requireAuth, async (req, res) => {
  try {
    await ensurePhoneReq();
    const approve = !!(req.body && req.body.approve === true);
    const { rows } = await pool.query("UPDATE phone_share_requests SET status=$1, decided_at=now() WHERE id=$2 AND owner_id=$3 AND status='pending' RETURNING requester_id", [approve ? "approved" : "rejected", req.params.id, req.user.id]);
    if (!rows.length) return res.status(404).json({ error: "Request not found" });
    sendPushToPatient(rows[0].requester_id, { title: approve ? "Phone number approved" : "Phone number request rejected", body: approve ? "You can now save your profile with this phone number." : "The owner did not approve this phone number.", data: { tag: "phone-request" } }).catch(() => {});
    return res.json({ success: true });
  } catch (err) {
    console.error("[phone-requests] decide error:", err.message);
    return res.status(500).json({ error: "Failed to save your answer" });
  }
});
router.patch("/profile", requireAuth, async (req, res) => {
  if (req.user.role !== "patient")
    return res.status(403).json({ error: "Patients only" });

  const { name, phone, yearOfBirth, age, area, bloodGroup, gender } = req.body;
  const thisYear = new Date().getFullYear();
  let yob = null;
  let calcAge = null;
  if (yearOfBirth !== undefined && yearOfBirth !== null && yearOfBirth !== "") {
    yob = Number(yearOfBirth);
    if (!Number.isInteger(yob) || yob < thisYear - 120 || yob > thisYear)
      return res.status(400).json({ error: "Enter a valid 4-digit year of birth" });
    calcAge = thisYear - yob;
  } else {
    calcAge = age ?? null;
  }
  const areaVal = typeof area === "string" && area.trim() ? area.trim().slice(0, 60) : null;
  const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "Unknown"];
  if (bloodGroup && !BLOOD_GROUPS.includes(bloodGroup))
    return res.status(400).json({ error: "Invalid blood group" });
  const bgVal = bloodGroup || null;
  const GENDERS = ["Male", "Female", "Other"];
  if (gender && !GENDERS.includes(gender))
    return res.status(400).json({ error: "Invalid gender" });
  const genderVal = gender || null;
  if (!phone || !name)
    return res.status(400).json({ error: "name and phone are required" });

  const normalised = phone.replace(/\D/g, "").slice(-10);
  if (normalised.length !== 10)
    return res.status(400).json({ error: "Enter a valid 10-digit phone number" });

  try {
    const curRow = await pool.query("SELECT phone FROM users WHERE id=$1", [req.user.id]);
    const unchanged = !!curRow.rows[0] && String(curRow.rows[0].phone || "").replace(/\D/g, "").slice(-10) === normalised;
    const { rows: others } = await pool.query(
      "SELECT id, name, uhid FROM users WHERE phone=$1 AND role='patient' AND id<>$2",
      [normalised, req.user.id]
    );
    const rel = typeof req.body.phoneRelation === "string" ? req.body.phoneRelation.trim() : "";
    const RELATIONS = ["Spouse", "Child", "Parent", "Sibling", "Other family"];
    const shared = !unchanged && others.length > 0;
    if (shared && !RELATIONS.includes(rel))
      return res.status(409).json({ code: "PHONE_SHARED", error: "This phone number is already used by another account. Select how you are related. The owner will be asked to approve.", relations: RELATIONS });
    if (shared) {
      await ensurePhoneReq();
      const ok = await pool.query("SELECT 1 FROM phone_share_requests WHERE requester_id=$1 AND phone=$2 AND status='approved' LIMIT 1", [req.user.id, normalised]);
      if (!ok.rows.length) {
        const pend = await pool.query("SELECT 1 FROM phone_share_requests WHERE requester_id=$1 AND phone=$2 AND status='pending' LIMIT 1", [req.user.id, normalised]);
        if (!pend.rows.length) {
          for (const o of others) {
            await pool.query("INSERT INTO phone_share_requests (id, requester_id, owner_id, phone, relation) VALUES ($1,$2,$3,$4,$5)", ["psr_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8), req.user.id, o.id, normalised, rel]);
            sendPushToPatient(o.id, { title: "Phone number request", body: name.trim() + " wants to use your phone number on their account. Open the app to approve or reject.", data: { tag: "phone-request" } }).catch(() => {});
          }
        }
        return res.status(409).json({ code: "PHONE_APPROVAL_PENDING", error: "Request sent to the owner of this number. You can save after they approve it in their app." });
      }
    }
    if (!unchanged) await pool.query("UPDATE users SET phone_relation=$1 WHERE id=$2", [shared ? rel : null, req.user.id]);
    await pool.query(
      "UPDATE users SET name=$1, phone=$2, age=$3, year_of_birth=COALESCE($4, year_of_birth), area=COALESCE($6, area), blood_group=COALESCE($7, blood_group), gender=COALESCE($8, gender) WHERE id=$5",
      [name.trim(), normalised, calcAge, yob, req.user.id, areaVal, bgVal, genderVal]
    );
    // Also patch bookings so future queries pick up the right name
    await pool.query(
      "UPDATE bookings SET patient_name=$1, phone=$2 WHERE patient_id=$3",
      [name.trim(), normalised, req.user.id]
    );
    return res.json({ success: true });
  } catch (err) {
    console.error("[profile] patch error:", err.message);
    if (err.code === "23505")
      return res.status(409).json({ error: "This phone number is already used by another account. Use a different number." });
    return res.status(500).json({ error: "Failed to update profile" });
  }
});


// ── GET /api/patients/profile — fetch saved profile for autofill ─────────────
router.get("/profile", requireAuth, async (req, res) => {
  if (req.user.role !== "patient")
    return res.status(403).json({ error: "Patients only" });
  try {
    const { rows } = await pool.query(
      "SELECT name, phone, age, year_of_birth, preferred_language, uhid, password_set, area, blood_group, gender FROM users WHERE id=$1",
      [req.user.id]
    );
    const u = rows[0] || {};
    const thisYear = new Date().getFullYear();
    const liveAge = u.year_of_birth ? thisYear - Number(u.year_of_birth) : (u.age != null ? Number(u.age) : null);
    const isComplete = !!(u.name && u.phone && (u.year_of_birth || u.age));
    return res.json({
      name: u.name || "",
      phone: u.phone || "",
      age: liveAge != null ? String(liveAge) : "",
      yearOfBirth: u.year_of_birth ? String(u.year_of_birth) : "",
      uhid: u.uhid || "",
      area: u.area || "",
      bloodGroup: u.blood_group || "",
      gender: u.gender || "",
      hasPassword: Number(u.password_set ?? 1) !== 0,
      preferredLanguage: u.preferred_language === "ta" ? "ta" : "en",
      isComplete,
    });
  } catch (err) {
    console.error("[profile] get error:", err.message);
    return res.status(500).json({ error: "Failed to load profile" });
  }
});

// PATCH /api/patients/language - save the patient's preferred site language
router.patch("/language", requireAuth, async (req, res) => {
  if (req.user.role !== "patient")
    return res.status(403).json({ error: "Patients only" });
  const lang = req.body && req.body.preferredLanguage;
  if (lang !== "en" && lang !== "ta")
    return res.status(400).json({ error: "preferredLanguage must be 'en' or 'ta'" });
  try {
    await pool.query("UPDATE users SET preferred_language=$1 WHERE id=$2", [lang, req.user.id]);
    return res.json({ success: true, preferredLanguage: lang });
  } catch (err) {
    console.error("[language] patch error:", err.message);
    return res.status(500).json({ error: "Failed to save language" });
  }
});

module.exports = router;

// ── DELETE patient permanently ────────────────────────────────────────────────
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    // Delete patient's bookings first
    await pool.query("DELETE FROM bookings WHERE patient_id = $1", [id]);
    // Delete the patient account
    const result = await pool.query("DELETE FROM users WHERE id = $1 AND role = 'patient'", [id]);
    if (result.rowCount === 0)
      return res.status(404).json({ error: "Patient not found" });
    console.log(`[patients] Deleted patient ${id} and their bookings`);
    res.json({ success: true, deleted: id });
  } catch (err) {
    console.error("[patients DELETE]", err.message);
    res.status(500).json({ error: err.message });
  }
});
