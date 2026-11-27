"use strict";
// Supabase Storage through its REST API (no extra package). Files live in a PRIVATE bucket and are only ever
// handed to the browser as short-lived signed links.
const BUCKET = process.env.SUPABASE_STAFF_BUCKET || "staff-documents";

function cfg() {
  const url = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_KEY || "";
  if (!url || !key) {
    const e = new Error("File storage is not set up yet (SUPABASE_URL / SUPABASE_SERVICE_KEY missing on the server).");
    e.status = 503; throw e;
  }
  return { url, key };
}
const enc = p => String(p).split("/").map(encodeURIComponent).join("/");
const hdr = (key, extra) => Object.assign({ Authorization: "Bearer " + key, apikey: key }, extra || {});

async function upload(path, buffer, contentType) {
  const { url, key } = cfg();
  const r = await fetch(`${url}/storage/v1/object/${BUCKET}/${enc(path)}`, {
    method: "POST",
    headers: hdr(key, { "Content-Type": contentType || "application/octet-stream", "x-upsert": "true" }),
    body: buffer,
  });
  if (!r.ok) throw new Error("Storage upload failed (" + r.status + "): " + (await r.text()).slice(0, 200));
}

async function signedUrl(path, seconds) {
  const { url, key } = cfg();
  const r = await fetch(`${url}/storage/v1/object/sign/${BUCKET}/${enc(path)}`, {
    method: "POST",
    headers: hdr(key, { "Content-Type": "application/json" }),
    body: JSON.stringify({ expiresIn: seconds || 300 }),
  });
  if (!r.ok) throw new Error("Storage link failed (" + r.status + "): " + (await r.text()).slice(0, 200));
  const j = await r.json();
  const s = j.signedURL || j.signedUrl;
  if (!s) throw new Error("Storage did not return a link");
  return /^https?:/i.test(s) ? s : `${url}/storage/v1${s.startsWith("/") ? "" : "/"}${s}`;
}

async function remove(path) {
  try {
    const { url, key } = cfg();
    await fetch(`${url}/storage/v1/object/${BUCKET}/${enc(path)}`, { method: "DELETE", headers: hdr(key) });
  } catch (e) { console.warn("[staff-storage] delete:", e.message); }
}

module.exports = { upload, signedUrl, remove, BUCKET };
