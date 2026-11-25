"""
Backend (O-Backend): send the patient's area with
  - Front Office "Currently admitted" list   (GET /front-office/inward)
  - Front Office / Admin bed requests list   (GET /bed-bookings/hospital)
Run from the O-Backend folder:  python fix_location_backend.py
Stops without changing anything if the code differs from what is expected.
"""
import sys, pathlib

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ".")

def find(name):
    hits = [p for p in root.rglob(name) if "node_modules" not in p.parts and p.parent.name == "routes"]
    if len(hits) != 1:
        sys.exit(f"STOP: expected exactly one routes/{name}, found {len(hits)}. Run this from the O-Backend folder.")
    return hits[0]

def load(p):
    raw = p.read_bytes().decode("utf-8")
    return raw.replace("\r\n", "\n"), "\r\n" in raw

def save(p, s, crlf):
    p.write_bytes((s.replace("\n", "\r\n") if crlf else s).encode("utf-8"))

def rep(s, old, new, label):
    if s.count(old) != 1:
        sys.exit(f"STOP: '{label}' not found exactly once - nothing was changed.")
    return s.replace(old, new)

fo = find("front_office.js")
bb = find("bed_bookings.js")
fo_s, fo_crlf = load(fo)
bb_s, bb_crlf = load(bb)

if "AS area FROM inward_patients" in fo_s or "AS area FROM bed_bookings" in bb_s:
    sys.exit("Already patched - nothing to do.")

fo_s = rep(fo_s,
  "AS uhid FROM inward_patients WHERE hospital_id=$1 AND status='admitted' ORDER BY admitted_at DESC",
  "AS uhid, (SELECT area FROM users WHERE users.id=inward_patients.patient_user_id) AS area FROM inward_patients WHERE hospital_id=$1 AND status='admitted' ORDER BY admitted_at DESC",
  "front_office /inward query")

bb_s = rep(bb_s,
  """      `SELECT * FROM bed_bookings WHERE hospital_id=$1 AND status = ANY($2)
        ORDER BY CASE status WHEN 'requested' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, created_at DESC`,""",
  """      `SELECT bb.*, (SELECT u.area FROM users u WHERE u.id = bb.patient_user_id) AS area FROM bed_bookings bb WHERE bb.hospital_id=$1 AND bb.status = ANY($2)
        ORDER BY CASE bb.status WHEN 'requested' THEN 0 WHEN 'confirmed' THEN 1 ELSE 2 END, bb.created_at DESC`,""",
  "bed_bookings /hospital query")

save(fo, fo_s, fo_crlf)
save(bb, bb_s, bb_crlf)
print("Patched:", fo, "and", bb)
