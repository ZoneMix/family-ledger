/* ─────────────────────────────────────────────────────────────
   The Family Ledger — chart.js
   Hand-rolled newspaper-style SVG line chart (used by Net Worth).
   ───────────────────────────────────────────────────────────── */

import { isPrivacy, ymNum, ymNext } from './util.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const svgEl = (tag, attrs) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
  return n;
};

// series: [{points: [{ym, v}], cls, dots}].
// Gap-aware: a missing month breaks the stroke instead of bridging it, so
// untracked stretches read as gaps. Isolated points would otherwise be
// invisible, so `dots` draws circles too.
// sensitiveY joins the tap-to-reveal system: y-axis labels mask behind •••
// until body.reveal-sensitive is set (the axis alone gives away magnitude).
export function svgLineChart({ series, events = [], height = 230, sensitiveY = false }) {
  const W = 720, H = height, PAD = { t: 14, r: 8, b: 22, l: 46 };
  const all = series.flatMap(s => s.points);
  if (all.length < 2) return null;
  const x0 = Math.min(...all.map(p => ymNum(p.ym)));
  const x1 = Math.max(...all.map(p => ymNum(p.ym)));
  const yMax = Math.max(...all.map(p => p.v), 1) * 1.06;
  const yMin = Math.min(0, ...all.map(p => p.v)) * 1.06;
  const X = (ym) => PAD.l + ((ymNum(ym) - x0) / Math.max(0.01, x1 - x0)) * (W - PAD.l - PAD.r);
  const Y = (v) => PAD.t + (1 - (v - yMin) / (yMax - yMin)) * (H - PAD.t - PAD.b);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hh-chart__svg', role: 'img' });

  for (let i = 0; i <= 3; i++) {
    const v = yMin + ((yMax - yMin) * i) / 3;
    svg.appendChild(svgEl('line', {
      x1: PAD.l, x2: W - PAD.r, y1: Y(v).toFixed(1), y2: Y(v).toFixed(1),
      class: 'hh-chart__grid',
    }));
    const labelText = isPrivacy() ? '•••' : `$${Math.round(v / 1000)}k`;
    const attrs = { x: PAD.l - 5, y: (Y(v) + 3).toFixed(1), 'text-anchor': 'end' };
    if (sensitiveY) {
      // Dual-node pattern: the masked label and the real value swap
      // visibility via body.reveal-sensitive.
      const masked = svgEl('text', { ...attrs, class: 'hh-chart__ylabel hh-chart__ylabel--masked' });
      masked.textContent = '•••';
      const value = svgEl('text', { ...attrs, class: 'hh-chart__ylabel hh-chart__ylabel--value' });
      value.textContent = labelText;
      svg.appendChild(masked);
      svg.appendChild(value);
    } else {
      const label = svgEl('text', { ...attrs, class: 'hh-chart__ylabel' });
      label.textContent = labelText;
      svg.appendChild(label);
    }
  }
  for (let y = Math.ceil(x0); y <= Math.floor(x1); y++) {
    const ym = `${y}-01`;
    if (ymNum(ym) < x0 || ymNum(ym) > x1) continue;
    const t = svgEl('text', {
      x: X(ym).toFixed(1), y: H - 8,
      class: 'hh-chart__xlabel', 'text-anchor': 'middle',
    });
    t.textContent = `’${String(y).slice(-2)}`;
    svg.appendChild(t);
  }
  if (yMin < 0) {
    svg.appendChild(svgEl('line', {
      x1: PAD.l, x2: W - PAD.r, y1: Y(0).toFixed(1), y2: Y(0).toFixed(1),
      class: 'hh-chart__zero',
    }));
  }
  for (const ev of events) {
    if (ymNum(ev.ym) < x0 || ymNum(ev.ym) > x1) continue;
    svg.appendChild(svgEl('line', {
      x1: X(ev.ym).toFixed(1), x2: X(ev.ym).toFixed(1),
      y1: PAD.t, y2: H - PAD.b, class: 'hh-chart__event',
    }));
  }
  for (const s of series) {
    const pts = [...s.points].sort((a, b) => (a.ym < b.ym ? -1 : 1));
    let d = '';
    let prev = null;
    for (const p of pts) {
      const cmd = prev && ymNext(prev) === p.ym ? 'L' : 'M';
      d += `${cmd}${X(p.ym).toFixed(1)},${Y(p.v).toFixed(1)}`;
      prev = p.ym;
    }
    svg.appendChild(svgEl('path', { d, class: `hh-chart__line ${s.cls || ''}`.trim(), fill: 'none' }));
    if (s.dots) {
      for (const p of pts) {
        svg.appendChild(svgEl('circle', {
          cx: X(p.ym).toFixed(1), cy: Y(p.v).toFixed(1), r: 2.6,
          class: 'hh-chart__dot',
        }));
      }
    }
  }
  return svg;
}
