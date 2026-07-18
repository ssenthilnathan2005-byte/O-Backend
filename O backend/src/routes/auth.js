"use strict";

const express = require("express");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { body, validationResult } = require("express-validator");
const { OAuth2Client } = require("google-auth-library");
const { pool } = require("../db/init");
const { sendOTP, generateOTP, normalisePhone, IS_DEV } = require("../services/sms");
const { Resend } = require("resend");

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
if (!resend) {
  console.warn("[auth] RESEND_API_KEY not set — password reset emails are disabled (server will still start).");
}

const router = express.Router();

const SECRET = process.env.JWT_SECRET || "fallback_dev_secret";
const EXPIRES = process.env.JWT_EXPIRES_IN || "7d";
const ADMIN_CODE = process.env.ADMIN_CODE || "ADMIN-001";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

function sign(payload) {
  return jwt.sign(payload, SECRET, { expiresIn: EXPIRES });
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
          token: sign({ id: user.id, name: user.name, phone: normPhone, role: "patient" }),
          user:  { id: user.id, name: user.name, phone: normPhone, role: "patient" },
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
        token: sign({ id: user.id, email: user.email, name: user.name, role: "patient" }),
        user:  { id: user.id, email: user.email, name: user.name, role: "patient" },
        message: "Account created successfully.",
      });

    } catch (err) {
      console.error("[auth signup]", err.message);
      return res.status(500).json({ error: err.message || "Signup failed." });
    }
  }
);

// ── Patient Login — email/password ───────────────────────────────────────────
router.post(
  "/patient/login",
  [
    body("password").notEmpty().withMessage("Password is required"),
    body("email").optional().trim(),
    body("identifier").optional().trim(),
    body().custom((v) => {
      const id = String(v.email || v.identifier || "").trim();
      if (!id) throw new Error("Email is required");
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

      if (isLikelyEmail(identifier)) {
        const { rows } = await pool.query(
          "SELECT * FROM users WHERE email=$1 AND role='patient'",
          [identifier.toLowerCase()]
        );
        user = rows[0] || null;
      } else {
        try {
          const normPhone = normalisePhone(identifier);
          const { rows } = await pool.query(
            "SELECT * FROM users WHERE phone=$1 AND role='patient'",
            [normPhone]
          );
          user = rows[0] || null;
        } catch {
          user = null;
        }
      }
      const tDbEnd = Date.now();

      if (!user) {
        return res.status(401).json({ error: "No account found with this email." });
      }
      const tCompareStart = Date.now();
      const ok = await bcrypt.compare(password, user.password);
      const tCompareEnd = Date.now();
      console.log(`[TIMING login] db lookup: ${tDbEnd - t0}ms | bcrypt.compare: ${tCompareEnd - tCompareStart}ms | TOTAL: ${tCompareEnd - t0}ms`);
      if (!ok) {
        return res.status(401).json({ error: "Incorrect password." });
      }

      return res.json({
        token: sign({ id: user.id, email: user.email, name: user.name, role: "patient" }),
        user: { id: user.id, email: user.email, name: user.name, role: "patient" },
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
        token: sign({ id: user.id, name: user.name, phone: pending.phone, role: "patient" }),
        user: { id: user.id, name: user.name, phone: pending.phone, role: "patient" },
      });
    }

    if (pending.context === "login") {
      const { rows: userRows } = await pool.query("SELECT * FROM users WHERE id=$1", [data.userId]);
      const user = userRows[0];
      if (!user) return res.status(404).json({ error: "Account not found." });

      return res.json({
        token: sign({ id: user.id, email: user.email, name: user.name, role: "patient" }),
        user: { id: user.id, email: user.email, name: user.name, role: "patient" },
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
        token: sign({ id: user.id, email: user.email, name: user.name, role: "patient" }),
        user: { id: user.id, email: user.email, name: user.name, role: "patient" },
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

      const { rows: newUserRows } = await pool.query("SELECT * FROM users WHERE id=$1", [id]);
      user = newUserRows[0];
    }

    return res.json({
      token: sign({ id: user.id, email: user.email, name: user.name, role: "patient" }),
      user: { id: user.id, email: user.email, name: user.name, role: "patient" },
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
  [body("code").trim().notEmpty(), body("phone").trim().notEmpty()],
  async (req, res) => {
    if (!validate(req, res)) return;
    try {
      const { code, phone } = req.body;
      const { rows: doctorRows } = await pool.query(
        "SELECT * FROM doctors WHERE UPPER(code)=UPPER($1)",
        [String(code || "").trim()]
      );
      const doctor = doctorRows[0];

      if (!doctor) {
        return res.status(401).json({ error: "Invalid access code. Please check with your admin." });
      }
      if (!(doctor.phone || "").trim()) {
        return res.status(401).json({ error: "No phone number set for this doctor. Contact admin." });
      }
      if (String(phone || "").trim() !== String(doctor.phone || "").trim()) {
        return res
          .status(401)
          .json({ error: "Incorrect password. Use your registered phone number." });
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

module.exports = router;
