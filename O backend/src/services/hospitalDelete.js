// Tables with a hospital_id column but no foreign key (or no cascade) - cleared explicitly.
// Tables that cascade from hospitals/doctors (doctors, nurses, prescriptions, bookings via doctors, ...) need nothing here.
const RELATED_TABLES = [
  "pharmacy_gst_profile", "pharmacy_bill_counters", "pharmacy_invoice_counter",
  "pharmacy_invoice_register", "pharmacy_bill_invoice", "pharmacy_imports",
  "pharmacy_med_categories", "hr_salary_paid", "hr_events", "hospital_staff",
  "front_office_staff", "hospital_lab_staff", "hospital_integrations", "bookings", "inward_patients",
];

async function hasColumn(client, table, column) {
  const r = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name=$2",
    [table, column]
  );
  return r.rowCount > 0;
}

async function deleteHospital(pool, hid) {
  const client = await pool.connect();
  try {
    const found = await client.query("SELECT 1 FROM hospitals WHERE id=$1", [hid]);
    if (found.rowCount === 0)
      return { ok: false, status: 404, error: "Hospital not found" };

    // Only ACTIVE doctors block the delete; deactivated ones are removed with the hospital.
    const active = await client.query(
      "SELECT COUNT(*) AS c FROM doctors WHERE hospital_id=$1 AND COALESCE(is_active,1)=1", [hid]);
    if (Number(active.rows[0].c) > 0)
      return { ok: false, status: 409, error: "Cannot delete hospital with active doctors. Remove the doctors first." };

    await client.query("BEGIN");

    if (await hasColumn(client, "token_states", "doctor_id"))
      await client.query("DELETE FROM token_states WHERE doctor_id IN (SELECT id FROM doctors WHERE hospital_id=$1)", [hid]);

    // 1) hr_staff_bd blocks deleting staff that have a login, so detach the logins first.
    await client.query("UPDATE hospital_staff SET login_id=NULL, login_type=NULL WHERE hospital_id=$1", [hid]);

    // 2) doctors_bd blocks deleting doctors that still have prescriptions or bookings, so clear them first.
    await client.query("DELETE FROM prescriptions WHERE hospital_id=$1 OR doctor_id IN (SELECT id FROM doctors WHERE hospital_id=$1)", [hid]);
    await client.query("DELETE FROM bookings WHERE doctor_id IN (SELECT id FROM doctors WHERE hospital_id=$1)", [hid]);

    for (const t of RELATED_TABLES) {
      if (await hasColumn(client, t, "hospital_id"))
        await client.query("DELETE FROM " + t + " WHERE hospital_id=$1", [hid]);
    }

    if (await hasColumn(client, "users", "walkin_hospital_id"))
      await client.query("UPDATE users SET walkin_hospital_id=NULL WHERE walkin_hospital_id=$1", [hid]);

    // Cascades: doctors (-> bookings, prescriptions, presets), nurses, pharmacy_staff, ...
    await client.query("DELETE FROM hospitals WHERE id=$1", [hid]);
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { deleteHospital };
