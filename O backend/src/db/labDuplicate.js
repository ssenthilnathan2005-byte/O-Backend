// Duplicate lab test booking prevention.
// One active booking per patient (matched by UHID) per lab test ID. Cancelled orders do not count.
async function findLabDuplicate(db, { patientId, testId, inwardId }) {
  if ((!patientId && !inwardId) || !testId) return null;
  let uhid = null;
  if (patientId) {
    const { rows: u } = await db.query("SELECT uhid FROM users WHERE id = $1", [patientId]);
    uhid = u[0] && u[0].uhid ? u[0].uhid : null;
  }
  const { rows } = await db.query(
    `SELECT o.id, o.token_number, o.slot_date, o.status
       FROM hospital_lab_orders o
      WHERE o.test_id = $2
        AND o.status <> 'cancelled'
        AND (
              ($1::text IS NOT NULL AND o.patient_id = $1)
           OR ($3::text IS NOT NULL AND o.patient_id IN (SELECT id FROM users WHERE uhid = $3))
           OR ($1::text IS NOT NULL AND o.inward_id IN (SELECT id FROM inward_patients WHERE patient_user_id = $1))
           OR ($4::text IS NOT NULL AND o.inward_id = $4)
        )
      LIMIT 1`,
    [patientId || null, testId, uhid, inwardId || null]);
  return rows[0] || null;
}

// Database safety net so two simultaneous bookings cannot both get through.
// Skipped (with a warning) while old duplicate rows still exist.
async function ensureLabDuplicateIndex(db) {
  try {
    const { rows } = await db.query(
      `SELECT patient_id, test_id, COUNT(*) AS n FROM hospital_lab_orders
        WHERE patient_id IS NOT NULL AND status <> 'cancelled'
        GROUP BY patient_id, test_id HAVING COUNT(*) > 1`);
    if (rows.length) {
      console.warn("[hospital-lab] " + rows.length + " patient/test duplicate group(s) exist; unique index not created until they are cancelled");
      return;
    }
    await db.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS uq_hlo_patient_test
         ON hospital_lab_orders (patient_id, test_id)
         WHERE patient_id IS NOT NULL AND status <> 'cancelled'`);
  } catch (e) { console.warn("[hospital-lab] duplicate index:", e.message); }
}

module.exports = { findLabDuplicate, ensureLabDuplicateIndex };
