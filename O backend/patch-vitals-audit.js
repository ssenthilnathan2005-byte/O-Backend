// patch-vitals-audit.js - adds an OCR audit table and stores it when vitals are saved with ocrScan.
// Run on the server from the backend folder:  node patch-vitals-audit.js
// Makes a backup first. Safe to run twice. A failed audit insert never blocks saving vitals.
const fs = require("fs");
const path = require("path");
const file = path.join("src", "routes", "nursing.js");
let src = fs.readFileSync(file, "utf8");
if (src.includes("hospital_vitals_ocr_audit")) { console.log("Already patched."); process.exit(0); }

const tableBlock = `
// -- OCR accuracy audit: what the scanner originally read vs what the nurse finally saved --
pool.query(\`
  CREATE TABLE IF NOT EXISTS hospital_vitals_ocr_audit (
    id TEXT PRIMARY KEY,
    vitals_id TEXT,
    hospital_id TEXT,
    patient_id TEXT,
    recorded_by_user_id TEXT,
    recorded_by_role TEXT,
    scanned_at TIMESTAMPTZ,
    saved_at TIMESTAMPTZ DEFAULT now(),
    template TEXT,
    version INTEGER,
    ocr_values JSONB,
    ocr_conf JSONB,
    ocr_flags JSONB,
    reviewed_values JSONB,
    final_values JSONB,
    raw_words JSONB
  )\`).then(() => pool.query("CREATE INDEX IF NOT EXISTS idx_hvoa_hospital ON hospital_vitals_ocr_audit(hospital_id)"))
  .then(() => pool.query("CREATE INDEX IF NOT EXISTS idx_hvoa_vitals ON hospital_vitals_ocr_audit(vitals_id)"))
  .catch(e => console.warn("[nursing] ocr audit migration:", e.message));

const AUDIT_FIELDS = ["bpSystolic", "bpDiastolic", "pulse", "spo2", "respRate", "temperature"];
function cleanAuditMap(m, asNumber) {
  const out = {};
  if (!m || typeof m !== "object") return out;
  for (const k of AUDIT_FIELDS) {
    if (m[k] === undefined || m[k] === null || m[k] === "") continue;
    const v = asNumber ? Number(m[k]) : String(m[k]).slice(0, 12);
    if (asNumber && !Number.isFinite(v)) continue;
    out[k] = v;
  }
  return out;
}
function cleanOcrScan(o) {
  if (!o || typeof o !== "object") return null;
  const flags = {};
  if (o.flags && typeof o.flags === "object") {
    for (const k of AUDIT_FIELDS) if (o.flags[k] === "confident" || o.flags[k] === "low-confidence") flags[k] = o.flags[k];
  }
  const words = Array.isArray(o.words) ? o.words.slice(0, 60).map(w => ({
    text: String((w && w.text) || "").slice(0, 20),
    conf: Number(w && w.conf) || 0,
    seen: String((w && w.seen) || "").slice(0, 10),
    recheck: String((w && w.recheck) || "").slice(0, 20),
    status: String((w && w.status) || "").slice(0, 80),
  })) : [];
  const scanned = o.scannedAt ? new Date(o.scannedAt) : null;
  return {
    version: Number(o.version) || 1,
    template: String(o.template || "").slice(0, 60),
    scannedAt: scanned && !isNaN(scanned.getTime()) ? scanned.toISOString() : null,
    proposed: cleanAuditMap(o.proposed, false),
    conf: cleanAuditMap(o.conf, true),
    flags,
    reviewed: cleanAuditMap(o.reviewed, false),
    words,
  };
}
`;

const getAnchor = 'router.get("/vitals", requireAuth, staffOrAdmin';
const gi = src.indexOf(getAnchor);
if (gi < 0) { console.error("Could not find the GET /vitals route. Nothing changed."); process.exit(1); }

const postAnchor = 'router.post("/vitals"';
const pi = src.indexOf(postAnchor);
if (pi < 0) { console.error("Could not find the POST /vitals route. Nothing changed."); process.exit(1); }
const resLine = "res.status(201).json(rows[0]);";
const ri = src.indexOf(resLine, pi);
if (ri < 0) { console.error("Could not find the end of the POST /vitals handler. Nothing changed."); process.exit(1); }

const auditCall = `{
      // Store the scanner's original values next to the saved ones. Never blocks saving the vitals.
      try {
        const scan = cleanOcrScan(req.body.ocrScan);
        if (scan) {
          const finalValues = cleanAuditMap({ bpSystolic, bpDiastolic, pulse, spo2, respRate, temperature }, true);
          await pool.query(
            \`INSERT INTO hospital_vitals_ocr_audit
               (id, vitals_id, hospital_id, patient_id, recorded_by_user_id, recorded_by_role, scanned_at, template, version,
                ocr_values, ocr_conf, ocr_flags, reviewed_values, final_values, raw_words)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb)\`,
            [\`hva_\${nanoid(10)}\`, rows[0].id, hospitalId, patientId || null, recordedByUserId, req.user.role || null,
             scan.scannedAt, scan.template, scan.version,
             JSON.stringify(scan.proposed), JSON.stringify(scan.conf), JSON.stringify(scan.flags),
             JSON.stringify(scan.reviewed), JSON.stringify(finalValues), JSON.stringify(scan.words)]);
        }
      } catch (auditErr) { console.warn("[nursing] ocr audit insert failed:", auditErr.message); }
    }
    `;

fs.copyFileSync(file, file + ".bak-before-ocr-audit");
src = src.slice(0, ri) + auditCall + src.slice(ri);
src = src.slice(0, gi) + tableBlock + "\n" + src.slice(gi);
fs.writeFileSync(file, src);
console.log("Patched " + file + " (backup: " + file + ".bak-before-ocr-audit)");
