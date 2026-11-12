const pool = require("../db/init");

/**
 * audit(req, action, resourceType, resourceId, patientId, meta)
 * Fire-and-forget — never throws, never slows the request.
 */
async function audit(req, action, resourceType = null, resourceId = null, patientId = null, meta = null) {
  try {
    const actor = req.user || {};
    await pool.query(
      `INSERT INTO data_access_audit (id, actor_id, actor_role, hospital_id, action, resource_type, resource_id, patient_id, ip, meta)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        actor.id || null,
        actor.role || null,
        actor.hospitalId || actor.hospital_id || null,
        action,
        resourceType,
        resourceId,
        patientId,
        req.headers["cf-connecting-ip"] || req.ip || null,
        meta ? JSON.stringify(meta) : null,
      ]
    );
  } catch (_) {}
}

module.exports = { audit };
