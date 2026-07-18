"use strict";
const { refundBooking } = require("./payments");
const { sendTokenCalled } = require("../services/whatsapp");
const { sendPushToPatient } = require("../services/push");
const express = require("express");
const { pool } = require("../db/init");
const { requireDoctorOrAdmin } = require("../middleware/auth");
const { broadcast } = require("../services/ws");

const router = express.Router();
const SENTINEL = "__cancelled__";

// ── Helpers ───────────────────────────────────────────────────────────────────
async function getState(sessionId, queryable = pool) {
  const { rows } = await queryable.query("SELECT * FROM token_states WHERE session_id=$1", [sessionId]);
  return rows[0] || null;
}

function parseState(row) {
  if (!row) return null;
  return {
    sessionId:        row.session_id,
    doctorId:         row.doctor_id,
    date:             row.date,
    session:          row.session,
    tokenStatuses:    JSON.parse(row.token_statuses  || "{}"),
    prioritySlots:    JSON.parse(row.priority_slots  || "{}"),
    currentToken:     row.current_token,
    nextToken:        row.next_token,
    isClosed:         row.is_closed === 1,
    cancelledSessions: JSON.parse(row.cancelled_keys || "[]"),
  };
}

// Single reusable update query — same shape as the old precompiled statement,
// just run through pool/client.query now instead of a prepared statement object.
async function saveState(queryable, sid, statuses, slots, current, next, closed) {
  await queryable.query(
    `UPDATE token_states SET token_statuses=$1, priority_slots=$2,
     current_token=$3, next_token=$4, is_closed=$5, updated_at=now()
     WHERE session_id=$6`,
    [
      JSON.stringify(statuses),
      JSON.stringify(slots),
      current ?? null,
      next    ?? null,
      closed ? 1 : 0,
      sid,
    ]
  );
}

async function broadcastState(sessionId) {
  const state = parseState(await getState(sessionId));
  if (state) broadcast(sessionId, { type: "state_update", state });
}

// Wrap every write in a transaction + error handler.
// fn receives (state, client) — use `client` for any queries inside the
// transaction so they run on the same connection as BEGIN/COMMIT.
async function withTx(sessionId, res, fn) {
  const client = await pool.connect();
  try {
    const row = await getState(sessionId, client);
    if (!row) { client.release(); return res.status(404).json({ error: "Session not found" }); }

    try {
      await client.query("BEGIN");
      await fn(parseState(row), client);
      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    }

    await broadcastState(sessionId);
    const finalRow = await getState(sessionId);
    res.json(parseState(finalRow));
  } catch (err) {
    console.error(`[tokens] error session=${sessionId}:`, err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
}

// ── GET token state ───────────────────────────────────────────────────────────
router.get("/:sessionId", async (req, res) => {
  try {
    const row = await getState(req.params.sessionId);
    res.json(row ? parseState(row) : null);
  } catch (err) {
    console.error("[tokens GET]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST regulate ─────────────────────────────────────────────────────────────
router.post("/:sessionId/regulate", requireDoctorOrAdmin, async (req, res) => {
  const clicked = Number(req.body.clickedToken);
  if (!Number.isInteger(clicked))
    return res.status(400).json({ error: "clickedToken must be an integer" });

  await withTx(req.params.sessionId, res, async (state, client) => {
    const statuses = { ...state.tokenStatuses };
    let { currentToken, nextToken } = state;

    if (currentToken !== null && currentToken !== clicked)
      statuses[currentToken] = "green";

    statuses[clicked] = "orange";
    currentToken = clicked;

    if (nextToken !== null && statuses[nextToken] === "yellow")
      statuses[nextToken] = "red";

    const reds = Object.entries(statuses)
      .filter(([n, s]) => s === "red" && Number(n) !== clicked)
      .map(([n]) => Number(n)).sort((a, b) => a - b);

    const nextRed = reds[0] ?? null;
    if (nextRed !== null) statuses[nextRed] = "yellow";
    nextToken = nextRed;

    await saveState(client, req.params.sessionId, statuses, state.prioritySlots, currentToken, nextToken, state.isClosed);

    // Send WhatsApp notification to called patient
    try {
      const { rows: bookingRows } = await client.query(
        `SELECT b.*, u.phone as uphone FROM bookings b LEFT JOIN users u ON b.patient_id=u.id
         WHERE b.session_id=$1 AND b.token_number=$2 AND b.status!='cancelled' LIMIT 1`,
        [req.params.sessionId, clicked]
      );
      const booking = bookingRows[0];
      if (booking) {
        const parts = req.params.sessionId.split("_");
        const { rows: docRows } = await client.query("SELECT * FROM doctors WHERE id=$1", [parts[0]]);
        const doc = docRows[0];
        const hosp = doc ? (await client.query("SELECT name FROM hospitals WHERE id=$1", [doc.hospital_id])).rows[0] : null;
        sendTokenCalled({ phone: booking.phone || booking.uphone, patientName: booking.patient_name, tokenNumber: clicked, doctorName: booking.doctor_name, hospitalName: hosp?.name || "" }).catch(() => {});
        sendPushToPatient(booking.patient_id, { title: "Your turn has arrived!", body: "Token #" + clicked + " - Dr. " + booking.doctor_name + " is ready for you. Please come in now.", data: { tag: "token-orange" } }).catch(() => {});
      }
      if (nextRed !== null) {
        const { rows: nextBookingRows } = await client.query(
          "SELECT * FROM bookings WHERE session_id=$1 AND token_number=$2 AND status!='cancelled' LIMIT 1",
          [req.params.sessionId, nextRed]
        );
        const nextBooking = nextBookingRows[0];
        if (nextBooking) sendPushToPatient(nextBooking.patient_id, { title: "Get Ready!", body: "Token #" + nextRed + " - You are next. Dr. " + nextBooking.doctor_name + " will call you soon.", data: { tag: "token-yellow" } }).catch(() => {});
      }
    } catch(_) {}
  });
});

// ── POST complete ─────────────────────────────────────────────────────────────
// Marks the current token as green (seen by doctor) — NOT eligible for refund
router.post("/:sessionId/complete", requireDoctorOrAdmin, async (req, res) => {
  await withTx(req.params.sessionId, res, async (state, client) => {
    const statuses = { ...state.tokenStatuses };
    const completedToken = state.currentToken;
    if (completedToken !== null) statuses[completedToken] = "green";

    let next = state.nextToken;
    if (next === null) {
      const reds = Object.entries(statuses)
        .filter(([, s]) => s === "red").map(([n]) => Number(n)).sort((a, b) => a - b);
      if (reds[0] !== undefined) { statuses[reds[0]] = "yellow"; next = reds[0]; }
    }
    await saveState(client, req.params.sessionId, statuses, state.prioritySlots, null, next, state.isClosed);

    // Mark the booking as 'completed' — no refund applicable
    if (completedToken !== null) {
      await client.query(
        "UPDATE bookings SET status='completed' WHERE session_id=$1 AND token_number=$2 AND status='confirmed'",
        [req.params.sessionId, completedToken]
      );
    }
  });
});

// ── POST skip ─────────────────────────────────────────────────────────────────
// Patient was not present — marked unvisited (purple). Eligible for refund.
// Accepts optional tokenNum in body — used when skipping directly from a red
// token without calling regulate first (currentToken would be null otherwise).
router.post("/:sessionId/skip", requireDoctorOrAdmin, async (req, res) => {
  await withTx(req.params.sessionId, res, async (state, client) => {
    const statuses = { ...state.tokenStatuses };

    // Use explicit tokenNum if provided (direct skip from red/yellow),
    // otherwise fall back to currentToken (skip after marking ongoing)
    const skippedToken = (req.body.tokenNum != null)
      ? Number(req.body.tokenNum)
      : state.currentToken;

    if (skippedToken !== null) {
      statuses[skippedToken] = "unvisited"; // purple
    }

    // If this token was the current active one, clear it
    const newCurrent = state.currentToken === skippedToken ? null : state.currentToken;

    // Find next red token to become yellow (next up)
    let next = (state.nextToken !== skippedToken) ? state.nextToken : null;
    if (next === null) {
      const reds = Object.entries(statuses)
        .filter(([n, s]) => s === "red" && Number(n) !== skippedToken)
        .map(([n]) => Number(n))
        .sort((a, b) => a - b);
      if (reds[0] !== undefined) { statuses[reds[0]] = "yellow"; next = reds[0]; }
    }

    await saveState(client, req.params.sessionId, statuses, state.prioritySlots, newCurrent, next, state.isClosed);

    // Mark the skipped patient's booking as 'unvisited' — refund eligible
    if (skippedToken !== null) {
      await client.query(
        "UPDATE bookings SET status='unvisited' WHERE session_id=$1 AND token_number=$2 AND status='confirmed'",
        [req.params.sessionId, skippedToken]
      );
    }
  });
});

// ── POST complete-skipped ─────────────────────────────────────────────────────
// Previously skipped patient returned and was seen — NOT eligible for refund
router.post("/:sessionId/complete-skipped", requireDoctorOrAdmin, async (req, res) => {
  const tokenNum = Number(req.body.tokenNum);
  await withTx(req.params.sessionId, res, async (state, client) => {
    const statuses = { ...state.tokenStatuses };
    if (statuses[tokenNum] === "unvisited") statuses[tokenNum] = "green";
    await saveState(client, req.params.sessionId, statuses, state.prioritySlots, state.currentToken, state.nextToken, state.isClosed);

    // Patient was eventually seen — mark completed, remove from refund eligibility
    await client.query(
      "UPDATE bookings SET status='completed' WHERE session_id=$1 AND token_number=$2 AND status='unvisited'",
      [req.params.sessionId, tokenNum]
    );
  });
});

// ── POST close session ────────────────────────────────────────────────────────
router.post("/:sessionId/close", requireDoctorOrAdmin, async (req, res) => {
  const sessionId = req.params.sessionId;
  const reason = String(req.body.reason || "").trim();

  // Find patients still waiting BEFORE we touch anything, so we know whether
  // a reason is actually required and who needs to be notified.
  const { rows: affected } = await pool.query(
    "SELECT * FROM bookings WHERE session_id=$1 AND status='confirmed'",
    [sessionId]
  );

  if (affected.length > 0 && !reason) {
    return res.status(400).json({
      error: "Please provide a reason for ending the session early — it will be shown to the patients who didn't get seen.",
    });
  }

  await withTx(sessionId, res, async (state, client) => {
    const statuses = { ...state.tokenStatuses };
    for (const [n, s] of Object.entries(statuses))
      if (s === "red" || s === "yellow") statuses[Number(n)] = "unvisited";

    await saveState(client, sessionId, statuses, state.prioritySlots, null, null, true);

    await client.query(
      "UPDATE bookings SET status='unvisited', close_reason=$1 WHERE session_id=$2 AND status='confirmed'",
      [reason || null, sessionId]
    );
  });

  // Notify every affected patient — paid bookings also get refunded.
  for (const b of affected) {
    if (b.payment_done === 1) {
      refundBooking(b.id).catch(() => {});
      sendPushToPatient(b.patient_id, {
        title: "Session ended early — refund on the way",
        body: `Dr. ${b.doctor_name} had to end today's session early${reason ? ` (${reason})` : ""}. Your payment will be refunded within a few days.`,
        data: { tag: "session-closed-early", bookingId: b.id },
      }).catch(() => {});
    } else {
      sendPushToPatient(b.patient_id, {
        title: "Session ended early",
        body: `Dr. ${b.doctor_name} had to end today's session early${reason ? ` (${reason})` : ""}. We're sorry for the inconvenience — please rebook for another available slot.`,
        data: { tag: "session-closed-early", bookingId: b.id },
      }).catch(() => {});
    }
  }
});

// ── POST priority-slot ────────────────────────────────────────────────────────
router.post("/:sessionId/priority-slot", requireDoctorOrAdmin, async (req, res) => {
  const { slotIndex, slot } = req.body;
  await withTx(req.params.sessionId, res, async (state, client) => {
    const slots = { ...state.prioritySlots, [slotIndex]: slot };
    await saveState(client, req.params.sessionId, state.tokenStatuses, slots, state.currentToken, state.nextToken, state.isClosed);
  });
});

// ── POST cancel-session ───────────────────────────────────────────────────────
router.post("/cancel-session", requireDoctorOrAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    const { doctorId, date, session } = req.body;
    const key = `${doctorId}_${date}_${session}`;

    try {
      await client.query("BEGIN");
      const row = await getState(SENTINEL, client);
      if (!row) {
        await client.query(
          `INSERT INTO token_states (session_id, doctor_id, date, session, cancelled_keys)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (session_id) DO NOTHING`,
          [SENTINEL, "", "", "morning", JSON.stringify([key])]
        );
      } else {
        const keys = JSON.parse(row.cancelled_keys || "[]");
        if (!keys.includes(key)) {
          keys.push(key);
          await client.query(
            "UPDATE token_states SET cancelled_keys=$1 WHERE session_id=$2",
            [JSON.stringify(keys), SENTINEL]
          );
        }
      }
      await client.query("COMMIT");
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    }

    const { rows: cancelBookings } = await pool.query(
      "SELECT id FROM bookings WHERE session_id=$1 AND status='confirmed' AND payment_done=1",
      [key]
    );
    await pool.query(
      "UPDATE bookings SET status='cancelled' WHERE session_id=$1 AND status='confirmed'",
      [key]
    );
    for (const b of cancelBookings) refundBooking(b.id).catch(() => {});
    res.json({ success: true, cancelledKey: key });
  } catch (err) {
    console.error("[tokens cancel-session]", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ── GET cancelled list ────────────────────────────────────────────────────────
router.get("/cancelled/list", async (req, res) => {
  try {
    const row = await getState(SENTINEL);
    res.json(row ? JSON.parse(row.cancelled_keys || "[]") : []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
