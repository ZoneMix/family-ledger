// src/auth.js — the optional password gate (DASHBOARD_PASSWORD).
// No session store: the cookie is a deterministic HMAC of a fixed message
// keyed by the dashboard password, so changing the password invalidates
// every existing cookie automatically and there's nothing to persist.

import crypto from 'crypto';

export const SESSION_COOKIE_NAME = 'fl_session';
const SESSION_MESSAGE = 'family-ledger-session-v1';
export const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ALWAYS_OPEN_PATHS = new Set(['/login.html', '/api/login', '/api/health']);
const LOGIN_WINDOW_MS = 60000;
const LOGIN_MAX_ATTEMPTS = 5;

export function sessionToken(password) {
  return crypto.createHmac('sha256', password).update(SESSION_MESSAGE).digest('hex');
}

export function safeEqual(a, b) {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    if (!key) continue;
    out[key] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Auth is entirely disabled (pass-through) unless DASHBOARD_PASSWORD is set.
export function createAuthGate(config) {
  if (!config.dashboardPassword) {
    return (req, res, next) => next();
  }
  const expected = sessionToken(config.dashboardPassword);
  return (req, res, next) => {
    if (ALWAYS_OPEN_PATHS.has(req.path)) return next();
    const cookies = parseCookies(req.headers.cookie);
    if (cookies[SESSION_COOKIE_NAME] && safeEqual(cookies[SESSION_COOKIE_NAME], expected)) {
      return next();
    }
    if (req.path.startsWith('/api/')) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    return res.redirect(302, '/login.html');
  };
}

// In-memory fixed-window limiter — good enough for a single-instance
// homelab deployment; not shared across replicas.
export function createLoginLimiter() {
  const attempts = new Map(); // ip -> { count, windowStart }
  return (ip) => {
    const now = Date.now();
    const entry = attempts.get(ip);
    if (!entry || now - entry.windowStart > LOGIN_WINDOW_MS) {
      attempts.set(ip, { count: 1, windowStart: now });
      return false;
    }
    entry.count += 1;
    return entry.count > LOGIN_MAX_ATTEMPTS;
  };
}
