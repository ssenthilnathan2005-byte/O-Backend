import io, os, sys

base = sys.argv[1] if len(sys.argv) > 1 else "O backend"
ROUTES = os.path.join(base, "src", "routes")

def load(name):
    raw = io.open(os.path.join(ROUTES, name), encoding="utf-8", newline="").read()
    return ("\r\n" in raw), raw.replace("\r\n", "\n")

def fail(msg):
    print("STOP - " + msg + " - nothing written")
    sys.exit(1)

def once(t, old, label):
    n = t.count(old)
    if n != 1:
        fail("%s not found exactly once (count=%d)" % (label, n))

TRANSFER_JS = """pool.query(`
  CREATE TABLE IF NOT EXISTS ipd_transfers (
    id             TEXT PRIMARY KEY,
    inward_id      TEXT NOT NULL,
    hospital_id    TEXT NOT NULL,
    from_ward      TEXT,
    from_bed       TEXT,
    to_ward        TEXT NOT NULL,
    to_bed         TEXT NOT NULL,
    to_rate        NUMERIC(10,2) NOT NULL DEFAULT 0,
    reason         TEXT,
    by_user        TEXT,
    by_role        TEXT,
    transferred_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_ipdtr_inward ON ipd_transfers(inward_id);
`).catch((e) => console.warn("[inward] transfer migration:", e.message));

// POST /inward/:id/transfer { bedId, rate?, reason? } - move an admitted patient to another free bed (any ward).
// New ward rate applies from the transfer day. The old ward is billed for the days before it.
router.post("/:id/transfer", requireAuth, requirePerm("ipd"), async (req, res) => {
  const client = await pool.connect();
  try {
    const hospitalId = req.user.role === "admin" ? req.body.hospitalId : req.user.hospitalId;
    const b = req.body || {};
    if (!hospitalId) return res.status(400).json({ error: "hospitalId required" });
    if (!b.bedId) return res.status(400).json({ error: "Choose the bed to move the patient to" });
    const reason = String(b.reason || "").trim().slice(0, 300);
    let rateOverride = null;
    if (b.rate !== undefined && b.rate !== null && b.rate !== "") {
      rateOverride = Number(b.rate);
      if (!(rateOverride >= 0)) return res.status(400).json({ error: "Enter a valid daily rate" });
    }
    await client.query("BEGIN");
    const { rows: cur } = await client.query(
      "SELECT * FROM inward_patients WHERE id=$1 AND hospital_id=$2 FOR UPDATE", [req.params.id, hospitalId]);
    if (!cur.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Not found" }); }
    const p = cur[0];
    if (p.status !== "admitted") { await client.query("ROLLBACK"); return res.status(409).json({ error: "Only an admitted patient can be moved" }); }
    const { rows: beds } = await client.query(
      "SELECT id, ward_id, status, bed_number, inward_id, reserved_booking_id, reserved_until FROM beds WHERE hospital_id=$1 AND (id=$2 OR inward_id=$3) ORDER BY id FOR UPDATE",
      [hospitalId, b.bedId, p.id]);
    const target = beds.find((x) => x.id === b.bedId);
    if (!target) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Bed not found" }); }
    if (target.inward_id === p.id) { await client.query("ROLLBACK"); return res.status(400).json({ error: "The patient is already in this bed" }); }
    const held = target.reserved_booking_id && target.reserved_until && new Date(target.reserved_until) > new Date();
    if (target.status !== "available" || held) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "That bed is not available now. Choose another bed." });
    }
    const oldBed = beds.find((x) => x.inward_id === p.id) || null;
    const { rows: nw } = await client.query("SELECT name, daily_rate FROM wards WHERE id=$1 AND hospital_id=$2", [target.ward_id, hospitalId]);
    if (!nw.length) { await client.query("ROLLBACK"); return res.status(404).json({ error: "Ward not found" }); }
    const { rows: ow } = await client.query("SELECT daily_rate FROM wards WHERE hospital_id=$1 AND name=$2 LIMIT 1", [hospitalId, p.ward]);
    const oldRate = ow.length ? (Number(ow[0].daily_rate) || 0) : 0;
    // freeze the old ward's rate so the days already spent there keep their price
    await client.query("UPDATE inward_patients SET bed_rate = COALESCE(bed_rate, $2::numeric) WHERE id=$1", [p.id, oldRate]);
    const newRate = rateOverride !== null ? Math.round(rateOverride * 100) / 100 : (Number(nw[0].daily_rate) || 0);
    await client.query(
      `INSERT INTO ipd_transfers (id, inward_id, hospital_id, from_ward, from_bed, to_ward, to_bed, to_rate, reason, by_user, by_role)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [`transfer_${nanoid(10)}`, p.id, hospitalId, p.ward || null, p.bed_number || null, nw[0].name, target.bed_number,
       newRate, reason || null, req.user.id || null, req.user.role || null]);
    const { rows: upd } = await client.query(
      "UPDATE inward_patients SET ward=$2, bed_number=$3 WHERE id=$1 RETURNING *", [p.id, nw[0].name, target.bed_number]);
    await client.query(
      `UPDATE beds SET status='occupied', patient_name=$1, inward_id=$2,
              cleaning_started_at=NULL, cleaning_ends_at=NULL, cleaning_duration_minutes=NULL, updated_at=now()
        WHERE id=$3`, [p.patient_name, p.id, target.id]);
    if (oldBed) {
      const { rows: m } = await client.query(
        `SELECT COALESCE(b.cleaning_override_minutes, w.cleaning_minutes,
                  (SELECT default_minutes FROM hospital_cleaning_settings WHERE hospital_id=$3), 30) AS minutes
           FROM beds b JOIN wards w ON w.id=b.ward_id WHERE b.id=$1 AND b.ward_id=$2`,
        [oldBed.id, oldBed.ward_id, hospitalId]);
      const minutes = m.length ? Number(m[0].minutes) : 30;
      await client.query(
        `UPDATE beds SET status='maintenance', patient_name=NULL, inward_id=NULL,
                cleaning_started_at=now(), cleaning_duration_minutes=$2::int,
                cleaning_ends_at=now() + make_interval(mins => $2::int), updated_at=now()
          WHERE id=$1`, [oldBed.id, minutes]);
    }
    await client.query("COMMIT");
    res.json(upd[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    res.status(500).json({ error: err.message });
  } finally { client.release(); }
});
"""

MIGRATION_JS = """pool.query(`
  CREATE TABLE IF NOT EXISTS ipd_transfers (
    id             TEXT PRIMARY KEY,
    inward_id      TEXT NOT NULL,
    hospital_id    TEXT NOT NULL,
    from_ward      TEXT,
    from_bed       TEXT,
    to_ward        TEXT NOT NULL,
    to_bed         TEXT NOT NULL,
    to_rate        NUMERIC(10,2) NOT NULL DEFAULT 0,
    reason         TEXT,
    by_user        TEXT,
    by_role        TEXT,
    transferred_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_ipdtr_inward ON ipd_transfers(inward_id);
  CREATE OR REPLACE FUNCTION ipd_bed_segments(p_id TEXT)
  RETURNS TABLE(seg_no INT, seg_ward TEXT, seg_rate NUMERIC, seg_start DATE, seg_days INT)
  LANGUAGE sql STABLE AS $fn$
    WITH ip AS (
      SELECT i.hospital_id, i.ward AS cur_ward, i.bed_rate,
             (i.admitted_at AT TIME ZONE 'Asia/Kolkata')::date AS a,
             (COALESCE(i.discharged_at, now()) AT TIME ZONE 'Asia/Kolkata')::date AS e
        FROM inward_patients i WHERE i.id = p_id
    ),
    tr AS (
      SELECT t.to_ward, t.to_rate, t.from_ward,
             (t.transferred_at AT TIME ZONE 'Asia/Kolkata')::date AS d,
             (row_number() OVER (ORDER BY t.transferred_at, t.id))::int AS n
        FROM ipd_transfers t WHERE t.inward_id = p_id
    ),
    seg AS (
      SELECT 0 AS sn,
             COALESCE((SELECT x.from_ward FROM tr x WHERE x.n = 1), ip.cur_ward) AS sw,
             COALESCE(ip.bed_rate,
                      (SELECT w.daily_rate FROM wards w WHERE w.hospital_id = ip.hospital_id AND w.name = ip.cur_ward LIMIT 1),
                      0)::numeric AS sr,
             ip.a AS sd,
             COALESCE((SELECT x.d FROM tr x WHERE x.n = 1), ip.e + 1) AS nd
        FROM ip
      UNION ALL
      SELECT t.n, t.to_ward, t.to_rate::numeric, t.d,
             COALESCE((SELECT x.d FROM tr x WHERE x.n = t.n + 1), (SELECT ip2.e + 1 FROM ip ip2))
        FROM tr t
    )
    SELECT sn, sw, sr, sd, GREATEST(nd - sd, 0)::int FROM seg ORDER BY sn
  $fn$;
`).catch((e) => console.warn("[ipd_billing] transfer migration:", e.message));
"""

BEDCHARGE_JS = """const { rows: segRows } = await db.query(
    "SELECT seg_no, seg_ward, seg_rate, seg_start::text AS seg_start, seg_days FROM ipd_bed_segments($1) ORDER BY seg_no", [stay.id]);
  const moved = segRows.length > 1;
  const segments = moved ? segRows.filter((s) => Number(s.seg_days) > 0).map((s) => ({
    ward: s.seg_ward, rate: num(s.seg_rate), days: Number(s.seg_days), from: s.seg_start,
    amount: money(num(s.seg_rate) * Number(s.seg_days)),
  })) : [];
  if (moved) rate = num(segRows[segRows.length - 1].seg_rate);
  const bedCharge = moved ? money(segments.reduce((s, x) => s + x.amount, 0)) : money(rate * stay.days);"""

SETTINGS_JS = """const tr = await pool.query(
        "UPDATE ipd_transfers SET to_rate=$1 WHERE id=(SELECT id FROM ipd_transfers WHERE inward_id=$2 ORDER BY transferred_at DESC, id DESC LIMIT 1) RETURNING id",
        [money(r), stay.id]);
      if (!tr.rows.length) await pool.query("UPDATE inward_patients SET bed_rate=$1 WHERE id=$2", [money(r), stay.id]);"""

crlf_i, ti = load("inward.js")
crlf_b, tb = load("ipd_billing.js")
out = {}

# ---- inward.js
if "/:id/transfer" in ti:
    print("inward.js: already patched")
else:
    a = 'router.patch("/:id/discharge"'
    once(ti, a, "discharge route")
    ti = ti.replace(a, TRANSFER_JS + "\n" + a)
    out["inward.js"] = (ti, crlf_i)

# ---- ipd_billing.js
if "ipd_bed_segments" in tb:
    print("ipd_billing.js: already patched")
else:
    a1 = '.catch((e) => console.warn("[ipd_billing] audit migration:", e.message));'
    once(tb, a1, "audit migration")
    tb = tb.replace(a1, a1 + "\n\n" + MIGRATION_JS)

    a2 = "const bedCharge = money(rate * stay.days);"
    once(tb, a2, "bedCharge line")
    tb = tb.replace(a2, BEDCHARGE_JS)

    a3 = "days: stay.days, bedRate: rate, bedCharge,"
    once(tb, a3, "bill return line")
    tb = tb.replace(a3, "days: stay.days, bedRate: rate, bedCharge, segments,")

    a4 = 'await pool.query("UPDATE inward_patients SET bed_rate=$1 WHERE id=$2", [money(r), stay.id]);'
    once(tb, a4, "settings bed rate line")
    tb = tb.replace(a4, SETTINGS_JS)

    s0 = "COALESCE(ip.bed_rate, (SELECT w.daily_rate FROM wards w WHERE w.hospital_id=ip.hospital_id AND w.name=ip.ward LIMIT 1), 0)"
    once(tb, s0, "summary bed expression")
    s = tb.index(s0)
    e = tb.index("AS bed,", s)
    if e - s > 500 or "admitted_at" not in tb[s:e]:
        fail("summary bed expression looks different from expected")
    old = tb[s:e].rstrip()
    new = ("CASE WHEN EXISTS (SELECT 1 FROM ipd_transfers tt WHERE tt.inward_id=ip.id) "
           "THEN COALESCE((SELECT SUM(g.seg_rate * g.seg_days) FROM ipd_bed_segments(ip.id) g), 0) "
           "ELSE " + old + " END ")
    tb = tb[:s] + new + tb[e:]
    out["ipd_billing.js"] = (tb, crlf_b)

if not out:
    print("Nothing to do")
    sys.exit(0)

for name, (text, crlf) in out.items():
    final = text.replace("\n", "\r\n") if crlf else text
    io.open(os.path.join(ROUTES, name), "w", encoding="utf-8", newline="").write(final)
    print("PATCHED " + name)
