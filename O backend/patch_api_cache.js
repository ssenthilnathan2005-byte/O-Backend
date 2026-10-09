// Run from the backend folder (the one that contains "src"):  node patch_api_cache.js
// Installs src/utils/apiCache.js and wires it into src/index.js. Makes a backup first.
// If anything looks unexpected it stops WITHOUT changing any file.
const fs = require("fs");
const path = require("path");

const root = process.cwd();
const indexPath = path.join(root, "src", "index.js");
const utilSrc = path.join(root, "apiCache.js");
const utilDst = path.join(root, "src", "utils", "apiCache.js");

function stop(msg) { console.error("STOPPED (nothing changed): " + msg); process.exit(1); }

if (!fs.existsSync(indexPath)) stop("src/index.js not found. Run this from the folder that contains 'src'.");
if (!fs.existsSync(utilSrc)) stop("apiCache.js must be in this folder next to patch_api_cache.js.");

const original = fs.readFileSync(indexPath, "utf8");
if (original.includes("utils/apiCache")) stop("src/index.js already contains the cache. Nothing to do.");

const eol = original.includes("\r\n") ? "\r\n" : "\n";
const lines = original.split(/\r?\n/);

// 1) first line that mounts any /api router -> clear cache on writes before every router
const firstApi = lines.findIndex((l) => /^\s*app\.use\(\s*["'`]\/api\//.test(l));
// 2) the line that mounts bookings -> cache GETs just before it
const bookingsLine = lines.findIndex((l) => /^\s*app\.use\(\s*["'`]\/api\/bookings["'`]/.test(l));
const patientsLine = lines.findIndex((l) => /^\s*app\.use\(\s*["'`]\/api\/patients["'`]/.test(l));

if (firstApi < 0) stop("could not find any app.use(\"/api/...\") line in src/index.js. Send me: Select-String -Path src\\index.js -Pattern 'app\\.use'");
if (bookingsLine < 0) stop("could not find the app.use(\"/api/bookings\" ...) line. Send me: Select-String -Path src\\index.js -Pattern 'app\\.use'");

const indent = (l) => (l.match(/^\s*/) || [""])[0];

// insert from the bottom up so earlier line numbers stay valid
const inserts = [];
inserts.push({
  at: bookingsLine,
  text: [
    indent(lines[bookingsLine]) + 'app.use("/api/bookings", apiCache.cacheGet(30000));',
  ],
});
if (patientsLine >= 0) {
  inserts.push({
    at: patientsLine,
    text: [
      indent(lines[patientsLine]) + 'app.use("/api/patients", apiCache.cacheGet(60000, (r) => r.path === "/"));',
    ],
  });
}
inserts.push({
  at: firstApi,
  text: [
    indent(lines[firstApi]) + 'const apiCache = require("./utils/apiCache");',
    indent(lines[firstApi]) + "app.use(apiCache.invalidateOnWrite);",
  ],
});

// the require/invalidate lines must come BEFORE the cacheGet lines
if (firstApi > Math.min(bookingsLine, patientsLine >= 0 ? patientsLine : bookingsLine)) {
  // first /api mount is after bookings: put everything at the bookings line instead
  inserts.length = 0;
  const at = Math.min(bookingsLine, patientsLine >= 0 ? patientsLine : bookingsLine);
  inserts.push({
    at,
    text: [
      indent(lines[at]) + 'const apiCache = require("./utils/apiCache");',
      indent(lines[at]) + "app.use(apiCache.invalidateOnWrite);",
      indent(lines[at]) + 'app.use("/api/bookings", apiCache.cacheGet(30000));',
      indent(lines[at]) + 'app.use("/api/patients", apiCache.cacheGet(60000, (r) => r.path === "/"));',
    ],
  });
  console.log("NOTE: routers mounted before bookings may not clear the cache; tell me and I will adjust.");
}

inserts.sort((a, b) => b.at - a.at).forEach((ins) => lines.splice(ins.at, 0, ...ins.text));

// everything checked -> now write files
fs.mkdirSync(path.dirname(utilDst), { recursive: true });
fs.copyFileSync(utilSrc, utilDst);
fs.copyFileSync(indexPath, indexPath + ".bak_apicache");
fs.writeFileSync(indexPath, lines.join(eol));
console.log("Done. Backup: src/index.js.bak_apicache");
console.log("Check the result with:  Select-String -Path src\\index.js -Pattern 'apiCache'");
