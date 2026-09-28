FILE = "./O backend/src/db/init.js"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

old = '  "ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS token_number INTEGER",'
new = '''  "ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS token_number INTEGER",
  "ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS late_flag BOOLEAN NOT NULL DEFAULT FALSE",
  "ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS late_eta_minutes INTEGER",
  "ALTER TABLE lab_bookings ADD COLUMN IF NOT EXISTS late_marked_at TIMESTAMPTZ",'''

if old not in content:
    print("ERROR: Could not find target line in init.js. No changes made.")
    raise SystemExit(1)
content = content.replace(old, new, 1)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)
print("Success: late-tracking columns added to init.js")
