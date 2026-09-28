FILE = "src/routes/inward.js"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

# ── 1. POST / (admit) — accept optional admittedAt ─────────────────────
old_post = '''    const { patientName, phone, age, gender, ward, bedNumber,
            admittingDoctorId, admittingDoctorName, diagnosis, notes } = req.body;
    if (!patientName || !hospitalId)
      return res.status(400).json({ error: "patientName required" });
    const id = `inward_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO inward_patients
         (id, hospital_id, patient_name, phone, age, gender, ward, bed_number,
          admitting_doctor_id, admitting_doctor_name, diagnosis, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [id, hospitalId, patientName, phone || null, age || null, gender || null,
       ward || null, bedNumber || null, admittingDoctorId || null,
       admittingDoctorName || null, diagnosis || null, notes || null]
    );'''
new_post = '''    const { patientName, phone, age, gender, ward, bedNumber,
            admittingDoctorId, admittingDoctorName, diagnosis, notes, admittedAt } = req.body;
    if (!patientName || !hospitalId)
      return res.status(400).json({ error: "patientName required" });
    const id = `inward_${nanoid(10)}`;
    const { rows } = await pool.query(
      `INSERT INTO inward_patients
         (id, hospital_id, patient_name, phone, age, gender, ward, bed_number,
          admitting_doctor_id, admitting_doctor_name, diagnosis, notes, admitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13::timestamptz, now())) RETURNING *`,
      [id, hospitalId, patientName, phone || null, age || null, gender || null,
       ward || null, bedNumber || null, admittingDoctorId || null,
       admittingDoctorName || null, diagnosis || null, notes || null,
       admittedAt || null]
    );'''

if old_post not in content:
    print("ERROR: POST / anchor not found. No changes made.")
    raise SystemExit(1)
content = content.replace(old_post, new_post, 1)

# ── 2. PATCH /:id (update) — accept optional admittedAt ────────────────
old_patch = '''    const { ward, bedNumber, diagnosis, notes, admittingDoctorId, admittingDoctorName } = req.body;
    const { rows } = await pool.query(
      `UPDATE inward_patients SET
         ward=$1, bed_number=$2, diagnosis=$3, notes=$4,
         admitting_doctor_id=$5, admitting_doctor_name=$6
       WHERE id=$7 AND hospital_id=$8 RETURNING *`,
      [ward || null, bedNumber || null, diagnosis || null, notes || null,
       admittingDoctorId || null, admittingDoctorName || null,
       req.params.id, hospitalId]
    );'''
new_patch = '''    const { ward, bedNumber, diagnosis, notes, admittingDoctorId, admittingDoctorName, admittedAt } = req.body;
    const { rows } = await pool.query(
      `UPDATE inward_patients SET
         ward=$1, bed_number=$2, diagnosis=$3, notes=$4,
         admitting_doctor_id=$5, admitting_doctor_name=$6,
         admitted_at=COALESCE($9::timestamptz, admitted_at)
       WHERE id=$7 AND hospital_id=$8 RETURNING *`,
      [ward || null, bedNumber || null, diagnosis || null, notes || null,
       admittingDoctorId || null, admittingDoctorName || null,
       req.params.id, hospitalId, admittedAt || null]
    );'''

if old_patch not in content:
    print("ERROR: PATCH /:id anchor not found. No changes made.")
    raise SystemExit(1)
content = content.replace(old_patch, new_patch, 1)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("Success: admittedAt accepted on both admit (POST) and update (PATCH) routes.")
