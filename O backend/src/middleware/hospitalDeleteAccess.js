const { requireAuth } = require("./auth");

const ALLOWED_ROLES = ["admin", "cto", "founder"];

function requireFounderOrAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (ALLOWED_ROLES.includes(req.user.role)) return next();
    return res.status(403).json({ error: "Not allowed to delete hospitals" });
  });
}

module.exports = { requireFounderOrAdmin };
