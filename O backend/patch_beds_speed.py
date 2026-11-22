import sys, os, shutil, time
d = sys.argv[1] if len(sys.argv) > 1 else "src/routes"
ts = str(int(time.time()))

def patch(fname, pairs):
    p = os.path.join(d, fname)
    s = open(p, encoding="utf-8").read()
    for old, new in pairs:
        if s.count(old) != 1:
            print("FAILED, anchor not found exactly once in", fname, ":", old[:60]); sys.exit(1)
        s = s.replace(old, new)
    shutil.copy(p, p + ".bak-" + ts)
    open(p, "w", encoding="utf-8").write(s)
    print("patched", fname)

patch("ipd_billing.js", [(
'''  const { rows: hosp } = await db.query("SELECT name, address, phone FROM hospitals WHERE id=$1", [stay.hospital_id]);
  const { rows: items } = await db.query(
    "SELECT * FROM ipd_bill_items WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]);
  const { rows: pays } = await db.query(
    "SELECT * FROM ipd_payments WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]);
  let labTests = [];
  try {
    const lr = await db.query(
      "SELECT * FROM hospital_lab_orders WHERE inward_id=$1 AND status<>'cancelled' ORDER BY ordered_at ASC", [stay.id]);
    labTests = lr.rows.map((r) => ({''',
'''  const [hospR, itemsR, paysR, lrR, segR] = await Promise.all([
    db.query("SELECT name, address, phone FROM hospitals WHERE id=$1", [stay.hospital_id]),
    db.query("SELECT * FROM ipd_bill_items WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]),
    db.query("SELECT * FROM ipd_payments WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]),
    db.query("SELECT * FROM hospital_lab_orders WHERE inward_id=$1 AND status<>'cancelled' ORDER BY ordered_at ASC", [stay.id]).catch(() => null),
    db.query("SELECT seg_no, seg_ward, seg_rate, seg_start::text AS seg_start, seg_days FROM ipd_bed_segments($1) ORDER BY seg_no", [stay.id]),
  ]);
  const hosp = hospR.rows, items = itemsR.rows, pays = paysR.rows;
  let labTests = [];
  try {
    const lr = lrR || { rows: [] };
    labTests = lr.rows.map((r) => ({'''),
(
'''  const { rows: segRows } = await db.query(
    "SELECT seg_no, seg_ward, seg_rate, seg_start::text AS seg_start, seg_days FROM ipd_bed_segments($1) ORDER BY seg_no", [stay.id]);
''',
'''  const segRows = segR.rows;
''')])

patch("wards.js", [(
'''    for (const r of rows) {
      r.bill_paid = null; r.bill_balance = null; r.bill_total = null;
      if (r.status === "occupied" && r.inward_id) {
        try {
          const bs = await ipdBilling.billStatus(pool, r.inward_id, hospitalId);
          if (bs) { r.bill_paid = bs.isPaid; r.bill_balance = bs.balance; r.bill_total = bs.total; }
        } catch (_) {}
      }
    }
    res.json(rows);''',
'''    for (const r of rows) { r.bill_paid = null; r.bill_balance = null; r.bill_total = null; }
    const occ = rows.filter((r) => r.status === "occupied" && r.inward_id);
    for (let i = 0; i < occ.length; i += 2) {
      await Promise.all(occ.slice(i, i + 2).map(async (r) => {
        try {
          const bs = await ipdBilling.billStatus(pool, r.inward_id, hospitalId);
          if (bs) { r.bill_paid = bs.isPaid; r.bill_balance = bs.balance; r.bill_total = bs.total; }
        } catch (_) {}
      }));
    }
    res.json(rows);''')])
