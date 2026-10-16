"use strict";
// Reads a photo / screenshot of a supplier invoice (JPG, PNG) with a vision model and feeds the table
// to the same normaliser + parser the PDF and Excel imports use. Needs ANTHROPIC_API_KEY in the server env.
const { normalizeTable } = require("./pdfImport");
const { parseSheet } = require("./universalImport");

const MODEL = process.env.IMAGE_IMPORT_MODEL || "claude-sonnet-5-5";
const MAX_BYTES = 5 * 1024 * 1024; // the vision API accepts images up to 5 MB

const PROMPT = [
  "You read a photo or scan of a pharmacy supplier invoice / stock list and return its table as JSON.",
  "Return ONLY JSON, no text around it, in this shape:",
  '{"supplier":"","invoiceNo":"","items":[{"name":"","category":"","strength":"","qty":0,"unit":"","pack":"","batch":"","expiry":"","cost":0,"costBasis":"","mrp":0,"mrpBasis":""}]}',
  "Rules:",
  "- Copy only what is printed. If a value is not visible or unreadable, use an empty string (or null for numbers). Never guess or calculate.",
  "- name: medicine name only. strength like '500 mg'. category like Tablet, Syrup/Tonic, Drops, Ointment/Cream, Injection, Capsule when printed.",
  "- qty: the ordered / stock quantity as a number. unit: Box, Carton, Strip, Bottle, etc. as printed.",
  "- pack: packing text like '10 strips x 10 tablets' or '10 bottles x 100 ml' when printed, else ''.",
  "- expiry: YYYY-MM-DD. If only month and year are printed, use the last day of that month.",
  "- cost / mrp: numbers without currency symbols. costBasis / mrpBasis: what the price is per (Box, Strip, Tablet, Bottle...) if printed, else ''.",
  "- One item per medicine line. Skip totals, tax lines, notes and signatures.",
].join("\n");

function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  return null;
}

// Build the same raw table a PDF would give, then let normalizeTable turn it into the Excel layout.
function buildRows(data) {
  const items = Array.isArray(data && data.items) ? data.items.slice(0, 200) : [];
  const str = v => (v == null ? "" : String(v).trim());
  const price = (n, b) => (n == null || n === "" || isNaN(Number(n)) ? "" : "Rs " + Number(n) + (str(b) ? " / " + str(b) : ""));
  const rows = [
    ["Supplier", str(data && data.supplier), "Invoice No.", str(data && data.invoiceNo)],
    [],
    ["Item / Medicine", "Category", "Strength", "Qty", "Unit", "Pack / Conversion", "Batch", "Expiry", "Cost / Basis", "MRP / Basis"],
  ];
  for (const it of items) {
    if (!str(it.name)) continue;
    const q = Number(it.qty);
    rows.push([str(it.name), str(it.category), str(it.strength), isFinite(q) && it.qty !== "" && it.qty != null ? String(q) : "",
      str(it.unit), str(it.pack), str(it.batch), str(it.expiry), price(it.cost, it.costBasis), price(it.mrp, it.mrpBasis)]);
  }
  return rows;
}

async function readImage(buf, mime, opts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key && !(opts && opts.fetchImpl)) { const e = new Error("Image import is not configured on the server yet."); e.code = "no_key"; throw e; }
  const f = (opts && opts.fetchImpl) || fetch;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  let res;
  try {
    res = await f("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": key || "test", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: MODEL, max_tokens: 4000,
        messages: [{ role: "user", content: [
          { type: "image", source: { type: "base64", media_type: mime, data: buf.toString("base64") } },
          { type: "text", text: PROMPT } ] }],
      }),
    });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? "Reading the image took too long. Please try a smaller or clearer image." : "Could not reach the image reader. Please try again.");
  } finally { clearTimeout(timer); }
  if (!res.ok) throw new Error("The image reader returned an error (" + res.status + "). Please try again, or upload the PDF / Excel version.");
  const body = await res.json();
  const text = (body.content || []).map(c => c.text || "").join("").replace(/```json|```/g, "").trim();
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  try { return JSON.parse(text.slice(a, b + 1)); }
  catch (e) { throw new Error("Could not read a table from this image. Please upload a clearer, straight-on photo, or the PDF / Excel version."); }
}

async function parseImageImport(buf, opts) {
  const mime = sniff(buf);
  if (!mime) throw new Error("This file is not a valid JPG or PNG image.");
  if (buf.length > MAX_BYTES) throw new Error("Image is larger than 5 MB. Please use a smaller photo or a PDF.");
  const data = await readImage(buf, mime, opts);
  const rows = normalizeTable(buildRows(data));
  const out = parseSheet(rows, "Image");
  if (!out || !out.rows || !out.rows.length) throw new Error("No medicine rows were found in this image. Please upload a clearer image or the PDF / Excel version.");
  out.parser = "universal";
  out.format = "image";
  out.needsCheck = true; // values come from reading a picture: the review screen is where they get verified
  return out;
}

module.exports = { parseImageImport, buildRows, sniff };
