// Dead-CSS audit: extracts every class name used in styles.css selectors
// and verifies each one is referenced somewhere in index.html or public/js.
// Exits 1 if any selector is unused — wired into CI so dead styles can't
// accumulate. Run: node scripts/dev/css-audit.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const css = readFileSync(join(ROOT, 'public/styles.css'), 'utf8');

let hay = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
hay += readFileSync(join(ROOT, 'public/login.html'), 'utf8');
const jsDir = join(ROOT, 'public/js');
for (const f of readdirSync(jsDir)) hay += readFileSync(join(jsDir, f), 'utf8');
hay += readFileSync(join(ROOT, 'public/sw.js'), 'utf8');

// Class tokens from selectors only (comments and rule bodies stripped)
const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
const selectorText = noComments.replace(/\{[^{}]*\}/g, '{}');
const classRe = /\.(-?[_a-zA-Z][_a-zA-Z0-9-]*)/g;
const classes = new Set();
let m;
while ((m = classRe.exec(selectorText)) !== null) classes.add(m[1]);

const unused = [...classes].sort().filter((c) => !hay.includes(c));

console.log(`css classes: ${classes.size}, unused: ${unused.length}`);
if (unused.length > 0) {
  for (const c of unused) console.log('  unused: .' + c);
  process.exit(1);
}
