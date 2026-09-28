import re

FILE = "./O backend/src/routes/labs.js"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

old_import = '''const { broadcast } = require("../services/ws");'''
new_import = '''const { broadcast } = require("../services/ws");
const { sendPushToPatient } = require("../services/push");'''

if old_import not in content:
    print("ERROR: Could not find the import line to patch. No changes made.")
    raise SystemExit(1)

content = content.replace(old_import, new_import, 1)

old_block = '''    const updated = rows[0];
    if (status === "cancelled" && updated.token_number != null) {
      try { await releaseCancelledToken(updated); } catch (e) { console.error("[labs] cancel queue cleanup error:", e.message); }
    }
    res.json(updated);'''

new_block = '''    const updated = rows[0];
    if (status === "cancelled" && updated.token_number != null) {
      try { await releaseCancelledToken(updated); } catch (e) { console.error("[labs] cancel queue cleanup error:", e.message); }
    }

    if (status === "report_ready" && updated.patient_id) {
      try {
        const { rows: info } = await pool.query(
          `SELECT l.name AS lab_name, t.name AS test_name
           FROM lab_bookings b
           JOIN labs l ON l.id = b.lab_id
           JOIN lab_tests t ON t.id = b.test_id
           WHERE b.id = $1`,
          [updated.id]
        );
        const labName = info[0]?.lab_name || "the lab";
        const testName = info[0]?.test_name || "Your test";
        await sendPushToPatient(updated.patient_id, {
          title: "Report Ready",
          body: `${testName} report from ${labName} is ready to view.`,
          data: { link: `/labs/track?bookingId=${updated.id}` },
        });
      } catch (e) {
        console.error("[labs] report_ready push notification error:", e.message);
      }
    }

    res.json(updated);'''

if old_block not in content:
    print("ERROR: Could not find the status-update response block to patch. No changes made.")
    raise SystemExit(1)

content = content.replace(old_block, new_block, 1)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("Success: report_ready push notification added to labs.js")
