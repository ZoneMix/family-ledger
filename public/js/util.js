/* ─────────────────────────────────────────────────────────────
   The Family Ledger — util.js
   Shared constants, privacy masking, formatters, DOM + date helpers.
   ───────────────────────────────────────────────────────────── */

export const REFRESH_MS = 30 * 1000;   // client poll; server cache refreshes on its own interval
export const RETRY_MS   = 10 * 1000;

export const MONTH_NAMES_FULL = [
  'January','February','March','April','May','June',
  'July','August','September','October','November','December',
];
export const MONTH_NAMES_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// ── Privacy mode ───────────────────────────────────────────
// Toggle via: tap the masthead subtitle. Replaces digits with bullets
// while keeping formatting intact. Persists in localStorage.
let privacyMode = localStorage.getItem('fl-privacy') === 'on';

export const isPrivacy = () => privacyMode;
export const setPrivacy = (on) => {
  privacyMode = on;
  localStorage.setItem('fl-privacy', on ? 'on' : 'off');
  document.body.classList.toggle('privacy-on', on);
};

export const maskDigits = (str) => String(str).replace(/\d/g, '•');
// Privacy mode also blanks WHO — payee and account names — not just amounts.
// Non-space chars become bullets so the row shape stays recognizable to the
// owner while being opaque to a shoulder-surfer.
export const maskName = (str) => privacyMode ? String(str).replace(/[^\s]/g, '•') : String(str);

// ── Formatters (privacy-aware, locale/currency from server config) ──
let CENTS_FMT = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
  minimumFractionDigits: 2, maximumFractionDigits: 2,
});
let WHOLE_FMT = new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD',
  minimumFractionDigits: 0, maximumFractionDigits: 0,
});

// Called once the /api/budget payload arrives with app.{currency,locale}.
export function configureFormatters(locale, currency) {
  try {
    CENTS_FMT = new Intl.NumberFormat(locale, {
      style: 'currency', currency,
      minimumFractionDigits: 2, maximumFractionDigits: 2,
    });
    WHOLE_FMT = new Intl.NumberFormat(locale, {
      style: 'currency', currency,
      minimumFractionDigits: 0, maximumFractionDigits: 0,
    });
  } catch (err) {
    console.warn(`invalid locale/currency (${locale}/${currency}), keeping defaults:`, err.message);
  }
}

export const fmt  = (cents) => {
  const raw = CENTS_FMT.format((cents || 0) / 100);
  return privacyMode ? maskDigits(raw) : raw;
};
export const fmtW = (cents) => {
  const raw = WHOLE_FMT.format((cents || 0) / 100);
  return privacyMode ? maskDigits(raw) : raw;
};
// Whole-currency formatter for values already in DOLLARS (goals, net worth
// manual assets) — unlike the cents-based fmt/fmtW.
export const fmtD = (dollars) => {
  const raw = WHOLE_FMT.format(dollars || 0);
  return privacyMode ? maskDigits(raw) : raw;
};

// ── DOM helpers ────────────────────────────────────────────
export const $  = (sel) => document.querySelector(sel);
export const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
};
export const setText = (sel, value) => { const n = $(sel); if (n) n.textContent = value; };

// ── Year-month helpers ─────────────────────────────────────
export const ymNum = (ym) => { const [y, m] = ym.split('-').map(Number); return y + (m - 1) / 12; };
export const ymNext = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
export const ymShort = (ym) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTH_NAMES_SHORT[m - 1]} ’${String(y).slice(-2)}`;
};

export function shortDate(iso) {
  if (!iso) return '—';
  const p = iso.split('-');
  return `${MONTH_NAMES_SHORT[parseInt(p[1], 10) - 1] || ''} ${parseInt(p[2], 10)}`;
}

// ── Error banner ───────────────────────────────────────────
export function showError(msg) {
  const banner = $('#error-banner');
  if (!banner) return;
  const text = $('#error-banner-text');
  if (text) text.textContent = msg;
  banner.hidden = false;
}
export function hideError() {
  const banner = $('#error-banner');
  if (banner) banner.hidden = true;
}

// Parse a user-entered amount string ("12.34", "12", "$12.34", "-12.34")
// into integer cents. Returns null if unparseable or empty. Keeps sign.
export function parseAmountToCents(str) {
  if (typeof str !== 'string') return null;
  const trimmed = str.trim().replace(/[$,\s]/g, '');
  if (!trimmed) return null;
  if (!/^-?\d+(\.\d{0,2})?$/.test(trimmed)) return null;
  const num = parseFloat(trimmed);
  if (Number.isNaN(num)) return null;
  return Math.round(num * 100);
}
