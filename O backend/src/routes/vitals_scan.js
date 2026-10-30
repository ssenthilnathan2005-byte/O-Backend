"use strict";
// POST /api/vitals/scan  (multipart, field "image")
// Reads a patient-monitor photo with a vision model and returns vitals as suggestions.
// The photo is processed in memory only: never written to disk, never stored, never logged.
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 6 * 1024 * 1024, files: 1 } });

const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.VITALS_VISION_MODEL || "claude-sonnet-5-5";

const RANGES = { bpSystolic: [50, 280], bpDiastolic: [20, 180], pulse: [20, 250], spo2: [50, 100], respRate: [4, 80] };

const PROMPT = `You read a photo of a patient monitor and return the vital signs shown on screen.
Return ONLY a JSON object, no other text, in exactly this shape:
{"bpSystolic":int|null,"bpDiastolic":int|null,"pulse":int|null,"spo2":int|null,"respRate":int|null,"temperatures":[{"value":number,"unit":"C"|"F","label":string}],"notes":string}
Rules:
- Use only digits you can clearly see. If a value is unclear, hidden, glared out or missing, use null. Never guess or estimate.
- BP means the cuff / NIBP / NBP pressure (for example 120/80). Do NOT use ART, IBP, A-line or arterial pressures for BP.
- Pulse is the heart rate / pulse rate (HR, PR). SpO2 is oxygen saturation in percent. respRate is breaths per minute (RESP, RR).
- Ignore small numbers that are alarm limits, units, clock times, trend values or the MAP value in brackets.
- If the screen shows more than one temperature, list each one in "temperatures" with its label (T1, T2, Tskin, Trect ...). Do not pick one.
- Do not read or output any names, IDs, dates or bed numbers.
- "notes": at most one short sentence about anything unclear (glare, blur, cut-off numbers), or an empty string.`;

const lastCall = new Map();

const asNum = (v) => {
  const n = typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const inRange = (f, n) => n !== null && n >= RANGES[f][0] && n <= RANGES[f][1];

router.post("/scan", requireAuth, upload.single("image"), async (req, res) => {
  if (!API_KEY) return res.status(503).json({ error: "Vision scan is not configured" });
  if (!req.file) return res.status(400).json({ error: "image is required" });
  if (!/^image\/(jpeg|png|webp)$/.test(req.file.mimetype)) return res.status(400).json({ error: "Use a JPEG, PNG or WebP photo" });

  const who = String((req.user && (req.user.nurseId || req.user.id || req.user.userId)) || req.ip || "anon");
  const now = Date.now();
  if (now - (lastCall.get(who) || 0) < 3000) return res.status(429).json({ error: "Please wait a few seconds before scanning again" });
  lastCall.set(who, now);
  if (lastCall.size > 500) lastCall.clear();

  try {
    // Resize, fix rotation, re-encode as JPEG. This also drops EXIF data such as GPS and device info.
    const jpeg = await sharp(req.file.buffer).rotate().resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let r;
    try {
      r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal: ctrl.signal,
        headers: { "content-type": "application/json", "x-api-key": API_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 500,
          messages: [{ role: "user", content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: jpeg.toString("base64") } },
            { type: "text", text: PROMPT },
          ] }],
        }),
      });
    } finally { clearTimeout(timer); }

    if (!r.ok) {
      console.warn("[vitals-scan] upstream status", r.status);
      return res.status(502).json({ error: "Scan service unavailable. Use the on-device scan or type the values." });
    }
    const data = await r.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").replace(/```json|```/g, "").trim();
    let raw;
    try { raw = JSON.parse(text); } catch { return res.status(502).json({ error: "Could not understand the scan result" }); }

    const values = {};
    for (const f of Object.keys(RANGES)) { const n = asNum(raw[f]); values[f] = inRange(f, n) ? Math.round(n) : null; }
    if (values.bpSystolic !== null && values.bpDiastolic !== null && values.bpSystolic <= values.bpDiastolic) { values.bpSystolic = null; values.bpDiastolic = null; }
    if ((values.bpSystolic === null) !== (values.bpDiastolic === null)) { values.bpSystolic = null; values.bpDiastolic = null; } // BP only as a pair

    const temperatures = [];
    for (const t of Array.isArray(raw.temperatures) ? raw.temperatures.slice(0, 4) : []) {
      const n = asNum(t && t.value);
      if (n === null) continue;
      const f = String(t.unit).toUpperCase() === "C" ? n * 9 / 5 + 32 : n;
      if (f >= 85 && f <= 110) temperatures.push({ label: String(t.label || "").slice(0, 12), shownValue: n, shownUnit: String(t.unit).toUpperCase() === "C" ? "C" : "F", valueF: Math.round(f * 10) / 10 });
    }

    res.json({ values, temperatures, notes: String(raw.notes || "").slice(0, 200), model: MODEL });
  } catch (e) {
    console.warn("[vitals-scan] failed:", e && e.name === "AbortError" ? "timeout" : (e && e.message));
    res.status(502).json({ error: "Scan failed. Use the on-device scan or type the values." });
  }
});

router.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Photo is too large" });
  next(err);
});

module.exports = router;
