FILE = "./O backend/src/routes/labs.js"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

old = '''// ── GET /api/labs/bookings — admin/hospital_admin list all ────────────────
router.get("/bookings", requireAdminOrHospitalAdmin, async (req, res) => {'''

new = '''// ── POST /api/labs/bookings/:id/mark-late — patient marks self as running late ──
router.post("/bookings/:id/mark-late", requireAuth, async (req, res) => {
  if (req.user.role !== "patient")
    return res.status(403).json({ error: "Only patients can mark themselves as late" });

  const etaMinutes = Number(req.body.etaMinutes);
  if (!Number.isInteger(etaMinutes) || etaMinutes <= 0 || etaMinutes > 180)
    return res.status(400).json({ error: "etaMinutes must be a positive integer (max 180 minutes)" });

  try {
    const { rows } = await pool.query(
      "SELECT * FROM lab_bookings WHERE id=$1 AND patient_id=$2",
      [req.params.id, req.user.id]
    );
    const booking = rows[0];
    if (!booking) return res.status(404).json({ error: "Booking not found" });
    if (booking.status === "cancelled" || booking.status === "report_ready")
      return res.status(400).json({ error: "This booking is no longer active" });

    await pool.query(
      "UPDATE lab_bookings SET late_flag=TRUE, late_eta_minutes=$1, late_marked_at=now() WHERE id=$2",
      [etaMinutes, req.params.id]
    );

    const sessionId = `${booking.lab_id}_${booking.test_id}_${booking.slot_date}_${booking.slot_time}`;
    broadcast(sessionId, {
      type: "patient_late",
      sessionId,
      tokenNumber: booking.token_number,
      patientName: booking.patient_name,
      etaMinutes,
    });

    res.json({ success: true, etaMinutes });
  } catch (err) {
    console.error("[labs] mark-late error:", err.message);
    res.status(500).json({ error: "Failed to update" });
  }
});

// ── GET /api/labs/bookings — admin/hospital_admin list all ────────────────
router.get("/bookings", requireAdminOrHospitalAdmin, async (req, res) => {'''

if old not in content:
    print("ERROR: Could not find target block in labs.js. No changes made.")
    raise SystemExit(1)
content = content.replace(old, new, 1)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)
print("Success: mark-late route added to labs.js")
