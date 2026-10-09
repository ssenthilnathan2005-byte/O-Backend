// Voice prescription: server-side speech-to-text.
// Audio is held in memory only. It is never written to disk and never logged.
const express = require("express");
const multer = require("multer");
const rateLimit = require("express-rate-limit");
const { requireDoctor } = require("../middleware/auth");

const router = express.Router();

const MAX_BYTES = 8 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String((req.user && (req.user.doctorId || req.user.id)) || "anon"),
  message: { error: "Too many voice requests. Please wait a moment." },
});

// Short hint list: the speech model's prompt is small, so only common names go here.
const BASE_HINTS = [
  "Paracetamol", "Dolo", "Azithromycin", "Amoxicillin", "Clavulanic Acid", "Cefixime", "Cefpodoxime",
  "Pantoprazole", "Rabeprazole", "Domperidone", "Ondansetron", "Cetirizine", "Levocetirizine", "Montelukast",
  "Ambroxol", "Metformin", "Glimepiride", "Amlodipine", "Telmisartan", "Losartan", "Atorvastatin",
  "Rosuvastatin", "Aspirin", "Clopidogrel", "Levothyroxine", "Diclofenac", "Aceclofenac", "Ibuprofen",
  "Doxycycline", "Ciprofloxacin", "Metronidazole", "Pregabalin", "Gabapentin", "Cholecalciferol",
  "Ferrous Ascorbate", "Folic Acid", "Methylcobalamin",
];

function cleanHints(raw) {
  let arr = [];
  try { arr = JSON.parse(raw || "[]"); } catch { arr = []; }
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s) => typeof s === "string")
    .map((s) => s.replace(/[^A-Za-z0-9 +\-]/g, "").trim())
    .filter((s) => s.length >= 2 && s.length <= 40)
    .slice(0, 15);
}

function buildPrompt(extra) {
  const names = [...new Set([...extra, ...BASE_HINTS])];
  let p = "Doctor dictating a prescription in Indian English. Medicines may include: " + names.join(", ") + ". Dose, how often, number of days.";
  if (p.length > 700) p = p.slice(0, 700);
  return p;
}

function extFor(mime) {
  if (/webm/.test(mime)) return "webm";
  if (/ogg/.test(mime)) return "ogg";
  if (/mp4|m4a|aac/.test(mime)) return "m4a";
  if (/mpeg|mp3/.test(mime)) return "mp3";
  if (/wav/.test(mime)) return "wav";
  return "webm";
}

async function fetchWithTimeout(url, init, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...init, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

// One function per provider. To add another, add an entry here and set VOICE_STT_PROVIDER.
const PROVIDERS = {
  async groq(buf, mime, { prompt, language }) {
    const key = process.env.GROQ_API_KEY;
    if (!key) throw new Error("GROQ_API_KEY is not set");
    const form = new FormData();
    form.append("file", new Blob([buf], { type: mime }), "speech." + extFor(mime));
    form.append("model", process.env.VOICE_STT_MODEL || "whisper-large-v3");
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");
    if (language) form.append("language", language);
    if (prompt) form.append("prompt", prompt);
    const r = await fetchWithTimeout(
      "https://api.groq.com/openai/v1/audio/transcriptions",
      { method: "POST", headers: { Authorization: "Bearer " + key }, body: form },
      25000
    );
    if (!r.ok) { const e = new Error("groq status " + r.status); e.status = r.status; throw e; }
    const j = await r.json();
    const lps = Array.isArray(j.segments)
      ? j.segments.map((s) => s.avg_logprob).filter((x) => typeof x === "number")
      : [];
    const confidence = lps.length
      ? Math.max(0, Math.min(1, Math.exp(lps.reduce((a, b) => a + b, 0) / lps.length)))
      : null;
    return { text: String(j.text || "").trim(), confidence };
  },
};

async function transcribeWithRetry(fn, buf, mime, opts) {
  try {
    return await fn(buf, mime, opts);
  } catch (err) {
    if (err.status && err.status < 500) throw err; // client-side problems are not retried
    return await fn(buf, mime, opts);
  }
}

// POST /api/voice/transcribe   (multipart: audio, optional language, optional hints JSON)
router.post("/transcribe", requireDoctor, limiter, upload.single("audio"), async (req, res) => {
  const started = Date.now();
  res.set("Cache-Control", "no-store");
  try {
    const f = req.file;
    if (!f || f.size < 1000) return res.status(400).json({ error: "No audio received" });
    const mime = f.mimetype || "audio/webm";
    if (!/^audio\//.test(mime) && !/^video\/(webm|mp4)$/.test(mime)) {
      return res.status(415).json({ error: "Unsupported audio type" });
    }
    const provider = (process.env.VOICE_STT_PROVIDER || "groq").toLowerCase();
    const fn = PROVIDERS[provider];
    if (!fn) return res.status(500).json({ error: "Voice provider is not configured" });

    let language = String((req.body && req.body.language) || process.env.VOICE_STT_LANGUAGE || "en").toLowerCase();
    if (!/^[a-z]{2}$/.test(language)) language = ""; // "auto" or anything else: let the model detect
    const prompt = buildPrompt(cleanHints(req.body && req.body.hints));

    const out = await transcribeWithRetry(fn, f.buffer, mime, { prompt, language });
    return res.json({ text: out.text, confidence: out.confidence, provider, ms: Date.now() - started });
  } catch (err) {
    console.error("[voice] transcription failed:", err.status || err.message); // never log transcript text
    return res.status(502).json({ error: "Speech service unavailable" });
  }
});

router.use((err, req, res, next) => {
  if (err && err.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "Recording too long" });
  return next(err);
});

module.exports = router;
