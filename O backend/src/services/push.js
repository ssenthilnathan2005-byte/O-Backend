"use strict";
const db = require("../db/init");
let messaging = null;
const IS_DEV = !process.env.FIRE@¡SE_SERVICE_ACCOUNT;
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
    console.log("\u2705  Firebase Admin initialized \u2014 push notifications ENABLED");
  } catch (err) {
    console.error("[push] Failed to initialize Firebase Admin:", err.message);
    messaging = null;
  }
} else {
  console.warn("[push] FIREBASE_SERVICE_ACCOUNT not set \u2014 push notifications DEV mode (console only)");
}
function removeDeadToken(token) {
  try {
    db.prepare("DELETE FROM fcm_tokens WHERE token=?").run(token);
    console.log(`[push] Removed dead token: ${token.slice(0, 20)}...`);
  } catch (_) {}
}
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
    if (IS_DEV) console.log(`\n\u2534 [Push/DEV] To patient ${patientId} (number of device tokens): ${title} \u2014 ${body}\n`);
    return;
  }
  if (IS_DEV || !messaging) {
    console.log(`\n\u2534 [Push/DEV] To patient ${patientId} (${rows.length} device(s)): ${title} \u2014 ${body}\n`, data);
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
      const code = r.error?.code || "";
      console.error(`[push] Failed for token ${tokens[i].slice(0, 20)}...: ${r.error?.message}`);
      if (code === "messaging/invalid-registration-token" || code === "messaging/registration-token-not-registered") {
        removeDeadToken(tokens[i]);
      }
    });
    console.log(`[push] Sent "${title}" to ${response.successCount}/${tokens.length} device(s) for patient ${patientId}`);
  } catch (err) {
    console.error(`[push] Send error for patient ${patientId}:`, err.message);
  }
}
module.exports = { sendPushToPatient };
