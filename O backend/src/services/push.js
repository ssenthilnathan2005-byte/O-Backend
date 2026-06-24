"use strict";
/**
 * push.js — Firebase Cloud Messaging (web push) service
 *
 * Mirrors the dev/prod fallback pattern used in whatsapp.js:
 *  - If Firebase credentials aren't set, logs to console instead of sending
 *    (so local dev / Codespaces never crashes without secrets).
 *  - If a target token is invalid/expired, FCM returns a specific error code;
 *    we catch that and clean the dead token out of the DB automatically.
 */

const db = require("../db/init");

let admin = null;
let messaging = null;
const IS_DEV = !process.env.FIREBASE_SERVICE_ACCOUNT;

if (!IS_DEV) {
  try {
    admin = require("firebase-admin");
    if (!admin.apps.length) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
    }
    messaging = admin.messaging();
    console.log("✅  Firebase Admin initialized — push notifications ENABLED");
  } catch (err) {
    console.error("[push] Failed to initialize Firebase Admin:", err.message);
    messaging = null;
  }
} else {
  console.warn("[push] FIREBASE_SERVICE_ACCOUNT not set — push notifications DEV mode (console only)");
}

/** Remove a dead/invalid token from the DB so we stop retrying it. */
function removeDeadToken(token) {
  try {
    db.prepare("DELETE FROM fcm_tokens WHERE token=?").run(token);
    console.log(`[push] Removed dead token: ${token.slice(0, 20)}...`);
  } catch (_) {}
}

/**
 * Send a push notification to every device registered for a patient.
 * Silently no-ops (and logs) if the patient has no registered devices,
 * or if Firebase isn't configured (dev mode).
 *
 * @param {string} patientId
 * @param {{ title: string, body: string, data?: Record<string,string> }} payload
 */
async function sendPushToPatient(patientId, { title, body, data = {} }) {
  if (!patientId) return;

  let rows;
  try {
    rows = db.prepare("SELECT token FROM fcm_tokens WHERE patient_id=?").all(patientId);
  } catch (err) {
    console.error("[push] DB read error:", err.message);
    return;
  }

  if (!rows.length) {
    if (IS_DEV) console.log(`\n🔔 [Push/DEV] To patient ${patientId} (no device tokens): ${title} — ${body}\n`);
    return;
  }

  if (IS_DEV || !messaging) {
    console.log(`\n🔔 [Push/DEV] To patient ${patientId} (${rows.length} device(s)): ${title} — ${body}\n`, data);
    return;
  }

  const tokens = rows.map(r => r.token);

  // Stringify all data values — FCM data payloads must be string-only.
  const stringData = {};
  for (const [k, v] of Object.entries(data)) stringData[k] = String(v);

  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      webpush: {
        notification: {
          icon: "/assets/Logo.jpg",
          badge: "/assets/Logo.jpg",
        },
        fcmOptions: {
          link: data.link || "/",
        },
      },
      data: stringData,
    });

    response.responses.forEach((r, i) => {
      if (!r.success) {
        const code = r.error?.code || "";
        console.error(`[push] Failed for token ${tokens[i].slice(0, 20)}...: ${r.error?.message}`);
        if (
          code === "messaging/invalid-registration-token" ||
          code === "messaging/registration-token-not-registered"
        ) {
          removeDeadToken(tokens[i]);
        }
      }
    });

    console.log(`[push] Sent "${title}" to ${response.successCount}/${tokens.length} device(s) for patient ${patientId}`);
  } catch (err) {
    console.error(`[push] Send error for patient ${patientId}:`, err.message);
  }
}

module.exports = { sendPushToPatient };
