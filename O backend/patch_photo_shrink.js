// Run from the backend folder (the one that contains "src"):  node patch_photo_shrink.js
// Makes new hospital photo uploads get shrunk (max 1000 px wide, JPEG 75%) before they are saved,
// and puts the new photo straight into the server's photo cache so Supabase is not re-read.
// Stops WITHOUT changing anything if the file does not look exactly as expected.
const fs = require("fs");
const path = require("path");

const file = path.join(process.cwd(), "src", "routes", "hospitals.js");
function stop(msg) { console.error("STOPPED (nothing changed): " + msg); process.exit(1); }
if (!fs.existsSync(file)) stop("src/routes/hospitals.js not found. Run this from the folder that contains 'src'.");

let s = fs.readFileSync(file, "utf8");
if (s.includes("shrinkToDataUrl")) stop("hospitals.js already contains the photo shrinking code.");
const eol = s.includes("\r\n") ? "\r\n" : "\n";

function count(str) { return s.split(str).length - 1; }
function replaceExactly(from, to, expected, label) {
  const n = count(from);
  if (n !== expected) stop("expected " + expected + " match(es) for '" + label + "' but found " + n + ".");
  s = s.split(from).join(to);
}

const photoMemLine = "const photoMem = new Map(); // hospital id -> { v, type, buf }";
const helper = [
  'const sharp = require("sharp");',
  "// Shrink uploaded photos so every later read from Supabase is small.",
  "async function shrinkToDataUrl(buf, mimetype) {",
  "  try {",
  "    const out = await sharp(buf).rotate()",
  "      .resize({ width: 1000, withoutEnlargement: true })",
  '      .flatten({ background: "#ffffff" })',
  "      .jpeg({ quality: 75, mozjpeg: true }).toBuffer();",
  '    if (out.length < buf.length) return "data:image/jpeg;base64," + out.toString("base64");',
  "  } catch (e) {",
  '    console.error("[hospitals photo] shrink failed, keeping original:", e.message);',
  "  }",
  '  return "data:" + mimetype + ";base64," + buf.toString("base64");',
  "}",
  "async function shrinkDataUrl(dataUrl) {",
  "  const m = /^data:([^;,]+);base64,([\\s\\S]*)$/.exec(dataUrl);",
  "  if (!m) return dataUrl;",
  '  return shrinkToDataUrl(Buffer.from(m[2], "base64"), m[1]);',
  "}",
  "// Put a freshly saved photo straight into the memory cache (no re-read from Supabase).",
  "function seedPhotoCache(id, dataUrl) {",
  "  const m = /^data:([^;,]+);base64,([\\s\\S]*)$/.exec(dataUrl);",
  "  if (!m) { photoMem.delete(String(id)); return; }",
  "  photoMem.set(String(id), {",
  '    v: crypto.createHash("md5").update(dataUrl, "utf8").digest("hex").slice(0, 10),',
  '    type: m[1], buf: Buffer.from(m[2], "base64"),',
  "  });",
  "}",
].join(eol);

if (/\bconst sharp\b/.test(s)) stop("hospitals.js already declares 'sharp'.");

replaceExactly(photoMemLine, photoMemLine + eol + helper, 1, "photoMem line");

replaceExactly(
  'const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;',
  "const base64 = await shrinkToDataUrl(req.file.buffer, req.file.mimetype);",
  1, "multipart upload base64 line"
);

replaceExactly("const { base64 } = req.body;", "let { base64 } = req.body;", 1, "photo-base64 body line");

replaceExactly(
  'return res.status(400).json({ error: "Invalid base64 image data" });',
  'return res.status(400).json({ error: "Invalid base64 image data" });' + eol + "    base64 = await shrinkDataUrl(base64);",
  1, "photo-base64 validation line"
);

replaceExactly(
  "[base64, req.params.id]); photoMem.delete(req.params.id);",
  "[base64, req.params.id]); seedPhotoCache(req.params.id, base64);",
  2, "photo UPDATE lines"
);

fs.copyFileSync(file, file + ".bak_shrink");
fs.writeFileSync(file, s);
console.log("Done. Backup: src/routes/hospitals.js.bak_shrink");
console.log("Check with:  Select-String -Path src\\routes\\hospitals.js -Pattern 'shrinkToDataUrl|shrinkDataUrl|seedPhotoCache'");
