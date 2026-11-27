"use strict";
// Live token queue for the HOSPITAL lab (same behaviour as the separate lab's queue).
// The separate lab keeps its queue in lab_test_sessions, which is tied to labs/lab_tests
// by foreign keys, so the hospital lab gets its own table with no such keys.
// red=booked, yellow=next up, orange=now serving, green=completed, purple=skipped
const { pool } = require("../db/init");
const { broadcast } = require("./ws");
const { sendPushToPatient } = require("./push");

pool.query(`
  CREATE TABLE IF NOT EXISTS hospital_lab_sessions (
    session_id     TEXT PRIMARY KEY,
    hospital_id    TEXT NOT NULL,
    test_id        TEXT NOT NULL,
    date           TEXT NOT NULL,
    session        TEXT NOT NULL,
    token_statuses TEXT NOT NULL DEFAULT '{}',
    current_token  INTEGER,
    next_token     INTEGER,
    is_closed      INTEGER NOT NULL DEFAULT 0,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_hl_sessions_hospital ON hospital_lab_sessions(hospital_id);
`).catch((e) => console.warn("[hospital_lab_queue] migration:", e.message));

const SESSIONS = ["morning", "afternoon"];
const sidOf = (hid, tid, date, sess) => `hl:${hid}_${tid}_${date}_${sess}`;

function parse(row) {
  if (!row) return null;
  return {
    sessionId: row.session_id,
    labId: row.hospital_id,
    testId: row.test_id,
    date: row.date,
    tokenStatuses: JSON.parse(row.token_statuses || "{}"),
    currentToken: row.current_token,
    nextToken: row.next_token,
    isClosed: row.is_closed === 1,
  };
}

function pickNext(statuses, exclude) {
  const reds = Object.entries(statuses)
    .filter(([n, s]) => s === "red" && Number(n) !== exclude)
    .map(([n]) => Number(n)).sort((a, b) => a - b);
  return reds[0] ?? null;
}

function validKey(date, sess) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(date || "")) && SESSIONS.includes(sess);
}

// Create the session row if needed, lock it, and fill it from the bookings that already exist
// (only while it is still empty, so a running queue is never overwritten).
async function loadForUpdate(client, hid, tid, date, sess) {
  const sid = sidOf(hid, tid, date, sess);
  await client.query(
    `INSERT INTO hospital_lab_sessions (session_id, hospital_id, test_id, date, session)
     VALUES ($1,$2,$3,$4,$5) ON CONFLICT (session_id) DO NOTHING`,
    [sid, hid, tid, date, sess]);
  let { rows } = await client.query("SELECT * FROM hospital_lab_sessions WHERE session_id=$1 FOR UPDATE", [sid]);
  if (rows[0].token_statuses === "{}") {
    const ord = await client.query(
      `SELECT token_number, status FROM hospital_lab_orders
        WHERE hospital_id=$1 AND test_id=$2 AND slot_date=$3 AND slot_time=$4 AND token_number IS NOT NULL`,
      [hid, tid, date, sess]);
    if (ord.rows.length) {
      const statuses = {};
      for (const r of ord.rows) statuses[r.token_number] = r.status === "cancelled" ? "purple" : r.status === "report_ready" ? "green" : "red";
      ({ rows } = await client.query(
        "UPDATE hospital_lab_sessions SET token_statuses=$1 WHERE session_id=$2 RETURNING *",
        [JSON.stringify(statuses), sid]));
    }
  }
  return { sid, state: parse(rows[0]) };
}

async function inTx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally { client.release(); }
}

// Staff view: always available (created on first look)
async function getState(hid, tid, date, sess) {
  if (!validKey(date, sess)) return null;
  return inTx(async (client) => (await loadForUpdate(client, hid, tid, date, sess)).state);
}

// Patient view: only for sessions that really have bookings, so random ids cannot create rows
async function getPublicState(hid, tid, date, sess) {
  if (!validKey(date, sess)) return null;
  const sid = sidOf(hid, tid, date, sess);
  const { rows } = await pool.query("SELECT * FROM hospital_lab_sessions WHERE session_id=$1", [sid]);
  if (rows.length) return parse(rows[0]);
  const ex = await pool.query(
    "SELECT 1 FROM hospital_lab_orders WHERE hospital_id=$1 AND test_id=$2 AND slot_date=$3 AND slot_time=$4 AND token_number IS NOT NULL LIMIT 1",
    [hid, tid, date, sess]);
  if (!ex.rows.length) return null;
  return getState(hid, tid, date, sess);
}

// A patient just booked: put the new token in the queue and tell everyone watching
async function onBooked(o) {
  const out = await inTx(async (client) => {
    const { sid, state } = await loadForUpdate(client, o.hospital_id, o.test_id, o.slot_date, o.slot_time);
    if (state.tokenStatuses[o.token_number] !== undefined) return { sid, state };
    const statuses = { ...state.tokenStatuses, [o.token_number]: "red" };
    const { rows } = await client.query(
      "UPDATE hospital_lab_sessions SET token_statuses=$1, updated_at=now() WHERE session_id=$2 RETURNING *",
      [JSON.stringify(statuses), sid]);
    return { sid, state: parse(rows[0]) };
  });
  broadcast(out.sid, { type: "state_update", state: out.state });
}

// call | complete | skip. Returns the new state; pushes go to the patients concerned.
async function applyAction(hid, tid, date, sess, action, reqTok) {
  if (!validKey(date, sess)) { const e = new Error("Invalid date or session"); e.status = 400; throw e; }
  const res = await inTx(async (client) => {
    const { sid, state: s } = await loadForUpdate(client, hid, tid, date, sess);
    const statuses = { ...s.tokenStatuses };
    let current = s.currentToken, next = s.nextToken;
    let calledToken = null, readyNextToken = null;

    if (action === "call") {
      const clicked = reqTok ?? next ?? pickNext(statuses, null);
      if (!Number.isInteger(clicked) || statuses[clicked] === undefined) { const e = new Error("No valid token to call"); e.status = 400; throw e; }
      if (current !== null && current !== clicked) statuses[current] = "green";
      statuses[clicked] = "orange";
      current = clicked;
      if (next !== null && statuses[next] === "yellow") statuses[next] = "red";
      next = pickNext(statuses, clicked);
      if (next !== null) statuses[next] = "yellow";
      calledToken = clicked;
      readyNextToken = next;
    } else if (action === "complete") {
      if (current !== null) statuses[current] = "green";
      current = null;
      if (next === null) {
        next = pickNext(statuses, null);
        if (next !== null) statuses[next] = "yellow";
      }
    } else {
      const tok = reqTok ?? current;
      if (!Number.isInteger(tok) || statuses[tok] === undefined) { const e = new Error("No valid token to skip"); e.status = 400; throw e; }
      statuses[tok] = "purple";
      if (tok === current) current = null;
      if (tok === next) next = null;
      if (next === null) {
        next = pickNext(statuses, null);
        if (next !== null) statuses[next] = "yellow";
      }
    }
    const { rows } = await client.query(
      "UPDATE hospital_lab_sessions SET token_statuses=$1, current_token=$2, next_token=$3, updated_at=now() WHERE session_id=$4 RETURNING *",
      [JSON.stringify(statuses), current, next, sid]);
    return { sid, state: parse(rows[0]), calledToken, readyNextToken };
  });
  broadcast(res.sid, { type: "state_update", state: res.state });

  if (res.calledToken !== null || res.readyNextToken !== null) {
    pushQueue(hid, tid, date, sess, res.calledToken, res.readyNextToken).catch((e) => console.error("[hospital_lab_queue] push error:", e.message));
  }
  return res.state;
}

async function patientIdOf(o) {
  if (o.patient_id) return o.patient_id;
  if (o.inward_id) {
    const { rows } = await pool.query("SELECT patient_user_id FROM inward_patients WHERE id=$1", [o.inward_id]);
    return (rows[0] && rows[0].patient_user_id) || null;
  }
  return null;
}

async function hospitalName(hid) {
  const { rows } = await pool.query("SELECT name FROM hospitals WHERE id=$1", [hid]);
  return (rows[0] && rows[0].name) || "the hospital lab";
}

async function orderForToken(hid, tid, date, sess, token) {
  const { rows } = await pool.query(
    `SELECT id, patient_id, inward_id, test_name FROM hospital_lab_orders
      WHERE hospital_id=$1 AND test_id=$2 AND slot_date=$3 AND slot_time=$4 AND token_number=$5 AND status <> 'cancelled' LIMIT 1`,
    [hid, tid, date, sess, token]);
  return rows[0] || null;
}

async function pushQueue(hid, tid, date, sess, calledToken, readyNextToken) {
  const name = await hospitalName(hid);
  if (calledToken !== null) {
    const o = await orderForToken(hid, tid, date, sess, calledToken);
    const pid = o && await patientIdOf(o);
    if (pid) {
      await sendPushToPatient(pid, {
        title: "Your turn has arrived!",
        body: `Token #${calledToken} - ${name} lab is ready for your ${o.test_name} sample collection.`,
        data: { link: `/labs/track?bookingId=${o.id}`, tag: "lab-token-orange" },
      });
    }
  }
  if (readyNextToken !== null) {
    const o = await orderForToken(hid, tid, date, sess, readyNextToken);
    const pid = o && await patientIdOf(o);
    if (pid) {
      await sendPushToPatient(pid, {
        title: "Get Ready!",
        body: `Token #${readyNextToken} - You are next at the ${name} lab. Please be ready.`,
        data: { link: `/labs/track?bookingId=${o.id}`, tag: "lab-token-yellow" },
      });
    }
  }
}

// A cancelled booking drops out of the live queue
async function releaseCancelled(o) {
  if (o.token_number == null || !o.slot_date || !o.slot_time || !o.test_id) return;
  const out = await inTx(async (client) => {
    const { sid, state: s } = await loadForUpdate(client, o.hospital_id, o.test_id, o.slot_date, o.slot_time);
    const tok = o.token_number;
    if (!["red", "yellow", "orange"].includes(s.tokenStatuses[tok])) return null;
    const statuses = { ...s.tokenStatuses, [tok]: "purple" };
    const current = s.currentToken === tok ? null : s.currentToken;
    let next = s.nextToken;
    if (next === tok) {
      next = pickNext(statuses, null);
      if (next !== null) statuses[next] = "yellow";
    }
    const { rows } = await client.query(
      "UPDATE hospital_lab_sessions SET token_statuses=$1, current_token=$2, next_token=$3, updated_at=now() WHERE session_id=$4 RETURNING *",
      [JSON.stringify(statuses), current, next, sid]);
    return { sid, state: parse(rows[0]) };
  });
  if (out) broadcast(out.sid, { type: "state_update", state: out.state });
}

const STATUS_PUSH = {
  sample_collected: (t, h) => ({ title: "Sample Collected", body: `Your sample for ${t} has been collected at ${h}.` }),
  processing: (t, h) => ({ title: "Processing", body: `Your ${t} sample is being processed at ${h}.` }),
  report_ready: (t, h) => ({ title: "Report Ready", body: `Your ${t} report from ${h} is ready to view.` }),
  cancelled: (t, h) => ({ title: "Booking Cancelled", body: `Your ${t} booking at ${h} was cancelled.` }),
};

// Call after a lab order's status really changed (not when only the result text was edited)
async function onStatusChanged(order) {
  try {
    if (order.status === "cancelled") await releaseCancelled(order);
  } catch (e) { console.error("[hospital_lab_queue] cancel cleanup:", e.message); }
  try {
    const build = STATUS_PUSH[order.status];
    if (!build) return;
    const pid = await patientIdOf(order);
    if (!pid) return;
    const msg = build(order.test_name || "your test", await hospitalName(order.hospital_id));
    await sendPushToPatient(pid, { ...msg, data: { link: `/labs/track?bookingId=${order.id}`, tag: `lab-${order.status}` } });
  } catch (e) { console.error("[hospital_lab_queue] status push:", e.message); }
}

module.exports = { sidOf, getState, getPublicState, onBooked, applyAction, onStatusChanged };
