"use strict";
const { pool } = require("../db/init");
let messaging = null;
const IS_DEV = !process.env.FIREBASE_SERVICE_ACCOUNT;
if (!IS_DEV) {
  try {
    const { initializeApp, cert, getApps } = require("firebase-admin/app");
    const { getMessaging } = require("firebase-admin/messaging");
    if (getApps().length === 0) {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
      }
      initializeApp({ credential: cert(serviceAccount) });
    }
    messaging = getMessaging();
    console.log("Firebase Admin initialized - push notifications ENABLED");
  } catch (err) {
    console.error("[push] Failed to initialize Firebase Admin:", err.message);
    messaging = null;
  }
} else {
  console.warn("[push] FIREBASE_SERVICE_ACCOUNT not set - DEV mode");
}
async function removeDeadToken(token) {
  try {
    await pool.query("DELETE FROM fcm_tokens WHERE token=$1", [token]);
  } catch (_) {}
}
async function sendPushToPatient(patientId, { title, body, data = {} }) {
  if (!patientId) return;
  let rows;
  try {
    ({ rows } = await pool.query("SELECT token FROM fcm_tokens WHERE patient_id=$1", [patientId]));
  } catch (err) {
    console.error("[push] DB read error:", err.message);
    return;
  }
  if (!rows.length) return;
  if (IS_DEV || !messaging) {
    console.log("[Push/DEV] To patient " + patientId + ": " + title + " - " + body);
    return;
  }
  const tokens = rows.map(r => r.token);
  const stringData = {};
  for (const [k, v] of Object.entries(data)) stringData[k] = String(v);
  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      notification: { title, body },
      webpush: {
        notification: { icon: "/assets/Logo.jpg", badge: "/assets/Logo.jpg" },
        fcmOptions: { link: data.link || "/" },
      },
      data: stringData,
    });
    response.responses.forEach((r, i) => {
      if (r.success) return;
      const code = r.error && r.error.code ? r.error.code : "";
      if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered") {
        removeDeadToken(tokens[i]);
      }
    });
    console.log("[push] Sent to " + response.successCount + "/" + tokens.length + " devices for patient " + patientId);
  } catch (err) {
    console.error("[push] Send error:", err.message);
  }
}
module.exports = { sendPushToPatient };
