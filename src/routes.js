// src/routes.js — the Express app: static PWA serving, the templated
// manifest, the optional password-gate login flow, and the core budget/
// health/sync endpoints. Transaction mutation endpoints live in
// transactions-routes.js.

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { createAuthGate, createLoginLimiter, sessionToken, safeEqual, SESSION_COOKIE_NAME, SESSION_MAX_AGE_MS } from './auth.js';
import { readOnlyGuard } from './read-only.js';
import { createTransactionsRouter } from './transactions-routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

function buildManifest(config) {
  return {
    name: config.appTitle,
    short_name: config.appTitle,
    description: `${config.appTitle} — a family budget dashboard.`,
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#f5f1e8',
    background_color: '#f5f1e8',
    categories: ['finance', 'lifestyle'],
    icons: [
      { src: '/icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}

export function createApp({ config, refreshEngine, bankSyncEngine, log }) {
  const app = express();
  app.disable('x-powered-by');
  // config.trustProxy defaults to private-range subnets only, so a reverse
  // proxy on the LAN or in the compose network is trusted to set
  // X-Forwarded-* (needed for req.secure below), but an internet client
  // can't spoof its way past the login rate limiter with a fake header.
  app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '16kb' }));
  // Every /api/* response carries live budget data — never let a browser,
  // proxy, or shared device cache it. Registered before any /api route.
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'private, no-store');
    next();
  });
  app.use(createAuthGate(config));

  const isRateLimited = createLoginLimiter();
  const manifest = buildManifest(config);

  // Registered BEFORE the static middleware so this route wins even though
  // the frontend build no longer ships a static public/manifest.json.
  app.get('/manifest.json', (req, res) => {
    res.json(manifest);
  });

  app.use(express.static(PUBLIC_DIR, {
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
      // Always revalidate code/markup/styles — deploy-to-visible delay
      // matters for a dashboard. The service worker still caches offline.
      if (/\.(html|js|css|json)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    },
  }));

  app.post('/api/login', (req, res) => {
    if (!config.dashboardPassword) {
      return res.status(404).json({ error: 'login is disabled' });
    }
    if (isRateLimited(req.ip)) {
      return res.status(429).json({ error: 'too many attempts — try again in a minute' });
    }
    const { password } = req.body || {};
    if (typeof password !== 'string' || !safeEqual(password, config.dashboardPassword)) {
      return res.status(401).json({ error: 'invalid password' });
    }
    res.cookie(SESSION_COOKIE_NAME, sessionToken(config.dashboardPassword), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_MS,
      // req.secure is true for a direct HTTPS connection, or plain HTTP
      // relayed through a proxy in config.trustProxy that sets
      // X-Forwarded-Proto: https. Plain-HTTP LAN logins keep working —
      // they just don't get the Secure attribute.
      secure: req.secure,
    });
    res.status(204).end();
  });

  app.get('/api/budget', (req, res) => {
    const cache = refreshEngine.getCache();
    if (!cache) {
      return res.status(503).json({ error: 'warming up', lastError: refreshEngine.getLastError() });
    }
    res.json(cache);
  });

  // Deliberately minimal and always open (see auth.js ALWAYS_OPEN_PATHS) —
  // a health check needs no auth, so it must never leak anything past a
  // single boolean. Detailed status (bankSync, lastError, etc.) is on
  // /api/budget instead, which sits behind the auth gate and cache-control
  // middleware above.
  app.get('/api/health', (req, res) => {
    res.json({ ok: !!refreshEngine.getCache() });
  });

  // Manual refresh — forces an immediate pull from Actual, bypassing the
  // periodic timer. Idempotent: concurrent calls return 202.
  app.post('/api/refresh', async (req, res) => {
    if (refreshEngine.isRefreshing()) {
      return res.status(202).json({ status: 'already-refreshing' });
    }
    try {
      await refreshEngine.refresh();
      const lastError = refreshEngine.getLastError();
      if (lastError) {
        return res.status(500).json({ status: 'error', error: lastError });
      }
      res.json({ status: 'refreshed', updatedAt: refreshEngine.getCache()?.updatedAt });
    } catch (err) {
      res.status(500).json({ status: 'error', error: err.message });
    }
  });

  app.post('/api/sync', readOnlyGuard(config), async (req, res) => {
    const result = await bankSyncEngine.runBankSyncCycle();
    if (result.skipped) {
      return res.status(202).json({ status: 'already-syncing' });
    }
    if (result.status === 'failed' && !result.results) {
      return res.status(500).json({ status: 'error', error: result.error });
    }
    res.json({
      status: result.status,
      syncStatus: result.status,
      error: refreshEngine.getBankSyncTelemetry().lastSyncError,
      updatedAt: refreshEngine.getCache()?.updatedAt,
      results: result.results,
    });
  });

  app.use(createTransactionsRouter({ config, refreshEngine, log }));

  return app;
}
