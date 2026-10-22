const fs = require("fs"), path = require("path");
const root = process.cwd();
const rd = p => fs.readFileSync(path.join(root, p), "utf8");
const wr = (p, s) => fs.writeFileSync(path.join(root, p), s, "utf8");
const bak = p => { const b = path.join(root, p + ".bak-family"); if (!fs.existsSync(b)) fs.copyFileSync(path.join(root, p), b); };

const NEWSQL = `"SELECT id FROM bookings WHERE session_id=$1 AND patient_id=$2 AND status!='cancelled' AND lower(btrim(patient_name))=lower(btrim($3)) AND (patient_year_of_birth IS NULL OR $4::int IS NULL OR patient_year_of_birth=$4::int)"`;
const DUPRE = /"SELECT id FROM bookings WHERE session_id=\$1 AND patient_id=\$2 AND status!='cancelled'",\s*\[sessionId, req\.user\.id\]/g;
const OLDMSG = /You already have a booking in this session/g;
const NEWMSG = "You already have a booking for this patient in this session";

function patch(file, paramsList) {
  let s = rd(file); let n = 0;
  s = s.replace(DUPRE, () => {
    const p = paramsList[n++];
    if (!p) throw new Error("unexpected extra duplicate check in " + file);
    return NEWSQL + ",\n        [sessionId, req.user.id, " + p + "]";
  });
  if (n !== paramsList.length) throw new Error(file + ": expected " + paramsList.length + " duplicate checks, found " + n);
  s = s.replace(OLDMSG, NEWMSG);
  bak(file); wr(file, s); console.log("patched", file, n);
}

patch("src/routes/bookings.js", [
  `(submittedName || patient?.name || "Unknown"), birthYearFrom(req.body)`
]);
patch("src/routes/payments.js", [
  `(submittedName || (await pool.query("SELECT name FROM users WHERE id=$1", [req.user.id])).rows[0]?.name || ""), birthYearFrom(req.body)`,
  `(submittedName || patient.name), birthYearFrom(req.body)`
]);

let ix = rd("src/index.js");
if (!ix.includes("family_members")) {
  const re = /app\.use\("\/api\/patients",\s+patientRoutes\);/;
  if (!re.test(ix)) throw new Error("patients mount line not found in index.js");
  ix = ix.replace(re, m => m + '\napp.use("/api/family-members", require("./routes/family_members"));');
  bak("src/index.js"); wr("src/index.js", ix); console.log("patched src/index.js");
}