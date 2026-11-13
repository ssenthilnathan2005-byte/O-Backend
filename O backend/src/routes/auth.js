"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const { OAuth2Client } = require("google-auth-library");
const { requireAuth } = require("../middleware/auth");
const { pool } = require("../db/init");
const { sendOTP, generateOTP, normalisePhone, IS_DEV } = require("../services/sms");
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (!resend) {
  console.warn("[auth] RESEND_API_KEY not set — password reset emails are disabled (server will still start).");
}

const router = express.Router();

// UHID format: DB01, DB02 ... (DB100 and up after DB99)
const UHID_RE = /^DB\d{2,}$/i;

const SECRET = require("../utils/secrets").JWT_SECRET;
const EXPIRES = process.env.JWT_EXPIRES_IN || "7d";
const ADMIN_CODE = process.env.ADMIN_CODE || "ADMIN-001";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function sign(payload) {
  const tok = jwt.sign(payload, SECRET, { expiresIn: EXPIRES });
  try { require("../db/init").pool.query(
    `INSERT INTO data_access_audit (id,actor_id,actor_role,hospital_id,action,ip) VALUES (gen_random_uuid(),$1,$2,$3,'auth.login',$4)`,
    [payload.id||null, payload.role||null, payload.hospitalId||null, null]
  ).catch(()=>{}); } catch(_){}
  return tok;
}

function validate(req, res) {
  const e = validationResult(req);
  if (!e.isEmpty()) {
    res.status(400).json({ error: e.array()[0].msg });
    return false;
  }
  return true;
}

async function cleanOTPs() {
  await pool.query("DELETE FROM otp_pending WHERE expires_at < $1", [Date.now()]);
}

function isLikelyEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(value || "").trim());
}

function isGmailAddress(value) {
  return isLikelyEmail(value) && String(value || "").trim().toLowerCase().endsWith("@gmail.com");
}

async function sendResetPasswordEmail(toEmail, name, resetLink) {
  const safeName = name || "there";

  try {
    if (!resend) {
      console.warn(`[auth forgot-password] Email service not configured — skipping reset email to ${toEmail}. Set RESEND_API_KEY in .env to enable this.`);
      throw new Error("Password reset email is not configured on this server yet.");
    }
    await resend.emails.send({
      from: "Doctor Booked <noreply@doctorbooked.in>",
      to: toEmail,
      subject: "Reset your Doctor Booked password",
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; border: 1px solid #e5e7eb; border-radius: 12px;">
          <div style="text-align: center; margin-bottom: 24px;">
            <h2 style="color: #14b8a6; margin: 0;">Doctor Booked</h2>
          </div>
          <p style="color: #111827;">Hi ${safeName},</p>
          <p style="color: #374151;">We received a request to reset your password. Click the button below to set a new password:</p>
          <div style="text-align: center; margin: 32px 0;">
            <a href="${resetLink}"
              style="background-color: #14b8a6; color: white; padding: 12px 28px; border-radius: 999px; text-decoration: none; font-weight: 600; display: inline-block;">
              Reset Password
            </a>
          </div>
          <p style="color: #6b7280; font-size: 13px;">This link expires in <strong>30 minutes</strong>. If you didn't request a password reset, you can safely ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 24px 0;" />
          <p style="color: #9ca3af; font-size: 12px; text-align: center;">Doctor Booked &mdash; Skip the waiting room.</p>
        </div>
      `,
    });
    console.log(`[auth forgot-password] Reset email sent to ${toEmail}`);
  } catch (err) {
    console.error(`[auth forgot-password] Resend error:`, err.message);
    throw new Error("Failed to send reset email. Please try again.");
  }
}

// ── Patient Signup — email/password OR phone/password ────────────────────────
router.post(
  "/patient/signup",
  [
    body("name").trim().notEmpty().withMessage("Name is required"),
    body("password")
      .isLength({ min: 6 })
      .withMessage("Password must be at least 6 chars"),
  ],
  async (req, res) => {
    if (!validate(req, res)) return;
    const t0 = Date.now();

    try {
      const name     = String(req.body.name || "").trim();
      const password = String(req.body.password || "");
      const rawEmail = String(req.body.email || "").trim().toLowerCase();
      const rawPhone = String(req.body.phone || "").trim();

      if (!rawEmail && !rawPhone) {
        return res.status(400).json({ error: "Please provide an email address or a 10-digit phone number." });
      }

      const tHashStart = Date.now();
      const hash = await bcrypt.hash(password, 10);
      const tHashEnd = Date.now();
      console.log(`[TIMING signup] validate+parse: ${tHashStart - t0}ms | bcrypt.hash: ${tHashEnd - tHashStart}ms`);

      // ── Phone-only signup ────────────────────────────────────────────────
      if (!rawEmail && rawPhone) {
        const normPhone = normalisePhone(rawPhone);
        if (!/^91\d{10}$/.test(normPhone)) {
          return res.status(400).json({ error: "Please enter a valid 10-digit Indian mobile number." });
        }
        const tDbStart = Date.now();
        const { rows: existsRows } = await pool.query(
          "SELECT id FROM users WHERE phone=$1 AND role='patient'",
          [normPhone]
        );
        if (existsRows[0]) {
          return res.status(409).json({ error: "Phone number already registered. Please log in." });
        }
        const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await pool.query(
          `INSERT INTO users (id, name, password, role, phone, phone_verified)
           VALUES ($1, $2, $3, 'patient', $4, 1)`,
          [id, name, hash, normPhone]
        );
        const { rows: userRows } = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
        const user = userRows[0];
        console.log(`[TIMING signup] db work: ${Date.now() - tDbStart}ms | TOTAL: ${Date.now() - t0}ms`);
        return res.json({
          token: sign({ id: user.id, name: user.name, phone: normPhone, role: "patient", uhid: user.uhid }),
          user:  { id: user.id, name: user.name, phone: normPhone, role: "patient", uhid: user.uhid },
          message: "Account created successfully.",
        });
      }

      // ── Email signup ─────────────────────────────────────────────────────
      if (!isGmailAddress(rawEmail)) {
        return res.status(400).json({ error: "Please use a Gmail address." });
      }
      const tDbStart = Date.now();
      const { rows: existsRows } = await pool.query(
        "SELECT id FROM users WHERE email=$1 AND role='patient'",
        [rawEmail]
      );
      if (existsRows[0]) {
        return res.status(409).json({ error: "Email already registered. Please log in." });
      }
      const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await pool.query(
        `INSERT INTO users (id, email, name, password, role, phone_verified)
         VALUES ($1, $2, $3, $4, 'patient', 0)`,
        [id, rawEmail, name, hash]
      );
      const { rows: userRows } = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
      const user = userRows[0];
      console.log(`[TIMING signup] db work: ${Date.now() - tDbStart}ms | TOTAL: ${Date.now() - t0}ms`);
      return res.json({
        token: sign({ id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid }),
        user:  { id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid },
        message: "Account created successfully.",
      });

    } catch (err) {
      console.error("[auth signup]", err.message);
      if (err.code === "23505") {
        return res.status(409).json({ error: "This phone number or email is already registered. Please log in." });
      }
      return res.status(500).json({ error: err.message || "Signup failed." });
    }
  }
);

// ── Patient Login — email/password ───────────────────────────────────────────
router.post(
  "/patient/login",
  [
    body("password").optional(),
    body("email").optional().trim(),
    body("identifier").optional().trim(),
    body().custom((v) => {
      const id = String(v.email || v.identifier || "").trim();
      if (!id) throw new Error("Email or phone number is required");
      return true;
    }),
  ],
  async (req, res) => {
    if (!validate(req, res)) return;
    const t0 = Date.now();

    try {
      const identifier = String(req.body.email || req.body.identifier || "").trim();
      const password = String(req.body.password || "");

      let user = null;

      if (UHID_RE.test(identifier)) {
        const { rows } = await pool.query(
          "SELECT * FROM users WHERE uhid=$1 AND role='patient'",
          [identifier.toUpperCase()]
        );
        user = rows[0] || null;
      } else if (isLikelyEmail(identifier)) {
        const { rows } = await pool.query(
          "SELECT * FROM users WHERE email=$1 AND role='patient'",
          [identifier.toLowerCase()]
        );
        user = rows[0] || null;
      } else {
        try {
          const normPhone = normalisePhone(identifier);
          const { rows } = await pool.query(
            "SELECT * FROM users WHERE phone=$1 AND role='patient' LIMIT 2",
            [normPhone]
          );
          if (rows.length > 1) {
            return res.status(409).json({ error: "More than one account uses this phone number. Log in with your UHID or email instead." });
          }
          user = rows[0] || null;
        } catch {
          user = null;
        }
      }
      const tDbEnd = Date.now();

      if (!user) {
        return res.status(401).json({ error: "No account found with this email or phone number." });
      }
      if (!user.password) {
        return res.json({ needsPassword: true, uhid: user.uhid });
      }
      const tCompareStart = Date.now();
      const ok = await bcrypt.compare(password, user.password);
      const tCompareEnd = Date.now();
      console.log(`[TIMING login] db lookup: ${tDbEnd - t0}ms | bcrypt.compare: ${tCompareEnd - tCompareStart}ms | TOTAL: ${tCompareEnd - t0}ms`);
      if (!ok) {
        return res.status(401).json({ error: "Incorrect password." });
      }

      return res.json({
        token: sign({ id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid }),
        user: { id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid },
      });
    } catch (err) {
      console.error("[auth login]", err.message);
      return res.status(500).json({ error: err.message || "Login failed." });
    }
  }
);

// ── Verify OTP ────────────────────────────────────────────────────────────────
router.post("/patient/verify-otp", async (req, res) => {
  try {
    await cleanOTPs();

    const { otpId, otp } = req.body;
    if (!otpId || !otp) {
      return res.status(400).json({ error: "otpId and otp are required." });
    }

    const { rows: pendingRows } = await pool.query("SELECT * FROM otp_pending WHERE id=$1", [otpId]);
    const pending = pendingRows[0];
    if (!pending) {
      return res
        .status(400)
        .json({ error: "OTP session not found or expired. Please request a new OTP." });
    }

    if (Date.now() > Number(pending.expires_at)) {
      await pool.query("DELETE FROM otp_pending WHERE id=$1", [otpId]);
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    if (pending.attempts >= 5) {
      await pool.query("DELETE FROM otp_pending WHERE id=$1", [otpId]);
      return res
        .status(429)
        .json({ error: "Too many wrong attempts. Please request a new OTP." });
    }

    if (pending.otp !== String(otp).trim()) {
      await pool.query("UPDATE otp_pending SET attempts=attempts+1 WHERE id=$1", [otpId]);
      const left = 5 - (pending.attempts + 1);
      return res
        .status(400)
        .json({ error: `Incorrect OTP. ${left} attempt${left !== 1 ? "s" : ""} remaining.` });
    }

    const data = JSON.parse(pending.data || "{}");
    await pool.query("DELETE FROM otp_pending WHERE id=$1", [otpId]);

    if (pending.context === "signup") {
      const { name, hash } = data;
      const id = `p_${pending.phone}`;
      await pool.query(
        `INSERT INTO users (id, email, name, password, role, phone, phone_verified)
         VALUES ($1, NULL, $2, $3, 'patient', $4, 1)`,
        [id, name, hash, pending.phone]
      );

      const { rows: userRows } = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
      const user = userRows[0];
      return res.json({
        token: sign({ id: user.id, name: user.name, phone: pending.phone, role: "patient", uhid: user.uhid }),
        user: { id: user.id, name: user.name, phone: pending.phone, role: "patient", uhid: user.uhid },
      });
    }

    if (pending.context === "login") {
      const { rows: userRows } = await pool.query("SELECT * FROM users WHERE id=$1", [data.userId]);
      const user = userRows[0];
      if (!user) return res.status(404).json({ error: "Account not found." });

      return res.json({
        token: sign({ id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid }),
        user: { id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid },
      });
    }

    if (pending.context === "google") {
      const { rows: userRows } = await pool.query("SELECT * FROM users WHERE id=$1", [data.userId]);
      const user = userRows[0];
      if (!user) return res.status(404).json({ error: "Account not found." });

      await pool.query(
        "UPDATE users SET phone=$1, phone_verified=1 WHERE id=$2",
        [pending.phone, user.id]
      );

      return res.json({
        token: sign({ id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid }),
        user: { id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid },
      });
    }

    return res.status(400).json({ error: "Unknown OTP context." });
  } catch (err) {
    console.error("[auth verify-otp]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Resend OTP ────────────────────────────────────────────────────────────────
router.post("/patient/resend-otp", async (req, res) => {
  try {
    const { otpId } = req.body;
    const { rows: pendingRows } = await pool.query("SELECT * FROM otp_pending WHERE id=$1", [otpId]);
    const pending = pendingRows[0];
    if (!pending) {
      return res.status(400).json({ error: "OTP session not found. Please start over." });
    }

    const otp = generateOTP();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    await pool.query(
      "UPDATE otp_pending SET otp=$1, expires_at=$2, attempts=0 WHERE id=$3",
      [otp, expiresAt, otpId]
    );

    await sendOTP(pending.phone, otp);

    const resp = { success: true, message: "New OTP sent." };
    if (IS_DEV) resp.devOtp = otp;
    return res.json(resp);
  } catch (err) {
    console.error("[auth resend-otp]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Google One Tap login ─────────────────────────────────────────────────────
router.post("/patient/google", async (req, res) => {
  try {
    if (!googleClient || !GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: "Google login is not configured." });
    }

    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ error: "Google credential is required." });
    }

    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (!payload?.email) {
      return res.status(401).json({ error: "Invalid Google credential." });
    }

    const email = String(payload.email).toLowerCase();
    const name = payload.name || email.split("@")[0];
    const googleId = String(payload.sub || "");

    let { rows: userRows } = await pool.query(
      "SELECT * FROM users WHERE email=$1 AND role='patient'",
      [email]
    );
    let user = userRows[0];

    if (!user) {
      const id = `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const hash = await bcrypt.hash(`google_${googleId}_${Date.now()}`, 10);
      await pool.query(
        `INSERT INTO users (id, email, name, password, role, phone_verified)
         VALUES ($1, $2, $3, $4, 'patient', 0)`,
        [id, email, name, hash]
      );

      await pool.query("UPDATE users SET password_set=0 WHERE id=$1", [id]);
      const { rows: newUserRows } = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
      user = newUserRows[0];
    }

    return res.json({
      token: sign({ id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid }),
      user: { id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid },
    });
  } catch (err) {
    console.error("[auth google]", err.message);
    if (
      err.message?.includes("Token used too late") ||
      err.message?.includes("Invalid token")
    ) {
      return res.status(401).json({ error: "Google sign-in expired. Please try again." });
    }
    return res.status(500).json({ error: "Google login failed. Please try again." });
  }
});

// ── Google phone OTP ─────────────────────────────────────────────────────────
router.post("/patient/google-phone-otp", async (req, res) => {
  try {
    const { userId, phone } = req.body;
    if (!userId || !phone) {
      return res.status(400).json({ error: "userId and phone are required." });
    }

    const normPhone = normalisePhone(phone);
    const { rows: takenRows } = await pool.query(
      "SELECT id FROM users WHERE phone=$1 AND id!=$2",
      [normPhone, userId]
    );

    if (takenRows[0]) {
      return res
        .status(409)
        .json({ error: "This phone is already registered to another account." });
    }

    const otp = generateOTP();
    const otpId = `otp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const expiresAt = Date.now() + 10 * 60 * 1000;

    await pool.query("DELETE FROM otp_pending WHERE phone=$1 AND context='google'", [normPhone]);
    await pool.query(
      `INSERT INTO otp_pending (id, phone, otp, context, data, expires_at)
       VALUES ($1,$2,$3,'google',$4,$5)`,
      [otpId, normPhone, otp, JSON.stringify({ userId }), expiresAt]
    );

    await sendOTP(normPhone, otp);

    const resp = {
      success: true,
      otpId,
      maskedPhone: `+${normPhone.slice(0, 2)}XXXXX${normPhone.slice(-4)}`,
      message: "OTP sent to your phone.",
    };
    if (IS_DEV) resp.devOtp = otp;
    return res.json(resp);
  } catch (err) {
    console.error("[auth google-phone-otp]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Doctor login ─────────────────────────────────────────────────────────────
router.post(
  "/doctor/login",
  [body("code").trim().notEmpty(), body("password").notEmpty()],
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const { code, password } = req.body;
      const phone = password; // password is stored in doctors.phone
      const { rows: doctorRows } = await pool.query(
        "SELECT * FROM doctors WHERE UPPER(code)=UPPER($1)",
        [String(code || "").trim()]
      );
      const doctor = doctorRows[0];
      if (doctor && doctor.is_active === 0) return res.status(401).json({ error: "Invalid access code. Please check with your admin." });

      if (!doctor) {
        return res.status(401).json({ error: "Invalid access code. Please check with your admin." });
      }
      const _stored = String(doctor.password || doctor.phone || "").trim();
      if (!_stored) {
        return res.status(401).json({ error: "No phone number set for this doctor. Contact admin." });
      }
      if (!(_stored.startsWith("$2") ? await bcrypt.compare(String(phone || "").trim(), _stored) : String(phone || "").trim() === _stored)) {
        return res
          .status(401)
          .json({ error: "Incorrect password." });
      }

      const payload = {
        id: `doc_${doctor.code}`,
        code: doctor.code,
        doctorId: doctor.id,
        role: "doctor",
      };

      return res.json({ token: sign(payload), user: payload });
    } catch (err) {
      console.error("[auth doctor/login]", err.message);
      return res.status(500).json({ error: err.message });
    }
  }
);

// ── Pharmacy staff login ───────────────────────────────────────────────────────
// Pharmacy staff password check (legacy staff without a password use their phone as a temporary one)
async function checkPharmacyPassword(staff, pw) {
  if (staff.password) return bcrypt.compare(String(pw), staff.password);
  return String(pw).trim() === String(staff.phone || "").trim();
}

function pharmacyPayload(staff) {
  return {
    id: "ph_" + staff.code,
    code: staff.code,
    pharmacyStaffId: staff.id,
    hospitalId: staff.hospital_id,
    hospitalName: staff.hospital_name,
    role: "pharmacy",
  };
}

router.post(
  "/pharmacy/login",
  [body("code").trim().notEmpty(), body("password").notEmpty()],
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const { code, password } = req.body;
      const { rows: staffRows } = await pool.query(
        "SELECT ps.*, h.name AS hospital_name, h.plan AS hospital_plan FROM pharmacy_staff ps JOIN hospitals h ON h.id = ps.hospital_id WHERE UPPER(ps.code)=UPPER($1)",
        [String(code || "").trim()]
      );
      const staff = staffRows[0];

      if (!staff || staff.is_active === 0) {
        return res.status(401).json({ error: "Invalid access code. Please check with your admin." });
      }
      if (!(await checkPharmacyPassword(staff, password))) {
        return res.status(401).json({ error: "Incorrect password." });
      }
      if (!staff.password || staff.first_login === 1) {
        return res.json({ firstLogin: true });
      }

      const payload = pharmacyPayload(staff);
      return res.json({ token: sign(payload), user: payload });
    } catch (err) {
      console.error("[auth pharmacy/login]", err.message);
      return res.status(500).json({ error: err.message });
    }
  }
);

router.post("/pharmacy/set-password", async (req, res) => {
  try {
    const { code, currentPassword, newPassword } = req.body;
    if (!code || !currentPassword || !newPassword)
      return res.status(400).json({ error: "code, currentPassword and newPassword are required" });
    if (String(newPassword).length < 6)
      return res.status(400).json({ error: "Password must be at least 6 characters" });
    if (String(newPassword) === String(currentPassword))
      return res.status(400).json({ error: "New password must be different from the current one" });

    const { rows } = await pool.query(
      "SELECT ps.*, h.name AS hospital_name FROM pharmacy_staff ps JOIN hospitals h ON h.id = ps.hospital_id WHERE UPPER(ps.code)=UPPER($1)",
      [String(code).trim()]
    );
    const staff = rows[0];
    if (!staff || staff.is_active === 0) return res.status(401).json({ error: "Invalid access code" });
    if (!(await checkPharmacyPassword(staff, currentPassword)))
      return res.status(401).json({ error: "Current password is incorrect" });

    const hash = await bcrypt.hash(String(newPassword), 10);
    await pool.query("UPDATE pharmacy_staff SET password=$1, first_login=0 WHERE id=$2", [hash, staff.id]);

    const payload = pharmacyPayload(staff);
    return res.json({ token: sign(payload), user: payload });
  } catch (err) {
    console.error("[auth pharmacy/set-password]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Admin login ──────────────────────────────────────────────────────────────
router.post(
  "/admin/login",
  [body("code").trim().notEmpty(), body("password").notEmpty()],
  async (req, res) => {
    if (!validate(req, res)) return;

    try {
      const { code, password } = req.body;

      if (String(code || "").toUpperCase() !== String(ADMIN_CODE).toUpperCase()) {
        return res.status(401).json({ error: "Invalid admin code" });
      }

      const ADMIN_PW = process.env.ADMIN_PASSWORD || "";
      if (ADMIN_PW && password === ADMIN_PW) {
        const payload = { id: "admin_1", role: "admin" };
        return res.json({ token: sign(payload), user: payload });
      }

      const { rows: adminRows } = await pool.query("SELECT * FROM users WHERE role='admin' LIMIT 1");
      const admin = adminRows[0];
      if (!admin || !(await bcrypt.compare(password, admin.password))) {
        return res.status(401).json({ error: "Invalid admin password" });
      }

      return res.json({
        token: sign({ id: admin.id, role: "admin" }),
        user: { id: admin.id, role: "admin" },
      });
    } catch (err) {
      console.error("[auth admin/login]", err.message);
      return res.status(500).json({ error: err.message });
    }
  }
);

// ── CTO login ────────────────────────────────────────────────────────────────
router.post(
  "/cto/login",
  [body("email").trim().notEmpty(), body("password").notEmpty()],
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const { email, password } = req.body;
      const E = String(process.env.CTO_EMAIL || "").trim().toLowerCase();
      const H = process.env.CTO_PASSWORD_HASH || "";
      if (!E || !H || String(email).trim().toLowerCase() !== E || !(await bcrypt.compare(String(password), H))) {
        return res.status(401).json({ error: "Invalid CTO credentials" });
      }
      const payload = { id: "cto_1", role: "cto" };
      return res.json({ token: sign(payload), user: payload });
    } catch (err) {
      console.error("[auth cto/login]", err.message);
      return res.status(500).json({ error: "Login failed" });
    }
  }
);

// ── Verify token ─────────────────────────────────────────────────────────────
router.get("/me", (req, res) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "No token" });

  try {
    return res.json({ user: jwt.verify(token, SECRET) });
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
});

// ── Forgot Password: send reset email via Resend ─────────────────────────────
router.post(
  "/patient/forgot-password",
  [body("email").trim().isEmail().withMessage("Valid email is required")],
  async (req, res) => {
    if (!validate(req, res)) return;

    try {
      const email = String(req.body.email || "").trim().toLowerCase();
      const { rows: userRows } = await pool.query(
        "SELECT * FROM users WHERE email=$1 AND role='patient'",
        [email]
      );
      const user = userRows[0];

      // Always return success to avoid account enumeration.
      if (!user) {
        return res.json({
          success: true,
          message: "If this email exists, a reset link has been sent.",
        });
      }

      const resetToken = jwt.sign(
        { id: user.id, role: "patient", purpose: "reset-password" },
        SECRET,
        { expiresIn: process.env.RESET_TOKEN_EXPIRES_IN || "30m" }
      );

      const resetLink = `${FRONTEND_URL}/login?mode=reset&token=${encodeURIComponent(resetToken)}`;

      await sendResetPasswordEmail(user.email, user.name, resetLink);

      const response = {
        success: true,
        message: "If this email exists, a reset link has been sent.",
      };
      if (IS_DEV) response.resetLink = resetLink;

      return res.json(response);
    } catch (err) {
      console.error("[auth forgot-password]", err.message);
      return res
        .status(500)
        .json({ error: err.message || "Failed to send reset email." });
    }
  }
);

// ── Reset Password via signed token link ─────────────────────────────────────
router.post("/patient/setup-password",
  [body("uhid").trim().notEmpty(), body("password").notEmpty()],
  async (req, res) => {
    if (!validate(req, res)) return;
    const uhid = String(req.body.uhid).trim().toUpperCase();
    const password = String(req.body.password);
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
    try {
      const { rows } = await pool.query("SELECT * FROM users WHERE uhid=$1 AND role='patient'", [uhid]);
      const user = rows[0];
      if (!user) return res.status(404).json({ error: "Patient not found" });
      if (user.password) return res.status(409).json({ error: "This account already has a password. Use login instead." });
      const hash = await bcrypt.hash(password, 10);
      await pool.query("UPDATE users SET password=$1 WHERE id=$2", [hash, user.id]);
      const token = jwt.sign({ id: user.id, role: "patient" }, process.env.JWT_SECRET, { expiresIn: "30d" });
      return res.json({ token, user: { id: user.id, name: user.name, uhid: user.uhid } });
    } catch (err) {
      console.error("[auth patient/setup-password]", err.message);
      return res.status(500).json({ error: "Server error" });
    }
  }
);

router.post("/patient/reset-password-by-token", async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: "token and newPassword are required." });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    let decoded = null;
    try {
      decoded = jwt.verify(token, SECRET);
    } catch {
      return res.status(400).json({ error: "Reset link is invalid or expired." });
    }

    if (!decoded || decoded.purpose !== "reset-password" || decoded.role !== "patient") {
      return res.status(400).json({ error: "Invalid reset token." });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password=$1 WHERE id=$2", [hash, decoded.id]);

    return res.json({
      success: true,
      message: "Password updated successfully. Please log in.",
    });
  } catch (err) {
    console.error("[auth reset-password-by-token]", err.message);
    return res
      .status(500)
      .json({ error: "Failed to reset password. Please try again." });
  }
});

// ── Legacy OTP reset endpoint ─────────────────────────────────────────────────
router.post("/patient/reset-password", async (req, res) => {
  try {
    const { otpId, otp, newPassword } = req.body;
    if (!otpId || !otp || !newPassword) {
      return res
        .status(400)
        .json({ error: "otpId, otp and newPassword are required." });
    }
    if (String(newPassword).length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }

    const { rows: pendingRows } = await pool.query(
      "SELECT * FROM otp_pending WHERE id=$1 AND context='reset'",
      [otpId]
    );
    const pending = pendingRows[0];
    if (!pending) {
      return res.status(400).json({ error: "OTP session not found or expired." });
    }

    if (Date.now() > Number(pending.expires_at)) {
      await pool.query("DELETE FROM otp_pending WHERE id=$1", [otpId]);
      return res.status(400).json({ error: "OTP has expired. Please request a new one." });
    }

    if (pending.attempts >= 5) {
      await pool.query("DELETE FROM otp_pending WHERE id=$1", [otpId]);
      return res
        .status(429)
        .json({ error: "Too many wrong attempts. Please request a new OTP." });
    }

    if (pending.otp !== String(otp).trim()) {
      await pool.query("UPDATE otp_pending SET attempts=attempts+1 WHERE id=$1", [otpId]);
      const left = 5 - (pending.attempts + 1);
      return res
        .status(400)
        .json({ error: `Incorrect OTP. ${left} attempt${left !== 1 ? "s" : ""} remaining.` });
    }

    const data = JSON.parse(pending.data || "{}");
    await pool.query("DELETE FROM otp_pending WHERE id=$1", [otpId]);

    const hash = await bcrypt.hash(String(newPassword), 10);
    await pool.query("UPDATE users SET password=$1 WHERE id=$2", [hash, data.userId]);

    return res.json({
      success: true,
      message: "Password updated successfully. Please log in.",
    });
  } catch (err) {
    console.error("[auth reset-password]", err.message);
    return res
      .status(500)
      .json({ error: "Failed to reset password. Please try again." });
  }
});

// ── Hospital Admin Login ────────────────────────────────────────────────────
// Step 1: POST loginId only (no password) is NOT supported — front end always
// sends both; if the account has never set a password (first_login=1) we
// tell the client to show the "set password" screen instead of comparing.
router.post("/hospital/login", async (req, res) => {
  try {
    const { loginId, password } = req.body;
    if (!loginId || !password) return res.status(400).json({ error: "loginId and password are required" });

    const { rows: hospRows } = await pool.query("SELECT id, name, admin_user_id, login_id FROM hospitals WHERE login_id=$1", [String(loginId).trim()]);
    const hospital = hospRows[0];
    if (!hospital) return res.status(401).json({ error: "Invalid login ID" });
    if (!hospital.admin_user_id) return res.status(401).json({ error: "No admin account set up for this hospital" });

    const { rows: userRows } = await pool.query("SELECT * FROM users WHERE id=$1", [hospital.admin_user_id]);
    const user = userRows[0];
    if (!user) return res.status(401).json({ error: "Admin account not found" });

    if (user.first_login === 1) {
      return res.json({ firstLogin: true, loginId, hospitalId: hospital.id, hospitalName: hospital.name });
    }

    const ok = await bcrypt.compare(password, user.password || "");
    if (!ok) return res.status(401).json({ error: "Incorrect password" });

    const payload = { id: user.id, role: "hospital_admin", hospitalId: hospital.id, hospitalName: hospital.name };
    return res.json({ token: sign(payload), user: payload });
  } catch (err) {
    console.error("[auth hospital/login]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Hospital Admin — set password on first login ────────────────────────────
router.post("/hospital/set-password", async (req, res) => {
  try {
    const { loginId, newPassword } = req.body;
    if (!loginId || !newPassword) return res.status(400).json({ error: "loginId and newPassword are required" });
    if (String(newPassword).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const { rows: hospRows } = await pool.query("SELECT id, name, admin_user_id, login_id FROM hospitals WHERE login_id=$1", [String(loginId).trim()]);
    const hospital = hospRows[0];
    if (!hospital || !hospital.admin_user_id) return res.status(404).json({ error: "Hospital not found" });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password=$1, first_login=0 WHERE id=$2", [hash, hospital.admin_user_id]);

    const payload = { id: hospital.admin_user_id, role: "hospital_admin", hospitalId: hospital.id, hospitalName: hospital.name };
    return res.json({ token: sign(payload), user: payload });
  } catch (err) {
    console.error("[auth hospital/set-password]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Lab Admin — login ────────────────────────────────────────────────────────
router.post("/lab/login", async (req, res) => {
  try {
    const { loginId, password } = req.body;
    if (!loginId || !password) return res.status(400).json({ error: "loginId and password are required" });

    const { rows: labRows } = await pool.query("SELECT * FROM labs WHERE login_id=$1", [String(loginId).trim()]);
    const lab = labRows[0];
    if (!lab) return res.status(401).json({ error: "Invalid login ID" });
    if (!lab.admin_user_id) return res.status(401).json({ error: "No admin account set up for this lab" });

    const { rows: userRows } = await pool.query("SELECT * FROM users WHERE id=$1", [lab.admin_user_id]);
    const user = userRows[0];
    if (!user) return res.status(401).json({ error: "Admin account not found" });

    if (user.first_login === 1) {
      return res.json({ firstLogin: true, loginId, labId: lab.id, labName: lab.name });
    }

    const ok = await bcrypt.compare(password, user.password || "");
    if (!ok) return res.status(401).json({ error: "Incorrect password" });

    const payload = { id: user.id, role: "lab_admin", labId: lab.id, labName: lab.name };
    return res.json({ token: sign(payload), user: payload });
  } catch (err) {
    console.error("[auth lab/login]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Lab Admin — set password on first login ─────────────────────────────────
router.post("/lab/set-password", async (req, res) => {
  try {
    const { loginId, newPassword } = req.body;
    if (!loginId || !newPassword) return res.status(400).json({ error: "loginId and newPassword are required" });
    if (String(newPassword).length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

    const { rows: labRows } = await pool.query("SELECT * FROM labs WHERE login_id=$1", [String(loginId).trim()]);
    const lab = labRows[0];
    if (!lab || !lab.admin_user_id) return res.status(404).json({ error: "Lab not found" });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password=$1, first_login=0 WHERE id=$2", [hash, lab.admin_user_id]);

    const payload = { id: lab.admin_user_id, role: "lab_admin", labId: lab.id, labName: lab.name };
    return res.json({ token: sign(payload), user: payload });
  } catch (err) {
    console.error("[auth lab/set-password]", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// -- Patient: set password (Google accounts that have none yet) --
router.post("/patient/set-password", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "patient") return res.status(403).json({ error: "Patients only" });
    const newPassword = String(req.body.newPassword || "");
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    const { rows } = await pool.query(
      "SELECT id, password_set FROM users WHERE id=$1 AND role='patient'",
      [req.user.id]
    );
    const u = rows[0];
    if (!u) return res.status(404).json({ error: "Account not found." });
    if (Number(u.password_set) !== 0) {
      return res.status(409).json({ error: "You already have a password. Use Change Password instead." });
    }
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password=$1, password_set=1 WHERE id=$2", [hash, u.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error("[auth patient/set-password]", err.message);
    return res.status(500).json({ error: "Could not set password. Please try again." });
  }
});

// -- Patient: change password (requires current password) --
router.post("/patient/change-password", requireAuth, async (req, res) => {
  try {
    if (req.user.role !== "patient") return res.status(403).json({ error: "Patients only" });
    const currentPassword = String(req.body.currentPassword || "");
    const newPassword = String(req.body.newPassword || "");
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "currentPassword and newPassword are required." });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters." });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: "New password must be different from the current one." });
    }
    const { rows } = await pool.query(
      "SELECT id, password, password_set FROM users WHERE id=$1 AND role='patient'",
      [req.user.id]
    );
    const u = rows[0];
    if (!u) return res.status(404).json({ error: "Account not found." });
    if (Number(u.password_set) === 0) {
      return res.status(409).json({ error: "You have not set a password yet. Use Set Password." });
    }
    const ok = await bcrypt.compare(currentPassword, u.password || "");
    if (!ok) return res.status(401).json({ error: "Current password is incorrect." });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query("UPDATE users SET password=$1 WHERE id=$2", [hash, u.id]);
    return res.json({ success: true });
  } catch (err) {
    console.error("[auth patient/change-password]", err.message);
    return res.status(500).json({ error: "Could not change password. Please try again." });
  }
});

// ── Claim a desk-created account: UHID + claim code + OTP ────────────────────
const nodeCrypto = require("crypto");
const CLAIM_GENERIC = "Invalid or expired claim code. Ask the hospital desk for a new one.";
const normClaimCode = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const hashClaimOtp = (claimId, otp) => nodeCrypto.createHash("sha256").update(claimId + ":" + otp).digest("hex");

router.post("/patient/claim/start", async (req, res) => {
  try {
    const uhid = String(req.body.uhid || "").trim().toUpperCase();
    const code = normClaimCode(req.body.code);
    if (!UHID_RE.test(uhid) || code.length !== 8) return res.status(400).json({ error: CLAIM_GENERIC });
    const { rows } = await pool.query(
      `SELECT c.* FROM patient_claims c JOIN users u ON u.id = c.user_id
        WHERE upper(u.uhid)=$1 AND u.role='patient' AND u.password IS NULL
          AND c.used_at IS NULL AND c.expires_at > now()
        ORDER BY c.created_at DESC LIMIT 1`, [uhid]);
    const c = rows[0];
    if (!c || c.attempts >= 5) return res.status(400).json({ error: CLAIM_GENERIC });
    if (!(await bcrypt.compare(code, c.code_hash))) {
      await pool.query("UPDATE patient_claims SET attempts = attempts + 1 WHERE id=$1", [c.id]);
      return res.status(400).json({ error: CLAIM_GENERIC });
    }
    if (c.otp_sent_at && Date.now() - new Date(c.otp_sent_at).getTime() < 60000)
      return res.status(429).json({ error: "Please wait a minute before asking for another OTP." });
    if (c.otp_sent_count >= 5)
      return res.status(429).json({ error: "Too many OTP requests. Ask the hospital desk for a new claim code." });
    const otp = generateOTP();
    await pool.query(
      "UPDATE patient_claims SET otp_hash=$1, otp_expires_at = now() + interval '10 minutes', otp_attempts=0, otp_sent_at=now(), otp_sent_count = otp_sent_count + 1 WHERE id=$2",
      [hashClaimOtp(c.id, otp), c.id]);
    await sendOTP(c.phone, otp);
    return res.json({ success: true, claimId: c.id, phoneHint: "******" + String(c.phone).slice(-2) });
  } catch (err) {
    console.error("[auth claim start]", err.message);
    return res.status(500).json({ error: "Could not start the claim. Please try again." });
  }
});

router.post("/patient/claim/finish", async (req, res) => {
  try {
    const claimId = String(req.body.claimId || "");
    const otp = String(req.body.otp || "").trim();
    const password = String(req.body.password || "");
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 chars" });
    if (!claimId || !/^\d{6}$/.test(otp)) return res.status(400).json({ error: "Enter the 6-digit OTP." });
    const { rows } = await pool.query("SELECT * FROM patient_claims WHERE id=$1 AND used_at IS NULL AND expires_at > now()", [claimId]);
    const c = rows[0];
    if (!c || !c.otp_hash || !c.otp_expires_at || new Date(c.otp_expires_at) < new Date())
      return res.status(400).json({ error: "OTP expired. Start again with your UHID and claim code." });
    if (c.otp_attempts >= 5) return res.status(429).json({ error: "Too many wrong OTP attempts. Start again to get a new OTP." });
    if (hashClaimOtp(c.id, otp) !== c.otp_hash) {
      await pool.query("UPDATE patient_claims SET otp_attempts = otp_attempts + 1 WHERE id=$1", [c.id]);
      return res.status(400).json({ error: "Incorrect OTP." });
    }
    const hash = await bcrypt.hash(password, 10);
    const client = await pool.connect();
    let user = null;
    try {
      await client.query("BEGIN");
      const up = await client.query(
        "UPDATE users SET password=$1, phone=$2, phone_verified=1, password_set=1 WHERE id=$3 AND password IS NULL RETURNING *",
        [hash, c.phone, c.user_id]);
      if (!up.rows.length) { await client.query("ROLLBACK"); return res.status(400).json({ error: CLAIM_GENERIC }); }
      user = up.rows[0];
      await client.query("UPDATE patient_claims SET used_at=now(), otp_hash=NULL, code_hash='' WHERE id=$1", [c.id]);
      await client.query("COMMIT");
    } catch (e) { try { await client.query("ROLLBACK"); } catch (_) {} throw e; }
    finally { client.release(); }
    return res.json({
      token: sign({ id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid }),
      user: { id: user.id, email: user.email, name: user.name, role: "patient", uhid: user.uhid },
    });
  } catch (err) {
    console.error("[auth claim finish]", err.message);
    return res.status(500).json({ error: "Could not finish the claim. Please try again." });
  }
});

module.exports = router;

// ── Logout (blacklist token) ──────────────────────────────────────────────────
router.post("/logout", async (req, res) => {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    const crypto = require("crypto");
    const { pool } = require("../db/init");
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const decoded = require("jsonwebtoken").decode(token);
    const expiresAt = decoded && decoded.exp ? new Date(decoded.exp * 1000).toISOString() : new Date(Date.now() + 8*3600*1000).toISOString();
    await pool.query(
      "INSERT INTO token_blacklist (token_hash, expires_at) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [tokenHash, expiresAt]
    );
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Clean up expired blacklist tokens every hour
setInterval(async () => {
  try {
    const { pool } = require('../db/init');
    await pool.query('DELETE FROM token_blacklist WHERE expires_at < now()');
  } catch(_) {}
}, 60 * 60 * 1000);
