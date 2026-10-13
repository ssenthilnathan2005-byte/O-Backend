// ocr-accuracy-report.js - how often the nurse changed what the scanner read.
// Run on the server from the backend folder:  set -a && . ./.env && set +a && node ocr-accuracy-report.js
const { Pool } = require("pg");
const p = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const sql = `
SELECT f.field,
  count(*) FILTER (WHERE coalesce(a.ocr_values->>f.field,'') <> '') AS scanner_proposed,
  count(*) FILTER (WHERE coalesce(a.ocr_values->>f.field,'') <> '' AND (a.ocr_values->>f.field)::numeric = (a.final_values->>f.field)::numeric) AS kept_as_read,
  count(*) FILTER (WHERE coalesce(a.ocr_values->>f.field,'') <> '' AND (a.final_values->>f.field) IS NOT NULL AND (a.ocr_values->>f.field)::numeric <> (a.final_values->>f.field)::numeric) AS corrected,
  count(*) FILTER (WHERE coalesce(a.ocr_values->>f.field,'') <> '' AND (a.final_values->>f.field) IS NULL) AS removed,
  count(*) FILTER (WHERE coalesce(a.ocr_values->>f.field,'') = '' AND (a.final_values->>f.field) IS NOT NULL) AS typed_by_nurse,
  count(*) FILTER (WHERE a.ocr_flags->>f.field = 'low-confidence') AS low_conf_proposed,
  count(*) FILTER (WHERE a.ocr_flags->>f.field = 'low-confidence' AND (a.ocr_values->>f.field)::numeric = (a.final_values->>f.field)::numeric) AS low_conf_correct
FROM hospital_vitals_ocr_audit a
CROSS JOIN (VALUES ('bpSystolic'),('bpDiastolic'),('pulse'),('spo2'),('respRate'),('temperature')) AS f(field)
GROUP BY f.field ORDER BY f.field`;
p.query("select count(*) as scans, min(saved_at) as first, max(saved_at) as last from hospital_vitals_ocr_audit")
  .then(r => { console.log("Audited scans:"); console.table(r.rows); return p.query(sql); })
  .then(r => { console.log("Per field (kept_as_read / proposed = accuracy):"); console.table(r.rows); return p.end(); })
  .catch(e => { console.error("ERR:", e.message); process.exit(1); });
