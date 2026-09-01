"use strict";
const cache = require("../utils/cache");
"use strict";
const express = require("express");
const { pool } = require("../db/init");
const { requireAdmin, requireAdminOrHospitalAdmin } = require("../middleware/auth");
const multer  = require("multer");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: (Number(process.env.MAX_FILE_SIZE_MB) || 5) * 1024 * 1024 },
  fileFilter: (_req, file, cb) =>
    file.mimetype.startsWith("image/") ? cb(null, true) : cb(new Error("Images only")),
});

// includePhoto=false skips the (potentially huge) base64 photo_data blob —
// used for list views where we don't want to drag megabytes per row.
async function row2hospital(r, req, includePhoto = true) {
  if (!r) return null;
  const { rows } = await pool.query("SELECT COUNT(*) as c FROM doctors WHERE hospital_id=$1", [r.id]);
  const doctorCount = Number(rows[0].c);

  let photoUrl = null;
  if (includePhoto && r.photo_data) {
    photoUrl = r.photo_data;
  } else if (r.photo_url) {
    if (r.photo_url.startsWith("http")) {
      photoUrl = r.photo_url;
    } else {
      const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
      const host  = req.headers["x-forwarded-host"] || req.headers.host || "";
      photoUrl = `${proto}://${host}${r.photo_url}`;
    }
  }

  return {
    id: r.id, name: r.name, area: r.area,
    address: r.address || "", phone: r.phone || "",
    rating: r.rating, gradient: r.gradient,
    photoUrl,
    isFree: r.is_free === 1,
    hasPharmacy: r.has_pharmacy === 1,
    doctorCount,
  };
}


// ── Simple in-memory cache for hospital list ───────────────────────────────
// Hospitals rarely change, so we cache for 60s to avoid hitting the DB
// (which requires a network round-trip to Supabase Tokyo) on every request.
let hospitalListCache = null;
let hospitalListCacheTime = 0;
const HOSPITAL_CACHE_TTL_MS = 0; // always fresh

function invalidateHospitalCache() {
  hospitalListCache = null;
}

// ── GET all hospitals ─────────────────────────────────────────────────────────
// Excludes photo_data (big base64 blob) — this was the main lag/egress cause.
router.get("/", async (req, res) => {
  try {
    const now = Date.now();
    if (hospitalListCache && (now - hospitalListCacheTime) < HOSPITAL_CACHE_TTL_MS) {
      return res.json(hospitalListCache);
    }

    const { rows } = await pool.query(
      "SELECT id, name, area, address, phone, rating, gradient, photo_url, is_free, has_pharmacy FROM hospitals ORDER BY name ASC"
    );

    // Batch doctor counts in ONE query instead of one query per hospital (fixes N+1)
    const { rows: countRows } = await pool.query(
      "SELECT hospital_id, COUNT(*) as c FROM doctors GROUP BY hospital_id"
    );
    const countMap = {};
    countRows.forEach(cr => { countMap[cr.hospital_id] = Number(cr.c); });

    const result = rows.map(r => {
      let photoUrl = null;
      if (r.photo_data) {
        photoUrl = r.photo_data;
      } else if (r.photo_url) {
        if (r.photo_url.startsWith("http")) {
          photoUrl = r.photo_url;
        } else {
          const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
          const host  = req.headers["x-forwarded-host"] || req.headers.host || "";
          photoUrl = `${proto}://${host}${r.photo_url}`;
        }
      }
      return {
        id: r.id, name: r.name, area: r.area,
        address: r.address || "", phone: r.phone || "",
        rating: r.rating, gradient: r.gradient,
        photoUrl,
        isFree: r.is_free === 1,
        hasPharmacy: r.has_pharmacy === 1,
        doctorCount: countMap[r.id] || 0,
      };
    });

    hospitalListCache = result;
    hospitalListCacheTime = Date.now();
    res.set("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error("[hospitals GET /]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET single hospital ───────────────────────────────────────────────────────
// Full photo included here — it's just one row, not a big deal.
router.get("/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM hospitals WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Hospital not found" });
    invalidateHospitalCache();
    res.json(await row2hospital(rows[0], req, true));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST create hospital ──────────────────────────────────────────────────────
router.post("/", requireAdmin, async (req, res) => {
  try {
    const { name, area, address = "", phone = "", gradient = "from-slate-400 to-slate-600", loginId } = req.body;
    if (!name || !area) return res.status(400).json({ error: "name and area are required" });

    const id = `h_${Date.now()}`;
    await pool.query(
      "INSERT INTO hospitals (id, name, area, address, phone, gradient) VALUES ($1,$2,$3,$4,$5,$6)",
      [id, name, area, address, phone, gradient]
    );

    // Optional: create a hospital_admin login for this hospital right away.
    // The account starts with no password (first_login=1) — the hospital
    // staff sets their own password the first time they log in with loginId.
    if (loginId) {
      const trimmedLoginId = String(loginId).trim();
      const { rows: existing } = await pool.query("SELECT id FROM hospitals WHERE login_id=$1", [trimmedLoginId]);
      if (existing[0]) return res.status(409).json({ error: "Login ID already taken" });

      const adminUserId = `ha_${Date.now()}`;
      await pool.query(
        "INSERT INTO users (id, name, password, role, first_login) VALUES ($1,$2,$3,'hospital_admin',1)",
        [adminUserId, `${name} Admin`, ""]
      );
      await pool.query("UPDATE hospitals SET login_id=$1, admin_user_id=$2 WHERE id=$3", [trimmedLoginId, adminUserId, id]);
    }

    const { rows } = await pool.query("SELECT * FROM hospitals WHERE id=$1", [id]);
    invalidateHospitalCache();
    res.status(201).json({ ...(await row2hospital(rows[0], req, true)), loginId: rows[0].login_id || null });
  } catch (err) {
    console.error("[hospitals POST]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── GET hospital admin login info (super admin only) ──────────────────────────
router.get("/:id/admin-info", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT h.login_id, h.admin_user_id, u.first_login
       FROM hospitals h LEFT JOIN users u ON u.id = h.admin_user_id
       WHERE h.id=$1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Hospital not found" });
    const r = rows[0];
    res.json({
      loginId: r.login_id || null,
      hasAdminAccount: !!r.admin_user_id,
      firstLogin: r.first_login === 1,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST reset hospital admin credentials (super admin only) ──────────────────
// Forces the hospital admin back into "set a new password" mode — useful if
// they're locked out or the login was compromised. Optionally rotates loginId.
router.post("/:id/reset-login", requireAdmin, async (req, res) => {
  try {
    const { rows: hospRows } = await pool.query("SELECT * FROM hospitals WHERE id=$1", [req.params.id]);
    const hospital = hospRows[0];
    if (!hospital) return res.status(404).json({ error: "Hospital not found" });

    const { newLoginId } = req.body;
    if (newLoginId) {
      const trimmed = String(newLoginId).trim();
      const { rows: dup } = await pool.query("SELECT id FROM hospitals WHERE login_id=$1 AND id<>$2", [trimmed, hospital.id]);
      if (dup[0]) return res.status(409).json({ error: "Login ID already taken" });
      await pool.query("UPDATE hospitals SET login_id=$1 WHERE id=$2", [trimmed, hospital.id]);
    }

    if (!hospital.admin_user_id) {
      const adminUserId = `ha_${Date.now()}`;
      await pool.query(
        "INSERT INTO users (id, name, password, role, first_login) VALUES ($1,$2,$3,'hospital_admin',1)",
        [adminUserId, `${hospital.name} Admin`, ""]
      );
      await pool.query("UPDATE hospitals SET admin_user_id=$1 WHERE id=$2", [adminUserId, hospital.id]);
    } else {
      await pool.query("UPDATE users SET password='', first_login=1 WHERE id=$1", [hospital.admin_user_id]);
    }

    const { rows } = await pool.query("SELECT login_id, admin_user_id FROM hospitals WHERE id=$1", [hospital.id]);
    invalidateHospitalCache();
    res.json({ loginId: rows[0].login_id, hasAdminAccount: !!rows[0].admin_user_id });
  } catch (err) {
    console.error("[hospitals reset-login]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PATCH update hospital ─────────────────────────────────────────────────────
router.patch("/:id", requireAdmin, async (req, res) => {
  try {
    const { rows: existingRows } = await pool.query("SELECT id FROM hospitals WHERE id=$1", [req.params.id]);
    if (!existingRows[0]) return res.status(404).json({ error: "Hospital not found" });

    const { name, area, address, phone, isFree, hasPharmacy } = req.body;
    await pool.query(
      `UPDATE hospitals SET name=COALESCE($1,name), area=COALESCE($2,area),
       address=COALESCE($3,address), phone=COALESCE($4,phone), is_free=COALESCE($5,is_free),
       has_pharmacy=COALESCE($6,has_pharmacy)
       WHERE id=$7`,
      [
        name || null,
        area || null,
        address ?? null,
        phone ?? null,
        isFree !== undefined ? (isFree ? 1 : 0) : null,
        hasPharmacy !== undefined ? (hasPharmacy ? 1 : 0) : null,
        req.params.id,
      ]
    );

    const { rows } = await pool.query("SELECT * FROM hospitals WHERE id=$1", [req.params.id]);
    invalidateHospitalCache();
    res.json(await row2hospital(rows[0], req, true));
  } catch (err) {
    console.error("[hospitals PATCH]", err.message);
    res.status(500).json({ error: err.message });
  }
});


// ── PATCH toggle pharmacy (hospital-admin) ────────────────────────────────────
router.patch("/:id/pharmacy-toggle", requireAdminOrHospitalAdmin, async (req, res) => {
  try {
    const { hasPharmacy } = req.body;
    if (req.user.role === "hospital_admin" && req.user.hospitalId !== req.params.id)
      return res.status(403).json({ error: "You can only update your own hospital" });
    await pool.query(
      "UPDATE hospitals SET has_pharmacy=$1 WHERE id=$2",
      [hasPharmacy ? 1 : 0, req.params.id]
    );
    invalidateHospitalCache();
    res.json({ success: true, hasPharmacy: !!hasPharmacy });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST upload hospital photo ────────────────────────────────────────────────
router.post("/:id/photo", requireAdmin, upload.single("photo"), async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id FROM hospitals WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Hospital not found" });
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const base64 = `data:${req.file.mimetype};base64,${req.file.buffer.toString("base64")}`;

    await pool.query("UPDATE hospitals SET photo_data=$1, photo_url=NULL WHERE id=$2", [base64, req.params.id]);

    console.log(`[hospitals photo] saved base64 for id=${req.params.id} size=${req.file.size} bytes`);
    invalidateHospitalCache();
    res.json({ photoUrl: base64 });
  } catch (err) {
    console.error("[hospitals photo]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── POST accept base64 photo directly (from frontend FileReader) ──────────────
router.post("/:id/photo-base64", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT id FROM hospitals WHERE id=$1", [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Hospital not found" });

    const { base64 } = req.body;
    if (!base64 || !base64.startsWith("data:image/"))
      return res.status(400).json({ error: "Invalid base64 image data" });

    await pool.query("UPDATE hospitals SET photo_data=$1, photo_url=NULL WHERE id=$2", [base64, req.params.id]);
    console.log(`[hospitals photo-base64] saved for id=${req.params.id}`);
    invalidateHospitalCache();
    res.json({ photoUrl: base64 });
  } catch (err) {
    console.error("[hospitals photo-base64]", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE hospital ───────────────────────────────────────────────────────────
router.delete("/:id", requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT COUNT(*) as c FROM doctors WHERE hospital_id=$1", [req.params.id]);
    const count = Number(rows[0].c);
    if (count > 0)
      return res.status(409).json({ error: "Cannot delete hospital with assigned doctors. Remove doctors first." });

    await pool.query("DELETE FROM hospitals WHERE id=$1", [req.params.id]);
    invalidateHospitalCache();
    res.json({ success: true });
  } catch (err) {
    console.error("[hospitals DELETE]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
