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
