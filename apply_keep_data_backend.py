import os, re, shutil, sys

ROUTES = sys.argv[1] if len(sys.argv) > 1 else r"F:\O-Backend\O backend\src\routes"
PHARMACY = os.path.join(ROUTES, "pharmacy.js")
BOOKINGS = os.path.join(ROUTES, "bookings.js")
failed = False

for p in (PHARMACY, BOOKINGS):
    if not os.path.exists(p):
        print("Cannot find " + p)
        print("Run:  python apply_keep_data_backend.py \"<path to your routes folder>\"")
        sys.exit(1)


def load(p):
    with open(p, "r", encoding="utf-8", newline="") as f:
        raw = f.read()
    return raw.replace("\r\n", "\n"), ("\r\n" in raw)


def save(p, t, crlf):
    if crlf:
        t = t.replace("\n", "\r\n")
    with open(p, "w", encoding="utf-8", newline="") as f:
        f.write(t)


# ------------------------------------------------ patient prescriptions
print("Patching pharmacy.js (patient prescriptions)")
s, crlf = load(PHARMACY)

# whitespace-tolerant: matches the 6-day condition however the line is indented / spaced
clause = re.compile(r"\s*AND\s+created_at\s*>\s*NOW\s*\(\s*\)\s*-\s*INTERVAL\s*'\s*6\s+days?\s*'", re.I)
hits = list(clause.finditer(s))

if not hits:
    left = [(i, l) for i, l in enumerate(s.split("\n"), 1) if re.search(r"6\s*days?", l, re.I)]
    if left:
        failed = True
        print("  [FAIL] a 6-day filter exists but its text is different from expected. Lines:")
        for i, l in left:
            print("         line %d: %r" % (i, l))
    else:
        print("  [SKIP] no 6-day filter found (already patched)")
elif len(hits) > 1:
    failed = True
    print("  [FAIL] found %d 6-day filters; expected exactly 1. Lines containing it:" % len(hits))
    for i, line in enumerate(s.split("\n"), 1):
        if re.search(r"6\s+days?", line, re.I):
            print("         line %d: %r" % (i, line))
else:
    m = hits[0]
    before = s[max(0, m.start() - 400): m.start()]
    if "prescriptions" in before and "patient_id" in before:
        shutil.copyfile(PHARMACY, PHARMACY + ".bak")
        s = s[: m.start()] + s[m.end():]
        save(PHARMACY, s, crlf)
        print("  [OK]   removed the 6-day limit on GET /my (patient prescriptions)")
    else:
        failed = True
        print("  [FAIL] the 6-day filter is not in the patient prescriptions query. Text before it:")
        print("         " + repr(before[-250:]))

# ---------------------------------------------------- patient bookings
print("Patching bookings.js (patient bookings)")
s, crlf = load(BOOKINGS)
old = "WHERE patient_id=$1 AND archived = FALSE ORDER BY created_at DESC"
new = "WHERE patient_id=$1 ORDER BY created_at DESC"
if old in s:
    shutil.copyfile(BOOKINGS, BOOKINGS + ".bak")
    s = s.replace(old, new, 1)
    save(BOOKINGS, s, crlf)
    print("  [OK]   patient bookings no longer hide archived (older) bookings")
elif new in s:
    print("  [SKIP] already patched")
else:
    failed = True
    print("  [FAIL] could not find the patient bookings query - paste bookings.js lines 95-105 to Claude")

print()
if failed:
    print("Some steps FAILED. Paste this output to Claude.")
else:
    print("Done. Now redeploy / restart the backend so the change goes live.")
