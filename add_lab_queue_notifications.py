FILE = "./O backend/src/routes/labs.js"

with open(FILE, "r", encoding="utf-8") as f:
    content = f.read()

old_block = '''    if (action === "call") {
      const clicked = reqTok ?? next ?? pickNext(statuses, null);
      if (!Number.isInteger(clicked) || statuses[clicked] === undefined) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "No valid token to call" });
      }
      if (current !== null && current !== clicked) statuses[current] = "green";
      statuses[clicked] = "orange";
      current = clicked;
      if (next !== null && statuses[next] === "yellow") statuses[next] = "red";
      next = pickNext(statuses, clicked);
      if (next !== null) statuses[next] = "yellow";
    } else if (action === "complete") {'''

new_block = '''    let calledToken = null;
    let readyNextToken = null;

    if (action === "call") {
      const clicked = reqTok ?? next ?? pickNext(statuses, null);
      if (!Number.isInteger(clicked) || statuses[clicked] === undefined) {
        await client.query("ROLLBACK");
        return res.status(400).json({ error: "No valid token to call" });
      }
      if (current !== null && current !== clicked) statuses[current] = "green";
      statuses[clicked] = "orange";
      current = clicked;
      if (next !== null && statuses[next] === "yellow") statuses[next] = "red";
      next = pickNext(statuses, clicked);
      if (next !== null) statuses[next] = "yellow";
      calledToken = clicked;
      readyNextToken = next;
    } else if (action === "complete") {'''

if old_block not in content:
    print("ERROR: Could not find the 'call' action block to patch. No changes made.")
    raise SystemExit(1)
content = content.replace(old_block, new_block, 1)

old_commit = '''    await client.query("COMMIT");
    const state = parseLabSession(up[0]);
    broadcast(sid, { type: "state_update", state });
    res.json(state);'''

new_commit = '''    await client.query("COMMIT");
    const state = parseLabSession(up[0]);
    broadcast(sid, { type: "state_update", state });
    res.json(state);

    if (calledToken !== null || readyNextToken !== null) {
      (async () => {
        try {
          const { rows: labRows } = await pool.query(
            `SELECT l.name AS lab_name, t.name AS test_name FROM labs l, lab_tests t WHERE l.id=$1 AND t.id=$2`,
            [labId, testId]
          );
          const labName = labRows[0]?.lab_name || "the lab";
          const testName = labRows[0]?.test_name || "your test";

          if (calledToken !== null) {
            const { rows: br } = await pool.query(
              `SELECT patient_id FROM lab_bookings
               WHERE lab_id=$1 AND test_id=$2 AND slot_date=$3 AND slot_time=$4
                 AND token_number=$5 AND status NOT IN ('cancelled') LIMIT 1`,
              [labId, testId, date, session, calledToken]
            );
            const b = br[0];
            if (b && b.patient_id) {
              sendPushToPatient(b.patient_id, {
                title: "Your turn has arrived!",
                body: `Token #${calledToken} - ${labName} is ready for your ${testName} sample collection.`,
                data: { tag: "lab-token-orange" },
              }).catch(() => {});
            }
          }

          if (readyNextToken !== null) {
            const { rows: nr } = await pool.query(
              `SELECT patient_id FROM lab_bookings
               WHERE lab_id=$1 AND test_id=$2 AND slot_date=$3 AND slot_time=$4
                 AND token_number=$5 AND status NOT IN ('cancelled') LIMIT 1`,
              [labId, testId, date, session, readyNextToken]
            );
            const nb = nr[0];
            if (nb && nb.patient_id) {
              sendPushToPatient(nb.patient_id, {
                title: "Get Ready!",
                body: `Token #${readyNextToken} - You are next at ${labName}. Please be ready.`,
                data: { tag: "lab-token-yellow" },
              }).catch(() => {});
            }
          }
        } catch (e) {
          console.error("[labs] queue notification error:", e.message);
        }
      })();
    }'''

if old_commit not in content:
    print("ERROR: Could not find the commit/response block to patch. No changes made.")
    raise SystemExit(1)
content = content.replace(old_commit, new_commit, 1)

with open(FILE, "w", encoding="utf-8") as f:
    f.write(content)

print("Success: lab queue call/next-up push notifications added to labs.js")
