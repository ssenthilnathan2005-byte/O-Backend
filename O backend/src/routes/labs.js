"use strict";
const express = require("express");
const jwt     = require("jsonwebtoken");
const { randomBytes } = require("crypto");
const router  = express.Router();
const { pool } = require("../db/init");
const { requireAuth, requireAdminOrHospitalAdmin, requireAdmin } = require("../middleware/auth");
const { broadcast } = require("../services/ws");
const { sendPushToPatient } = require("../services/push");

function requireLabOrAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role === "admin" || req.user.role === "lab_admin") return next();
    return res.status(403).json({ error: "Lab admin access required" });
  });
}

// Returns null (clear), "lat, lng" (valid) or false (invalid)
function cleanMapLocation(v) {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  if (!t) return null;
  const m = t.match(/^(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)$/);
  if (!m) return false;
  const lat = parseFloat(m[1]), lng = parseFloat(m[2]);
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
  return lat + ", " + lng;
}

function nanoid(n = 10) { return randomBytes(n).toString("hex").slice(0, n); }
const JWT_SECRET = process.env.JWT_SECRET || "fallback_dev_secret";

// ── Lab self-management: tests & pricing ───────────────────────────────────

// GET /api/labs/me/tests — logged-in lab's own test offerings
// ── Lab settings: home collection ──────────────────────────────────────────
router.get("/me/settings", requireLabOrAdmin, async (req, res) => {
  try {
    if (!req.user.labId) return res.status(400).json({ error: "Lab account required" });
    const { rows } = await pool.query("SELECT home_collection, home_collection_fee FROM labs WHERE id=$1", [req.user.labId]);
    if (!rows.length) return res.status(404).json({ error: "Lab not found" });
    res.json({ homeCollection: rows[0].home_collection, homeCollectionFee: Number(rows[0].home_collection_fee) });
  } catch (err) {
    console.error("[labs] GET me/settings error:", err.message);
    res.status(500).json({ error: "Failed to load settings" });
  }
});

router.patch("/me/settings", requireLabOrAdmin, async (req, res) => {
  try {
    if (!req.user.labId) return res.status(400).json({ error: "Lab account required" });
    const { homeCollection, homeCollectionFee } = req.body;
    const fee = homeCollectionFee === undefined ? undefined : Number(homeCollectionFee);
    if (fee !== undefined && (!Number.isFinite(fee) || fee < 0)) {
      return res.status(400).json({ error: "Invalid home collection fee" });
    }
    const sets = []; const params = [];
    if (homeCollection !== undefined) { params.push(!!homeCollection); sets.push("home_collection=$" + params.length); }
    if (fee !== undefined)            { params.push(fee);              sets.push("home_collection_fee=$" + params.length); }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });
    params.push(req.user.labId);
    const { rows } = await pool.query(
      "UPDATE labs SET " + sets.join(", ") + " WHERE id=$" + params.length + " RETURNING home_collection, home_collection_fee",
      params
    );
    if (!rows.length) return res.status(404).json({ error: "Lab not found" });
    res.json({ homeCollection: rows[0].home_collection, homeCollectionFee: Number(rows[0].home_collection_fee) });
  } catch (err) {
    console.error("[labs] PATCH me/settings error:", err.message);
    res.status(500).json({ error: "Failed to update settings" });
  }
});

router.get("/me/tests", requireLabOrAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.category, t.sample_type, t.report_hours, t.description, o.price, o.is_active
       FROM lab_test_offerings o JOIN lab_tests t ON t.id = o.test_id
       WHERE o.lab_id = $1 ORDER BY t.name`,
      [req.user.labId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch your tests" });
  }
});

// POST /api/labs/me/tests — add/attach a test with pricing (creates test if new)
router.post("/me/tests", requireLabOrAdmin, async (req, res) => {
  try {
    const { testName, category, sampleType, reportHours, description, price } = req.body;
    if (!testName || price === undefined) return res.status(400).json({ error: "testName and price are required" });

    let testId;
    const { rows: existing } = await pool.query("SELECT id FROM lab_tests WHERE name=$1", [testName.trim()]);
    if (existing.length) {
      testId = existing[0].id;
    } else {
      testId = `test_${nanoid(10)}`;
      await pool.query(
        `INSERT INTO lab_tests (id, name, category, sample_type, report_hours, description)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [testId, testName.trim(), category || "general", sampleType || "blood", reportHours || 24, description || null]
      );
    }

    const offeringId = `off_${nanoid(10)}`;
    await pool.query(
      `INSERT INTO lab_test_offerings (id, lab_id, test_id, price) VALUES ($1,$2,$3,$4)
       ON CONFLICT (lab_id, test_id) DO UPDATE SET price=EXCLUDED.price, is_active=TRUE`,
      [offeringId, req.user.labId, testId, price]
    );

    res.status(201).json({ success: true, testId });
  } catch (err) {
    console.error("[labs] me/tests POST error:", err.message);
    res.status(500).json({ error: "Failed to add test" });
  }
});

// PATCH /api/labs/me/tests/:testId — update price or active status for own offering
router.patch("/me/tests/:testId", requireLabOrAdmin, async (req, res) => {
  try {
    const { price, isActive } = req.body;
    const sets = []; const params = [];
    if (price !== undefined)    { params.push(price);    sets.push(`price=$${params.length}`); }
    if (isActive !== undefined) { params.push(isActive); sets.push(`is_active=$${params.length}`); }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });

    params.push(req.user.labId, req.params.testId);
    const { rows } = await pool.query(
      `UPDATE lab_test_offerings SET ${sets.join(", ")} WHERE lab_id=$${params.length - 1} AND test_id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: "Offering not found" });
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: "Failed to update test" });
  }
});

// GET /api/labs/me/bookings — logged-in lab's own bookings
router.get("/me/bookings", requireLabOrAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*, t.name AS test_name FROM lab_bookings b JOIN lab_tests t ON t.id = b.test_id
       WHERE b.lab_id=$1 ORDER BY b.created_at DESC`,
      [req.user.labId]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch bookings" });
  }
});

// ── GET /api/labs — search/list labs (public) ──────────────────────────────
router.get("/", async (req, res) => {
  try {
    const { area, q } = req.query;
    let query  = "SELECT * FROM labs WHERE is_active = TRUE";
    const params = [];
    if (area) { params.push(`%${area}%`); query += ` AND area ILIKE $${params.length}`; }
    if (q)    { params.push(`%${q}%`);    query += ` AND name ILIKE $${params.length}`; }
    query += " ORDER BY rating DESC";
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("[labs] GET error:", err.message);
    res.status(500).json({ error: "Failed to fetch labs" });
  }
});

router.get("/tests/catalog", async (req, res) => {
  try {
    const { q } = req.query;
    let query  = "SELECT * FROM lab_tests";
    const params = [];
    if (q) { params.push(`%${q}%`); query += ` WHERE name ILIKE $${params.length}`; }
    query += " ORDER BY name";
    const { rows } = await pool.query(query, params);
    res.json(rows);
  } catch (err) {
    console.error("[labs] GET tests/catalog error:", err.message);
    res.status(500).json({ error: "Failed to fetch test catalog" });
  }
});

// ── POST /api/labs/bookings — book a lab test (guest allowed) ─────────────
router.post("/bookings", async (req, res) => {
  try {
    const {
      patientName, phone, labId, testId, slotDate, slotTime,
      collectionType = "home", address, notes,
    } = req.body;

    if (!patientName || !phone || !labId || !testId || !slotDate || !slotTime) {
      return res.status(400).json({ error: "patientName, phone, labId, testId, slotDate and slotTime are required" });
    }
    if (!["morning", "afternoon"].includes(slotTime)) {
      return res.status(400).json({ error: "slotTime must be morning or afternoon" });
    }
    if (collectionType === "home" && !address) {
      return res.status(400).json({ error: "address is required for home collection" });
    }

    const priceRes = await pool.query(
      "SELECT price FROM lab_test_offerings WHERE lab_id=$1 AND test_id=$2 AND is_active=TRUE",
      [labId, testId]
    );
    if (!priceRes.rows.length) return res.status(400).json({ error: "This test is not offered by the selected lab" });
    const basePrice = priceRes.rows[0].price;
    const { rows: labRows } = await pool.query(
      "SELECT home_collection, home_collection_fee FROM labs WHERE id=$1 AND is_active=TRUE", [labId]
    );
    if (!labRows.length) return res.status(400).json({ error: "Lab not found" });
    if (collectionType === "home" && !labRows[0].home_collection) {
      return res.status(400).json({ error: "This lab does not offer home collection" });
    }
    const price = collectionType === "home"
      ? Number(basePrice) + Number(labRows[0].home_collection_fee || 0)
      : basePrice;

    let patientId = null;
    const authHeader = req.headers.authorization || "";
    if (authHeader.startsWith("Bearer ")) {
      try {
        const decoded = jwt.verify(authHeader.slice(7).trim(), JWT_SECRET);
        patientId = decoded.id || null;
      } catch {}
    }

    const id = `lab_${nanoid(10)}`;
    const sessionId = `${labId}_${testId}_${slotDate}_${slotTime}`;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [sessionId]);
      const { rows: tk } = await client.query(
        "SELECT COALESCE(MAX(token_number),0)+1 AS n FROM lab_bookings WHERE lab_id=$1 AND test_id=$2 AND slot_date=$3 AND slot_time=$4",
        [labId, testId, slotDate, slotTime]
      );
      const tokenNumber = tk[0].n;
      await client.query(
        `INSERT INTO lab_bookings
          (id, patient_id, patient_name, phone, lab_id, test_id, slot_date, slot_time, collection_type, address, price, notes, token_number)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, patientId, patientName, phone, labId, testId, slotDate, slotTime, collectionType, address || null, price, notes || null, tokenNumber]
      );
      await client.query(
        "INSERT INTO lab_test_sessions (session_id, lab_id, test_id, date) VALUES ($1,$2,$3,$4) ON CONFLICT (session_id) DO NOTHING",
        [sessionId, labId, testId, slotDate]
      );
      const { rows: st } = await client.query("SELECT token_statuses FROM lab_test_sessions WHERE session_id=$1 FOR UPDATE", [sessionId]);
      const statuses = JSON.parse(st[0].token_statuses || "{}");
      statuses[tokenNumber] = "red";
      await client.query("UPDATE lab_test_sessions SET token_statuses=$1, updated_at=now() WHERE session_id=$2", [JSON.stringify(statuses), sessionId]);
      await client.query("COMMIT");
    } catch (e) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw e;
    } finally {
      client.release();
    }
    try {
      const { rows: sr } = await pool.query("SELECT * FROM lab_test_sessions WHERE session_id=$1", [sessionId]);
      if (sr[0]) broadcast(sessionId, { type: "state_update", state: parseLabSession(sr[0]) });
    } catch (_) {}

    const { rows } = await pool.query("SELECT * FROM lab_bookings WHERE id=$1", [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("[labs] POST bookings error:", err.message);
    res.status(500).json({ error: "Failed to book lab test" });
  }
});

// ── GET /api/labs/bookings/my — logged-in patient's own bookings ──────────
router.get("/bookings/my", requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*, l.name AS lab_name, l.area AS lab_area, t.name AS test_name
       FROM lab_bookings b
       JOIN labs l ON l.id = b.lab_id
       JOIN lab_tests t ON t.id = b.test_id
       WHERE b.patient_id=$1 ORDER BY b.created_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[labs] GET bookings/my error:", err.message);
    res.status(500).json({ error: "Failed to fetch your lab bookings" });
  }
});

// ── GET /api/labs/bookings — admin/hospital_admin list all ────────────────
router.get("/bookings", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT b.*, l.name AS lab_name, t.name AS test_name
       FROM lab_bookings b
       JOIN labs l ON l.id = b.lab_id
       JOIN lab_tests t ON t.id = b.test_id
       ORDER BY b.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    console.error("[labs] GET bookings error:", err.message);
    res.status(500).json({ error: "Failed to fetch lab bookings" });
  }
});

// ── PATCH /api/labs/bookings/:id/status — admin updates status (live tracking) ──
const STATUS_FLOW = ["booked", "technician_assigned", "sample_collected", "processing", "report_ready"];

// Allowed next statuses: one step forward (walk-in skips technician_assigned),
// cancel only before the sample is collected. report_ready / cancelled are final.
function allowedNextStatuses(collectionType, status) {
  const i = STATUS_FLOW.indexOf(status);
  if (i === -1 || status === "report_ready") return [];
  let next = STATUS_FLOW[i + 1];
  if (next === "technician_assigned" && collectionType !== "home") next = STATUS_FLOW[i + 2];
  const out = [next];
  if (i <= 1) out.push("cancelled");
  return out;
}

// When a booking is cancelled, drop its token from the live queue.
async function releaseCancelledToken(b) {
  const sid = sidOf(b.lab_id, b.test_id, b.slot_date, b.slot_time);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM lab_test_sessions WHERE session_id=$1 FOR UPDATE", [sid]);
    if (!rows.length) { await client.query("ROLLBACK"); return; }
    const s = parseLabSession(rows[0]);
    const tok = b.token_number;
    if (!["red", "yellow", "orange"].includes(s.tokenStatuses[tok])) { await client.query("ROLLBACK"); return; }
    const statuses = { ...s.tokenStatuses, [tok]: "purple" };
    const current = s.currentToken === tok ? null : s.currentToken;
    let next = s.nextToken;
    if (next === tok) {
      next = pickNext(statuses, null);
      if (next !== null) statuses[next] = "yellow";
    }
    const { rows: up } = await client.query(
      "UPDATE lab_test_sessions SET token_statuses=$1, current_token=$2, next_token=$3, updated_at=now() WHERE session_id=$4 RETURNING *",
      [JSON.stringify(statuses), current, next, sid]
    );
    await client.query("COMMIT");
    broadcast(sid, { type: "state_update", state: parseLabSession(up[0]) });
  } catch (e) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

router.patch("/bookings/:id/status", requireLabOrAdmin, async (req, res) => {
  try {
    const { status, reportUrl, notes } = req.body;
    const validStatuses = ["booked", "technician_assigned", "sample_collected", "processing", "report_ready", "cancelled"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: "Invalid status" });
    }

    if (req.user.role === "lab_admin") {
      const { rows: cur } = await pool.query("SELECT lab_id, status, collection_type FROM lab_bookings WHERE id=$1", [req.params.id]);
      if (!cur.length) return res.status(404).json({ error: "Booking not found" });
      if (cur[0].lab_id !== req.user.labId) {
        return res.status(403).json({ error: "You can only update bookings for your own lab" });
      }
      if (status !== cur[0].status) {
        const allowed = allowedNextStatuses(cur[0].collection_type, cur[0].status);
        if (!allowed.includes(status)) {
          return res.status(400).json({
            error: allowed.length
              ? "Cannot move from " + cur[0].status + " to " + status
              : "This booking is " + cur[0].status + " and can no longer be changed",
          });
        }
      }
    }

    const sets   = ["status=$1", "updated_at=now()"];
    const params = [status];
    if (reportUrl !== undefined) { sets.push(`report_url=$${params.length + 1}`); params.push(reportUrl); }
    if (notes !== undefined)     { sets.push(`notes=$${params.length + 1}`);      params.push(notes); }

    params.push(req.params.id);
    const { rows } = await pool.query(
      `UPDATE lab_bookings SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`,
      params
    );
    if (!rows.length) return res.status(404).json({ error: "Booking not found" });
    const updated = rows[0];
    if (status === "cancelled" && updated.token_number != null) {
      try { await releaseCancelledToken(updated); } catch (e) { console.error("[labs] cancel queue cleanup error:", e.message); }
    }

    if (status === "report_ready" && updated.patient_id) {
      try {
        const { rows: info } = await pool.query(
          `SELECT l.name AS lab_name, t.name AS test_name
           FROM lab_bookings b
           JOIN labs l ON l.id = b.lab_id
           JOIN lab_tests t ON t.id = b.test_id
           WHERE b.id = $1`,
          [updated.id]
        );
        const labName = info[0]?.lab_name || "the lab";
        const testName = info[0]?.test_name || "Your test";
        await sendPushToPatient(updated.patient_id, {
          title: "Report Ready",
          body: `${testName} report from ${labName} is ready to view.`,
          data: { link: `/labs/track?bookingId=${updated.id}` },
        });
      } catch (e) {
        console.error("[labs] report_ready push notification error:", e.message);
      }
    }

    res.json(updated);
  } catch (err) {
    console.error("[labs] PATCH bookings/:id/status error:", err.message);
    res.status(500).json({ error: "Failed to update status" });
  }
});

// ── Lab token queue (mirrors doctor token_states) ───────────────────────────
// red=booked, yellow=next up, orange=now serving, green=completed, purple=skipped
const sidOf = (labId, testId, date, session) => `${labId}_${testId}_${date}_${session}`;

function parseLabSession(row) {
  if (!row) return null;
  return {
    sessionId:     row.session_id,
    labId:         row.lab_id,
    testId:        row.test_id,
    date:          row.date,
    tokenStatuses: JSON.parse(row.token_statuses || "{}"),
    currentToken:  row.current_token,
    nextToken:     row.next_token,
    isClosed:      row.is_closed === 1,
  };
}

function pickNext(statuses, exclude) {
  const reds = Object.entries(statuses)
    .filter(([n, s]) => s === "red" && Number(n) !== exclude)
    .map(([n]) => Number(n)).sort((a, b) => a - b);
  return reds[0] ?? null;
}

// GET /api/labs/sessions/:labId/:testId/:date — public queue state
router.get("/sessions/:labId/:testId/:date/:session", async (req, res) => {
  try {
    const { labId, testId, date, session } = req.params;
    const { rows } = await pool.query("SELECT * FROM lab_test_sessions WHERE session_id=$1", [sidOf(labId, testId, date, session)]);
    res.json(parseLabSession(rows[0]));
  } catch (err) {
    console.error("[labs] GET session error:", err.message);
    res.status(500).json({ error: "Failed to load session" });
  }
});

// POST /api/labs/sessions/:labId/:testId/:date/:action  (call | complete | skip)
router.post("/sessions/:labId/:testId/:date/:session/:action", requireLabOrAdmin, async (req, res) => {
  const { labId, testId, date, session, action } = req.params;
  if (!["call", "complete", "skip"].includes(action)) return res.status(400).json({ error: "Invalid action" });
  if (req.user.role === "lab_admin" && req.user.labId !== labId) {
    return res.status(403).json({ error: "You can only manage your own lab" });
  }
  const sid = sidOf(labId, testId, date, session);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT * FROM lab_test_sessions WHERE session_id=$1 FOR UPDATE", [sid]);
    if (!rows.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Session not found" }); }

    const s = parseLabSession(rows[0]);
    const statuses = { ...s.tokenStatuses };
    let current = s.currentToken, next = s.nextToken;
    const reqTok = req.body && req.body.token !== undefined && req.body.token !== null ? Number(req.body.token) : null;

    let calledToken = null;
    let readyNextToken = null;

    if (action === "call") {
      const clicked = reqTok ?? next ?? pickNext(statuses, null);
      if (!Number.isInteger(clicked) || statuses[clicked] === undefined) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "No valid token to call" });
      }
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
      if (!Number.isInteger(tok) || statuses[tok] === undefined) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "No valid token to skip" });
      }
      statuses[tok] = "purple";
      if (tok === current) current = null;
      if (tok === next) next = null;
      if (next === null) {
        next = pickNext(statuses, null);
        if (next !== null) statuses[next] = "yellow";
      }
    }

    const { rows: up } = await client.query(
      "UPDATE lab_test_sessions SET token_statuses=$1, current_token=$2, next_token=$3, updated_at=now() WHERE session_id=$4 RETURNING *",
      [JSON.stringify(statuses), current, next, sid]
    );
    await client.query("COMMIT");
    const state = parseLabSession(up[0]);
    broadcast(sid, { type: "state_update", state });
    res.json(state);

    if (calledToken !== null || readyNextToken !== null) {
      (async () => {
        try {
          const { rows: labRows } = await pool.query(
            `SELECT l.name AS lab_name, t.name AS test_name FROM labs l, lab_tests t WHERE l.id=$1 AND t.id=$2`,
            [labId, testId]
          );
          const labName = labRows[0]?.lab_name || "the lab";
          const testName = labRows[0]?.test_name || "your test";

          if (calledToken !== null) {
            const { rows: br } = await pool.query(
              `SELECT patient_id FROM lab_bookings
               WHERE lab_id=$1 AND test_id=$2 AND slot_date=$3 AND slot_time=$4
                 AND token_number=$5 AND status NOT IN ('cancelled') LIMIT 1`,
              [labId, testId, date, session, calledToken]
            );
            const b = br[0];
            if (b && b.patient_id) {
              sendPushToPatient(b.patient_id, {
                title: "Your turn has arrived!",
                body: `Token #${calledToken} - ${labName} is ready for your ${testName} sample collection.`,
                data: { tag: "lab-token-orange" },
              }).catch(() => {});
            }
          }

          if (readyNextToken !== null) {
            const { rows: nr } = await pool.query(
              `SELECT patient_id FROM lab_bookings
               WHERE lab_id=$1 AND test_id=$2 AND slot_date=$3 AND slot_time=$4
                 AND token_number=$5 AND status NOT IN ('cancelled') LIMIT 1`,
              [labId, testId, date, session, readyNextToken]
            );
            const nb = nr[0];
            if (nb && nb.patient_id) {
              sendPushToPatient(nb.patient_id, {
                title: "Get Ready!",
                body: `Token #${readyNextToken} - You are next at ${labName}. Please be ready.`,
                data: { tag: "lab-token-yellow" },
              }).catch(() => {});
            }
          }
        } catch (e) {
          console.error("[labs] queue notification error:", e.message);
        }
      })();
    }
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    console.error("[labs] session action error:", err.message);
    res.status(500).json({ error: "Failed to update queue" });
  } finally {
    client.release();
  }
});

// ── GET /api/labs/:id — lab detail ──────────────────────────────────────────
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM labs WHERE id=$1", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Lab not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[labs] GET :id error:", err.message);
    res.status(500).json({ error: "Failed to fetch lab" });
  }
});

// ── GET /api/labs/:id/tests — tests offered by this lab, with pricing ──────
router.get("/:id/tests", async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT t.id, t.name, t.category, t.sample_type, t.report_hours, t.description, o.price
       FROM lab_test_offerings o
       JOIN lab_tests t ON t.id = o.test_id
       WHERE o.lab_id = $1 AND o.is_active = TRUE
       ORDER BY t.name`,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error("[labs] GET :id/tests error:", err.message);
    res.status(500).json({ error: "Failed to fetch lab tests" });
  }
});

// ── GET /api/labs/tests/catalog — full test catalog (search by name) ──────
// ── POST /api/labs — create a lab (super admin only) ──────────────────────
router.post("/", requireAdmin, async (req, res) => {
  try {
    const { name, area, address, phone, rating, mapLocation } = req.body;
    if (!name || !area) return res.status(400).json({ error: "name and area are required" });
    const mapLoc = cleanMapLocation(mapLocation);
    if (mapLoc === false) return res.status(400).json({ error: "mapLocation must be coordinates like 9.5104, 77.6294" });

    const id = `lab_${nanoid(10)}`;
    await pool.query(
      `INSERT INTO labs (id, name, area, address, phone, rating, map_location) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, name, area, address || null, phone || null, rating ?? 4.5, mapLoc]
    );
    const { rows } = await pool.query("SELECT * FROM labs WHERE id=$1", [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error("[labs] POST error:", err.message);
    res.status(500).json({ error: "Failed to create lab" });
  }
});

// ── PATCH /api/labs/:id — update lab details (admin or the lab itself) ────
router.patch("/:id", requireLabOrAdmin, async (req, res) => {
  try {
    if (req.user.role === "lab_admin" && req.user.labId !== req.params.id) {
      return res.status(403).json({ error: "You can only update your own lab" });
    }
    const { name, area, address, phone, rating, isActive, mapLocation } = req.body;
    const sets = []; const params = [];
    if (name !== undefined)     { params.push(name);     sets.push(`name=$${params.length}`); }
    if (area !== undefined)     { params.push(area);     sets.push(`area=$${params.length}`); }
    if (address !== undefined)  { params.push(address);  sets.push(`address=$${params.length}`); }
    if (phone !== undefined)    { params.push(phone);    sets.push(`phone=$${params.length}`); }
    if (rating !== undefined)   { params.push(rating);   sets.push(`rating=$${params.length}`); }
    if (isActive !== undefined) { params.push(isActive); sets.push(`is_active=$${params.length}`); }
    if (mapLocation !== undefined) {
      const ml = cleanMapLocation(mapLocation);
      if (ml === false) return res.status(400).json({ error: "mapLocation must be coordinates like 9.5104, 77.6294" });
      params.push(ml); sets.push("map_location=$" + params.length);
    }
    if (!sets.length) return res.status(400).json({ error: "No fields to update" });

    params.push(req.params.id);
    const { rows } = await pool.query(`UPDATE labs SET ${sets.join(", ")} WHERE id=$${params.length} RETURNING *`, params);
    if (!rows.length) return res.status(404).json({ error: "Lab not found" });
    res.json(rows[0]);
  } catch (err) {
    console.error("[labs] PATCH error:", err.message);
    res.status(500).json({ error: "Failed to update lab" });
  }
});

// ── GET /api/labs/:id/admin-info — lab login info (super admin only) ──────
router.get("/:id/admin-info", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT l.login_id, l.admin_user_id, u.first_login
       FROM labs l LEFT JOIN users u ON u.id = l.admin_user_id
       WHERE l.id=$1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Lab not found" });
    const r = rows[0];
    res.json({
      loginId: r.login_id || null,
      hasAdminAccount: !!r.admin_user_id,
      firstLogin: r.first_login === 1,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/labs/:id/reset-login — reset/create lab credentials (super admin only) ──
router.post("/:id/reset-login", requireAdmin, async (req, res) => {
  try {
    const { rows: labRows } = await pool.query("SELECT * FROM labs WHERE id=$1", [req.params.id]);
    const lab = labRows[0];
    if (!lab) return res.status(404).json({ error: "Lab not found" });

    const { newLoginId } = req.body;
    if (newLoginId) {
      const trimmed = String(newLoginId).trim();
      const { rows: dup } = await pool.query("SELECT id FROM labs WHERE login_id=$1 AND id<>$2", [trimmed, lab.id]);
      if (dup[0]) return res.status(409).json({ error: "Login ID already taken" });
      await pool.query("UPDATE labs SET login_id=$1 WHERE id=$2", [trimmed, lab.id]);
    }

    if (!lab.admin_user_id) {
      const adminUserId = `la_${Date.now()}`;
      await pool.query(
        "INSERT INTO users (id, name, password, role, first_login) VALUES ($1,$2,$3,'lab_admin',1)",
        [adminUserId, `${lab.name} Admin`, ""]
      );
      await pool.query("UPDATE labs SET admin_user_id=$1 WHERE id=$2", [adminUserId, lab.id]);
    } else {
      await pool.query("UPDATE users SET password='', first_login=1 WHERE id=$1", [lab.admin_user_id]);
    }

    const { rows } = await pool.query("SELECT login_id, admin_user_id FROM labs WHERE id=$1", [lab.id]);
    res.json({ loginId: rows[0].login_id, hasAdminAccount: !!rows[0].admin_user_id });
  } catch (err) {
    console.error("[labs] reset-login error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
