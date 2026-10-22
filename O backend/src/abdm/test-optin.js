// Run from "O backend": node src/abdm/test-optin.js   (uses your installed express; no DB needed)
const assert = require("assert");
const http = require("http");
const express = require("express");
const optin = require("./optin");

const hospitals = { h1: { id: "h1", name: "Test", admin_user_id: "u1", abdm_enabled: false } };
const log = [];
const pool = { async query(sql, p) {
  if (/^SELECT id, name, abdm_enabled/.test(sql)) return { rows: Object.values(hospitals).filter((h) => p[0].includes(h.admin_user_id)) };
  if (/^UPDATE hospitals/.test(sql)) { hospitals[p[2]].abdm_enabled = p[0]; return { rows: [] }; }
  if (/^INSERT INTO abdm_consent_log/.test(sql)) { log.push(p[3]); return { rows: [] }; }
  return { rows: [] }; // schema DDL
} };
// Fake auth: x-user header carries JSON; absent = logged out.
const requireAuth = (req, res, next) => {
  if (!req.headers["x-user"]) return res.status(401).json({ error: "No token" });
  req.user = JSON.parse(req.headers["x-user"]); next();
};
const app = express(); app.use(express.json());
app.use("/api/abdm", optin({ pool, requireAuth }));

const call = (method, path, user, body) => new Promise((resolve) => {
  const req = http.request({ port: server.address().port, path, method, headers: { "content-type": "application/json", ...(user ? { "x-user": JSON.stringify(user) } : {}) } },
    (res) => { let d = ""; res.on("data", (c) => (d += c)); res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(d || "{}") })); });
  req.end(body ? JSON.stringify(body) : undefined);
});
let server;
(async () => {
  server = app.listen(0);
  const admin = { id: "u1", role: "hospital_admin" };
  assert.strictEqual((await call("POST", "/api/abdm/enable", null, { confirm: true })).status, 401, "logged out");
  assert.strictEqual((await call("POST", "/api/abdm/enable", { id: "d1", role: "doctor" }, { confirm: true })).status, 403, "doctor");
  assert.strictEqual((await call("POST", "/api/abdm/enable", { id: "p1", role: "patient" }, { confirm: true })).status, 403, "patient");
  assert.strictEqual((await call("POST", "/api/abdm/enable", { id: "u2", role: "hospital_admin" }, { confirm: true })).status, 404, "other hospital's admin");
  assert.strictEqual((await call("POST", "/api/abdm/enable", admin, {})).status, 400, "needs confirm");
  assert.strictEqual(hospitals.h1.abdm_enabled, false, "still off after rejected calls");
  assert.strictEqual((await call("POST", "/api/abdm/enable", admin, { confirm: true })).status, 200);
  assert.strictEqual((await call("GET", "/api/abdm/status", admin)).body.enabled, true);
  assert.strictEqual((await call("POST", "/api/abdm/disable", admin)).status, 200);
  assert.strictEqual(hospitals.h1.abdm_enabled, false);
  assert.deepStrictEqual(log, ["enable", "disable"]);
  console.log("ABDM opt-in tests passed"); server.close();
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
