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

test('prefers-reduced-motion guard freezes the atmospheric layer', () => {
  const css = read('styles.css');
  const idx = css.indexOf('@media (prefers-reduced-motion: reduce)');
  assert(idx !== -1, 'no prefers-reduced-motion media query');
  const block = css.slice(idx, css.indexOf('}', css.lastIndexOf('animation: none', css.length)) + 1);
  // Must freeze ambient decoration and not just exist empty.
  assert(/body::before/.test(block), 'guard should freeze body::before ambient layer');
  assert(/animation:\s*none/.test(block), 'guard should set animation:none on decoration');
  // Must NOT disable the finite self-removing feedback effects (they clean up
  // on animationend; freezing them would leave elements stuck on screen).
  for (const finite of ['.xp-burst', '.ripple-circle', '.sr-xp-float']) {
    assert(!new RegExp(`\\${finite}\\b`).test(block), `${finite} must stay animated (animationend cleanup)`);
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

// ─── 6d. Quiz generator distractor-quality guards ───────────────
console.log('\nQuiz generators');
test('"Which ingredient is NOT in this dish?" rejects substring-ambiguous fakes', () => {
  // The fix added a bidirectional substring filter so we never produce
  // questions like "Which is NOT in this dish? Egg / Egg yolk / Squid / Onion"
  // where the fake ("Egg") is a substring of a real ingredient ("Egg yolk").
  const m = /const fakeIng = _djShuffle\(otherIngs\.filter\(i => \{([\s\S]*?)\}\)\)/.exec(html);
  assert(m, 'fake-ingredient filter signature changed — bug-2 guard may be gone');
  const body = m[1];
  // Both directions of substring overlap must be filtered out.
  assert(/real\.includes\(il\)/.test(body),
    'filter must reject fakes that are substrings of real ingredients (real.includes(il))');
  assert(/il\.includes\(real\)/.test(body),
    'filter must reject real ingredients that are substrings of the fake (il.includes(real))');
});

test('modification quiz excludes the dish-defining ingredient from distractors', () => {
  // The fix added isDishDefining() so we no longer produce options like
  // "Comandar SIN CALAMAR" for Calamares a la Andaluza — those are obvious
  // throwaways that defeat the test.
  assert(/const isDishDefining\s*=/.test(html),
    'isDishDefining helper missing — bug-3 guard may be gone');
  assert(/_simExtractIngredients\(src\)\.filter\(i =>[\s\S]*?!isDishDefining\(i\)/.test(html),
    'distractor pool must filter out dish-defining ingredients');
});

// ─── 6e. Dashboard hierarchy — action-first, no duplication ─────
console.log('\nDashboard hierarchy');
test('hero is slim: no motivational quote, no duplicate level title', () => {
  // The motivational quote and the badge-side level title were causing
  // visual clutter and a duplicate (the XP bar already shows the title).
  // These regressions matter because the user reports the screen feels
  // overwhelming — keep the hero a single source of truth.
  assert(!/dash-hero-quote/.test(html), 'hero motivational quote is back');
  assert(!/dash-hero-lvl-title/.test(html), 'duplicate level title in hero badge is back');
  assert(!/motivations_es|motivations_en/.test(html), 'dead motivational quote arrays returned');
});

test('Plan de hoy sits above Stats Strip on the dashboard', () => {
  // Action-first hierarchy: the user opens the app to see WHAT TO DO,
  // not how many flashcards exist. Stats are passive context, moved below.
  const dashStart = html.indexOf("document.getElementById('appContent').innerHTML=`", html.indexOf('function renderDashboard'));
  assert(dashStart !== -1, 'renderDashboard innerHTML template not found');
  const dashEnd = html.indexOf('`;', dashStart);
  const dashTpl = html.slice(dashStart, dashEnd);
  const planIdx = dashTpl.indexOf('PLAN DE HOY');
  const statsIdx = dashTpl.indexOf('STATS STRIP');
  assert(planIdx !== -1, 'PLAN DE HOY section missing');
  assert(statsIdx !== -1, 'STATS STRIP section missing');
  assert(planIdx < statsIdx,
    'PLAN DE HOY must come before STATS STRIP (action-first hierarchy)');
});

// ─── 6f. Latent-bug regression guards (sideways drift family) ───
console.log('\nLatent bug guards');
test('every fullscreen-ish overflow-y:auto container also clips X', () => {
  const css = read('styles.css');
  // The sideways-drift bug class: setting overflow-y:auto without taming
  // overflow-x lets touch scrollers drift diagonally, especially when a
  // child has a sticky :hover translateX. These selectors are fullscreen
  // or near-fullscreen, so they're the high-impact ones — child-level
  // pills/chips with their own intentional horizontal scrollers are fine.
  const mustClip = [
    '.sf-overlay', '.svc-body', '.dj-body', '.ranks-body',
    '.wine-detail-overlay', '.login-employees'
  ];
  for (const sel of mustClip) {
    const ruleRe = new RegExp(`\\${sel}\\s*\\{[^}]*\\}`, 'g');
    let found = 0, clipped = 0;
    for (const m of css.matchAll(ruleRe)) {
      found++;
      if (/overflow-x\s*:\s*hidden/.test(m[0])) clipped++;
    }
    assert(found > 0, `selector ${sel} no longer defined`);
    assert(clipped === found, `${sel}: ${clipped}/${found} rules clip overflow-x — sideways drift regression`);
  }
});

test('hover translateX rules are scoped to @media(hover:hover)', () => {
  // On touch, :hover sticks after tap — if the hover shifts an element
  // horizontally and the parent doesn't clip X, you get the sideways
  // drift bug again. Every sideways hover transform must be inside a
  // hover-capable media query.
  const css = read('styles.css');
  // Find :hover rules that translateX and check the preceding 80 chars
  // include the media query.
  const re = /([\s\S]{0,80}):hover\s*\{[^}]*transform\s*:[^;}]*translateX/g;
  for (const m of css.matchAll(re)) {
    const context = m[1];
    assert(/@media\s*\(\s*hover\s*:\s*hover/.test(context),
      `unscoped :hover translateX near offset ${m.index} — touch will stick`);
  }
});

test('async render functions guard against tab-change races', () => {
  // When the user navigates away while a multi-fetch render is awaiting
  // Supabase, the final innerHTML overwrites the new tab. Every async
  // renderTab function must capture currentTab and bail before writing.
  for (const fn of ['renderVinos', 'renderDuel', 'renderJoinLiveQuiz']) {
    const startIdx = html.search(new RegExp(`async function ${fn}\\(`));
    assert(startIdx !== -1, `${fn} no longer async — guard expectations stale`);
    // The body of the function is bounded by the next top-level function
    // declaration; grab a generous slice and check for the pattern.
    const slice = html.slice(startIdx, startIdx + 8000);
    assert(/const _startTab\s*=\s*currentTab/.test(slice) ||
           /var _startTab\s*=\s*currentTab/.test(slice),
      `${fn} missing _startTab capture — tab-change race regression`);
    assert(/currentTab\s*!==\s*_startTab/.test(slice),
      `${fn} missing currentTab !== _startTab guard`);
  }
});

test('quiz distractor pools prefer same-category dishes', () => {
  // The pedagogical bug: a "Tarta de queso: Queso San Millán, ..." option
  // appearing as distractor in an Entrantes ingredient quiz reveals itself
  // by name prefix — the trainee crosses it off without knowing the recipe.
  // _pickDistractorPool(d) filters to same-category dishes when possible
  // so distractors stay pedagogically valid.
  const helper = html.match(/function _pickDistractorPool\(d\)\s*\{[\s\S]{0,400}?\}/);
  assert(helper, '_pickDistractorPool helper missing — distractors will leak across categories');
  assert(/x\.cat\s*===\s*d\.cat/.test(helper[0]),
    '_pickDistractorPool no longer filters by category');
  assert(/sameCat\.length\s*>=?\s*6/.test(helper[0]),
    '_pickDistractorPool fallback threshold removed — small categories like Sugerencias will starve');
  // 1 definition + 4 callsites (startExam, renderLiveQuizHost, smart review, error mode)
  const usages = (html.match(/_pickDistractorPool\(/g) || []).length;
  assert(usages >= 5, `_pickDistractorPool used ${usages-1} times; expected 4 callsites`);
  // No raw `DISHES.filter(x=>x.id!==d.id)` should remain — those bypassed the category filter
  const orphans = (html.match(/DISHES\.filter\(x=>x\.id!==d\.id\)/g) || []).length;
  assert(orphans === 0, `${orphans} unfiltered DISHES distractor pools remain — re-introduces cross-category leaks`);
});

test('todayStr() uses Intl Atlantic/Canary, not manual UTC math', () => {
  // Before the fix, todayStr() returned the UTC date computed from
  // raw UTC hours. In CEST (UTC+1), between 00:00 and 01:00 Canary
  // local, the UTC date was still "yesterday" — streaks double-counted
  // and a single overnight session split across two day buckets. Intl
  // with the IANA zone is the only DST-safe way to compute this.
  const fn = html.match(/function todayStr\(\)\s*\{[\s\S]{0,600}?^\}/m);
  assert(fn, 'todayStr() function missing');
  assert(/Atlantic\/Canary/.test(fn[0]),
    'todayStr() no longer references Atlantic/Canary — manual DST math will silently break overnight');
  assert(/Intl\.DateTimeFormat/.test(fn[0]),
    'todayStr() no longer uses Intl — regressed to manual UTC math');
  // Verify the invariant the fix protects: 00:30 CEST should return the
  // Canary date, not the UTC date.
  const probe = new Intl.DateTimeFormat('en-CA', { timeZone: 'Atlantic/Canary' })
    .format(new Date(Date.UTC(2025, 5, 10, 23, 30)));
  assert(probe === '2025-06-11',
    `Intl Atlantic/Canary returned ${probe} instead of 2025-06-11 — runtime broken`);
});

test('modal a11y coverage ratchet', () => {
  // Number of createElement-based overlays wired into the central
  // setupModalA11y helper (ESC-to-close, focus trap, focus restoration,
  // role/aria-modal). This floor ratchets up as we migrate each modal;
  // dropping below it means a modal lost its keyboard accessibility.
  //
  // Migrated so far: delOverlay, notifOverlay, pinOverlay,
  // cloudPinOverlay, avatarPickerOverlay.
  // Remaining candidates: djOverlay (has custom keydown — needs care),
  // onboardingOverlay, wineDetailOverlay, smartOverlay (x2), sfOverlay,
  // ~10 total.
  // Count only real call sites: lines that invoke the helper with the
  // remove-callback pattern. Excludes the function definition, the
  // doc-comment example, and the window assignment.
  const calls = (html.match(/^\s+setupModalA11y\(overlay,\s*\(\)/gm) || []).length;
  assert(calls >= 5,
    `setupModalA11y wired to only ${calls} overlays; expected >= 5 after avatarPickerOverlay migration`);
});

test('mobile input font-size avoids iOS Safari auto-zoom trap', () => {
  // iOS Safari (mobile WebKit) auto-zooms <input> elements whose
  // computed font-size is below 16px when they receive focus. The zoom
  // shifts the layout and can hide the on-screen keypad behind the
  // input. Hot-path search inputs that the camarero uses during service
  // must sit at the 16px floor in the mobile media block.
  //
  // Currently audited: .svc-search (service panel search). Add more
  // selectors to this list as future passes migrate other inputs.
  const css = read('styles.css');
  // Each selector in the list must have at least one mobile-context rule
  // where font-size is >= 16px. Walk every `.selector{...}` block,
  // measure font-size if present, and require at least one safe variant.
  for (const sel of ['.svc-search']) {
    const ruleRe = new RegExp(`\\${sel}\\s*\\{([^}]+)\\}`, 'g');
    const sizes = [];
    let m;
    while ((m = ruleRe.exec(css)) !== null) {
      const sizeMatch = m[1].match(/font-size:\s*([\d.]+)(rem|px|em)/);
      if (sizeMatch) {
        const px = sizeMatch[2] === 'px'
          ? parseFloat(sizeMatch[1])
          : parseFloat(sizeMatch[1]) * 16;
        sizes.push(px);
      }
    }
    assert(sizes.length > 0, `${sel} no font-size declared anywhere`);
    // The smallest declared font-size for this selector must clear 16px.
    // CSS cascade may make a larger value win at runtime, but the
    // mobile-context one (which is usually the smallest) is the trap.
    const min = Math.min(...sizes);
    assert(min >= 16,
      `${sel} declares font-size ${min}px somewhere — iOS Safari auto-zooms <16px inputs on focus`);
  }

  // Some inputs are styled inline (no CSS class) instead of via
  // styles.css. Audit those by id directly against the inline style
  // attribute on the <input id="..."> tag.
  // Currently audited: maridajeSearch (sommelier pairing search).
  const html = read('index.html');
  for (const id of ['maridajeSearch']) {
    const tagRe = new RegExp(`id="${id}"[^>]*style="([^"]+)"`);
    const tagMatch = html.match(tagRe);
    assert(tagMatch, `<input id="${id}"> not found with inline style`);
    const sizeMatch = tagMatch[1].match(/font-size:\s*([\d.]+)(rem|px|em)/);
    assert(sizeMatch, `#${id} no inline font-size declared`);
    const px = sizeMatch[2] === 'px'
      ? parseFloat(sizeMatch[1])
      : parseFloat(sizeMatch[1]) * 16;
    assert(px >= 16,
      `#${id} inline font-size is ${px}px — iOS Safari auto-zooms <16px inputs on focus`);
  }
});

test('live quiz answer submission guards against double-tap race', () => {
  // submitLiveAnswer does a read-modify-write of sess.answers (not an
  // atomic upsert). On slow restaurant Wi-Fi the round trip can take
  // seconds; a second tap on another choice before the first resolves
  // races the first and can silently overwrite it — the camarero's
  // first (intended) answer gets replaced by whichever network call
  // resolves last. The handler must disable #liveChoices buttons and
  // bail on re-entry *before* the first await, synchronously on tap.
  const startIdx = html.search(/async function submitLiveAnswer\(/);
  assert(startIdx !== -1, 'submitLiveAnswer not found');
  const slice = html.slice(startIdx, startIdx + 800);
  const firstAwaitIdx = slice.search(/\bawait\b/);
  assert(firstAwaitIdx !== -1, 'submitLiveAnswer has no await — guard expectations stale');
  const beforeAwait = slice.slice(0, firstAwaitIdx);
  assert(/#liveChoices button/.test(beforeAwait),
    'submitLiveAnswer must inspect/disable #liveChoices buttons before the first await');
  assert(/\.disabled\s*=\s*true/.test(beforeAwait),
    'submitLiveAnswer must disable choice buttons before the first await — double-tap can overwrite the first answer');
  assert(/return/.test(beforeAwait),
    'submitLiveAnswer must bail out early on re-entry (already-disabled buttons) before the first await');
});

test('pinSubmit guards against re-entrant double-submit', () => {
  // pinSubmit is scheduled via setTimeout from pinKey/pinHiddenInputHandler
  // once the 4th digit lands, then awaits verifyEmployeePinServer (a fetch).
  // On slow restaurant Wi-Fi that round trip can take seconds; if the camarero
  // deletes and re-enters a digit while it's in flight, a second pinSubmit
  // gets scheduled and runs concurrently, double-counting recordPinFail (or
  // recordPinSuccess/closePinAndEnter) for a single PIN entry. A module-level
  // in-flight flag, checked before the first await and cleared in a finally,
  // must prevent the re-entrant call.
  const startIdx = html.search(/async function pinSubmit\(\)\{/);
  assert(startIdx !== -1, 'pinSubmit not found');
  const slice = html.slice(startIdx, startIdx + 3200);
  const endIdx = slice.search(/\n\}\n/);
  assert(endIdx !== -1, 'could not find end of pinSubmit');
  const body = slice.slice(0, endIdx);
  const firstAwaitIdx = body.search(/\bawait\b/);
  assert(firstAwaitIdx !== -1, 'pinSubmit has no await — guard expectations stale');
  const beforeAwait = body.slice(0, firstAwaitIdx);
  assert(/_pinSubmitInFlight\)\s*return/.test(beforeAwait),
    'pinSubmit must bail out early on re-entry (in-flight flag already set) before the first await');
  assert(/_pinSubmitInFlight\s*=\s*true/.test(beforeAwait),
    'pinSubmit must set the in-flight flag before the first await');
  assert(/finally\s*\{\s*_pinSubmitInFlight\s*=\s*false;/.test(body),
    'pinSubmit must clear the in-flight flag in a finally block so the next PIN entry is not permanently blocked');
});

test('.btn-secondary has a real style rule (not a bare grey button)', () => {
  // .btn-secondary is used on "Volver" buttons but for a long time had no
  // CSS rule, so those rendered as unstyled grey system buttons. The rule
  // must exist with the brand cream/gold treatment and the dark-gold text
  // that clears WCAG (#9a7340 was 3.98:1 and failed; #7d5c2f is 5.66:1).
  const css = read('styles.css');
  const rule = css.match(/\.btn-secondary\s*\{([^}]*)\}/);
  assert(rule, '.btn-secondary has no CSS rule — Volver buttons render as bare grey');
  assert(/border:[^;]*var\(--gold\)/.test(rule[1]) || /border:[^;]*#c49a3c/.test(rule[1]),
    '.btn-secondary lost its gold border');
  assert(/color:\s*#7d5c2f/.test(rule[1]),
    '.btn-secondary text must be dark gold #7d5c2f (lighter gold fails WCAG on cream)');
  // Still used in the markup — guard against the class being renamed away.
  assert((html.match(/class="btn-secondary/g) || []).length >= 1,
    'no .btn-secondary usages found — was the class renamed?');
});

test('dashboard review alert uses the .dash-num data badge', () => {
  // Ported "Dato protagonista" (variant B): the SRS review count moves to
  // a large left-hand badge so the camarero sees how many dishes are due
  // at a glance. The badge styling must exist and the review alert markup
  // must use it (with the count no longer duplicated in the title).
  const css = read('styles.css');
  assert(/\.dash-num\s*\{[^}]*width:\s*44px/.test(css),
    '.dash-num badge style missing or resized — data-badge redesign lost');
  // The badge is now generalised to all dashboard alerts (review, rank,
  // focus practice, needs-practice, excellent). Count the render sites so
  // a regression that drops the badge from some cards is caught.
  const badgeUses = (html.match(/class="dash-num"/g) || []).length;
  assert(badgeUses >= 5,
    `.dash-num used on only ${badgeUses} dashboard alerts; expected >= 5 after generalising the badge`);
  // svg/emoji sub-styles must exist so icon/rank badges size correctly.
  assert(/\.dash-num svg\s*\{[^}]*width:\s*24px/.test(css),
    '.dash-num svg sizing missing — icon badges will render at wrong size');
  // Subtitle legibility bump shipped alongside: must clear the old .58rem.
  const sub = (css.match(/\.dash-alert-sub\s*\{([^}]*)\}/) || [])[1] || '';
  const subSize = (sub.match(/font-size:\s*([\d.]+)rem/) || [])[1];
  assert(subSize && parseFloat(subSize) >= 0.64,
    `.dash-alert-sub font-size ${subSize}rem is back below the legible floor (.64rem)`);
});

test('exam .choice has high-contrast state badge + check/cross mark', () => {
  // Ported "Claridad" redesign: on answer the letter badge must go to the
  // DARK green/red (white letter legible) and a ✓/✕ mark must appear so the
  // result isn't communicated by colour alone. The mark is CSS-injected via
  // ::after keyed on the state class, so the markup just needs the span.
  const css = read('styles.css');
  assert(/\.choice\.correct\s+\.choice-ltr\s*\{[^}]*background:\s*#2d6a3e/.test(css),
    '.choice.correct badge must use dark green #2d6a3e (light sage fails WCAG on white text)');
  assert(/\.choice\.wrong\s+\.choice-ltr\s*\{[^}]*background:\s*#a85848/.test(css),
    '.choice.wrong badge must use dark red #a85848 (light rose fails WCAG on white text)');
  assert(/\.choice\.correct\s+\.choice-mark::after\s*\{\s*content:\s*'✓'/.test(css),
    '.choice.correct must inject a ✓ mark (colour-blind-safe state signal)');
  assert(/\.choice\.wrong\s+\.choice-mark::after\s*\{\s*content:\s*'✕'/.test(css),
    '.choice.wrong must inject a ✕ mark');
  assert(/min-width:\s*0/.test((css.match(/\.choice-txt\s*\{([^}]*)\}/)||[])[1]||''),
    '.choice-txt needs min-width:0 so long ingredient text does not push the badge/mark off a narrow phone');
  // Markup must carry the two spans the CSS targets.
  assert(/class="choice-txt"/.test(html) && /class="choice-mark"/.test(html),
    'exam choice markup must include .choice-txt and .choice-mark spans');
});

test('viewport is clipped horizontally on <html>, not just <body>', () => {
  // Sideways-drift on app open: body had overflow-x:hidden but <html>
  // did not. On iOS/Android the document scroll lives on <html>, so the
  // viewport still drags sideways (e.g. the 140vw login godrays). <html>
  // must clip overflow-x; clip is preferred (no scroll container, keeps
  // sticky working) with hidden as the old-WebKit fallback.
  const css = read('styles.css');
  // The base html/body rules each start at the beginning of a line.
  const htmlRule = css.match(/\nhtml\s*\{([^}]*)\}/);
  assert(htmlRule, 'html rule not found');
  assert(/overflow-x\s*:\s*(clip|hidden)/.test(htmlRule[1]),
    'html must set overflow-x:clip/hidden or the viewport drags sideways on touch');
  // body should also disable horizontal overscroll so there's no
  // rubber-band / swipe-to-navigate drift.
  const bodyRule = css.match(/\nbody\s*\{([^}]*)\}/);
  assert(bodyRule && /overscroll-behavior-x\s*:\s*none/.test(bodyRule[1]),
    'body must set overscroll-behavior-x:none to stop horizontal rubber-band drift');
});

test('PWA theme-color is unified across manifest and meta tag', () => {
  // The launch splash on installed Android PWAs is drawn by the OS from
  // the manifest. Keeping theme_color == background_color (the brand dark
  // green #1c2a22) makes the status bar and splash one cohesive surface
  // instead of a black flash. The <meta name="theme-color"> must match the
  // manifest so the in-app status bar doesn't drift back to black.
  const manifest = JSON.parse(read('manifest.json'));
  assert(manifest.theme_color === manifest.background_color,
    `manifest theme_color (${manifest.theme_color}) != background_color (${manifest.background_color}) — splash/status-bar mismatch returns`);
  const meta = html.match(/<meta\s+name="theme-color"\s+content="([^"]+)"/i);
  assert(meta, 'meta theme-color tag missing');
  assert(meta[1].toLowerCase() === manifest.theme_color.toLowerCase(),
    `<meta theme-color> (${meta[1]}) != manifest theme_color (${manifest.theme_color}) — they must stay in sync`);
});

test('Servicio Fantasma inactivity trigger stays disabled', () => {
  // The Servicio Fantasma drill used to intercept returning users on login
  // when inactive >= 7 days. The owner asked to remove that interception.
  // launchServicioFantasma must therefore appear ONLY as its own definition,
  // never as a call site — any re-introduced invocation brings the drill back.
  const defs = (html.match(/function\s+launchServicioFantasma\s*\(/g) || []).length;
  const allRefs = (html.match(/launchServicioFantasma\s*\(/g) || []).length;
  assert(defs === 1, `expected exactly 1 launchServicioFantasma definition, found ${defs}`);
  assert(allRefs === defs,
    `launchServicioFantasma is invoked ${allRefs - defs} time(s) — the inactivity drill trigger is back; the owner disabled it`);
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
