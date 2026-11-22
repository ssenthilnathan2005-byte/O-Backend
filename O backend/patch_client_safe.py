import sys, os, shutil, time
p = os.path.join(sys.argv[1] if len(sys.argv) > 1 else "src/routes", "ipd_billing.js")
s = open(p, encoding="utf-8").read()
a = "  const [hospR, itemsR, paysR, lrR, segR] = await Promise.all(["
b = '''  const par = (fns) => db.release
    ? fns.reduce((pr, f) => pr.then(async (acc) => { acc.push(await f()); return acc; }), Promise.resolve([]))
    : Promise.all(fns.map((f) => f()));
  const [hospR, itemsR, paysR, lrR, segR] = await par(['''
if s.count(a) != 1: print("FAILED anchor 1"); sys.exit(1)
s = s.replace(a, b)
rep = [
 ('    db.query("SELECT name, address, phone FROM hospitals WHERE id=$1", [stay.hospital_id]),',
  '    () => db.query("SELECT name, address, phone FROM hospitals WHERE id=$1", [stay.hospital_id]),'),
 ('    db.query("SELECT * FROM ipd_bill_items WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]),',
  '    () => db.query("SELECT * FROM ipd_bill_items WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]),'),
 ('    db.query("SELECT * FROM ipd_payments WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]),',
  '    () => db.query("SELECT * FROM ipd_payments WHERE inward_id=$1 ORDER BY created_at ASC", [stay.id]),'),
 ("    db.query(\"SELECT * FROM hospital_lab_orders WHERE inward_id=$1 AND status<>'cancelled' ORDER BY ordered_at ASC\", [stay.id]).catch(() => null),",
  "    () => db.query(\"SELECT * FROM hospital_lab_orders WHERE inward_id=$1 AND status<>'cancelled' ORDER BY ordered_at ASC\", [stay.id]).catch(() => null),"),
 ('    db.query("SELECT seg_no, seg_ward, seg_rate, seg_start::text AS seg_start, seg_days FROM ipd_bed_segments($1) ORDER BY seg_no", [stay.id]),\n  ]);',
  '    () => db.query("SELECT seg_no, seg_ward, seg_rate, seg_start::text AS seg_start, seg_days FROM ipd_bed_segments($1) ORDER BY seg_no", [stay.id]),\n  ]);'),
]
for o, n in rep:
    if s.count(o) != 1: print("FAILED anchor:", o[:50]); sys.exit(1)
    s = s.replace(o, n)
shutil.copy(p, p + ".bak-" + str(int(time.time())))
open(p, "w", encoding="utf-8").write(s)
print("patched ipd_billing.js")
