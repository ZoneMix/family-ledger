// src/read-only.js — blocks mutating requests when READ_ONLY=true.
// Read-only pulls (GET /api/budget, GET /api/transactions/month, POST /api/refresh)
// stay allowed; only writes to Actual are blocked.

export function readOnlyGuard(config) {
  return (req, res, next) => {
    if (!config.readOnly) return next();
    res.status(403).json({ error: 'read-only mode' });
  };
}
