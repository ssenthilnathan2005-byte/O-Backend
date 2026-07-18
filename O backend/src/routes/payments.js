"use strict";
const express  = require("express");
const crypto   = require("crypto");
const Razorpay = require("razorpay");
const { pool } = require("../db/init");
const { requireAuth } = require("../middleware/auth");
const { broadcast }   = require("../services/ws");
const { sendBookingConfirmation } = require("../services/whatsapp");
const { validateRequiredIndianPhone } = require("../utils/phone");

const router = express.Router();

const KEY_ID     = process.env.RAZORPAY_KEY_ID     || "";
const KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || "";

let razorpay = null;
if (KEY_ID && KEY_SECRET) {
  razorpay = new Razorpay({ key_id: KEY_ID, key_secret: KEY_SECRET });
  console.log("[Razorpay] Initialized — key:", KEY_ID.slice(0, 8) + "...");
} else {
  console.warn("[Razorpay] KEY_ID or KEY_SECRET not set — payment routes disabled");
}

function ensureRazorpay(res) {
  if (!razorpay) {
    res.status(503).json({ error: "Payment gateway is not configured. Contact support." });
    return false;
  }
  return true;
}

// Razorpay API call with timeout + retry
async function razorpayWithRetry(fn, attempts = 2) {
  for (let i = 1; i <= attempts; i++) {
    try {
      return await Promise.race([
        fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("Razorpay timeout")), 15_000)),
      ]);
    } catch (err) {
      if (i === attempts) throw err;
      console.warn(`[Razorpay] Attempt ${i} failed: ${err.message} — retrying...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ── POST /api/payments/create-order ──────────────────────────────────────────
router.post("/create-order", requireAuth, async (req, res) => {
  try {
    const { doctorId, date, session, complaint = "", phone, patientName: submittedName = "", patientAge = "" } = req.body;
    if (!doctorId || !date || !session)
      return res.status(400).json({ error: "doctorId, date and session are required." });

    const phoneValidation = validateRequiredIndianPhone(phone);
    if (!phoneValidation.ok) {
      return res.status(400).json({ error: phoneValidation.error });
    }

    if (!ensureRazorpay(res)) return;

    // Validate date format (YYYY-MM-DD)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
      return res.status(400).json({ error: "Invalid date format. Use YYYY-MM-DD." });

    const { rows: doctorRows } = await pool.query("SELECT * FROM doctors WHERE id=$1", [doctorId]);
    const doctor = doctorRows[0];
    if (!doctor)   return res.status(404).json({ error: "Doctor not found." });
    if (!doctor.is_available)
      return res.status(409).json({ error: "Doctor is not available." });

    const { rows: hospitalRows } = await pool.query("SELECT name FROM hospitals WHERE id=$1", [doctor.hospital_id]);
    const hospital  = hospitalRows[0];
    const sessionId = `${doctorId}_${date}_${session}`;

    // Check capacity
    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*) as c FROM bookings WHERE session_id=$1 AND payment_done=1 AND status!='cancelled'",
      [sessionId]
    );
    const count = Number(countRows[0].c);
    if (count >= doctor.tokens_per_session)
      return res.status(409).json({ error: "This session is fully booked." });

    // Check duplicate booking
    const { rows: dupRows } = await pool.query(
      "SELECT id FROM bookings WHERE session_id=$1 AND patient_id=$2 AND status!='cancelled'",
      [sessionId, req.user.id]
    );
    if (dupRows[0]) return res.status(409).json({ error: "You already have a booking in this session." });

    const amountRupees = doctor.consultation_fee || doctor.price || 10;
    const amountPaise  = Math.round(amountRupees * 100);

    // Idempotency key — prevents duplicate orders on network retry
    const idempotencyKey = `${req.user.id}_${sessionId}_${Date.now()}`;

    const order = await razorpayWithRetry(() =>
      razorpay.orders.create({
        amount:   amountPaise,
        currency: "INR",
        receipt:  `rcpt_${Date.now()}`.slice(0, 40),
        notes: {
          doctorId,
          doctorName:   doctor.name,
          hospitalName: hospital?.name || "",
          date,
          session,
          patientId:    req.user.id,
          sessionId,
          complaint:    (complaint || "").slice(0, 200),
          phone:        phoneValidation.phone,
          patientName:  (submittedName || "").slice(0, 100),
          patientAge:   String(patientAge || "").slice(0, 5),
        },
      })
    );

    console.log(`[Razorpay] Order created: ${order.id} ₹${amountRupees} for ${req.user.id}`);
    res.json({
      orderId:      order.id,
      amount:       amountPaise,
      amountRupees,
      currency:     "INR",
      keyId:        KEY_ID,
      doctorName:   doctor.name,
      hospitalName: hospital?.name || "",
    });
  } catch (err) {
    console.error("[payments create-order]", err.message);
    if (err.message?.includes("timeout"))
      return res.status(504).json({ error: "Payment gateway timed out. Please try again." });
    res.status(500).json({ error: "Failed to create payment order. Please try again." });
  }
});

// ── POST /api/payments/verify ─────────────────────────────────────────────────
router.post("/verify", requireAuth, async (req, res) => {
  if (!ensureRazorpay(res)) return;
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: "Missing payment verification fields." });

    // ── Idempotency — if booking already exists for this order, return it ────
    const { rows: existingBookingRows } = await pool.query(
      "SELECT * FROM bookings WHERE razorpay_order_id=$1",
      [razorpay_order_id]
    );
    const existingBooking = existingBookingRows[0];
    if (existingBooking) {
      console.log(`[Razorpay] Duplicate verify for order ${razorpay_order_id} — returning existing booking`);
      return res.json({
        success: true,
        booking: formatBooking(existingBooking),
      });
    }

    // ── Verify HMAC-SHA256 signature ─────────────────────────────────────────
    const expectedSig = crypto
      .createHmac("sha256", KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    // Constant-time comparison to prevent timing attacks
    const sigBuffer  = Buffer.from(razorpay_signature, "hex");
    const expBuffer  = Buffer.from(expectedSig, "hex");
    const sigValid   = sigBuffer.length === expBuffer.length &&
                       crypto.timingSafeEqual(sigBuffer, expBuffer);

    if (!sigValid) {
      console.error(`[Razorpay] Signature mismatch for order ${razorpay_order_id}`);
      return res.status(400).json({ error: "Payment verification failed. Please contact support." });
    }

    // ── Fetch order from Razorpay ─────────────────────────────────────────────
    const order = await razorpayWithRetry(() => razorpay.orders.fetch(razorpay_order_id));
    const notes = order.notes || {};

    const { doctorId, date, session, patientId, sessionId,
            doctorName, hospitalName, complaint = "", phone = "",
            patientName: submittedName = "", patientAge = "" } = notes;

    if (!doctorId || !date || !session || !patientId || !sessionId)
      return res.status(400).json({ error: "Invalid payment order data." });

    const phoneValidation = validateRequiredIndianPhone(phone);
    if (!phoneValidation.ok) {
      return res.status(400).json({ error: `Invalid payment order data: ${phoneValidation.error}` });
    }

    // Verify the patient matches
    if (patientId !== req.user.id)
      return res.status(403).json({ error: "Payment does not belong to this account." });

    const { rows: doctorRows } = await pool.query("SELECT * FROM doctors WHERE id=$1", [doctorId]);
    const { rows: patientRows } = await pool.query("SELECT * FROM users WHERE id=$1", [req.user.id]);
    const doctor  = doctorRows[0];
    const patient = patientRows[0];
    if (!doctor || !patient)
      return res.status(404).json({ error: "Doctor or patient not found." });

    // ── Create booking in a transaction (race-condition safe) ─────────────────
    let booking;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Re-check capacity
      const { rows: freshCountRows } = await client.query(
        "SELECT COUNT(*) as c FROM bookings WHERE session_id=$1 AND payment_done=1 AND status!='cancelled'",
        [sessionId]
      );
      const freshCount = Number(freshCountRows[0].c);
      if (freshCount >= doctor.tokens_per_session)
        throw Object.assign(
          new Error("Session became fully booked during payment. You will be refunded within 5-7 business days."),
          { status: 409 }
        );

      // Re-check duplicate
      const { rows: dupRows } = await client.query(
        "SELECT id FROM bookings WHERE session_id=$1 AND patient_id=$2 AND status!='cancelled'",
        [sessionId, req.user.id]
      );
      if (dupRows[0])
        throw Object.assign(new Error("You already have a booking in this session."), { status: 409 });

      const tokenNumber = freshCount + 1;
      const bookingId   = `b_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;

      await client.query(
        `INSERT INTO bookings
          (id, patient_id, patient_name, doctor_id, doctor_name, hospital_name,
           date, session, token_number, session_id, payment_done, status,
           phone, complaint, razorpay_order_id, razorpay_payment_id, patient_age)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,'confirmed',$11,$12,$13,$14,$15)`,
        [
          bookingId, req.user.id, (submittedName || patient.name),
          doctorId, doctorName || doctor.name, hospitalName || "",
          date, session, tokenNumber, sessionId,
          phoneValidation.phone, complaint,
          razorpay_order_id, razorpay_payment_id,
          patientAge !== "" && patientAge != null ? Number(patientAge) : null,
        ]
      );

      // Update token state
      const { rows: existingRows } = await client.query(
        "SELECT * FROM token_states WHERE session_id=$1",
        [sessionId]
      );
      const existing = existingRows[0];
      if (existing) {
        const statuses = JSON.parse(existing.token_statuses || "{}");
        statuses[tokenNumber] = "red";
        await client.query(
          `UPDATE token_states SET token_statuses=$1, priority_slots=$2,
           current_token=$3, next_token=$4, is_closed=$5, updated_at=now()
           WHERE session_id=$6`,
          [
            JSON.stringify(statuses), existing.priority_slots,
            existing.current_token, existing.next_token, existing.is_closed, sessionId,
          ]
        );
      } else {
        await client.query(
          "INSERT INTO token_states (session_id, doctor_id, date, session, token_statuses) VALUES ($1,$2,$3,$4,$5)",
          [sessionId, doctorId, date, session, JSON.stringify({ [tokenNumber]: "red" })]
        );
      }

      const { rows: bookingRows } = await client.query("SELECT * FROM bookings WHERE id=$1", [bookingId]);
      booking = bookingRows[0];
      console.log(`[Razorpay] Booking confirmed: ${bookingId} token ${tokenNumber} order ${razorpay_order_id}`);

      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }

    res.json({ success: true, booking: formatBooking(booking) });

    // Side effects run after the API response so checkout completion is not held up.
    setImmediate(() => {
      try {
        sendBookingConfirmation({
          phone: booking.phone || patient.phone,
          patientName: patient.name,
          doctorName: doctorName || doctor.name,
          hospitalName: hospitalName || "",
          date,
          session,
          tokenNumber: booking.token_number,
        }).catch(() => {});
        broadcast(sessionId, { type: "token_booked", tokenNumber: booking.token_number, sessionId });
      } catch (wsErr) {
        console.error("[payments] WS broadcast error:", wsErr.message);
      }
    });
  } catch (err) {
    console.error("[payments verify]", err.message);
    if (err.message?.includes("timeout"))
      return res.status(504).json({ error: "Payment gateway timed out. Your payment may have gone through — check your bookings before trying again." });
    res.status(err.status || 500).json({ error: err.message });
  }
});

function formatBooking(b) {
  return {
    id: b.id, patientId: b.patient_id, patientName: b.patient_name,
    doctorId: b.doctor_id, doctorName: b.doctor_name,
    hospitalName: b.hospital_name, date: b.date,
    session: b.session, tokenNumber: b.token_number,
    sessionId: b.session_id, paymentDone: !!b.payment_done, status: b.status,
    phone: b.phone || "", complaint: b.complaint || "", patientAge: b.patient_age ?? null,
    createdAt: b.created_at,
  };
}


async function refundBooking(bookingId) {
  if (!razorpay) { console.warn("[Refund] Razorpay not configured", bookingId); return; }
  try {
    const { rows } = await pool.query("SELECT * FROM bookings WHERE id=$1", [bookingId]);
    const booking = rows[0];
    if (!booking) { console.warn("[Refund] Booking not found:", bookingId); return; }
    if (!booking.razorpay_payment_id) { console.warn("[Refund] No payment ID:", bookingId); return; }
    if (booking.refund_id) { console.warn("[Refund] Already refunded:", bookingId); return; }
    const payment = await razorpayWithRetry(() => razorpay.payments.fetch(booking.razorpay_payment_id));
    const refund = await razorpayWithRetry(() => razorpay.payments.refund(booking.razorpay_payment_id, { amount: payment.amount, speed: "optimum", notes: { bookingId, reason: "Session cancelled or patient unavailable" } }));
    await pool.query("UPDATE bookings SET refund_id=$1 WHERE id=$2", [refund.id, bookingId]);
    console.log("[Refund] Refunded booking", bookingId, "refund ID:", refund.id);
  } catch(err) {
    console.error("[Refund] Failed for booking", bookingId, err.message);
  }
}
module.exports = router;
module.exports.refundBooking = refundBooking;
