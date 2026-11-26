"use strict";
// Decides which changes are important enough for the Activity Monitor.
// Anything not listed here (lab reports, bed cleaning/vacate/occupy, nursing, check-ins,
// fee collection, payment entries, discharge, attendance, ...) keeps working but is never shown.
const PRICE_FIELD = /(price|mrp|rate|fee|charge|discount|tax|gst)/i;

// Recorded only when a price / rate / fee field really changed.
const PRICE_ONLY = ["doctor.profile_updated", "inventory.item_updated", "pharmacy.packing_changed", "pharmacy.stock_received"];

const ALWAYS = [
  // pricing and billing exceptions
  "bed.ward_rate_changed", "ipd.bill_settings", "ipd.payment_removed", "ipd.bill_item_removed",
  "lab.test_created", "lab.test_deleted", "pharmacy.gst_settings",
  // permissions and passwords
  "hr.permissions_changed", "hr.password_viewed", "hr.password_changed", "hr.nurse_password_reset",
  "doctor.password_reset", "hr.pharmacy_password", "hr.lab_password",
  // staff and logins
  "doctor.created", "doctor.removed", "hr.nurse_login_created", "hr.nurse_login_removed",
  "hr.front_office_created", "hr.front_office_updated", "hr.front_office_removed",
  "hr.pharmacy_created", "hr.pharmacy_removed", "hr.lab_created", "hr.lab_removed",
  "hr.login_created", "hr.login_terminated", "hr.doctor_replaced", "hr.doctor_terminated",
  "hr.staff_created", "hr.staff_updated", "hr.staff_removed",
  // critical configuration
  "hospital.settings_updated", "hospital.settings_changed", "doctor.vitals_config_changed", "lab.toggle",
  "wards.ward_created", "wards.ward_deleted", "wards.beds_added", "wards.bed_deleted",
];

function shouldRecord(action, changes) {
  if (ALWAYS.includes(action)) return true;
  if (PRICE_ONLY.includes(action)) return Array.isArray(changes) && changes.some((c) => c && PRICE_FIELD.test(String(c.field || "")));
  return false;
}

const q = (list) => list.map((a) => "'" + a + "'").join(",");

/** SQL condition (no parameters) that keeps only important rows, including rows saved before this filter existed. */
function importantClause() {
  return "(action IN (" + q(ALWAYS) + ") OR (action IN (" + q(PRICE_ONLY) + ") AND changes::text ~* '\"field\": \"[a-z_:]*(price|mrp|rate|fee|charge|discount|tax|gst)'))";
}

module.exports = { ALWAYS, PRICE_ONLY, shouldRecord, importantClause };
