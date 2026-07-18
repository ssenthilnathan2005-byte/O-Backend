"use strict";
const cron = require("node-cron");
const { pool } = require("../db/init");
const { refundBooking } = require("../routes/payments");

// ── Fast, no network calls. Finds all confirmed bookings whose date has
// passed and flips them to 'unvisited' (so they move from "To Visit" to
// "Visited" with an unvisited marker in the doctor's Live Tokens panel).
// Returns the rows that were just expired, for refund processing by the
// caller. Safe to call on every request — only touches rows still in
// 'confirmed' status, so already-processed bookings are a cheap no-op.
async function markStaleConfirmedAsUnvisited() {
  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  const { rows: expiredBookings } = await pool.query(
    `SELECT id, session_id, date, patient_name, token_number
     FROM bookings
     WHERE status = 'confirmed'
       AND payment_done = 1
       AND date < $1`,
    [today]
  );

  if (expiredBookings.length === 0) return [];

  await pool.query(
    `UPDATE bookings
     SET status = 'unvisited'
     WHERE status = 'confirmed'
       AND payment_done = 1
       AND date < $1`,
    [today]
  );

  console.log(`[Scheduler] Marked ${expiredBookings.length} stale booking(s) as unvisited.`);
  return expiredBookings;
}

// ── Slow path — issues a refund per expired booking. Network calls to
// Razorpay, so this should always be run in the background (setImmediate /
// fire-and-forget) rather than awaited inside a request handler.
async function refundExpiredBookings(expiredBookings) {
  for (const booking of expiredBookings) {
    console.log(`[Scheduler] Refunding expired booking ${booking.id} — ${booking.patient_name} token #${booking.token_number} on ${booking.date}`);
    await refundBooking(booking.id).catch((err) =>
      console.error(`[Scheduler] Refund failed for ${booking.id}:`, err.message)
    );
  }
}

// ── Combined helper used by the midnight cron and on server startup ──────────
async function expireStaleBookings() {
  try {
    const expired = await markStaleConfirmedAsUnvisited();
    if (expired.length === 0) return;
    console.log(`[Scheduler] Found ${expired.length} expired booking(s) — processing refunds...`);
    await refundExpiredBookings(expired);
    console.log(`[Scheduler] Done. Processed ${expired.length} expired booking(s).`);
  } catch (err) {
    console.error("[Scheduler] Error during cleanup:", err.message);
  }
}

// ── Runs every day at midnight IST ────────────────────────────────────────────
// This is a best-effort schedule — if the server happens to be asleep or
// restarting exactly at midnight (common on free/low-cost hosting), the cron
// tick is simply missed. expireStaleBookings() is therefore also called on
// server startup, and markStaleConfirmedAsUnvisited() is called lazily on
// every GET /bookings request (see routes/bookings.js), so stale "confirmed"
// bookings always get cleaned up the next time anyone looks, regardless of
// whether the midnight cron actually fired.
function startScheduler() {
  cron.schedule("0 0 * * *", () => {
    console.log("[Scheduler] Running midnight expired bookings cleanup...");
    void expireStaleBookings();
  }, {
    timezone: "Asia/Kolkata" // IST midnight
  });

  console.log("[Scheduler] Midnight cleanup job scheduled (IST).");
}

module.exports = { startScheduler, expireStaleBookings, markStaleConfirmedAsUnvisited, refundExpiredBookings };
