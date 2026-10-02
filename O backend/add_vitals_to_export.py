FILE = "src/routes/inward.js"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

old_admitted_query = '''    const { rows: admitted } = await pool.query(
      `SELECT * FROM inward_patients
        WHERE hospital_id=$1 AND status='admitted'
          AND admitted_at::date >= $2::date AND admitted_at::date <= $3::date
        ORDER BY admitted_at DESC`,
      [hospitalId, from, to]
    );

    const { rows: discharged } = await pool.query(
      `SELECT * FROM inward_patients
        WHERE hospital_id=$1 AND status='discharged'
          AND discharged_at IS NOT NULL
          AND discharged_at::date >= $2::date AND discharged_at::date <= $3::date
        ORDER BY discharged_at DESC`,
      [hospitalId, from, to]
    );

    if (admitted.length === 0 && discharged.length === 0)
      return res.status(404).json({ error: "No inward patient records found for this period." });'''

new_admitted_query = '''    const { rows: admitted } = await pool.query(
      `SELECT * FROM inward_patients
        WHERE hospital_id=$1 AND status='admitted'
          AND admitted_at::date >= $2::date AND admitted_at::date <= $3::date
        ORDER BY admitted_at DESC`,
      [hospitalId, from, to]
    );

    const { rows: discharged } = await pool.query(
      `SELECT * FROM inward_patients
        WHERE hospital_id=$1 AND status='discharged'
          AND discharged_at IS NOT NULL
          AND discharged_at::date >= $2::date AND discharged_at::date <= $3::date
        ORDER BY discharged_at DESC`,
      [hospitalId, from, to]
    );

    if (admitted.length === 0 && discharged.length === 0)
      return res.status(404).json({ error: "No inward patient records found for this period." });

    // Latest vitals reading per patient (blank if none recorded)
    const allIds = [...admitted, ...discharged].map((p) => p.id);
    let latestVitalsMap = {};
    if (allIds.length > 0) {
      const placeholders = allIds.map((_, i) => `$${i + 1}`).join(",");
      const { rows: vitalsRows } = await pool.query(
        `SELECT DISTINCT ON (patient_id) patient_id, temperature, pulse, bp_systolic, bp_diastolic, spo2, recorded_at
           FROM hospital_nursing_vitals
          WHERE patient_id IN (${placeholders})
          ORDER BY patient_id, recorded_at DESC`,
        allIds
      );
      for (const v of vitalsRows) latestVitalsMap[v.patient_id] = v;
    }'''

if old_admitted_query not in content:
    print("ERROR: query block anchor not found. No changes made.")
    raise SystemExit(1)
content = content.replace(old_admitted_query, new_admitted_query, 1)

old_cols = '''      { header: "Admitted At", key: "admitted_at", width: 20 },
      { header: "Discharged At", key: "discharged_at", width: 20 },
      { header: "Days", key: "days", width: 8 },
    ];'''
new_cols = '''      { header: "Admitted At", key: "admitted_at", width: 20 },
      { header: "Discharged At", key: "discharged_at", width: 20 },
      { header: "Days", key: "days", width: 8 },
      { header: "Temp (°F)", key: "temperature", width: 10 },
      { header: "Pulse (bpm)", key: "pulse", width: 12 },
      { header: "BP", key: "bp", width: 10 },
      { header: "SpO2 (%)", key: "spo2", width: 10 },
      { header: "Vitals Recorded At", key: "vitals_recorded_at", width: 20 },
    ];'''

if old_cols not in content:
    print("ERROR: columns anchor not found. No changes made.")
    raise SystemExit(1)
content = content.replace(old_cols, new_cols, 1)

old_row_build = '''        sheet.addRow({
          patient_name: r.patient_name,
          phone: r.phone || "",
          age: r.age ?? "",
          gender: r.gender || "",
          ward: r.ward || "",
          bed_number: r.bed_number || "",
          admitting_doctor_name: r.admitting_doctor_name || "",
          diagnosis: r.diagnosis || "",
          notes: r.notes || "",
          admitted_at: r.admitted_at ? new Date(r.admitted_at).toLocaleString() : "",
          discharged_at: r.discharged_at ? new Date(r.discharged_at).toLocaleString() : "",
          days,
        });'''
new_row_build = '''        const v = latestVitalsMap[r.id];
        sheet.addRow({
          patient_name: r.patient_name,
          phone: r.phone || "",
          age: r.age ?? "",
          gender: r.gender || "",
          ward: r.ward || "",
          bed_number: r.bed_number || "",
          admitting_doctor_name: r.admitting_doctor_name || "",
          diagnosis: r.diagnosis || "",
          notes: r.notes || "",
          admitted_at: r.admitted_at ? new Date(r.admitted_at).toLocaleString() : "",
          discharged_at: r.discharged_at ? new Date(r.discharged_at).toLocaleString() : "",
          days,
          temperature: v?.temperature ?? "",
          pulse: v?.pulse ?? "",
          bp: (v?.bp_systolic != null && v?.bp_diastolic != null) ? `${v.bp_systolic}/${v.bp_diastolic}` : "",
          spo2: v?.spo2 ?? "",
          vitals_recorded_at: v?.recorded_at ? new Date(v.recorded_at).toLocaleString() : "",
        });'''

if old_row_build not in content:
    print("ERROR: row-build anchor not found. No changes made.")
    raise SystemExit(1)
content = content.replace(old_row_build, new_row_build, 1)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("Success: latest vitals (temp, pulse, BP, SpO2) added to export, blank when none recorded.")
