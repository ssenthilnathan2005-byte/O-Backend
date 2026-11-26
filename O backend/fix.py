p = r'F:\O-Backend\O backend\src\routes\front_office.js'
s = open(p, encoding='utf-8').read()
old = '  await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS checked_in_by TEXT");'
if s.count(old) != 1: print("ERROR anchor"); exit(1)
s = s.replace(old, old + '\n  await pool.query("UPDATE bookings SET checked_in_at=now() WHERE booking_source=\'front_desk\' AND status=\'confirmed\' AND checked_in_at IS NULL");')
open(p, 'w', encoding='utf-8').write(s)
print("Done")
