#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════
// TXOKO Formación — Smoke tests (zero-dependency, Node ≥18)
// ═══════════════════════════════════════════════════════════════
// Purpose: a safety net for a single-file PWA that has no build step
// and no unit tests. These checks catch the classes of mistake that
// are easy to make when hand-editing a 31k-line index.html and would
// otherwise only surface in production:
//
//   1. JS syntax errors in the main inline <script> (white screen).
//   2. Malformed JSON data files (lazy-loaded tabs crash on open).
//   3. Dangling tab routes — showTab() pointing at a missing render fn.
//   4. Lazy-load paths pointing at files that don't exist.
//   5. Service-worker version drift (stale cache served forever).
//   6. CDN <script>/<link> tags missing crossorigin (blocks SRI).
//   7. Leftover git conflict markers.
//
// Run:  node tests/smoke.mjs        (or: npm test)
// Exit: 0 = all green, 1 = at least one failure.
// ═══════════════════════════════════════════════════════════════

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// ─── tiny test harness ──────────────────────────────────────────
let passed = 0, failed = 0;
const fails = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  catch (e) { failed++; fails.push(`${name}: ${e.message}`); console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${e.message}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

const html = read('index.html');

// ─── 1. Main inline <script> parses ─────────────────────────────
console.log('\nJS syntax');
test('main inline <script> block parses without syntax errors', () => {
  // The app's logic lives in the last, largest <script> block. Slice from
  // the final `<script>` (no src) to the final `</script>` and verify the
  // engine can compile it. new Function only parses — it never executes —
  // so browser globals (document, window) are irrelevant here.
  const open = html.lastIndexOf('<script>');
  const close = html.lastIndexOf('</script>');
  assert(open !== -1 && close > open, 'could not locate main <script> block');
  const js = html.slice(open + '<script>'.length, close);
  assert(js.length > 100000, `main script suspiciously small (${js.length} bytes)`);
  // throws SyntaxError with line/col if the JS is malformed
  new Function(js); // eslint-disable-line no-new-func
});

// ─── 2. JSON data files valid + structurally sound ──────────────
console.log('\nData files');
test('data/wines.json is a non-empty array with id/name/type', () => {
  const wines = JSON.parse(read('data/wines.json'));
  assert(Array.isArray(wines) && wines.length > 0, 'not a non-empty array');
  for (const w of wines) {
    assert(typeof w.id === 'number', `wine missing numeric id: ${JSON.stringify(w).slice(0,80)}`);
    assert(typeof w.name === 'string' && w.name, `wine ${w.id} missing name`);
    assert(typeof w.type === 'string' && w.type, `wine ${w.id} missing type`);
  }
  const ids = wines.map(w => w.id);
  assert(new Set(ids).size === ids.length, 'duplicate wine ids');
});

test('data/vinos-content.json keys match what loadVinosContent() assigns', () => {
  const content = JSON.parse(read('data/vinos-content.json'));
  const jsonKeys = Object.keys(content).sort();
  assert(jsonKeys.length === 10, `expected 10 constants, got ${jsonKeys.length}`);
  // Each value must be a non-empty object/array (no accidental nulls)
  for (const k of jsonKeys) {
    const v = content[k];
    assert(v && typeof v === 'object', `${k} is not an object/array`);
    const len = Array.isArray(v) ? v.length : Object.keys(v).length;
    assert(len > 0, `${k} is empty`);
  }
  // Cross-check against the assignments in loadVinosContent() so the JSON and
  // the loader can't drift apart (key added to one but not the other).
  const loader = html.match(/async function loadVinosContent\([^)]*\)\s*\{[\s\S]*?\n\}/);
  assert(loader, 'could not find loadVinosContent()');
  const assigned = [...loader[0].matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*data\.\1\s*;/gm)].map(m => m[1]).sort();
  assert(JSON.stringify(assigned) === JSON.stringify(jsonKeys),
    `loader assigns [${assigned}] but JSON has [${jsonKeys}]`);
});

test('data/lqa-situations.json is valid JSON (non-empty array)', () => {
  const lqa = JSON.parse(read('data/lqa-situations.json'));
  assert(Array.isArray(lqa) && lqa.length > 0, 'not a non-empty array');
});

test('data/ghost-scenarios.json scenarios have scenes with options', () => {
  const ghost = JSON.parse(read('data/ghost-scenarios.json'));
  assert(Array.isArray(ghost) && ghost.length > 0, 'not a non-empty array');
  for (const sc of ghost) {
    assert(typeof sc.id === 'string' && sc.id, 'scenario missing id');
    assert(Array.isArray(sc.scenes) && sc.scenes.length > 0, `scenario ${sc.id} has no scenes`);
    for (const [i, scene] of sc.scenes.entries()) {
      assert(Array.isArray(scene.options) && scene.options.length > 0,
        `scenario ${sc.id} scene ${i} has no options`);
    }
  }
});

// ─── 3. Every showTab route resolves to a defined function ──────
console.log('\nRouting integrity');
test('every renderMap route points to a function that exists', () => {
  const m = html.match(/renderMap\s*=\s*\{([^}]*)\}/);
  assert(m, 'could not find renderMap');
  // entries look like  key:renderSomething
  const routes = m[1].split(',').map(s => s.trim()).filter(Boolean);
  assert(routes.length >= 5, `renderMap suspiciously small (${routes.length} routes)`);
  for (const r of routes) {
    const fn = r.split(':')[1]?.trim();
    assert(fn, `malformed route entry: "${r}"`);
    const defined = new RegExp(`(?:async\\s+)?function\\s+${fn}\\s*\\(`).test(html);
    assert(defined, `route target "${fn}" is not defined anywhere`);
  }
});

// ─── 4. Lazy-load data paths exist on disk ──────────────────────
test('every loadLazyData("data/…") path exists on disk', () => {
  const paths = [...html.matchAll(/loadLazyData\(\s*['"`](data\/[^'"`]+)['"`]/g)].map(x => x[1]);
  assert(paths.length > 0, 'no loadLazyData paths found (did the API change?)');
  for (const p of new Set(paths)) {
    assert(existsSync(join(ROOT, p)), `lazy-loaded file missing: ${p}`);
  }
});

// ─── 4b. Extracted stylesheet wired + precached ─────────────────
console.log('\nStylesheet');
test('styles.css is linked, non-trivial, and not duplicated inline', () => {
  assert(/<link\s+rel="stylesheet"\s+href="styles\.css">/.test(html), 'styles.css <link> missing');
  assert(existsSync(join(ROOT, 'styles.css')), 'styles.css file missing');
  const css = read('styles.css');
  assert(css.length > 50000, `styles.css suspiciously small (${css.length} bytes)`);
  // The big inline <style> block must be gone (no regression to inline CSS).
  assert(!/<style>/.test(html), 'an inline <style> block is back in index.html');
  // SW must precache it so first paint after install is instant + offline-safe.
  const sw = read('sw.js');
  assert(/['"`]\.\/styles\.css['"`]/.test(sw), 'styles.css not in SW SHELL_URLS');
});

// ─── 4c. Design system token layer is coherent ─────────────────
console.log('\nDesign system');
test('styles.css defines the formalized token scales', () => {
  const css = read('styles.css');
  // Spacing scale (1..8), type scale, radius/elevation aliases, motion.
  for (let i = 1; i <= 8; i++) assert(css.includes(`--space-${i}:`), `--space-${i} missing`);
  for (const t of ['--text-micro','--text-base','--text-3xl']) assert(css.includes(`${t}:`), `${t} missing`);
  for (const t of ['--radius-sm','--radius-md','--radius-lg','--radius-full']) assert(css.includes(`${t}:`), `${t} missing`);
  for (const t of ['--elev-1','--elev-2','--elev-3']) assert(css.includes(`${t}:`), `${t} missing`);
  for (const t of ['--motion-fast','--motion-base','--ease-standard']) assert(css.includes(`${t}:`), `${t} missing`);
  for (const t of ['--font-sans','--font-serif','--font-mono','--font-read']) assert(css.includes(`${t}:`), `${t} missing`);
});

test('semantic color tokens reference existing primitives (no dangling var())', () => {
  const css = read('styles.css');
  const root = css.slice(css.indexOf(':root{'), css.indexOf('}', css.indexOf(':root{')) + 1);
  const defined = new Set([...css.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map(m => m[1]));
  // Every var(--x) used INSIDE a token definition must itself be defined.
  for (const m of root.matchAll(/var\((--[a-z0-9-]+)\)/gi)) {
    assert(defined.has(m[1]), `token references undefined ${m[1]}`);
  }
  // Spot-check the semantic aliases exist and point somewhere.
  for (const t of ['--color-bg','--color-accent','--color-danger','--color-success']) {
    assert(new RegExp(`${t}:\\s*var\\(--`).test(css), `${t} should alias a primitive`);
  }
});

test('DESIGN_SYSTEM.md exists and documents the scales', () => {
  const doc = read('DESIGN_SYSTEM.md');
  for (const s of ['Color', 'Typography', 'Spacing', 'Motion', 'Atmospheric', 'Dual mode']) {
    assert(doc.includes(s), `DESIGN_SYSTEM.md missing section: ${s}`);
  }
});

// ─── 5. Service-worker version hygiene ──────────────────────────
console.log('\nService worker');
test('sw.js VERSION is well-formed and drives CACHE_NAME', () => {
  const sw = read('sw.js');
  const v = sw.match(/const VERSION\s*=\s*['"`](v\d+\.\d+)['"`]/);
  assert(v, 'VERSION missing or not in vN.N form');
  assert(/CACHE_NAME\s*=\s*`txoko-shell-\$\{VERSION\}`/.test(sw),
    'CACHE_NAME must derive from VERSION so old caches are dropped on bump');
});

// ─── 6. CDN tags carry crossorigin (SRI prerequisite) ───────────
console.log('\nSupply chain');
test('all third-party CDN <script>/<link> tags set crossorigin', () => {
  const cdnTags = [...html.matchAll(/<(?:script|link)\b[^>]*(?:unpkg\.com|jsdelivr\.net)[^>]*>/g)].map(x => x[0]);
  assert(cdnTags.length > 0, 'expected at least one CDN tag');
  for (const tag of cdnTags) {
    assert(/crossorigin/.test(tag), `CDN tag missing crossorigin (blocks SRI): ${tag.slice(0,90)}…`);
  }
});

// ─── 6b. Content-Security-Policy present + covers critical origins ──
console.log('\nContent-Security-Policy');
test('CSP meta tag is present with core hardening directives', () => {
  const m = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i);
  assert(m, 'CSP meta tag missing');
  const csp = m[1];
  for (const dir of ["default-src 'self'", 'script-src', 'connect-src', "object-src 'none'", "base-uri 'self'"]) {
    assert(csp.includes(dir), `CSP missing directive: ${dir}`);
  }
});

test('CSP does not break critical paths (Supabase, CDNs, fonts, map)', () => {
  // A too-narrow CSP would silently break login/sync or the map. Assert the
  // origins the app genuinely loads from are still allow-listed, so a future
  // CSP edit can't quietly cut them off.
  const csp = html.match(/Content-Security-Policy"\s+content="([^"]+)"/i)[1];
  const required = [
    'advkoujfgbrrjvqexrcu.supabase.co', // login + all data sync (connect-src)
    'cdn.jsdelivr.net',                 // supabase-js (script-src)
    'unpkg.com',                        // maplibre + topojson (script/style)
    'fonts.googleapis.com',             // font CSS (style-src)
    'fonts.gstatic.com',                // font files (font-src)
    'tile.opentopomap.org',             // wine map tiles (img/connect)
    'www.youtube.com'                   // video embeds (frame-src)
  ];
  for (const o of required) assert(csp.includes(o), `CSP no longer allows ${o} — would break a feature`);
});

// ─── 6c. Employee PIN server-verify wiring ──────────────────────
console.log('\nAuth hardening');
test('USE_SERVER_EMP_PIN_VERIFY exists and ships disabled (safe default)', () => {
  const m = html.match(/const USE_SERVER_EMP_PIN_VERIFY\s*=\s*(true|false)\s*;/);
  assert(m, 'USE_SERVER_EMP_PIN_VERIFY flag missing');
  // Must ship false: enabling it requires deploying supabase/employee_pin.sql
  // first, otherwise the verify RPC 404s. (It falls back to local, but the
  // flag should not be flipped in the repo until the SQL is live.)
  assert(m[1] === 'false', 'USE_SERVER_EMP_PIN_VERIFY must default to false in the repo');
  // The helpers it relies on must exist.
  assert(/async function verifyEmployeePinServer\(/.test(html), 'verifyEmployeePinServer() missing');
  assert(/async function setEmployeePinServer\(/.test(html), 'setEmployeePinServer() missing');
});

test('supabase/employee_pin.sql defines the verify/set RPCs and locks the table', () => {
  const sql = read('supabase/employee_pin.sql');
  assert(/create or replace function public\.verify_employee_pin\(/.test(sql), 'verify_employee_pin RPC missing');
  assert(/create or replace function public\.set_employee_pin\(/.test(sql), 'set_employee_pin RPC missing');
  assert(/revoke all on public\.employee_pin_secret from anon/.test(sql), 'secret table not revoked from anon');
  assert(/gen_salt\('bf'/.test(sql), 'not using bcrypt (gen_salt bf)');
});

// ─── 7. No leftover git conflict markers ────────────────────────
console.log('\nHygiene');
test('no git conflict markers in tracked source', () => {
  for (const f of ['index.html', 'sw.js', 'data/wines.json', 'data/lqa-situations.json', 'data/ghost-scenarios.json']) {
    const txt = read(f);
    // match at line start to avoid false positives in legitimate content
    assert(!/^<{7}\s|^={7}$|^>{7}\s/m.test(txt), `conflict marker found in ${f}`);
  }
});

// ─── summary ────────────────────────────────────────────────────
console.log(`\n${failed === 0 ? '\x1b[32m' : '\x1b[31m'}${passed} passed, ${failed} failed\x1b[0m`);
if (failed > 0) { console.log('\nFailures:\n  - ' + fails.join('\n  - ')); process.exit(1); }
