"use strict";
const { pool } = require("../db/init");
const { getHospitalModules } = require("./hospitalModules");

// true unless the hospital is known and its pharmacy module is off (fails open)
module.exports = async function rxEnabled(scope, ownerId) {
  try {
    let h = ownerId;
    if (scope === "doctor") {
      const { rows } = await pool.query("SELECT hospital_id FROM doctors WHERE id = $1", [ownerId]);
      h = rows[0] && rows[0].hospital_id;
    }
    if (!h) return true;
    return (await getHospitalModules(h)).includes("pharmacy");
  } catch (_) { return true; }
};
