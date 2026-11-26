"""
Backend (O-Backend): save the Address typed on
  - Front Office > Admit inpatient   (POST /front-office/admit)
  - Front Office > Register patient  (POST /front-office/walkin)
It is stored on the patient's account (users.area), the same place the
"Area" lines in Currently admitted / Bed requests read from. For an existing
patient it only fills the account's address if it is empty, so it never
overwrites an address the patient saved themselves.
No database change needed (users.area already exists).
Run from the O-Backend folder:  python fix_address_backend.py
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
s, crlf = load(fo)
if "SET area=$1 WHERE id=$2 AND (area IS NULL" in s:
    sys.exit("Already patched - nothing to do.")

FILL = 'await client.query("UPDATE users SET area=$1 WHERE id=$2 AND (area IS NULL OR area=\'\')", [area, %s]);'

# ---- /admit ----
s = rep(s,
  'if (!b.wardId || !b.bedId) return res.status(400).json({ error: "Choose a ward and bed" });',
  'if (!b.wardId || !b.bedId) return res.status(400).json({ error: "Choose a ward and bed" });\n    const area = String(b.area || "").trim().slice(0, 200) || null;',
  "admit: read address")
s = rep(s,
  'patientUserId = acc.id; uhid = acc.uhid;',
  'patientUserId = acc.id; uhid = acc.uhid;\n      if (area) ' + FILL % "acc.id",
  "admit: fill existing account")
s = rep(s,
  'await client.query("INSERT INTO users (id, name, role, walkin_hospital_id, age, gender) VALUES ($1,$2,\'patient\',$3,$4,$5)", [patientUserId, name, hid, age, b.gender || null]);',
  'await client.query("INSERT INTO users (id, name, role, walkin_hospital_id, age, gender, area) VALUES ($1,$2,\'patient\',$3,$4,$5,$6)", [patientUserId, name, hid, age, b.gender || null, area]);',
  "admit: new account insert")

# ---- /walkin ----
s = rep(s,
  'if (!b.doctorId) return res.status(400).json({ error: "Choose a doctor" });',
  'if (!b.doctorId) return res.status(400).json({ error: "Choose a doctor" });\n    const area = String(b.patientArea || "").trim().slice(0, 200) || null;',
  "walkin: read address")
s = rep(s,
  'patientId = acc.id; uhid = acc.uhid; name = acc.name || name;',
  'patientId = acc.id; uhid = acc.uhid; name = acc.name || name;\n      if (area) ' + FILL % "acc.id",
  "walkin: fill existing account")
s = rep(s,
  'await client.query("INSERT INTO users (id, name, role, walkin_hospital_id, age, gender, phone) VALUES ($1,$2,\'patient\',$3,$4,$5,$6)", [patientId, name, hid, age, ["Male", "Female", "Other"].includes(b.patientGender) ? b.patientGender : null, phone]);',
  'await client.query("INSERT INTO users (id, name, role, walkin_hospital_id, age, gender, phone, area) VALUES ($1,$2,\'patient\',$3,$4,$5,$6,$7)", [patientId, name, hid, age, ["Male", "Female", "Other"].includes(b.patientGender) ? b.patientGender : null, phone, area]);',
  "walkin: new account insert")

save(fo, s, crlf)
print("Patched:", fo)
