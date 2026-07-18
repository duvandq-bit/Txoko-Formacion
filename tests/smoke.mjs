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
import { execSync } from 'node:child_process';
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

test('data/themes.json venue registry is well-formed', () => {
  // Multi-restaurant registry: every venue needs a name and the 8 brand hexes
  // that applyTheme() injects; at least one venue must be enabled or the app
  // would boot without an identity.
  const themes = JSON.parse(read('data/themes.json'));
  assert(Array.isArray(themes.venues) && themes.venues.length > 0, 'venues array missing/empty');
  const enabled = themes.venues.filter(v => v.enabled);
  assert(enabled.length >= 1, 'at least one venue must be enabled');
  const keys = ['primary','secondary','accent','accentHi','accent2','accentDeep','ink','paper'];
  for (const v of themes.venues) {
    assert(v.id && v.name, `venue missing id/name: ${JSON.stringify(v).slice(0,60)}`);
    for (const k of keys) {
      assert(v.brand && /^#[0-9a-fA-F]{6}$/.test(v.brand[k]),
        `venue ${v.id}: brand.${k} must be a 6-digit hex`);
    }
  }
  // The default (first enabled) venue must match the CSS Txoko defaults, so
  // first paint and the themed state agree.
  assert(enabled[0].brand.accent.toLowerCase() === '#c49a3c',
    'first enabled venue accent must match the CSS default (#c49a3c)');
});

test('multi-restaurant theming is wired (applyTheme + login picker)', () => {
  for (const fn of ['applyTheme','initVenues','renderVenuePicker','selectVenue']) {
    assert(new RegExp(`function ${fn}\\(`).test(html), `${fn}() missing`);
  }
  assert(/initVenues\(\);/.test(html), 'initVenues() must run at DOMContentLoaded');
  // Picker exists and ships hidden — single-venue installs must never flash it.
  assert(/id="loginVenue"[^>]*style="display:none"/.test(html),
    'login venue picker must exist and be hidden by default');
  // applyTheme must cover all 8 brand tokens and validate hex before injecting.
  for (const t of ['--brand-primary','--brand-secondary','--brand-accent','--brand-accent-hi',
                   '--brand-accent-2','--brand-accent-deep','--brand-ink','--brand-paper']) {
    assert(html.includes(`'${t}'`), `applyTheme token map missing ${t}`);
  }
  assert(/\^#\[0-9a-fA-F\]\{6\}\$/.test(html), 'applyTheme must validate hex values');
  // Venue fields are injected with escapeHtml (registry is data, not code).
  assert(/escapeHtml\(v\.name \|\| ''\)/.test(html), 'venue name must go through escapeHtml');
  // Dropdown shape: trigger + panel, closes on outside tap like the other dropdowns.
  assert(/id="loginVenueTrigger"/.test(html), 'venue dropdown trigger missing');
  assert(/\.nav-dd\.open, \.login-venue-dd\.open/.test(html),
    'click-outside handler must also close the venue dropdown');
  // Locked venues: rendered with a padlock + aria-disabled, and selectVenue
  // only accepts enabled venues (registry is the gate, not just the styling).
  assert(/aria-disabled="true" tabindex="-1"/.test(html), 'locked venues must be aria-disabled');
  assert(/Próximamente/.test(html), 'locked venues must read Próximamente');
  assert(/const v = _enabledVenues\(\)\.find\(x => x\.id === id\);\s*\n?\s*if\(!v\) return;/.test(html),
    'selectVenue must reject venues that are not enabled');
  // El héroe del login ya no muestra nombres de venue (siempre «Meseo», jul
  // 2026, arreglo del parpadeo de marca) — el auto-ajuste .long del logo se
  // fue con esa responsabilidad y no debe volver.
  assert(!/classList\.toggle\('long'/.test(html),
    'applyTheme must not scale venue names into the login logo (the hero is always Meseo)');
  assert(/\.login-venue-card\.on\{/.test(read('styles.css')), 'selected venue card style missing');
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

// Ghost (Servicio Fantasma) full schema + integrity guard.
// Locks the 12 Forbes-inspection scenarios added Jul 2026 (g_reserva, g_idioma,
// g_acceso, g_bebe, g_ebrio, g_halal, g_derrame, g_vino, g_sobremesa, g_terraza,
// g_cuenta, g_olvido) plus the shared invariants of the whole bank.
test('data/ghost-scenarios.json full schema + std ids + ES/EN parity', () => {
  const ghost = JSON.parse(read('data/ghost-scenarios.json'));
  assert(ghost.length >= 22, `expected >= 22 scenarios, got ${ghost.length}`);
  const NEW = new Set(['g_reserva','g_idioma','g_acceso','g_bebe','g_ebrio','g_halal',
    'g_derrame','g_vino','g_sobremesa','g_terraza','g_cuenta','g_olvido']);
  const ids = new Set();
  const topStr = ['id','title','title_en','role','role_en','tagline','tagline_en','icon','ctx','ctx_en'];
  const scStr = ['title','title_en','role','role_en','situation','situation_en','prompt','prompt_en'];
  for (const s of ghost) {
    assert(!ids.has(s.id), `duplicate scenario id ${s.id}`);
    ids.add(s.id);
    for (const f of topStr) assert(typeof s[f] === 'string' && s[f].trim(), `${s.id}: empty/missing ${f}`);
    for (const [i, sc] of s.scenes.entries()) {
      for (const f of scStr) assert(typeof sc[f] === 'string' && sc[f].trim(), `${s.id} sc${i}: empty/missing ${f}`);
      assert(sc.options.length === 3, `${s.id} sc${i}: expected 3 options, got ${sc.options.length}`);
      let allMet = 0;
      for (const o of sc.options) {
        for (const f of ['label','label_en','feedback','feedback_en'])
          assert(typeof o[f] === 'string' && o[f].trim(), `${s.id} sc${i}: option empty/missing ${f}`);
        assert(Array.isArray(o.effects) && o.effects.length > 0, `${s.id} sc${i}: option has no effects`);
        for (const e of o.effects) {
          assert(Number.isInteger(e.std) && e.std >= 1 && e.std <= 80, `${s.id} sc${i}: std ${e.std} out of range 1..80`);
          assert(typeof e.met === 'boolean', `${s.id} sc${i}: effect met not boolean`);
        }
        if (o.effects.every(e => e.met)) allMet++;
      }
      // One correct answer per scene, for ALL scenarios (owner-reviewed fix,
      // Jul 2026: the three farewell/clearing scenes that scored two options
      // as fully correct now have exactly one). Sole documented exception:
      // g_family scene 4 — the kitchen-chain failure is an intentional no-win
      // crisis with ZERO perfect options.
      if (s.id === 'g_family' && i === 3) {
        assert(allMet === 0, `${s.id} sc${i}: the no-win crisis must have 0 all-met options, got ${allMet}`);
      } else {
        assert(allMet === 1, `${s.id} sc${i}: expected exactly 1 all-met option, got ${allMet}`);
      }
    }
    // New scenarios: arc of 4-5 scenes.
    if (NEW.has(s.id)) assert(s.scenes.length >= 4 && s.scenes.length <= 5, `${s.id}: expected 4-5 scenes, got ${s.scenes.length}`);
  }
  for (const id of NEW) assert(ids.has(id), `missing new scenario ${id}`);
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

test('tokenization phase 2: no raw brand hexes in CSS contexts of index.html', () => {
  // Inline styles and template-literal CSS must reference the brand tokens,
  // not raw hexes, so applyTheme() reskins them. Quoted JS strings and SVG
  // presentation attributes are exempt (phase 3 — var() in SVG attributes is
  // not Safari-safe).
  const cssCtx = html.match(/[:,]#(c49a3c|e4be68|d4aa4c|7d5c2f|1c2a22|f4ede2|4d8a5e|2d6a3e)/gi) || [];
  assert(cssCtx.length === 0,
    `found ${cssCtx.length} raw brand hexes in CSS contexts: ${cssCtx.slice(0,4).join(' ')}`);
  // The dashboard greeting eyebrow follows the active venue.
  assert(/dash-hero-label">\$\{\(typeof ACTIVE_VENUE/.test(html),
    'dashboard hero label must be venue-aware');
});

test('brand-token layer drives the palette (multi-restaurant ready)', () => {
  const css = read('styles.css');
  // The 8 brand tokens must be defined with the Txoko identity values so a new
  // venue is a theme swap, not a find-and-replace. The dark ones must stay dark
  // (WCAG): --brand-primary #2d6a3e and --brand-accent-deep #7d5c2f.
  assert(/--brand-primary:\s*#2d6a3e/.test(css), '--brand-primary must be #2d6a3e (dark green)');
  assert(/--brand-accent:\s*#c49a3c/.test(css), '--brand-accent must be #c49a3c (gold)');
  assert(/--brand-accent-deep:\s*#7d5c2f/.test(css), '--brand-accent-deep must be #7d5c2f (dark gold)');
  assert(/--brand-ink:\s*#1c2a22/.test(css), '--brand-ink must be #1c2a22');
  assert(/--brand-paper:\s*#f4ede2/.test(css), '--brand-paper must be #f4ede2');
  // Primitives must derive from the brand layer, and the migration targets exist.
  assert(/--gold:\s*var\(--brand-accent\)/.test(css), '--gold must derive from --brand-accent');
  assert(/--green-deep:\s*var\(--brand-primary\)/.test(css), '--green-deep must derive from --brand-primary');
  assert(/--gold-deep:\s*var\(--brand-accent-deep\)/.test(css), '--gold-deep must derive from --brand-accent-deep');
  // The migration must have removed the raw brand hexes from the sheet: only the
  // 8 --brand-* definitions should still carry them (comments may add a couple).
  const rawGold = (css.match(/#c49a3c/gi) || []).length;
  assert(rawGold <= 1, `#c49a3c should survive only in --brand-accent (found ${rawGold})`);
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

test('sw.js serves the shell network-first (no HTML/CSS version skew)', () => {
  // Stale-while-revalidate on the shell caused mismatched HTML/CSS after a
  // deploy. The shell (navigation + styles.css) must be network-first so an
  // online user always gets a matching, freshly-deployed pair.
  const sw = read('sw.js');
  assert(/function isShellRequest\(/.test(sw),
    'sw must classify shell requests (navigation + styles.css)');
  assert(/if \(isShellRequest\(req, url\)\)/.test(sw),
    'the fetch handler must branch on shell requests');
  assert(sw.includes('index\\.html|styles\\.css|manifest\\.json'),
    'styles.css must be treated as part of the shell');
  // and the page reloads once when a new SW takes control
  assert(/addEventListener\('controllerchange'/.test(html) && /_swReloaded/.test(html),
    'a guarded controllerchange reload must apply new deploys in-session');
  // an installed PWA must actively check for updates on load + on refocus,
  // otherwise a frozen standalone page never sees a new deploy.
  assert(/function _checkForAppUpdate\(/.test(html) && /reg\.update\(\)/.test(html),
    'must force a SW update check');
  assert(/visibilitychange'[^]*?_checkForAppUpdate|_checkForAppUpdate[^]*?visibilitychange/.test(html),
    'update check must run when the app returns to the foreground');
});

test('sw.js keeps a STABLE runtime cache so updates never drop the images', () => {
  // Bug "se perdieron los gráficos al actualizar": el activate borraba TODA la
  // caché por versión (incluidos sprites), y con red floja no se redescargaban.
  // Los assets perezosos (sprites/data) deben vivir en una caché de nombre FIJO
  // (sin la versión) que el activate NO borra.
  const sw = read('sw.js');
  const m = sw.match(/const RUNTIME_CACHE = '([^']+)'/);
  assert(m, 'debe existir un RUNTIME_CACHE con nombre estable');
  assert(!/\$\{VERSION\}|`/.test(m[1]) && !m[1].includes('shell'),
    'RUNTIME_CACHE debe ser fijo (sin la versión) para sobrevivir a los bumps');
  // la rama stale-while-revalidate (assets) usa la caché estable, no la del shell
  assert(/caches\.open\(RUNTIME_CACHE\)/.test(sw),
    'los assets perezosos deben cachearse en RUNTIME_CACHE');
  // el activate solo borra cachés de shell → la runtime se conserva
  assert(/keys\.filter\(k => k\.startsWith\('txoko-shell-'\) && k !== CACHE_NAME\)/.test(sw),
    'el activate solo debe borrar cachés de shell (conservar la runtime)');
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
    'basemaps.cartocdn.com',            // wine map tiles — CARTO Voyager (img/connect)
    'www.youtube.com'                   // video embeds (frame-src)
  ];
  for (const o of required) assert(csp.includes(o), `CSP no longer allows ${o} — would break a feature`);
  // The team chat needs the realtime WebSocket + storage images.
  assert(/wss:\/\/advkoujfgbrrjvqexrcu\.supabase\.co/.test(csp),
    'CSP connect-src must allow the Supabase realtime WebSocket (wss) for the chat');
  assert(/img-src[^;]*advkoujfgbrrjvqexrcu\.supabase\.co/.test(csp),
    'CSP img-src must allow Supabase storage so chat photos (and wine images) render');
});

test('Team chat: nav wired, realtime teardown, safe render, moderation', () => {
  // Nav button + route so the tab is reachable and renders.
  assert(/showTab\('chat'\)/.test(html) && html.includes('navChat'), 'chat nav entry missing');
  assert(/chat:renderChat/.test(html), 'chat route not registered in renderMap');
  assert(/function renderChat\(/.test(html), 'renderChat() missing');
  // Realtime must be torn down when leaving the tab (no socket/presence leak).
  assert(/currentTab==='chat' && tab!=='chat'/.test(html) && /function _chatDisconnect\(/.test(html),
    'chat realtime teardown on tab change missing');
  // User content must be escaped (no XSS via message/name/photo url).
  const rc = html.slice(html.indexOf('function _chatRenderStream'), html.indexOf('function _chatRenderStream') + 8000);
  assert(/_chatEsc\(m\.message\)/.test(rc) && /_chatEsc\(m\.image_url\)/.test(rc) && /_chatEsc\(m\.employee\)/.test(rc),
    'chat message/photo/author must be HTML-escaped');
  // Moderation: author deletes own; supervisor 'Duvan' deletes any.
  assert(/m\.employee===currentUser \|\| currentUser==='Duvan'/.test(html),
    'chat delete gate (author or supervisor) missing');
  // Photos are downscaled client-side before upload (mobile bandwidth).
  assert(/function _chatDownscale\(/.test(html) && /\.toBlob\(/.test(html) && /'image\/webp'/.test(html),
    'chat photo downscale-to-webp missing');
});

test('Team chat: WhatsApp features (mentions, replies, reactions, typing)', () => {
  // @Mentions: autocomplete + parse + notify (in-app bell AND lock-screen push)
  assert(/function _chatMentionScan\(/.test(html) && /function _chatParseMentions\(/.test(html),
    'mention autocomplete/parse missing');
  const send = html.slice(html.indexOf('async function _chatSend'), html.indexOf('async function _chatSend') + 2200);
  assert(/te ha mencionado/.test(send) && /send-push/.test(send),
    'mentioned teammates must get in-app notification + push');
  // Mention highlighting must operate on ALREADY-ESCAPED text (no XSS door).
  assert(/_chatDecorateMentions\(_chatEsc\(m\.message\)/.test(html),
    'mention decoration must wrap the escaped message, never raw');
  // Replies: composer bar + reply_to persisted + quote block + tap-to-jump.
  assert(/function _chatStartReply\(/.test(html) && /fields\.reply_to = _chatReplyTo\.id/.test(html)
    && /chat-quote/.test(html) && /_chatScrollToMsg/.test(html), 'reply-quoting incomplete');
  // Reactions: toggle own name per emoji, optimistic PATCH, pills with count.
  assert(/function _chatReact\(/.test(html) && /chat-react-pill/.test(html),
    'emoji reactions missing');
  // Typing: broadcast (no DB writes) + throttle + expiry.
  assert(/event:'typing'/.test(html) && /_chatNotifyTyping/.test(html) && /_chatTypingSentAt < 2200/.test(html),
    'typing indicator must use throttled realtime broadcast');
  // New-message push: absent teammates only, sender/present/mentioned excluded,
  // rate-limited so a lively conversation can't machine-gun phones.
  const bp = html.slice(html.indexOf('function _chatBroadcastPush'), html.indexOf('function _chatBroadcastPush') + 1600);
  assert(/_chatPresence/.test(bp) && /mentioned/.test(bp) && /currentUser, \.\.\.present, \.\.\.mentioned/.test(bp),
    'chat broadcast push must exclude sender, present users and mentioned users');
  assert(/3\*60\*1000/.test(bp), 'chat broadcast push must be rate-limited (3 min gate)');
  assert(/_chatBroadcastPush\(body\)/.test(html), 'broadcast push must fire on successful insert');
  // The typing dots respect reduced motion.
  const css = read('styles.css');
  assert(/prefers-reduced-motion[^}]*\{[^}]*chat-typing-dots/s.test(css) || /chat-typing-dots i, \.chat-row\.sel/.test(css),
    'chat animations need a reduced-motion gate');
});

test('update push is silent (no vibration/sound) — quiet banner only', () => {
  // Petición del propietario: el aviso de actualización lo más discreto
  // posible. iOS obliga a mostrar un banner en todo push, pero podemos
  // callarlo: sin vibración, sin sonido, sin re-alerta para tag 'app-update'.
  const sw = read('sw.js');
  assert(/const _quiet = data\.tag === 'app-update'/.test(sw), 'update push must be flagged quiet');
  assert(/silent: _quiet/.test(sw), 'update push must set silent');
  assert(/vibrate: _quiet \? \[\]/.test(sw), 'update push must not vibrate');
  assert(/renotify: _quiet \? false/.test(sw), 'update push must not re-alert');
  assert(/tag:'app-update', renotify:false/.test(html), 'sender must not request renotify for updates');
  // los avisos de chat/menciones conservan su vibración (no rompimos eso)
  assert(/data\.renotify \? \[200, 100, 200, 100, 200\] : \[200, 100, 200\]/.test(sw),
    'chat/mention notifications must keep their vibration');
});

test('push notifications: raster icons, deep links, rich payload', () => {
  // Android renders an SVG notification icon as a generic grey circle — the
  // logo must be raster (icon-192.png) plus a white-on-transparent status-bar
  // badge (badge-96.png). Taps deep-link into the app (chat pushes land in
  // the chat tab), mentions re-alert through a coalesced tag, photo messages
  // show the picture itself. Deep link works even through the v2 send-push
  // fn (title/body/tag only): the SW infers data.tab from tag === 'chat'.
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  for (const f of ['icon-192.png', 'badge-96.png']) {
    assert(existsSync(join(ROOT, f)), `${f} missing`);
    assert(readFileSync(join(ROOT, f)).subarray(0, 4).equals(PNG), `${f} is not a PNG`);
  }
  const sw = read('sw.js');
  assert(sw.includes("'./icon-192.png'") && sw.includes("'./badge-96.png'"), 'SW must use raster icon + badge');
  assert(/icon-192\.png/.test(sw.match(/const SHELL_URLS = \[[^\]]*\]/)[0]), 'raster icons must be pre-cached in the shell');
  assert(/renotify: _quiet \? false : data\.renotify/.test(sw) && /options\.image = data\.image/.test(sw),
    'SW push handler must support renotify (chat) + big-picture image');
  assert(/data\.tag === 'chat'\) data\.data\.tab = 'chat'/.test(sw), 'chat tag must infer the deep link (v2 fn compatibility)');
  assert(/postMessage\(\{ type: 'openTab', tab \}\)/.test(sw), 'notification click must deep-link an open window');
  assert(sw.includes("'#tab=' + encodeURIComponent(tab)"), 'cold-start deep link (#tab= hash) missing from click handler');
  // Client side: SW message listener, boot hash consumption, post-login landing.
  assert(/type !== 'openTab'/.test(html) && /_pendingDeepTab/.test(html), 'client deep-link plumbing missing');
  assert(html.includes("icon: 'icon-192.png'"), 'in-page Notification must use the raster icon too');
  assert(/renotify:true, data:\{tab:'chat'\}/.test(html), 'mention push must renotify + deep-link to chat');
  assert(/extra\.image = body\.image_url/.test(html), 'photo chat pushes must attach the image');
  const manifest = JSON.parse(read('manifest.json'));
  assert(manifest.icons.some(i => i.src === 'icon-192.png' && i.type === 'image/png'), 'manifest missing the PNG icon');
});

test('wine map is real cartography (Voyager basemap, no fake 3D or DO shapes)', () => {
  // Basemap must be CARTO Voyager retina raster served untouched — no hue/
  // saturation filters that make real cartography look artificial.
  assert(html.includes('basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png'),
    'CARTO Voyager retina tiles missing from map init');
  assert(!/raster-hue-rotate|raster-saturation/.test(html),
    'raster color filters are back — the basemap should render untouched');
  // The old "3D terrain" pointed at a DEM endpoint that does not exist
  // (demotiles.maplibre.org/terrain-tiles) — it must stay removed.
  assert(!html.includes('demotiles.maplibre.org'), 'dead demotiles DEM endpoint is back in the map');
  assert(!/setTerrain\(/.test(html), 'fake 3D terrain is back in the wine map');
  // Hand-approximated DO rings must not render as filled areas over real
  // cartography: each DO is a precise centroid point + label instead.
  assert(html.includes("id: 'do-points', type: 'circle'"), 'do-points circle layer missing');
  assert(!html.includes("id: 'do-fill'"), 'hand-drawn DO polygon fill layer is back');
  assert(/function _mlDOCentroid\(/.test(html), '_mlDOCentroid centroid helper missing');
  // OSM/CARTO tile usage requires visible attribution on the map.
  assert(/new maplibregl\.AttributionControl\(\{ compact: true \}\)/.test(html),
    'map attribution control missing (required by OSM/CARTO tile terms)');
});

test('ingredient-allergen base: valid schema + no NEW undeclared allergens', () => {
  // data/ingredients.json is the single source of truth for ingredient →
  // allergen tags (EU-14, app vocabulary). The audit (tests/allergen-audit.mjs)
  // cross-checks it against every dish's hand-written allergen list.
  const base = JSON.parse(read('data/ingredients.json'));
  assert(Array.isArray(base.eu14) && base.eu14.length === 14, 'eu14 canon must have exactly 14 entries');
  const canon = new Set(base.eu14.map(e => e.app));
  for (const [key, e] of Object.entries(base.ingredientes)) {
    assert(Array.isArray(e.alergenos) && e.alergenos.every(a => canon.has(a)),
      `ingredient "${key}" carries a tag outside the EU-14 canon`);
    assert(['certeza culinaria', 'notas del plato', 'deducido de la carta', 'propuesta', 'pendiente', 'confirmado por propietario'].includes(e.fuente),
      `ingredient "${key}" has invalid fuente`);
  }
  // PHASE-3 LOCK (partial): declared === computed, both directions.
  // Direction 1 at ZERO tolerance: any dish whose tagged ingredients imply
  // an allergen it does not declare fails CI immediately.
  const audit = JSON.parse(execSync('node tests/allergen-audit.mjs --json', { cwd: ROOT }).toString());
  for (const f of audit.no_declarado) {
    assert(false,
      `UNDECLARED allergen: dish ${f.id} "${f.plato}" is missing ${f.alergeno} (from: ${f.por.join(', ')})`);
  }
  // Direction 2 at ZERO: every declared allergen has a component origin.
  // The kitchen (Mónica, Jul 2026) resolved the final 14 gaps — vinegars in
  // mojo/citrus mayo, wine in fillings and mushroom sauce, the demi butter
  // (removable!), the tocinillo crisps, the sea bass added to its own list,
  // and three over-declarations removed (oysters are MOLLUSCS not
  // crustaceans; pisto and bao carry no sulphites). Declared ≡ computed is
  // now total, both directions, no exceptions.
  for (const f of audit.sin_origen) {
    assert(false,
      `ORPHAN declaration: dish ${f.id} "${f.plato}" declares ${f.alergeno} but no tagged ingredient explains it`);
  }
});

test('DISH_ACTIONS matrix: full coverage, comandas present, Trifasi fix locked', () => {
  // FASE 3b: retirability is DATA (DISH_ACTIONS), not prose parsing. Lock:
  // every declared allergen of every dish has a matrix entry; every removable
  // has its comanda; consumers read the matrix first; and the one intentional
  // divergence from the old prose parser (Trifasi Huevos = structural, the
  // veg-shortcut bug) stays fixed.
  const iM = html.indexOf('const DISH_ACTIONS = {');
  assert(iM !== -1, 'DISH_ACTIONS matrix missing');
  const jM = html.indexOf('};', iM);
  const M = JSON.parse(html.slice(iM + 'const DISH_ACTIONS = '.length, jM + 1));
  const iEs = html.indexOf('const DISHES = ['), jEs = html.indexOf('\n];', iEs);
  const dishBlock = html.slice(iEs, jEs);
  let pairs = 0, removables = 0;
  for (const m of dishBlock.matchAll(/\{id:(\d+),cat:'[^']*',name:'((?:[^'\\]|\\.)*)',allergens:\[([^\]]*)\]/g)) {
    const id = m[1], name = m[2];
    const allergens = [...m[3].matchAll(/'([^']+)'/g)].map(x => x[1]);
    assert(M[id], `dish ${id} "${name}" has no DISH_ACTIONS entry`);
    for (const a of allergens) {
      pairs++;
      const e = M[id][a];
      assert(e && (e.r === 0 || e.r === 1), `dish ${id} "${name}": allergen ${a} missing from matrix`);
      if (e.r === 1) { removables++; assert(e.c, `dish ${id} "${name}": removable ${a} has no comanda`); }
    }
  }
  assert(pairs >= 260 && removables >= 70, `matrix coverage shrank (pairs=${pairs}, removables=${removables})`);
  assert(M['89'] && M['89']['Huevos'] && M['89']['Huevos'].r === 0,
    'Trifasi Huevos must stay STRUCTURAL (veg version keeps the fried egg; brioche egg is structural)');
  // Vitello tonnato (owner, jul 2026): la salsa tonnata es ingrediente
  // principal — retirarla desarma el plato. Pescado/Huevos/Sulfitos NUNCA
  // vuelven a ser adaptables aquí; solo el brioche (Gluten) se retira.
  for (const a of ['Pescado', 'Huevos', 'Sulfitos']) {
    assert(M['8'] && M['8'][a] && M['8'][a].r === 0, `Vitello ${a} must stay STRUCTURAL (tonnato is core)`);
  }
  assert(M['8']['Gluten'] && M['8']['Gluten'].r === 1, 'Vitello Gluten (brioche) must stay removable');
  // Consumers must consult the matrix before the prose parser.
  const nr = html.slice(html.indexOf('function _simNonRemovableAllergens'), html.indexOf('function _simNonRemovableAllergens') + 1200);
  assert(/DISH_ACTIONS\[dish\.id\]/.test(nr), '_simNonRemovableAllergens must read DISH_ACTIONS first');
  const drill = html.slice(html.indexOf('function buildAllergenQuestions'), html.indexOf('function startAllergenTest'));
  assert(/DISH_ACTIONS\[dish\.id\]/.test(drill), 'allergen drill comanda must read DISH_ACTIONS first');
});

test('dish detail + immersive journey read verdicts from DISH_ACTIONS', () => {
  // The service-facing surfaces must show the MATRIX verdict (adaptable with
  // its exact comanda / structural), never the old word-sniffing heuristic
  // ("Posiblemente eliminable bajo petición" guessed from notes keywords).
  const detail = html.slice(html.indexOf('function renderRepasoDishDetail'), html.indexOf('function changeRepasoTopic'));
  assert(/DISH_ACTIONS\[dish\.id\]/.test(detail), 'dish detail panel must read DISH_ACTIONS');
  assert(/SE ADAPTA/.test(detail) && /ESTRUCTURAL/.test(detail), 'dish detail must show both verdicts');
  const dj = html.slice(html.indexOf('function _djPhaseAllergens'), html.indexOf('function _djPhaseAllergens') + 7000);
  assert(/DISH_ACTIONS\[dish\.id\]/.test(dj), 'immersive journey allergen cards must read DISH_ACTIONS');
  assert(!/Posiblemente eliminable bajo petición/.test(html), 'heuristic "maybe removable" chip must stay retired');
});

test('DISH_COMPONENTS: dish allergens derive exactly from components, zero drift vs base', () => {
  // FASE 4: cada plato = lista de componentes y sus alérgenos se CALCULAN
  // como la unión de los de sus componentes — la declaración manual queda
  // como espejo verificado, no como fuente editable. Tres candados:
  //   1. unión(componentes) == allergens declarados, EXACTA, por plato;
  //   2. cada componente existe en data/ingredients.json con el MISMO set
  //      de alérgenos (la base única sigue siendo la única fuente);
  //   3. el rol m=1 (modificable) coincide con DISH_ACTIONS (r=1 en todos
  //      sus alérgenos), y la ficha de plato muestra la procedencia.
  const iC = html.indexOf('const DISH_COMPONENTS = {');
  assert(iC !== -1, 'DISH_COMPONENTS missing');
  const jC = html.indexOf('};', iC);
  const C = new Function(html.slice(iC, jC + 2) + '; return DISH_COMPONENTS;')(); // eslint-disable-line no-new-func
  const iM = html.indexOf('const DISH_ACTIONS = {');
  const M = JSON.parse(html.slice(iM + 'const DISH_ACTIONS = '.length, html.indexOf('};', iM) + 1));
  const base = JSON.parse(read('data/ingredients.json')).ingredientes;
  const byName = {};
  for (const e of Object.values(base)) byName[e.nombre] = e.alergenos;
  // Pseudo-components (multi-variant dishes): allergens that depend on the
  // chosen variant — real provenance, but no single base ingredient and no
  // per-comanda role, so locks 2 and 3 don't apply to them.
  const PSEUDO = new Set(['Base de todas las variantes', 'Según la variante elegida']);
  const iEs = html.indexOf('const DISHES = ['), jEs = html.indexOf('\n];', iEs);
  let checked = 0, modeled = 0;
  for (const m of html.slice(iEs, jEs).matchAll(/\{id:(\d+),cat:'[^']*',name:'((?:[^'\\]|\\.)*)',allergens:\[([^\]]*)\]/g)) {
    const id = m[1], name = m[2];
    const declared = [...m[3].matchAll(/'([^']+)'/g)].map(x => x[1]).sort();
    checked++;
    if (!declared.length) continue;
    const comps = C[id];
    assert(comps && comps.length, `dish ${id} "${name}" declares allergens but has no components`);
    modeled++;
    const union = [...new Set(comps.flatMap(c => c.a))].sort();
    assert(JSON.stringify(union) === JSON.stringify(declared),
      `dish ${id} "${name}": derived [${union}] != declared [${declared}]`);
    for (const c of comps) {
      if (PSEUDO.has(c.n)) continue;
      assert(byName[c.n], `dish ${id}: component "${c.n}" not in ingredient base`);
      assert(JSON.stringify([...c.a].sort()) === JSON.stringify([...byName[c.n]].sort()),
        `dish ${id}: component "${c.n}" allergens drifted from base`);
      const allRemovable = c.a.every(a => M[id] && M[id][a] && M[id][a].r === 1);
      assert((c.m === 1) === allRemovable,
        `dish ${id}: component "${c.n}" role m=${c.m} contradicts DISH_ACTIONS`);
    }
  }
  assert(checked >= 85 && modeled >= 75, `coverage shrank (dishes=${checked}, modeled=${modeled})`);
  // Runtime derivation + service-facing provenance in the dish card.
  assert(/function computeDishAllergens/.test(html), 'computeDishAllergens helper missing');
  const detail = html.slice(html.indexOf('function renderRepasoDishDetail'), html.indexOf('function changeRepasoTopic'));
  assert(/DISH_COMPONENTS\[dish\.id\]/.test(detail), 'dish detail must read DISH_COMPONENTS for provenance');
  assert(/'From':'Por'/.test(detail), 'allergen provenance line missing from dish detail');
});

test('smart review console: simulation briefing with terminal typing', () => {
  // El propietario pidió una introducción que haga sentir que se entra en
  // una simulación. El briefing vive en el terminal Pip-Boy, se teclea la
  // primera vez por sesión y respeta prefers-reduced-motion (aparece
  // completo, sin animación).
  const sr = html.slice(html.indexOf("c.innerHTML = `\n    <div class=\"ri-console\">"), html.indexOf('function _riSetDifficulty'));
  assert(/ri-brief/.test(sr) && /riBriefText/.test(sr), 'simulation briefing block missing from the console');
  assert(/BRIEFING DE SIMULACIÓN/.test(sr) && /SIMULATION BRIEFING/.test(sr), 'briefing header must exist in both languages');
  assert(/turno virtual de Txoko/.test(sr) && /virtual Txoko shift/.test(sr), 'briefing copy missing');
  assert(/prefers-reduced-motion/.test(sr), 'typing effect must respect reduced motion');
  assert(/_srBriefTyped/.test(sr), 'typing must run once per session (sessionStorage gate)');
  const css = read('styles.css');
  assert(/\.ri-brief-text\.typing::after/.test(css), 'typing cursor style missing');
  assert(/\.ri-console \.ri-brief\{/.test(css), 'briefing styles must be scoped to the console');
});

test('supervisor panel: realtime employees channel + silent refresh + live pill', () => {
  // Reporte del propietario: el panel cargaba de la nube UNA vez y quedaba
  // congelado. Ahora: canal realtime sobre employees (tabla añadida a la
  // publicación supabase_realtime), refresco silencioso con debounce, sondeo
  // de respaldo, desconexión al salir, y el refresco NUNCA saca al
  // supervisor de una subpantalla (guard por presencia de supLivePill).
  assert(/function _supConnectLive/.test(html) && /table:'employees'/.test(html),
    'realtime subscription to employees missing');
  assert(/function _supDisconnect/.test(html), '_supDisconnect missing');
  const q = html.slice(html.indexOf('function _supQueueRefresh'), html.indexOf('function _supQueueRefresh') + 900);
  assert(/supLivePill/.test(q) && /renderSupDashboard\(true\)/.test(q) && /4000/.test(q),
    'silent refresh must be debounced and gated on the dashboard view');
  assert(/function renderSupDashboard\(silent\)/.test(html), 'renderSupDashboard must accept silent mode');
  assert(/currentTab==='supervisor' && tab!=='supervisor'/.test(html), 'showTab must tear down the supervisor channel');
  assert(/currentTab==='supervisor'\) _supDisconnect\(\)/.test(html.replace(/typeof _supDisconnect==='function'\) _supDisconnect/g, "currentTab==='supervisor') _supDisconnect")) || /pagehide/.test(html),
    'pagehide must drop the supervisor channel');
  assert(/id="supLivePill"/.test(html) && /_supStampLive/.test(html), 'live pill + timestamp missing');
  const css = read('styles.css');
  assert(/\.sup-live-dot\{/.test(css) && /prefers-reduced-motion:reduce\)\{\.sup-live-dot\{animation:none\}/.test(css.replace(/\s+/g, '')),
    'live dot pulse must respect reduced motion');
  assert(/\.sup-emp-card\{background:transparent/.test(css), 'employee cards must be de-boxed (ledger rows)');

  // Reorganización (petición del propietario: "hay que deslizar mucho"):
  // 4 secciones con pestañas y fichas de empleado PLEGADAS (details/summary).
  // El estado (sección activa + fichas abiertas) sobrevive al refresco EN VIVO.
  assert(/class="sup-seg"/.test(html) && (html.match(/_supSetSection\('/g) || []).length >= 4,
    'segmented control with 4 sections missing');
  for (const sec of ['hoy', 'equipo', 'analisis', 'acciones']) {
    assert(html.includes(`data-sec="${sec}"`), `section ${sec} missing`);
  }
  assert(/<details class="sup-emp-card"/.test(html) && /<summary class="sup-emp-header">/.test(html),
    'employee cards must be collapsible details/summary');
  assert(/_supOpenEmps/.test(html) && /_supApplySection\(\)/.test(html),
    'section + open-cards state must survive silent refreshes');
  const css2 = read('styles.css');
  assert(/\.sup-sec\{display:none\}/.test(css2) && /\.sup-seg button\.active/.test(css2),
    'section visibility CSS missing');

  // iOS se comía los toques: el refresco EN VIVO reemplazaba el DOM cada ~4 s
  // con el equipo activo, destruyendo el botón bajo el dedo. Tres candados:
  // hash (sin cambios → solo sello), guard de toque (<1.2 s → esperar) y
  // herramientas envueltas con toast de error.
  assert(/window\._supLastHash === _hash/.test(html), 'silent refresh must skip re-render when data is unchanged');
  assert(/window\._supLastTouch\|\|0\) < 1200/.test(html), 'refresh must yield to a recent touch');
  // 5 herramientas envueltas: carta, analítica, aviso, fotos, stats LQA.
  // (La antigua "Stats Protocolo" se retiró al fusionar Protocolo→LQA; el
  // quiz en vivo se retiró en jul 2026 — lo sustituye el Quiz del Día.)
  assert(/function _supTool/.test(html) && (html.match(/_supTool\('/g) || []).length >= 5,
    'supervisor tools must go through the error-surfacing wrapper');
  assert(/function renderSupLqaStats/.test(html),
    'the LQA Stats supervisor view (renderSupLqaStats) must be defined');
  assert(!/renderSupProtocolStats/.test(html),
    'dead renderSupProtocolStats reference must not linger (Protocolo was removed)');
});

test('notification panel: fixed header, 44px close, mark-all-read', () => {
  // Reporte del propietario (iOS/Android): la ✕ vivía DENTRO del área con
  // scroll (desaparecía al desplazarse), sin área táctil ni safe-area, y no
  // existía "marcar todas como leídas".
  const p = html.slice(html.indexOf('async function renderNotifPanel'), html.indexOf('async function markNotifRead'));
  assert(/flex-direction:column/.test(p) && /flex-shrink:0/.test(p) && /id="notifList"[^>]*flex:1;overflow-y:auto/.test(p),
    'panel header must be fixed with only the list scrolling');
  assert(/min-width:44px;min-height:44px/.test(p), 'close button needs a 44px touch target');
  assert(/env\(safe-area-inset-top/.test(p), 'panel header must respect the notch');
  assert(/min\(340px,86vw\)/.test(p), 'drawer must always leave a tappable backdrop strip');
  assert(/markAllNotifsRead\(\)/.test(p) && /function markAllNotifsRead/.test(html),
    'mark-all-read button/function missing');
  const f = html.slice(html.indexOf('async function markAllNotifsRead'), html.indexOf('async function markAllNotifsRead') + 1200);
  assert(/readNotifIds/.test(f) && /Promise\.allSettled/.test(f) && /notifBadge/.test(f),
    'mark-all must persist locally, sync to Supabase and clear the badge');
});

test('wine detail: opaque overlay, dark hero band, SVG bottle by type', () => {
  // "El diseño es pobre" (propietario): el overlay al 97% dejaba sangrar el
  // dashboard como texto fantasma y la botella era una caja pálida con un
  // icono diminuto. Ahora: fondo opaco INLINE (a prueba de CSS viejo), banda
  // hero TUNIC oscura y botella SVG dibujada por tipo.
  assert(/overlay\.style\.background = '#f4ede2'/.test(html), 'wine overlay must be opaque inline');
  assert(/function _wineBottleSvg/.test(html), 'SVG bottle renderer missing');
  const b = html.slice(html.indexOf('function _wineBottleSvg'), html.indexOf('function _wineImgHtml'));
  for (const t of ['tinto', 'blanco', 'rosado', 'espumoso', 'dulce']) assert(b.includes(t), `bottle color for ${t} missing`);
  assert(/class="wd-hero"/.test(html), 'dark hero band missing from wine detail');
  const hero = html.slice(html.indexOf('class="wd-hero"') - 40, html.indexOf('class="wd-hero"') + 600);
  assert(/var\(--brand-ink\)/.test(hero), 'hero band must use the brand token background');
  assert(/background:transparent;border:none;box-shadow:none/.test(html.slice(html.indexOf('function _wineImgHtml'), html.indexOf('function _wineImgHtml') + 1600)),
    'bottle wrap must be transparent (no pale box on the dark band)');

  // Los chips de "Vinos similares" llevaban emojis (🍇, 🛢) — fuera:
  // micro-SVGs monolínea con currentColor.
  assert(/CHIP_ICO_GRAPE/.test(html) && /CHIP_ICO_TANK/.test(html), 'chip SVG icons missing');
  const chips = html.slice(html.indexOf('function _consolidateChips'), html.indexOf('function _renderSimilarWinesSection'));
  assert(!/[\u{1F347}\u{1F6E2}]/u.test(chips), 'emoji found in similar-wine chips — banned');
});

test('logo taps home + persistent search pill under the nav', () => {
  // Peticiones del propietario: el logo TXOKO vuelve al inicio (accesible:
  // role button + Enter/Espacio) y la búsqueda global vive a UN toque bajo
  // la barra de Inicio (antes estaba escondida dentro del desplegable).
  const logo = html.slice(html.indexOf('id="headerLogo"') - 40, html.indexOf('id="headerLogo"') + 400);
  assert(/onclick="showTab\('dashboard'\)"/.test(logo) && /role="button"/.test(logo) && /onkeydown/.test(logo),
    'header logo must navigate home, accessibly');
  const pill = html.slice(html.indexOf('id="globalSearchPill"') - 40, html.indexOf('id="globalSearchPill"') + 700);
  assert(/onclick="openGlobalSearch\(\)"/.test(pill), 'search pill must open the global search');
  assert(/min-height:40px/.test(pill), 'search pill needs a touch-friendly height');
  assert(/globalSearchPillLbl/.test(html.slice(html.indexOf('const _gsLbl'), html.indexOf('const _gsLbl') + 600)),
    'pill label must be localized with the rest');
});

test('update push: SW pre-installs new build on tag app-update', () => {
  // "¿Qué se necesita para enviar la actualización a los dispositivos?" —
  // el push despierta al SW aunque la app esté cerrada: con tag 'app-update'
  // dispara registration.update(), cuyo install precachea el shell FRESCO
  // (no-cache), y muestra la notificación (obligatoria en iOS). El botón
  // vive en el panel del supervisor.
  const sw = read('sw.js');
  assert(/new Request\(u, \{ cache: 'no-cache' \}\)/.test(sw), 'shell precache must bypass the HTTP cache');
  assert(/data\.tag === 'app-update'/.test(sw) && /self\.registration\.update\(\)/.test(sw),
    'push handler must background-update on tag app-update');
  assert(/Promise\.all\(jobs\)/.test(sw), 'notification and update must both be awaited');
  assert(/function sendAppUpdatePush/.test(html), 'supervisor sendAppUpdatePush missing');
  const fn = html.slice(html.indexOf('async function sendAppUpdatePush'), html.indexOf('async function sendAppUpdatePush') + 1400);
  assert(/tag:'app-update'/.test(fn) && /target:'all'/.test(fn) && /confirm\(/.test(fn),
    'update push must target all with the app-update tag, behind a confirm');
  assert(/onclick="sendAppUpdatePush\(\)"/.test(html), 'supervisor panel button missing');
});

test('every dish has name, ingredients and story in ES and EN', () => {
  // El Capítulo I del Viaje Inmersivo muestra dish.history; 26 platos lo
  // tenían vacío (relleno "no disponible"). Redactados desde su ficha + el
  // producto local canario. Candado: ninguna ficha sin historia, en ningún
  // idioma — así el Viaje nunca abre con un capítulo hueco.
  for (const arr of ['DISHES', 'DISHES_EN']) {
    const i = html.indexOf('const ' + arr + ' = [');
    const j = html.indexOf('\n];', i);
    const blk = html.slice(i, j);
    const starts = [...blk.matchAll(/\{id:(\d+),/g)];
    for (let k = 0; k < starts.length; k++) {
      const obj = blk.slice(starts[k].index, k + 1 < starts.length ? starts[k + 1].index : blk.length);
      const h = obj.match(/history:'((?:[^'\\]|\\.)*)'/);
      assert(h && h[1].trim().length > 0, `${arr} dish ${starts[k][1]} has no story`);
      // Los ingredientes se muestran en flashcards/ficha en AMBOS idiomas —
      // 6 platos los tenían vacíos en EN (reporte del propietario). Nunca
      // más un plato sin ingredientes, en ningún idioma.
      const ing = obj.match(/ingredients:'((?:[^'\\]|\\.)*)'/);
      assert(ing && ing[1].trim().length > 0, `${arr} dish ${starts[k][1]} has no ingredients`);
      const nm = obj.match(/name:'((?:[^'\\]|\\.)*)'/);
      assert(nm && nm[1].trim().length > 0, `${arr} dish ${starts[k][1]} has no name`);
    }
  }
});

test('audit fixes: exam empty-pool guard + journey/txoko option de-dup', () => {
  // Auditoría jul 2026 (55k preguntas ejecutadas). Tres arreglos de robustez:
  // 1) el Examen crasheaba con pool vacío (categoría mono-turno en el turno
  //    contrario — Hamburguesas en Cena — o Guarniciones + tema≠historia);
  // 2) el quiz del Viaje daba opciones duplicadas (ingredientes repetidos) y
  //    3 opciones (Chateaubriand: su nombre largo no cabe);
  // 3) el Juego Txoko duplicaba opciones al truncar el display a 90 car.
  // Guard 1 — Examen protege el pool vacío en vez de pintar roto:
  const se = html.slice(html.indexOf('function startExam'), html.indexOf('function renderExamQuestion'));
  assert(/if\(validQuestions\.length === 0\)\{/.test(se), 'startExam must guard empty pool');
  assert(/renderExam\(\);\s*\n\s*return;/.test(se), 'startExam must return to setup on empty pool');
  const rq = html.slice(html.indexOf('function renderExamQuestion'), html.indexOf('function renderExamQuestion') + 400);
  assert(/!examDishes\[examIndex\]/.test(rq), 'renderExamQuestion must guard missing question');
  // Guard 2 — Viaje: pool de ingredientes reales ÚNICOS, exige 3:
  const dj = html.slice(html.indexOf('const _seenIng = new Set()'), html.indexOf('const _seenIng = new Set()') + 700);
  assert(/realIngPool\.length >= 3/.test(dj) && /_seenIng\.has\(il\)/.test(dj),
    'journey Q3 must require 3 unique real ingredients');
  // Guard 3 — Juego Txoko: dedupe por display truncado, no por texto completo:
  const tx = html.slice(html.indexOf('const seenDisplay=new Set'), html.indexOf('const seenDisplay=new Set') + 700);
  assert(/seenDisplay\.has\(dn\)/.test(tx), 'txoko game must de-dup on the truncated display');
});

test('dish journey: overlay persists across phases (no white flash)', () => {
  // Reporte del propietario: pantallazos blancos al pulsar "Continuar" en el
  // Viaje Inmersivo. Causa: _djRender destruía el overlay oscuro y creaba uno
  // nuevo en cada fase → se veía el fondo claro del dashboard entre medias, y
  // el fade de 0.4s se repetía. Fix: el overlay se crea UNA vez; los cambios
  // de fase solo refrescan el contenedor interior.
  const dj = html.slice(html.indexOf('function _djRender'), html.indexOf('function _djNext'));
  assert(/const existing = document\.getElementById\('djOverlay'\);/.test(dj), '_djRender must look for existing overlay');
  assert(/cont\.innerHTML = containerHtml;\s*return;/.test(dj),
    'phase change must update the container in place and return (never recreate the overlay)');
  // La destrucción incondicional del overlay (el bug) no debe volver.
  assert(!/const existing = document\.getElementById\('djOverlay'\);\s*\n\s*if\(existing\) existing\.remove\(\);\s*\n\s*const overlay/.test(dj),
    'unconditional overlay remove+recreate is back — the flash bug returns');
  assert(/overlay\.innerHTML = `<div class="dj-container">\$\{containerHtml\}<\/div>`/.test(dj),
    'first open must wrap the container once');
});

test('shift change refreshes in place without the fade flicker', () => {
  // Reporte del propietario: cambiar de turno hacía parpadear el dashboard.
  // Causa: _setStudyShift llamaba a showTab(currentTab), que hace un fundido
  // de salida a blanco (120ms) + re-anima la entrada. Fix: showTab(tab, true)
  // refresca en el sitio, sin fundido ni re-entrada, y solo en las pantallas
  // que dependen del turno.
  assert(/function showTab\(tab, instant\)/.test(html), 'showTab must accept an instant flag');
  assert(/if\(instant\)\{[\s\S]{0,120}no-entrance-anim/.test(html), 'instant path must suppress entrance animation');
  assert(/setTimeout\(_doRender, 120\)/.test(html), 'normal tab change keeps its fade');
  // El recuadro verde (héroe) parpadeaba porque el path instantáneo QUITABA
  // no-entrance-anim de forma síncrona, y quitar animation:none re-dispara la
  // animación slideUp del héroe. El fix: dejar la clase puesta (return sin
  // remove) y retirarla solo en la siguiente navegación real.
  const stBody = html.slice(html.indexOf('function showTab(tab, instant)'), html.indexOf('function showTab(tab, instant)') + 5200);
  const _instStart = stBody.indexOf('if(instant){');
  const instBlock = stBody.slice(_instStart, stBody.indexOf('return;', _instStart) + 7);
  assert(!/classList\.remove\('no-entrance-anim'\)/.test(instBlock),
    'instant path must NOT remove no-entrance-anim (removing it re-triggers the hero slideUp = flicker)');
  assert(/classList\.remove\('no-entrance-anim'\)/.test(stBody),
    'the non-instant path must clear no-entrance-anim so real navigations animate');
  const ss = html.slice(html.indexOf('function _setStudyShift'), html.indexOf('function _setStudyShift') + 700);
  assert(/showTab\(currentTab, true\)/.test(ss), 'shift change must refresh instantly');
  assert(/_shiftTabs = \{ dashboard:1/.test(ss), 'shift refresh must be limited to shift-dependent tabs');
  const css = read('styles.css');
  assert(/#appContent\.no-entrance-anim [^{]*\{animation:none!important/.test(css.replace(/\s+/g,' ')),
    'no-entrance-anim must disable animations for the instant refresh');
  // El brillo decorativo del héroe se exime para que no se congele mientras la
  // clase permanece puesta entre un cambio de turno y la siguiente navegación.
  assert(/#appContent\.no-entrance-anim \.dash-hero-shine::after\{animation:dashHeroShine/.test(css.replace(/\s+/g,' ')),
    'hero shine must keep looping while no-entrance-anim lingers');
});

test('study shift filter: DISH_SERVICE complete + all generators route by shift', () => {
  // Petición del propietario: estudiar los platos de almuerzo con los de
  // almuerzo y los de cena con los de cena, en TODO (exámenes, flashcards,
  // repaso, simulacro, quiz, fantasma). El guard EJECUTA el filtro: en modo
  // almuerzo no puede salir ningún plato solo-cena y viceversa.
  const cut = (a, b) => { const i = html.indexOf(a); assert(i !== -1, 'missing ' + a); return html.slice(i, html.indexOf(b, i) + b.length); };
  const dishesSrc = cut('const DISHES = [', '\n];');
  const svcSrc = cut('const DISH_SERVICE = {', '};') + ';';
  const helpers = html.slice(html.indexOf('let _studyShift'), html.indexOf('function computeDishAllergens'));
  const stub = 'function _renderShiftBar(){} var currentTab=null; function showTab(){}; var localStorage={getItem:()=>null,setItem:()=>{}};';
  const M = new Function(stub + dishesSrc + svcSrc + helpers + 'return {DISHES, DISH_SERVICE, _shiftDishes, setShift:(s)=>{_studyShift=s;}};')(); // eslint-disable-line no-new-func
  const bad = M.DISHES.filter(d => !['a', 'c', 'ambos'].includes(M.DISH_SERVICE[d.id]));
  assert(bad.length === 0, `dishes without a valid service: ${bad.map(d => d.id).join(',')}`);
  const twins = { 9: 'c', 78: 'a', 109: 'c', 69: 'a', 119: 'a' };
  for (const [id, exp] of Object.entries(twins))
    assert(M.DISH_SERVICE[id] === exp, `twin ${id} must be shift ${exp}, got ${M.DISH_SERVICE[id]}`);
  for (const shift of ['a', 'c']) {
    M.setShift(shift);
    const leak = M._shiftDishes(M.DISHES).filter(d => { const s = M.DISH_SERVICE[d.id]; return s !== 'ambos' && s !== shift; });
    assert(leak.length === 0, `shift ${shift} leaks ${leak.length} wrong-shift dishes`);
  }
  M.setShift('todo');
  assert(M._shiftDishes(M.DISHES).length === M.DISHES.length, "'todo' must pass every dish");
  const raw = (html.match(/DISHES\[Math\.floor\(Math\.random\(\)\*DISHES\.length\)\]/g) || []);
  assert(raw.length === 0, `${raw.length} raw random DISHES[...] access left unrouted by shift`);
  assert(/const dishes = _lqaShuffle\(_shiftDishes\(DISHES\)/.test(html), 'Txoko game must shuffle a shift-filtered pool');
  assert(/let pool=_shiftDishes\(examConfig\.cat/.test(html), 'exam pool must be shift-filtered');
  assert(/const pool = _shiftDishes\(\(cat && cat/.test(html), 'allergen drill pool must be shift-filtered');
  assert(/let pool=_shiftDishes\(cat&&cat/.test(html), 'flashcards pool must be shift-filtered');
  assert(/function _simDishes\(\)\{ return DISHES\.filter\(d=>!d\.archived && _shiftDishOk\(d\)\)/.test(html), '_simDishes must apply shift');
  assert(/id="shiftBar"/.test(html) && /function _renderShiftBar/.test(html), 'shift selector bar missing');
  const rsb = html.slice(html.indexOf('function _renderShiftBar'), html.indexOf('function _renderShiftBar') + 900);
  assert(/\['a',[^\]]*\], \['c',[^\]]*\], \['todo',/.test(rsb) && /onclick="_setStudyShift/.test(rsb),
    'shift bar must offer Lunch/Dinner/All');
  assert(/localStorage\.setItem\('txoko_shift'/.test(html), 'shift choice must persist');
});

test('study shift filter: subject AND distractor pools route by shift (no wrong-shift leaks)', () => {
  // Regresión (jul 2026): el propietario detectó que, con turno almuerzo/cena,
  // algunos generadores mostraban platos del OTRO turno como opción-distractor
  // o como sugerencia. El sujeto ya iba filtrado; el pool de distractores no.
  // Guards estructurales por cada fuga corregida + guard empírico en txBuildQuestion.

  // #1 txBuildQuestion — distractores por turno con fallback seguro (≥3)
  assert(/const _wpShift=_shiftDishes\(_wpBase\)/.test(html) &&
    /const wrongPool=_lqaShuffle\(_wpShift\.length>=3\?_wpShift:_wpBase\)/.test(html),
    'txBuildQuestion distractor pool must be shift-filtered with a safe fallback');
  // #2 Dish Journey — sugerencia de próximo plato por turno con fallback
  assert(/const _sameCatSh = _shiftDishes\(_sameCatAll\)/.test(html) &&
    /const _anyUnSh   = _shiftDishes\(_anyUnAll\)/.test(html),
    'journey next-dish suggestion must be shift-filtered with a fallback');
  // #3 renderRepasoTopic — lista por categoría por turno + estado vacío
  assert(/const _repAll=DISHES\.filter\(d=>d\.cat===repasoCat\);\s*\n\s*const dishes=_shiftDishes\(_repAll\)/.test(html),
    'renderRepasoTopic per-category list must be shift-filtered');
  assert(/\$\{dishes\.length\?rows:/.test(html),
    'renderRepasoTopic must show an empty state when the shift leaves no dishes');
  // #4 (Live Quiz Host: retirado en jul 2026 con el quiz de supervisor; su
  //     sucesor, el Quiz del Día, NO filtra por turno a propósito — la
  //     competición compartida exige un pool idéntico para todo el equipo)
  // #5 Servicio Fantasma — los fallbacks mantienen el turno antes de relajarlo
  assert(/if\(!safe\.length\) safe = DISHES\.filter\(function\(d\)\{ return _shiftDishOk\(d\) && _sfOfr\(d\)/.test(html),
    'Ghost service "safe" fallback must keep shift before dropping it');
  assert(/if\(!dangerDish\.length\) dangerDish = DISHES\.filter\(function\(d\)\{return _shiftDishOk\(d\) && _sfOfr\(d\)/.test(html),
    'Ghost service "danger" fallback must keep shift before dropping it');
  assert(/var safeAlt = safeDishes\.length \? safeDishes\[0\] : \(DISHES\.find\(function\(d\)\{return _shiftDishOk\(d\)/.test(html),
    'Ghost service "safeAlt" fallback must keep shift before dropping it');

  // Guard empírico: extraer txBuildQuestion real y comprobar que en modo a/c
  // ninguna opción-distractor pertenece EXCLUSIVAMENTE a platos de otro turno.
  const cut = (a, b) => { const i = html.indexOf(a); assert(i !== -1, 'missing ' + a); return html.slice(i, html.indexOf(b, i) + b.length); };
  const fn = (name) => { const sig = 'function ' + name + '('; const i = html.indexOf(sig); let depth = 0, j = html.indexOf('{', i), k = j;
    while (true) { const ch = html[k]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return html.slice(i, k + 1); } k++; } };
  const dishesSrc = cut('const DISHES = [', '\n];');
  const svcSrc = cut('const DISH_SERVICE = {', '};') + ';';
  const helpers = html.slice(html.indexOf('let _studyShift'), html.indexOf('function computeDishAllergens'));
  // ingredients/history son ahora preguntas INVERTIDAS (fix legibilidad jul 2026):
  // el pasaje va en la burbuja y las opciones son NOMBRES DE PLATO. El generador
  // real usa _examRedact/_examNameTokens/_EXAM_STOP y WAITER_MSGS_REV/_txRevBubble,
  // así que hay que extraerlos e integrarlos aquí (antes solo truncaba texto).
  const wmRev = cut('const WAITER_MSGS_REV={', '  ]};');
  const examStop = cut('const _EXAM_STOP = new Set', ']);') + ';';
  const stub = 'function _renderShiftBar(){} var localStorage={getItem:()=>null,setItem:()=>{}};'
    + 'var LANG="es"; function getDish(d){return d;} function allergenLocal(a){return a;} function t(k){return k;}'
    + 'function escapeHTML(s){return String(s);}'
    + 'function _isDishQuizableForTopic(d,tk){ if(d.cat===\'Guarniciones y Salsas\') return tk===\'history\'; return true; }'
    + 'var DISHES_EN=[]; var TOPICS=[{key:"allergens",label:"al"},{key:"ingredients",label:"in"},{key:"history",label:"hi"}];'
    + 'var WAITER_MSGS={allergens:[n=>n],ingredients:[n=>n],history:[n=>n]};'
    + 'var TX_VOICE_MSGS={}; var TX_VOICE_MSGS_REV={};';
  const M = new Function(stub + dishesSrc + svcSrc + helpers + wmRev + examStop // eslint-disable-line no-new-func
    + fn('_txRevBubble') + fn('_examNameTokens') + fn('_examRedact')
    + fn('_lqaShuffle') + fn('txNorm') + fn('txGetAnswer') + fn('txTruncate') + fn('_txNameWords') + fn('_txNameTwin') + fn('_txDishBanned') + fn('txBuildQuestion')
    + 'return {DISHES, DISH_SERVICE, txBuildQuestion, txGetAnswer, txTruncate, txNorm, setShift:(s)=>{_studyShift=s;}};')();
  const svc = M.DISH_SERVICE;
  // Mapea una opción a los platos que la producen. Las opciones invertidas son
  // NOMBRES DE PLATO; las de alérgenos son la cadena de alérgenos.
  const optDishes = (optText) => {
    const on = M.txNorm(optText); const res = [];
    for (const d of M.DISHES) { if (M.txNorm(d.name) === on) res.push(d); }         // ing/history → nombre
    for (const d of M.DISHES) { const raw = M.txGetAnswer(d, 'allergens'); if (raw && M.txNorm(raw) === on && !res.includes(d)) res.push(d); } // alérgenos
    return res;
  };
  // Gemelo de nombre (fix legibilidad/ambigüedad jul 2026 — tomates con/sin
  // ventresca): el corto es prefijo POR PALABRAS del largo tras quitar acentos
  // y «(Cena)/(Almuerzo)». Detector independiente para no auto-validar el del
  // código con su propio bug.
  const twinCheck = (a, b) => {
    const w = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/\([^)]*\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
    const wa = w(a), wb = w(b); if (!wa.length || !wb.length) return false;
    const [s, l] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
    for (let i = 0; i < s.length; i++) if (s[i] !== l[i]) return false;
    return true;
  };
  for (const shift of ['a', 'c']) {
    M.setShift(shift);
    let n = 0, leak = 0, trunc = 0, tooLong = 0, twinPairs = 0;
    for (let i = 0; i < 1500; i++) {
      const q = M.txBuildQuestion(); if (!q) continue; n++;
      const rev = (q.topicKey === 'ingredients' || q.topicKey === 'history');
      if (rev) {
        const ch = q.choices || [];
        for (let a = 0; a < ch.length; a++) for (let b = a + 1; b < ch.length; b++)
          if (twinCheck(ch[a], ch[b])) twinPairs++;
      }
      for (const o of (q.choices || [])) {
        // Guard de legibilidad (fix jul 2026): ninguna opción puede quedar
        // truncada con «...» ni, en preguntas invertidas, exceder 60 car.
        if (/(\.\.\.|…)\s*$/.test(o)) trunc++;
        if (rev && o.length > 60) tooLong++;
        const cand = optDishes(o); if (!cand.length) continue;
        if (cand.every(d => { const s = svc[d.id]; return s !== 'ambos' && s !== shift; })) leak++;
      }
    }
    assert(n > 1000, `txBuildQuestion produced too few questions in shift ${shift} (${n}) — over-filtered?`);
    assert(leak === 0, `txBuildQuestion leaked ${leak} wrong-shift distractor options in shift ${shift}`);
    assert(trunc === 0, `txBuildQuestion produced ${trunc} truncated «...» options in shift ${shift} — options must stay short & fully legible`);
    assert(tooLong === 0, `txBuildQuestion produced ${tooLong} over-long (>60 char) inverted options in shift ${shift}`);
    // Ningún par de opciones invertidas puede ser gemelo de nombre (variante
    // veg / turno / prefijo): «Tomates aliñados» ⟷ «… con granizado de gazpacho»
    // se leen mal y el pasaje de uno describe al otro. Medido antes: 0.91% de
    // las invertidas; después: 0.
    assert(twinPairs === 0, `txBuildQuestion produced ${twinPairs} name-twin inverted option pairs in shift ${shift} — variant/veg twins must never co-occur as options`);
  }
});

test('Mr. Shoesmith habla en 1ª persona y las carnes de autor van por storytelling', () => {
  // Directriz del propietario (jul 2026): Mr. Shoesmith es UN cliente sentado a
  // SU mesa (la 501) que interroga él mismo al camarero — un enunciado que nombra
  // «Mesa 304», a otro huésped o que narra en 3ª persona rompe la ficción.
  // Medido ANTES: 41% de los enunciados nombraban otra mesa y 83% no estaban en
  // su voz. Además, en los cortes de Carnes de Autor la pregunta invertida de
  // ingredientes filtraba la respuesta por el eco del peso («(300 g)» ↔ «300g»
  // del nombre) en el 100% de los casos — incluso con doble-correcta plausible
  // (Entrecot de Angus 300g vs Entrecot de Wagyu 300g). DESPUÉS: 0 en todo.
  // (1) El juego pide la voz de la persona activa (Shoesmith por defecto si no
  //     hay ninguna sembrada); Duelos/Retos conservan la neutra sin voz.
  const txNextSrc = html.slice(html.indexOf('function txNext('), html.indexOf('function txAnimTick('));
  assert(/const _voice=\(txokoState\.persona\)\|\|'shoesmith'/.test(txNextSrc) && /q=txBuildQuestion\(_voice\)/.test(txNextSrc),
    'txNext must build questions in the active persona\'s voice (defaulting to Shoesmith)');
  // (2) Gate estructural: platos con ingredientes vacuos no preguntan ingredientes.
  assert(/topicKey === 'ingredients' && _txIngredientsVacuous\(d\)/.test(html),
    'vacuous-ingredients gate missing from _isDishQuizableForTopic');
  // (3) _examNameTokens debe emitir la parte numérica de los pesos del nombre
  //     para que _examRedact enmascare «(300 g)» en el pasaje (anti-eco).
  assert(/w\.match\(\/\\d\{2,\}\/g\)/.test(html), '_examNameTokens must emit numeric weight stems');
  // (4) Empírico con el generador y los pools REALES.
  const cut = (a, b) => { const i = html.indexOf(a); assert(i !== -1, 'missing ' + a); return html.slice(i, html.indexOf(b, i) + b.length); };
  const fn = (name) => { const sig = 'function ' + name + '('; const i = html.indexOf(sig); assert(i !== -1, 'missing fn ' + name); let depth = 0, k = html.indexOf('{', i);
    while (true) { const ch = html[k]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return html.slice(i, k + 1); } k++; } };
  const stub = 'function _renderShiftBar(){} var localStorage={getItem:()=>null,setItem:()=>{}};'
    + 'var LANG="es"; function allergenLocal(a){return a;} function t(k){return k==="noHistory"?"✦ Storytelling próximamente":k;}'
    + 'function escapeHTML(s){return String(s);}'
    + 'function getDish(d){ if(LANG!=="en") return d; const en=DISHES_EN.find(x=>x.id===d.id); return en?Object.assign({},d,en):d; }'
    + 'var TOPICS=[{key:"allergens",label:"al"},{key:"ingredients",label:"in"},{key:"history",label:"hi"}];';
  const M = new Function(stub // eslint-disable-line no-new-func
    + cut('const DISHES = [', '\n];') + cut('const DISHES_EN = [', '\n];') + cut('const DISH_SERVICE = {', '};') + ';'
    + html.slice(html.indexOf('let _studyShift'), html.indexOf('function computeDishAllergens'))
    + cut('const WAITER_MSGS={', '  ]};') + cut('const WAITER_MSGS_REV={', '  ]};')
    + cut('const SHOESMITH_MSGS={', '  ]};') + cut('const SHOESMITH_MSGS_REV={', '  ]};')
    + 'var TX_VOICE_MSGS={shoesmith:SHOESMITH_MSGS}; var TX_VOICE_MSGS_REV={shoesmith:SHOESMITH_MSGS_REV};'
    + cut('const _EXAM_STOP = new Set', ']);') + ';' + cut('const _ING_GENERIC = new Set', ']);') + ';'
    + fn('_txIngredientsVacuous') + fn('_isQuizableDish') + fn('_isDishQuizableForTopic')
    + fn('_txRevBubble') + fn('_examNameTokens') + fn('_examRedact')
    + fn('_lqaShuffle') + fn('txNorm') + fn('txGetAnswer') + fn('txTruncate') + fn('_txNameWords') + fn('_txNameTwin') + fn('_txDishBanned') + fn('txBuildQuestion')
    + 'return {DISHES, SHOESMITH_MSGS, SHOESMITH_MSGS_REV, txBuildQuestion, txNorm, _txIngredientsVacuous,'
    + '  setShift:(s)=>{_studyShift=s;}, setLang:(l)=>{LANG=l;}, dishByName:(n)=>DISHES.find(d=>getDish(d).name===n)};')();
  // Todo enunciado del pool de Shoesmith, en ambos idiomas, debe estar en SU voz:
  // sin mesas numeradas, sin terceros (huésped/compañero/cocina) y sin 3ª persona.
  const NOT_HIS_VOICE = /\b(mesa|table)\s*\d+|hu[eé]sped|guest|compa[ñn]ero|colleague|cocina|kitchen|Mr\.?\s*Shoesmith|VIP/i;
  for (const lang of ['es', 'en']) {
    M.setLang(lang);
    const stems = [
      ...M.SHOESMITH_MSGS.allergens.map(f => f('PLATO')),
      ...M.SHOESMITH_MSGS_REV.ingredients.map(f => f()),
      ...M.SHOESMITH_MSGS_REV.history.map(f => f()),
    ];
    assert(stems.length >= 12, `Shoesmith stem pool too small (${stems.length}) — keep variety`);
    for (const s of stems) assert(!NOT_HIS_VOICE.test(s), `Shoesmith stem out of voice (${lang}): «${s}»`);
  }
  // Barrido del generador real (voz shoesmith): el TALLO (antes del pasaje
  // citado) nunca menciona mesas/terceros, y ninguna pregunta de ingredientes
  // cae en un plato vacuo ni deja eco de peso hacia la opción correcta.
  for (const lang of ['es', 'en']) {
    M.setLang(lang);
    for (const shift of ['a', 'c']) {
      M.setShift(shift);
      let n = 0;
      for (let i = 0; i < 1200; i++) {
        const q = M.txBuildQuestion('shoesmith'); if (!q) continue; n++;
        const stem = String(q.msg).split('<div')[0].replace(/<[^>]+>/g, ' ');
        assert(!NOT_HIS_VOICE.test(stem), `stem out of Shoesmith voice (${lang}/${shift}): «${stem}»`);
        if (q.topicKey === 'ingredients') {
          const dish = M.dishByName(q.dishName);
          assert(dish && !M._txIngredientsVacuous(dish),
            `vacuous-ingredients dish reached an ingredients question: ${q.dishName}`);
          const pass = String(q.msg).replace(/<[^>]+>/g, ' ');
          const w = pass.match(/(\d[\d.,]{1,})\s*(?:g|kg)\b/i);
          if (w) {
            const digits = w[1].replace(/[.,]/g, '');
            assert(!String(q.choices[q.correctIdx]).replace(/[.,]/g, '').includes(digits),
              `weight echo leaks the answer (${lang}/${shift}): «${w[0]}» → «${q.choices[q.correctIdx]}»`);
          }
        }
      }
      assert(n > 800, `Shoesmith voice produced too few questions (${n}) in ${lang}/${shift} — over-filtered?`);
    }
  }
});

test('La Crítica: segundo personaje jugable — selector, ficha, voz propia sin mesas ajenas (jul 2026)', () => {
  // «vamos con eso» (propietario): un segundo cliente para Mr. Shoesmith, con
  // su propio set de fotogramas (vídeo Grok) y su propia voz — elegido con un
  // selector previo (no al azar, no en Camarero Survivors). Misma regla de
  // ficción que Shoesmith: ella es la única clienta en su mesa.
  // (1) El motor de humor/animación lee de un registro por persona, no de
  //     constantes de Shoesmith a secas — así un tercer personaje no exige
  //     tocar txClientFace/txApplyMood/txAnimTick/txAnswer/txNext.
  assert(/const TX_PERSONAS=\{/.test(html), 'TX_PERSONAS registry missing');
  const reg = html.slice(html.indexOf('const TX_PERSONAS={'), html.indexOf('const TX_VOICE_MSGS='));
  assert(/critic:\{[\s\S]*?talkTier:4/.test(reg), 'critic persona must define its own talkTier (her talk frame lives at a different tier than Shoesmith\'s)');
  assert(/shoesmith:\{[\s\S]*?blinkTier:5/.test(reg), 'shoesmith persona must keep its blinkTier (regression: engine must stay backward-compatible)');
  assert(!/critic:\{[^}]*blinkTier/.test(reg), 'critic persona must NOT claim a blinkTier — her source video has no natural blink, and the engine must skip it rather than fake one');
  // (2) Selector previo: el juego pide ahora el picker, no salta directo a
  //     ninguna ficha de personaje — y cada tarjeta abre su propia ficha.
  assert(/onclick="txStart\(\)"/.test(html), 'the Games-hub card must still call bare txStart() — it now opens the persona picker');
  assert(/function txShowPersonaPicker\(/.test(html), 'txShowPersonaPicker missing');
  const picker = html.slice(html.indexOf('function txShowPersonaPicker('), html.indexOf('function txShowPersonaPicker(') + 2000);
  assert(/onclick="txShowIntro\('\$\{p\.id\}'\)"/.test(picker), 'each persona card must open its own ficha via txShowIntro(id)');
  const introFn = html.slice(html.indexOf('function txShowIntro('), html.indexOf('function txShowPersonaPicker('));
  assert(/function txShowIntro\(personaId\)/.test(introFn), 'txShowIntro must take a personaId parameter');
  assert(/onclick="txStart\(true,'\$\{p\.id\}'\)"/.test(introFn), 'the ficha CTA must seed txStart with the chosen persona');
  assert(/onclick="txShowPersonaPicker\(\)"/.test(introFn), 'the ficha back button must return to the picker, not straight to the games hub');
  // (2b) La pantalla de juego (txRender) también debe leer el nombre/mesa de la
  //     persona activa — un tag "MR. SHOESMITH" fijo mientras se juega como La
  //     Crítica fue un bug real detectado en la verificación con Playwright.
  const renderFn = html.slice(html.indexOf('function txRender('), html.indexOf('function txGameOver('));
  assert(!/MR\.\s*SHOESMITH/.test(renderFn) && !/MESA 501/.test(renderFn) && !/TABLE 501/.test(renderFn),
    'txRender must not hardcode Shoesmith\'s name/table — it must read the active persona');
  assert(/_pName/.test(renderFn) && /_pMesa/.test(renderFn), 'txRender must derive the face tag and table label from the active persona');
  // (2c) "Try again" tras Game Over debe conservar la persona con la que se
  //     jugó — sin esto, reintentar como La Crítica te devolvía a Shoesmith
  //     en silencio.
  const overFn = html.slice(html.indexOf('function txGameOver('), html.indexOf('function txGameOver(') + 2200);
  assert(/txStart\(true,'\$\{txokoState\.persona\|\|'shoesmith'\}'\)/.test(overFn),
    'Try again must replay with the SAME persona, not silently reset to Shoesmith');
  // (3) Voz propia: 5 caras + 5 fotogramas de ánimo (sin parpadeo) embebidos.
  assert(/const CRITIC_FACES=\[/.test(html), 'CRITIC_FACES missing');
  for (let k = 0; k < 5; k++) {
    assert(html.includes(`img/sprites/critic-f${k}.jpg`), `critic face ${k} path missing`);
    assert(existsSync(join(ROOT, `img/sprites/critic-f${k}.jpg`)), `img/sprites/critic-f${k}.jpg missing on disk`);
  }
  assert(html.includes("const CRITIC_INTRO='img/sprites/critic-intro.jpg'") && existsSync(join(ROOT, 'img/sprites/critic-intro.jpg')),
    'CRITIC_INTRO must point to the repo file');
  // (4) Barrido del generador real con la voz de la crítica: mismo estándar que
  //     Shoesmith — sin mesas/terceros, sin ingredientes en platos vacuos, sin
  //     eco de peso. Prueba que la voz NO es un simple alias de Shoesmith: sus
  //     frases son distintas y no dependen de "mi mujer".
  const cut = (a, b) => { const i = html.indexOf(a); assert(i !== -1, 'missing ' + a); return html.slice(i, html.indexOf(b, i) + b.length); };
  const fn = (name) => { const sig = 'function ' + name + '('; const i = html.indexOf(sig); assert(i !== -1, 'missing fn ' + name); let depth = 0, k = html.indexOf('{', i);
    while (true) { const ch = html[k]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return html.slice(i, k + 1); } k++; } };
  const stub = 'function _renderShiftBar(){} var localStorage={getItem:()=>null,setItem:()=>{}};'
    + 'var LANG="es"; function allergenLocal(a){return a;} function t(k){return k==="noHistory"?"✦ Storytelling próximamente":k;}'
    + 'function escapeHTML(s){return String(s);}'
    + 'function getDish(d){ if(LANG!=="en") return d; const en=DISHES_EN.find(x=>x.id===d.id); return en?Object.assign({},d,en):d; }'
    + 'var TOPICS=[{key:"allergens",label:"al"},{key:"ingredients",label:"in"},{key:"history",label:"hi"}];';
  const M = new Function(stub // eslint-disable-line no-new-func
    + cut('const DISHES = [', '\n];') + cut('const DISHES_EN = [', '\n];') + cut('const DISH_SERVICE = {', '};') + ';'
    + html.slice(html.indexOf('let _studyShift'), html.indexOf('function computeDishAllergens'))
    + cut('const WAITER_MSGS={', '  ]};') + cut('const WAITER_MSGS_REV={', '  ]};')
    + cut('const CRITIC_MSGS={', '  ]};') + cut('const CRITIC_MSGS_REV={', '  ]};')
    + 'var TX_VOICE_MSGS={critic:CRITIC_MSGS}; var TX_VOICE_MSGS_REV={critic:CRITIC_MSGS_REV};'
    + cut('const _EXAM_STOP = new Set', ']);') + ';' + cut('const _ING_GENERIC = new Set', ']);') + ';'
    + fn('_txIngredientsVacuous') + fn('_isQuizableDish') + fn('_isDishQuizableForTopic')
    + fn('_txRevBubble') + fn('_examNameTokens') + fn('_examRedact')
    + fn('_lqaShuffle') + fn('txNorm') + fn('txGetAnswer') + fn('txTruncate') + fn('_txNameWords') + fn('_txNameTwin') + fn('_txDishBanned') + fn('txBuildQuestion')
    + 'return {DISHES, CRITIC_MSGS, CRITIC_MSGS_REV, txBuildQuestion, txNorm, _txIngredientsVacuous,'
    + '  setShift:(s)=>{_studyShift=s;}, setLang:(l)=>{LANG=l;}, dishByName:(n)=>DISHES.find(d=>getDish(d).name===n)};')();
  const NOT_HER_VOICE = /\b(mesa|table)\s*\d+|hu[eé]sped|guest|compa[ñn]ero|colleague|cocina|kitchen|mi mujer|my wife|Mr\.?\s*Shoesmith|VIP/i;
  for (const lang of ['es', 'en']) {
    M.setLang(lang);
    const stems = [
      ...M.CRITIC_MSGS.allergens.map(f => f('PLATO')),
      ...M.CRITIC_MSGS_REV.ingredients.map(f => f()),
      ...M.CRITIC_MSGS_REV.history.map(f => f()),
    ];
    assert(stems.length >= 12, `Critic stem pool too small (${stems.length}) — keep variety`);
    for (const s of stems) assert(!NOT_HER_VOICE.test(s), `Critic stem out of voice (${lang}): «${s}»`);
  }
  for (const lang of ['es', 'en']) {
    M.setLang(lang);
    for (const shift of ['a', 'c']) {
      M.setShift(shift);
      let n = 0;
      for (let i = 0; i < 1200; i++) {
        const q = M.txBuildQuestion('critic'); if (!q) continue; n++;
        const stem = String(q.msg).split('<div')[0].replace(/<[^>]+>/g, ' ');
        assert(!NOT_HER_VOICE.test(stem), `stem out of Critic voice (${lang}/${shift}): «${stem}»`);
        // Veto Ben & Jerry's (propietario, jul 2026): ni sujeto ni opción.
        assert(!/jerry/i.test(q.dishName), `Ben & Jerry's reached a question as subject (${lang}/${shift})`);
        for (const o of (q.choices || [])) assert(!/jerry/i.test(o), `Ben & Jerry's leaked as an option (${lang}/${shift}): «${o}»`);
        if (q.topicKey === 'ingredients') {
          const dish = M.dishByName(q.dishName);
          assert(dish && !M._txIngredientsVacuous(dish),
            `vacuous-ingredients dish reached an ingredients question: ${q.dishName}`);
        }
      }
      assert(n > 800, `Critic voice produced too few questions (${n}) in ${lang}/${shift} — over-filtered?`);
    }
  }
});

test('La Crítica sarcástica + veto Ben & Jerry\'s + un segundo más por nivel (jul 2026)', () => {
  // Tres ajustes del propietario tras probar el juego:
  // (1) Tono sarcástico: anclamos dos frases características para que una
  //     reescritura futura no la devuelva al tono neutro sin querer.
  assert(html.includes('Sorpréndame: ¿de verdad sabe qué alérgenos lleva?'),
    'critic voice must keep its sarcastic edge (allergens stem)');
  assert(html.includes('permítame dudarlo'), 'critic voice must keep its sarcastic edge (history stem)');
  assert(html.includes('yo solo anoto todo lo que haga mal'), 'critic intro quote must stay sarcastic');
  // (2) Ben & Jerry's fuera del generador del juego: filtro estructural en el
  //     pool de sujetos, en AMBOS pools de distractores y en el recuento de
  //     respuestas únicas (el barrido empírico vive en el test de La Crítica).
  assert(/function _txDishBanned\(d\)\{ return \/jerry\/i\.test\(d\.name\)/.test(html), '_txDishBanned helper missing');
  assert(/const dishes = _lqaShuffle\([^)]*\)\.filter\(d=>!_txDishBanned\(d\)\)/.test(html.replace(/_shiftDishes\(DISHES\)\.length \? _shiftDishes\(DISHES\) : DISHES/g, 'P')),
    'subject pool must exclude banned dishes');
  assert((html.match(/x\.id!==chosenDish\.id&&!_txDishBanned\(x\)/g) || []).length === 2,
    'BOTH distractor pools must exclude banned dishes');
  assert(/if\(_txDishBanned\(d\)\) return;/.test(html), 'unique-answer viability count must skip banned dishes');
  // (3) +1s por nivel: leer la pregunta ya consume tiempo. Valores exactos.
  const lv = html.slice(html.indexOf('const TXOKO_LEVELS=['), html.indexOf('];', html.indexOf('const TXOKO_LEVELS=[')));
  for (const t of ['time:14', 'time:11', 'time:8', 'time:6']) {
    assert(lv.includes(t), `TXOKO_LEVELS must carry the +1s budgets (missing ${t})`);
  }
});

test('study shift filter: Error Mode (Puntos Débiles) subject pool routes by shift', () => {
  // Regresión (jul 2026, barrido exhaustivo): startErrorMode elegía el plato-
  // sujeto de getFailedDishes() SIN filtrar por turno — medido: 47% del pool
  // eran platos de otro turno en modo almuerzo. Ahora filtra con fallback.
  assert(/const _failedSh=_shiftDishes\(_failedAll\);\s*\n\s*const failed=_failedSh\.length\?_failedSh:_failedAll;/.test(html),
    'startErrorMode subject pool must be shift-filtered with a safe fallback');

  // Guard empírico: ejecutar el startErrorMode real y exigir 0 sujetos de otro
  // turno en modo almuerzo/cena, con suficientes preguntas (sin sobre-filtrar).
  const cut = (a, b) => { const i = html.indexOf(a); assert(i !== -1, 'missing ' + a); return html.slice(i, html.indexOf(b, i) + b.length); };
  const fn = (name) => { const sig = 'function ' + name + '('; const i = html.indexOf(sig); assert(i !== -1, 'missing fn ' + name); let depth = 0, k = html.indexOf('{', i);
    while (true) { const ch = html[k]; if (ch === '{') depth++; else if (ch === '}') { depth--; if (depth === 0) return html.slice(i, k + 1); } k++; } };
  const dishesSrc = cut('const DISHES = [', '\n];');
  const svcSrc = cut('const DISH_SERVICE = {', '};') + ';';
  const helpers = html.slice(html.indexOf('let _studyShift'), html.indexOf('function computeDishAllergens'));
  const topicsSrc = cut('const TOPICS=[', '\n];');
  const env = `var LANG='es';var localStorage={getItem:()=>null,setItem:()=>{}};function _renderShiftBar(){}
    function allergenLocal(a){return a;} function getDish(d){return d;}
    function t(k,a){ if(k==='noHistory')return '__NOHIST__'; if(k==='noAllergens')return '__NOALLERG__'; return (k||'')+(a?(' '+a):''); }
    function showTab(){} var currentUser='u'; var _emp={examCorrect:{},sessions:[]}; function getEmp(){return _emp;}
    var examConfig={cat:'all',topic:'mixed',count:15};
    var examDishes=[],examIndex=0,examScore=0,examAnswered=false,examActive=false,examResults=null,examStartTime=0;`;
  const M = new Function(env + dishesSrc + '\n' + svcSrc + '\n' + helpers + '\n' + topicsSrc + '\n' // eslint-disable-line no-new-func
    + fn('_lqaShuffle') + fn('_pickDistractorPool') + fn('getFailedDishes') + fn('startErrorMode')
    + 'return {DISHES, DISH_SERVICE, setShift:(s)=>{_studyShift=s;}, run:()=>{examDishes=[];examActive=false;startErrorMode();return examDishes.slice();}};')();
  const svc = M.DISH_SERVICE;
  for (const shift of ['a', 'c']) {
    M.setShift(shift);
    let nQ = 0, leak = 0;
    for (let i = 0; i < 120; i++) {
      const qs = M.run(); nQ += qs.length;
      for (const q of qs) { const s = svc[q.dish.id]; if (s !== 'ambos' && s !== shift) leak++; }
    }
    assert(nQ > 500, `Error Mode produced too few questions in shift ${shift} (${nQ}) — over-filtered?`);
    assert(leak === 0, `Error Mode leaked ${leak} wrong-shift subject dishes in shift ${shift}`);
  }
});

test('login fits one phone screen; Share/Update buttons prominent', () => {
  // Petición del propietario: nada de arrastrar en el login, y Compartir/
  // Actualizar se veían "muy poco". Medido en headless a 390x844: el botón
  // Actualizar termina en y=833 (cabe). Candados de las reglas que lo logran.
  const css = read('styles.css');
  assert(/#screenLogin\{padding:1rem \.9rem \.8rem\}/.test(css), 'mobile login compaction missing');
  assert(/\.login-error:empty\{min-height:0/.test(css), 'empty error div must not reserve height');
  assert(/\.login-logo h1\{font-size:2\.35rem\}/.test(css), 'mobile logo size missing');
  assert(/max-height:720px/.test(css), 'short-screen (iPhone SE) tier missing');
  // Los botones del pie con presencia: borde y texto firmes, fondo sutil
  const shareBtn = html.slice(html.indexOf('onclick="shareApp()"'), html.indexOf('onclick="shareApp()"') + 400);
  assert(/rgba\(196,154,60,\.55\)/.test(shareBtn) && /rgba\(196,154,60,\.08\)/.test(shareBtn),
    'Share button must have the strengthened border + subtle fill');
  const updBtn = html.slice(html.indexOf('onclick="forceAppUpdate()"'), html.indexOf('onclick="forceAppUpdate()"') + 400);
  assert(/rgba\(196,154,60,\.55\)/.test(updBtn), 'Update button must have the strengthened border');
});

test('avatar system: branded SVG medallions, no emojis, self-styled picker', () => {
  // Reporte del propietario: el selector salía como texto crudo (las clases
  // avatar-picker-* nunca existieron en styles.css) y las opciones eran
  // letras/símbolos pobres. Ahora: medallones SVG de marca, sin emojis, y el
  // modal lleva TODOS sus estilos inline (no puede renderizar desnudo).
  const iA = html.indexOf('const AVATAR_ICONS = {');
  assert(iA !== -1, 'AVATAR_ICONS missing');
  const icons = html.slice(iA, html.indexOf('function _avatarSvg', iA));
  const count = (icons.match(/\{c:'#/g) || []).length;
  assert(count >= 18, `avatar icon set shrank (${count})`);
  assert(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(icons), 'emoji found in avatar icons — owner banned them');
  assert(!/const AVATAR_OPTIONS/.test(html), 'legacy letter/symbol AVATAR_OPTIONS must stay retired');
  // Ambos renderers entienden icon:
  const rsa = html.slice(html.indexOf('function renderSmallAvatar'), html.indexOf('function renderSmallAvatar') + 2400);
  assert(/indexOf\('icon:'\)/.test(rsa) && /_avatarSvg/.test(rsa), 'renderSmallAvatar must render icon: avatars');
  const rha = html.slice(html.indexOf('function _renderHeaderAvatar'), html.indexOf('function getEmpAvatar'));
  assert(/indexOf\('icon:'\)/.test(rha), 'header avatar must render icon: avatars');
  // El picker es autosuficiente: estilos inline, sin depender de clases CSS
  const pk = html.slice(html.indexOf('function openAvatarPicker'), html.indexOf('function selectAvatar'));
  assert(/overlay\.style\.cssText = 'position:fixed/.test(pk), 'picker overlay must carry inline styles');
  assert(!/class="avatar-grid"/.test(pk) && !/class="avatar-picker-modal"/.test(pk),
    'picker must not depend on the never-defined avatar-picker CSS classes');
  assert(/safe-area-inset-top/.test(pk), 'picker must respect the iOS notch');
});

test('app header respects the iOS notch (safe-area inset)', () => {
  // black-translucent + viewport-fit=cover extienden la página bajo la barra
  // de estado de iOS: con height fija la cabecera quedaba DEBAJO del reloj y
  // sus botones eran intocables (reporte del propietario, iPhone de sala).
  const css = read('styles.css');
  const hdr = css.slice(css.indexOf('.app-header{'), css.indexOf('.header-logo{'));
  assert(/height:calc\(56px \+ env\(safe-area-inset-top/.test(hdr), 'header height must grow with the notch');
  assert(/padding:env\(safe-area-inset-top/.test(hdr), 'header padding must push content below the status bar');
  assert(/viewport-fit=cover/.test(html) && /black-translucent/.test(html),
    'iOS viewport/status-bar metas changed — re-audit safe-area handling');

  // Y debe CABER en un iPhone estrecho: el reporte "los botones no responden
  // y no pueden cambiar el idioma" era la fila desbordando — EN y Salir
  // quedaban fuera de pantalla a 375-390px. Compresión responsiva medida en
  // headless a 375px: todos los controles (ES, EN, Salir) dentro del ancho.
  assert(/@media \(max-width:520px\)\{\s*\n?\s*\.app-header\{padding-left:\.7rem/.test(css.replace(/\r/g,'')),
    'narrow-screen header compression missing');
  assert(/\.header-uname\{display:none\}/.test(css), 'username must hide on narrow screens (avatar identifies)');
  // Android estrecho (Galaxy S20 = 360px CSS): "Salir" se cortaba por la
  // derecha. Tiers de compresión extra a ≤400px y ≤340px; medido en headless:
  // Salir dentro del ancho a 412/360/320px.
  assert(/@media \(max-width:400px\)/.test(css) && /@media \(max-width:340px\)/.test(css),
    'narrow-Android header compression tiers (400px/340px) missing');
});

test('force-update escape hatch + APP_VERSION synced to the SW', () => {
  // iOS PWAs se aferran a builds viejas (reporte del propietario: "en iPhone
  // sigue apareciendo la versión antigua"). El botón Actualizar del login
  // desregistra el SW, borra las cachés y recarga con cache-busting — sin
  // tocar localStorage — y muestra la versión realmente cacheada en el
  // dispositivo. APP_VERSION (cosmética, consola) debe ir SIEMPRE a la par
  // de la VERSION del service worker: llevaba clavada en 5.8.3 desde mayo.
  assert(/async function forceAppUpdate\(\)/.test(html), 'forceAppUpdate missing');
  const f = html.slice(html.indexOf('async function forceAppUpdate'), html.indexOf('async function forceAppUpdate') + 900);
  assert(/unregister\(\)/.test(f) && /caches\.delete\(k\)/.test(f) && /localStorage/.test(f) === false,
    'forceAppUpdate must unregister SW + clear caches and never touch localStorage');
  assert(/\?upd=/.test(f), 'forceAppUpdate must reload with cache-busting');
  assert(/onclick="forceAppUpdate\(\)"/.test(html), 'update button missing from login footer');
  assert(/txoko-shell-/.test(html.slice(html.indexOf('_showCachedVersion'), html.indexOf('_showCachedVersion') + 700)),
    'cached-version label must read the real SW cache name');
  const swv = read('sw.js').match(/const VERSION = 'v([\d.]+)';/)[1];
  const appv = html.match(/const APP_VERSION='([\d.]+)'/)[1];
  assert(swv === appv, `APP_VERSION (${appv}) must match sw.js VERSION (${swv}) — bump both together`);

  // El botón también avisa si el servidor tiene versión más nueva que la
  // cacheada (fetch de sw.js con no-store y comparación).
  const scv = html.slice(html.indexOf('_showCachedVersion'), html.indexOf('_showCachedVersion') + 1600);
  assert(/cache: 'no-store'/.test(scv) && /!== local/.test(scv), 'update button must detect a newer published version');
});

test('ghost inactivity interceptor stays dead: no callers + kill-switch', () => {
  // El propietario eliminó el Servicio Fantasma por inactividad; se siguió
  // viendo en dispositivos con la build ANTIGUA cacheada (justo los
  // inactivos). Triple candado en la build actual: (1) cero llamadas a
  // launchServicioFantasma/_sfShouldTrigger, (2) kill-switch dentro de la
  // propia función, (3) el onboarding ya no promete la intercepción.
  const launches = (html.match(/launchServicioFantasma\(/g) || []).length;
  assert(launches === 1, `launchServicioFantasma has ${launches - 1} caller(s) — must have none (definition only)`);
  const triggers = (html.match(/_sfShouldTrigger\(/g) || []).length;
  assert(triggers === 1, `_sfShouldTrigger has ${triggers - 1} caller(s) — must have none`);
  assert(/if\(!window\.__SF_ENABLED\) return false;[\s\S]{0,120}_sfDifficulty/.test(html),
    'launchServicioFantasma kill-switch missing');
  assert(!/Servicio Fantasma te pondrá a prueba/.test(html) && !/Ghost Service will test you/.test(html),
    'onboarding still promises the removed inactivity interceptor');
});

test('offer rules: kids menu and Vegetariano never recommended to generic guests', () => {
  // Reglas del propietario (jul 2026, reporte en vivo): el Fish and chips de
  // la CENA es solo del menú infantil y los platos Vegetariano solo se
  // recomiendan a vegetarianos. El Servicio Fantasma recomendaba ambos en
  // una pregunta que además pedía ENTRANTES con un pool de cualquier
  // categoría. _simOfferable centraliza la regla; se verifica ejecutándola.
  assert(/KIDS_ONLY_DISH_IDS = new Set\(\[109\]\)/.test(html), 'kids-only set missing (Fish and chips Cena = 109)');
  const cut = (start, endMark) => { const i = html.indexOf(start); assert(i !== -1, 'missing ' + start); return html.slice(i, html.indexOf(endMark, i)); };
  const dishesSrc = cut('const DISHES = [', '\n];') + '\n];';
  // extrae _simIsSideNamed + KIDS_ONLY + _simOfferable por marcadores fijos
  const iH = html.indexOf('function _simIsSideNamed(d){');
  const jH = html.indexOf('function _simOfferable(d){');
  const kH = html.indexOf('}', jH) + 1;
  const src = html.slice(iH, kH);
  const stubs = "const LANG='es'; function getDish(d){return d;} const DISHES_EN=[];";
  const f = new Function(stubs + dishesSrc + src + '; return {DISHES, _simOfferable};'); // eslint-disable-line no-new-func
  const { DISHES, _simOfferable } = f();
  const fish = DISHES.find(d => d.id === 109), arroz = DISHES.find(d => d.id === 53);
  assert(fish && !_simOfferable(fish), 'Fish and chips (Cena) must NOT be offerable (kids menu)');
  assert(arroz && !_simOfferable(arroz), 'Arroz cremoso (Vegetariano) must NOT be a generic recommendation');
  assert(DISHES.filter(d => d.cat === 'Entrantes' && _simOfferable(d)).length >= 10,
    'offerable starters pool collapsed');
  // Consumidores: SR SafeAlternative/WhichAdaptable y SF alergia (entrantes)
  const sfA = html.slice(html.indexOf("if(sc.type==='alergia')"), html.indexOf("} else if(sc.type==='maridaje')"));
  assert(/cat==='Entrantes' && _sfOfr\(d\)/.test(sfA), 'ghost-service alergia must draw offerable STARTERS (text asks for entrantes)');
  const wa2 = html.slice(html.indexOf('function _scenarioWhichAdaptable'), html.indexOf('function _srWaitMins'));
  assert(/_simOfferable\(d\)/.test(wa2), 'WhichAdaptable offers must be offerable');
});

test('smart review provenance: DISH_COMPONENTS-driven, executed, anti-obvious', () => {
  // FASE 4 en el entrenamiento: las preguntas de procedencia derivan de
  // DISH_COMPONENTS (base única validada). El guard EJECUTA los builders con
  // los datos reales: bien formadas, sin opciones duplicadas y la correcta
  // nunca delata el alérgeno por morfología (mantequilla→Lácteos prohibido
  // como correcta: la pregunta exige conocer la ficha, no saber clasificar).
  const cut = (start, endMark) => {
    const i = html.indexOf(start); assert(i !== -1, 'missing: ' + start);
    return html.slice(i, html.indexOf(endMark, i));
  };
  const dishesSrc = cut('const DISHES = [', '\n];') + '\n];';
  const compsSrc = cut('const DISH_COMPONENTS = {', '};') + '};';
  const buildersSrc = cut('const _SR_OBVIOUS = {', '// ═══ Main generator');
  assert(/DISH_COMPONENTS\[dish\.id\]/.test(buildersSrc), 'builders must read DISH_COMPONENTS');
  const gen = html.slice(html.indexOf('function _srGenerateQuiz'), html.indexOf('function _srGenerateQuiz') + 3500);
  assert(/_scenarioAllergenSource/.test(gen) && /_scenarioComponentAllergen/.test(gen),
    'provenance builders missing from the Smart Review rotation');
  const stubs = "const LANG='es';" +
    "function _djShuffle(a){const x=[...a];for(let i=x.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[x[i],x[j]]=[x[j],x[i]];}return x;}" +
    "function _simPick(a){return a[Math.floor(Math.random()*a.length)];}" +
    "function _simAllergenLabel(a,en){return a;}";
  const f = new Function(stubs + dishesSrc + compsSrc + buildersSrc + // eslint-disable-line no-new-func
    "return {DISHES, _scenarioAllergenSource, _scenarioComponentAllergen, _srNorm, _srObviousSource};");
  const { DISHES, _scenarioAllergenSource, _scenarioComponentAllergen, _srNorm, _srObviousSource } = f();
  assert(_srNorm('Lácteos') === 'lacteos', '_srNorm must strip diacritics (combining-class regex intact)');
  assert(_srObviousSource('Lácteos', 'Mantequilla') && _srObviousSource('Pescado', 'Atún')
    && !_srObviousSource('Sulfitos', 'Mirim'), 'obviousness filter broken');
  let made = 0;
  for (let round = 0; round < 4; round++) {
    for (const d of DISHES) {
      for (const fn of [_scenarioAllergenSource, _scenarioComponentAllergen]) {
        const q = fn(d, d, false);
        if (!q) continue;
        made++;
        assert(q.options.length === 4 && q.correctIdx >= 0 && q.correctIdx < 4
          && q.options.filter(o => o === q.options[q.correctIdx]).length === 1,
          `malformed provenance question for dish ${d.id}: ${q.q}`);
        assert(new Set(q.options.map(o => o.toLowerCase())).size === 4,
          `duplicate options for dish ${d.id}: ${q.options.join(' | ')}`);
        // Anti-fuga de nombre: la correcta de "¿qué componente lo aporta?"
        // no puede compartir palabra con el nombre del plato (Focaccia ↔
        // "Focaccia con vegetales" se respondía leyendo el enunciado).
        if (fn === _scenarioAllergenSource) {
          const dt = new Set(_srNorm(d.name).split(/[^a-z0-9ñ]+/).filter(w => w.length > 3));
          const leak = _srNorm(q.options[q.correctIdx]).split(/[^a-z0-9ñ]+/).some(w => w.length > 3 && dt.has(w));
          assert(!leak, `name leak: dish "${d.name}" answer "${q.options[q.correctIdx]}"`);
        }
      }
    }
  }
  assert(made >= 400, `provenance yield collapsed (${made} questions from 4 rounds)`);
  // El Simulacro de Alérgenos mezcla los MISMOS builders (~30% procedencia):
  // misma calidad medida en las dos superficies, sin generador duplicado.
  const drill = html.slice(html.indexOf('function buildAllergenQuestions'), html.indexOf('function startAllergenTest'));
  assert(/_scenarioAllergenSource/.test(drill) && /_scenarioComponentAllergen/.test(drill),
    'allergen drill must mix the provenance builders');
  const rq = html.slice(html.indexOf('function renderAllergenQuestion'), html.indexOf('function answerAllergenTest'));
  assert(/q\.prompt \|\|/.test(rq), 'drill renderer must honour per-question prompt label');
  const aq = html.slice(html.indexOf('function answerAllergenTest'), html.indexOf('function renderAllergenResults'));
  assert(/q\.explain/.test(aq), 'drill feedback must show the provenance explanation');
});

test('pairingExplanations: every entry matches a dish still on the menu', () => {
  // Los mapas indexados por nombre de plato quedan huérfanos en silencio
  // cuando un plato sale de la carta (pasó con el Rejo de pulpo): la entrada
  // nunca se ejecuta pero envejece como dato muerto. Candado: cada clave del
  // mapa de narrativas de maridaje debe corresponder a un plato actual.
  const iP = html.indexOf('const pairingExplanations = {');
  assert(iP !== -1, 'pairingExplanations map missing');
  // fin del mapa: la primera '};' a nivel de indentación 2
  const jP = html.indexOf('\n  };', iP);
  const mapSrc = html.slice(iP, jP);
  const keys = [...mapSrc.matchAll(/\n    '((?:[^'\\]|\\.)*)': \{/g)].map(m => m[1].replace(/\\'/g, "'"));
  assert(keys.length >= 10, `pairing map suspiciously small (${keys.length} keys)`);
  const norm = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  const iEs = html.indexOf('const DISHES = ['), jEs = html.indexOf('\n];', iEs);
  const names = new Set([...html.slice(iEs, jEs).matchAll(/name:'((?:[^'\\]|\\.)*)'/g)]
    .map(m => norm(m[1].replace(/\\'/g, "'").replace(/ \((Almuerzo|Cena)\)$/i, ''))));
  // match laxo: todas las palabras significativas de la clave aparecen en el
  // nombre de algún plato ('pluma ibérica' ↔ 'Pluma de cerdo Ibérico').
  const STOP = new Set(['de', 'del', 'la', 'el', 'con', 'al', 'a', 'y', 'en']);
  const stem = w => w.replace(/(os|as|es)$/, '').replace(/[ao]$/, '');
  const toks = s2 => norm(s2).split(/[^a-z0-9ñ]+/).filter(w => w && !STOP.has(w)).map(stem);
  const nameToks = [...names].map(n => new Set(toks(n)));
  // Allowlist VACÍA: el propietario cerró todas las dudas (jul 2026) — los
  // 8 cortes son fichas reales y la narrativa de Ben & Jerry's se eliminó
  // junto a sus maridajes. Cualquier huérfano nuevo debe fallar aquí.
  const PENDING_OWNER = new Set([]);
  for (const k of keys) {
    if (PENDING_OWNER.has(norm(k))) continue;
    const kt = toks(k);
    assert(nameToks.some(nt => kt.every(w => nt.has(w))),
      `pairing narrative for "${k}" matches no dish on the menu (orphan — dish removed?)`);
  }
});

test('ES and EN dish twins declare identical allergens', () => {
  // The EN cards are hand-written too — a divergent twin misinforms staff
  // using the app in English (found live: EN Croquettes missing Molluscs and
  // Mustard). Locked: every twin must match through the vocabulary map.
  const MAP = { 'Lácteos':'Dairy','Huevos':'Eggs','Pescado':'Fish','Crustáceos':'Crustaceans',
    'Moluscos':'Molluscs','Sulfitos':'Sulphites','Frutos secos':'Tree nuts',
    'Granos de sésamo':'Sesame seeds','Cacahuete':'Peanut','Apio':'Celery',
    'Mostaza':'Mustard','Soja':'Soy','Gluten':'Gluten','Altramuces':'Lupin' };
  const parse = (block) => {
    const out = {};
    for (const m of block.matchAll(/\{id:(\d+)(?:,cat:'[^']*')?,name:'((?:[^'\\]|\\.)*)',allergens:\[([^\]]*)\]/g)) {
      out[m[1]] = { name: m[2], alg: [...m[3].matchAll(/'([^']+)'/g)].map(x => x[1]).sort() };
    }
    return out;
  };
  const iEn = html.indexOf('const DISHES_EN = ['), jEn = html.indexOf('\n];', iEn);
  const iEs = html.indexOf('const DISHES = ['), jEs = html.indexOf('\n];', iEs);
  const EN = parse(html.slice(iEn, jEn)), ES = parse(html.slice(iEs, jEs));
  for (const id of Object.keys(ES)) {
    assert(EN[id], `dish ${id} "${ES[id].name}" has no EN twin`);
    const expected = ES[id].alg.map(a => MAP[a] || `??${a}`).sort();
    assert(JSON.stringify(expected) === JSON.stringify(EN[id].alg),
      `dish ${id} "${ES[id].name}": EN twin allergens diverge (ES→${expected.join(',')} vs EN ${EN[id].alg.join(',')})`);
  }
});

test('no dish in the Vegetariano category self-declares as not vegetarian', () => {
  // Owner call (Jul 2026): the potato purée sat in Vegetariano while its own
  // card warned "NO es vegetariano (caldo de pollo)" — moved to Guarniciones.
  // Lock the class of contradiction, not just that dish.
  const i = html.indexOf('const DISHES = [');
  const j = html.indexOf('\n];', i);
  const dishes = html.slice(i, j);
  for (const m of dishes.matchAll(/\{id:(\d+),cat:'Vegetariano'[^\n]*/g)) {
    assert(!/NO es vegetariano/i.test(m[0]), `dish id:${m[1]} is in Vegetariano but its notes say it is not vegetarian`);
  }
});

// ─── 6c. Employee PIN server-verify wiring ──────────────────────
console.log('\nAuth hardening');
test('verificación del PIN de empleado en servidor (SHA RPCs) ACTIVADA', () => {
  const m = html.match(/const USE_SERVER_EMP_PIN_VERIFY\s*=\s*(true|false)\s*;/);
  assert(m, 'USE_SERVER_EMP_PIN_VERIFY flag missing');
  // jul 2026: ACTIVADO. Las RPCs verify_employee_pin_sha / set_employee_pin_sha
  // están desplegadas; el cliente ya no lee/escribe employees.pin.
  assert(m[1] === 'true', 'USE_SERVER_EMP_PIN_VERIFY debe estar en true (RPCs SHA desplegadas)');
  assert(/rpc\/verify_employee_pin_sha/.test(html), 'debe usar verify_employee_pin_sha');
  assert(/rpc\/set_employee_pin_sha/.test(html), 'debe usar set_employee_pin_sha');
  assert(/rpc\/employee_has_pin/.test(html), 'debe usar employee_has_pin para "entrar vs crear"');
  // el hash del pin ya NO se sube en los payloads de employees
  assert(!/\bpin:\s*pin\b/.test(html) && !/\bpin:\s*emp\.pin\b/.test(html),
    'los upserts de employees NO deben incluir el hash del pin');
  // las lecturas de employees excluyen la columna pin
  assert(/const _EMP_COLS\s*=/.test(html) && !/_EMP_COLS[^']*\bpin\b/.test(html),
    '_EMP_COLS (columnas leídas) no debe incluir pin');
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

test('dashboard: plan first, stats folded into the dark progress panel', () => {
  // TUNIC manual-page redesign (owner-approved): the standalone stats strip
  // is gone — the four figures live as a mono line inside the progress panel,
  // below the actionable plan.
  const dashStart = html.indexOf("document.getElementById('appContent').innerHTML=`", html.indexOf('function renderDashboard'));
  assert(dashStart !== -1, 'renderDashboard innerHTML template not found');
  const dashEnd = html.indexOf('`;', dashStart);
  const dashTpl = html.slice(dashStart, dashEnd);
  // v7.199: PLAN DE HOY + reto + misiones se fusionaron en la sección «HOY».
  assert(dashTpl.indexOf('HOY:') !== -1, 'HOY section missing');
  assert(dashTpl.indexOf('STATS STRIP') === -1, 'the boxed stats strip must stay removed');
  assert(/dash-statline/.test(dashTpl), 'stat line must live inside the progress panel');
  assert(dashTpl.indexOf('HOY:') < dashTpl.indexOf('dash-statline'),
    'plan (actions) must come before the stats (passive context)');
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
  for (const fn of ['renderVinos', 'renderDuel']) {
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
  // 1 definition + 4 callsites (startExam, smart review, error mode ×2 —
  // el del quiz en vivo se fue con el quiz en vivo, jul 2026)
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
  const slice = html.slice(startIdx, startIdx + 3800);
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

test('Smart Review console wears the Pip-Boy phosphor skin', () => {
  const css = read('styles.css');
  const con = (css.match(/\.ri-console\s*\{([^}]*)\}/) || [])[1] || '';
  assert(/#03160c/.test(con) || /#02110a/.test(con),
    '.ri-console must use the dark Pip-Boy background');
  assert(/\.ri-console \.ri-stat-v\{color:#9fffc8/.test(css),
    'the stat numbers must be phosphor green in the reskinned console');
  assert(/\.ri-console::after\{[^}]*repeating-linear-gradient/.test(css),
    'the CRT scanline overlay on the console is missing');
});

test('smart review screen is stripped to the simulation lead', () => {
  // Owner removed the focus-areas, difficulty-picker and allergen blocks
  // from the smart-review screen; difficulty is auto. Guard they stay out.
  const start = html.indexOf('function renderSmartReview()');
  const fn = html.slice(start, start + 12000);
  assert(!/\$\{focusHTML\}/.test(fn) && !/\$\{diffHTML\}/.test(fn) && !/\$\{allergenHTML\}/.test(fn),
    'a removed block (focus/difficulty/allergens) is back in the smart-review render');
  assert(/const pickedDiff = autoDiff;/.test(html),
    'difficulty must be auto (pickedDiff = autoDiff) now the picker is gone');
});

test('simulation terminal uses the Pip-Boy phosphor-green palette', () => {
  // The contextual-simulation screen (.smart-terminal) was reskinned to a
  // Fallout Pip-Boy: phosphor green on near-black with a CRT bloom.
  const css = read('styles.css');
  const rule = (css.match(/\.smart-terminal\s*\{([^}]*)\}/) || [])[1] || '';
  assert(/--trm-ink:\s*#3dffa0/.test(rule),
    '.smart-terminal --trm-ink must be phosphor green #3dffa0 (Pip-Boy look)');
  assert(/--trm-accent:\s*#22ff88/.test(rule),
    '.smart-terminal --trm-accent must be phosphor green #22ff88');
  assert(/\.smart-terminal \.dj-phase-title\{text-shadow:0 0 9px rgba\(34,255,136/.test(css),
    'the phosphor glow on the title is missing — core of the CRT look');
});

test('main nav is a dropdown, not a horizontal scroller', () => {
  // The 8-section top nav scrolled horizontally, hiding half the sections.
  // It's now a Tenet-style dropdown: a trigger + the .nav-btn list.
  assert(/id="mainNavDD"/.test(html) && /class="nav-dd-trigger"/.test(html),
    'main nav dropdown trigger missing');
  assert(/class="app-nav nav-dd-list"/.test(html),
    'the nav list must carry the .nav-dd-list class');
  // showTab must reflect the active section into the trigger + close it
  assert(/_navCur\.innerHTML = _activeNav\.innerHTML/.test(html),
    'showTab must update the nav trigger to the active section');
  assert(/_navDD\.classList\.remove\('open'\)/.test(html),
    'showTab must close the nav dropdown after navigating');
  const css = read('styles.css');
  assert(/\.nav-dd-list \.nav-btn\.active\{[^}]*border-left-color:var\(--gold\)/.test(css),
    'active nav item must show the gold accent bar');
});

test('Simulación uses a green dot, not a red one', () => {
  assert(/'Simulación',_srsCount>0\?'🟢'/.test(html),
    'the SRS-due indicator on the Simulación chip must be a green dot, not red');
});

test('nav opens as a thumb-zone bottom sheet with a dim scrim', () => {
  // The option list rises from the bottom (reachable one-handed) instead of
  // dropping from the top edge, and a scrim dims the page behind it.
  const css = read('styles.css');
  assert(/\.nav-scrim\{[^}]*position:fixed[^}]*z-index:999\d/.test(css),
    'nav scrim must be a fixed full-screen layer above the header');
  assert(/\.nav-dd \.nav-dd-list\{[^}]*position:fixed[^}]*bottom:0[^}]*transform:translateY\(105%\)/.test(css),
    'the nav list must be a bottom sheet that slides up (translateY)');
  assert(/\.nav-dd\.open \.nav-dd-list\{transform:translateY\(0\)/.test(css),
    'opening the nav must slide the sheet into view');
  // markup: scrim element that closes the sheet on tap
  assert(/class="nav-scrim"[^>]*onclick="[^"]*mainNavDD'\)\.classList\.remove\('open'\)/.test(html),
    'a tappable scrim element that closes the nav must exist');
});

test('screen wrapper never animates transform (breaks fixed nav sheet)', () => {
  // The bottom-sheet nav + search overlay are position:fixed inside #screenApp.
  // If .screen.active animates transform, #screenApp becomes a containing block
  // and the sheet renders at the bottom of the (tall) page instead of the
  // viewport — i.e. off-screen. It must use an opacity-only enter animation.
  const css = read('styles.css');
  const m = css.match(/\.screen\.active\{[^}]*animation:\s*([a-zA-Z0-9_-]+)/);
  assert(m, '.screen.active must declare an enter animation');
  const anim = m[1];
  assert(anim === 'screenEnter', `.screen.active must use the opacity-only screenEnter (got ${anim})`);
  const kf = css.match(/@keyframes\s+screenEnter\{([^]*?)\}\s*(?:@|\/\*|\.[a-z])/i);
  assert(kf && !/transform/.test(kf[1]),
    'screenEnter keyframes must not animate transform');
});

test('dropdown triggers use a clear chevron-chip (not a subtle glyph)', () => {
  const css = read('styles.css');
  assert(/\.nav-dd-chev\{[^}]*border:1px solid[^}]*\}/.test(css) && /\.nav-dd-chev svg\{/.test(css),
    'nav chevron must be a bordered chip containing an SVG');
  assert(/class="nav-dd-chev"[^>]*><svg/.test(html),
    'main nav trigger chevron must be an SVG, not a ▾ glyph');
  // (la sub-navegación pasó a chips visibles — solo el nav principal es desplegable)
});

test('achievement toasts stack and stay readable', () => {
  // Several achievements unlocking together used to render at the same fixed
  // position (text painted over text) with a dark-on-dark description.
  assert(/achToastStack/.test(html), 'toasts must render into the shared stack');
  assert(/flex-direction:column[^']*pointer-events:none/.test(html),
    'toast stack must be a column that lets taps through');
  assert(!/Logro Desbloqueado'\}[^]*?color:var\(--parch3\)/.test(
    html.slice(html.indexOf('function showAchievementToast'), html.indexOf('function showAchievementToast') + 2200)),
    'toast description must not use the dark parch3 color on the dark toast');
});

test('ranking rows drop the placeholder styling before injecting', () => {
  // #rankingContent ships with text-align:center + 2rem padding for the "—"
  // placeholder; leaked into the results it centered and squeezed the rows.
  assert(/_rc\.removeAttribute\('style'\)/.test(html),
    'renderRanking must clear the placeholder style before rows');
});

test('vinos filter pills wrap instead of side-scrolling', () => {
  // Side-scrolling pill rows hid options past the viewport edge — the exact
  // pattern the owner banned from the navigation.
  const pillRows = [...html.matchAll(/<div style="([^"]*)">\s*\$\{(?:types|levels|\(_en\?\[\['all')/g)].map(m => m[1]);
  assert(pillRows.length >= 3, `expected 3 pill containers, found ${pillRows.length}`);
  for (const style of pillRows) {
    assert(/flex-wrap:wrap/.test(style) && !/overflow-x:auto/.test(style),
      `pill container must wrap, not scroll: ${style.slice(0,60)}`);
  }
});

test('section labels share the tunic-divider recipe (no rogue styles)', () => {
  // One section-label style across screens: the gold Cinzel divider. Ranking
  // used orange Quicksand (also ~2.4:1 on cream, WCAG fail), exam had a
  // literal ◆…◆ variant, games a one-off mono hint.
  assert(/tunic-divider"><span>\$\{LANG==='en'\?'By total XP':'Por XP total'\}/.test(html),
    'ranking label must use the tunic-divider');
  // (exam mastery moved into the dark dom-panel under a gilded-divider label
  //  in the simplified Examen redesign — asserted by its own test below)
  assert(/tunic-divider"[^>]*><span>\$\{_en\?'More ways to train':'Más formas de entrenar'\}/.test(html),
    'games section label must use the tunic-divider');
  // Ranking XP value must be brand gold (WCAG 5.66:1), not candy-orange.
  assert(!/color:var\(--candy-orange\)"?>\$\{\(emp\.xp/.test(html),
    'ranking XP value must not be candy-orange');
  // The replaced one-off recipes must not linger unused in the stylesheet.
  const css = read('styles.css');
  assert(!/exam-topics-mastery-title|games-secondary-hint/.test(css + html),
    'orphaned section-label classes must be removed');
});

test('vinos carta premium port: fonts, search, pills, card, light sub-trigger', () => {
  const css = read('styles.css');
  // Cormorant Garamond powers the sommelier voice — it must actually load.
  assert(/fonts\.googleapis\.com\/css2\?[^"]*Cormorant\+Garamond/.test(html),
    'Cormorant Garamond must be in the Google Fonts link');
  assert(/\.wine-storybook-text\{[^}]*Cormorant Garamond/.test(css)
    && /\.wc-story\{[^}]*Cormorant Garamond/.test(css),
    'hero quote and card story must use Cormorant');
  // Jewel search: full pill and 16px (iOS zoom trap — was .82rem).
  assert(/\.wine-search\{[^}]*font-size:16px/.test(css) && /\.wine-search\{[^}]*border-radius:999px/.test(css),
    'wine search must be a 16px full pill');
  // Pills: fine mono count, no spreadsheet parens in the type row.
  assert(/class="wfp-count"/.test(html) && /\.wfp-count\{/.test(css),
    'pill counts must use the fine mono style');
  assert(!/wine-filter-pill[^>]*>\$\{icon\} \$\{label\} <span[^>]*>\(/.test(html),
    'type pills must not render parenthesised counts');
  // Active pill keeps dark ink on gold (white-on-gold is 2.2:1, WCAG fail).
  assert(/\.wine-filter-pill\.active\{[^}]*color:#1a0f05/.test(css),
    'active pill text must stay dark ink for contrast');
  // Card hierarchy classes exist and are used.
  for (const cls of ['wc-name','wc-price','wc-story','wc-type-dot','wc-rec']) {
    assert(css.includes(`.${cls}`) && html.includes(`class="${cls}`),
      `card class .${cls} missing from CSS or markup`);
  }
  // Chips claros sobre nav oscuro (jerarquía); el activo de Repaso Inteligente
  // conserva su verde Pip-Boy oscuro.
  assert(/\.subtab-chip\{[^}]*background:#faf6ee/.test(css),
    'sub-tab chips must be the light variant');
  assert(/\.subtab-chip\.on\.subtab-chip--green\{[^}]*#0c3a22/.test(css),
    'green active chip must keep its dark Pip-Boy look');
});

test('wine detail speaks the premium carta language', () => {
  // The detail view must match the redesigned carta: dot+mono type, deep-gold
  // prices, Cormorant story, and the "G " label typo fixed to the ◇ ornament.
  const detail = html.slice(html.indexOf('function _showWineDetail'), html.indexOf('function _showWineDetail') + 9000);
  assert(/class="wc-type"/.test(detail), 'detail type must use the dot+mono style');
  assert(/color:var\(--gold-deep\);font-weight:600">\$\{w\.price\} €/.test(detail),
    'detail bottle price must be deep gold with a spaced euro');
  assert(/Cormorant Garamond[^"]*"[^>]*>"\$\{escapeHTML\(_en && w\.story_en/.test(detail),
    'detail story must use Cormorant italic');
  assert(!/wine-info-label"[^>]*>G \$\{/.test(html),
    'the broken "G " info label must be the ◇ ornament');
});

test('editorial sweep: quiz + dish headers join the shared recipe', () => {
  assert(/wine-section-title">\$\{LANG==='en'\?'Wine Quiz':'Quiz de Vinos'\}/.test(html),
    'wine quiz header must use the shared editorial classes');
  assert(/text-align:left;margin-bottom:1\.2rem;padding-bottom:\.65rem;border-bottom:1px solid rgba\(28,42,34,\.12\)/.test(html),
    'explorar dish header must be the left editorial block');
});

test('editorial TUNIC DNA: left headers, pull-quotes, crisp radii, slim bars', () => {
  // Owner verdict: the centered temple-hero pattern on every screen read as
  // AI-made. Sub-screen headers are now left-aligned editorial blocks with a
  // hairline; quotes are left pull-quotes with a gold edge; global radii are
  // crisper; the two nav bars are slimmer.
  const css = read('styles.css');
  assert(/--r:12px; --r2:10px; --r3:7px;/.test(css), 'crisp radius tokens missing');
  assert(/\.wine-section-header\{\n  text-align:left/.test(css), 'section header must be left-aligned');
  assert(/\.wine-section-header::before\{content:none\}/.test(css), 'centered glow orb must be retired');
  assert(/\.wine-storybook-intro\{[^}]*border-left:2px solid rgba\(196,154,60,\.45\)/.test(css),
    'storybook quote must be the left pull-quote');
  assert(/\.wine-hub-title\{\n  font-family:'Cinzel',serif;font-size:1\.18rem[^}]*text-align:left/.test(css),
    'sommelier hub title must be editorial');
  assert(/\.wine-hex-medallion\{display:none;/.test(css) && !/\.wine-hex-medallion\{display:none;[^}]*display:flex/.test(css),
    'hub medallion must be retired without a later display override');
  assert(/\.nav-dd-trigger\{[^}]*min-height:44px/.test(css) && /\.subtab-chip\{[^}]*min-height:40px/.test(css),
    'nav stays slim 44px and sub-nav chips stay tappable (40px)');
});

test('vinos sweep 3: sommelier index, maridaje rows, frases rows', () => {
  // Visible de-boxing for the remaining sub-screens (owner follow-up).
  assert(/dash-index-entry" onclick="_vinoSubTab='carta';renderVinos\(\)/.test(html),
    'sommelier quick access must be the manual index');
  assert(!/wine-quiz-option" style="flex-direction:column/.test(html),
    'boxed quick-access tiles must be gone');
  assert(/maridaje-item[^>]*style="padding:\.6rem \.15rem;border-bottom:1px solid rgba\(28,42,34,\.1\)/.test(html),
    'pairing guide entries must be hairline rows');
  assert(/wine-service-card wc-row/.test(html), 'selling scripts must use the row modifier');
  const css = read('styles.css');
  assert(/\.wine-service-card\.wc-row,/.test(css), 'wc-row must cover service cards');
});

test('vinos sweep 2: quiz rows, concept rows, no paren counts on map pills', () => {
  // Re-audit with the TUNIC bar: quiz category tiles and concept accordion
  // cards become hairline rows; map origin pills drop spreadsheet parens.
  assert(/dash-row" onclick="_startWineQuiz\('all',15\)/.test(html),
    'wine quiz must lead with the all-questions ledger row');
  assert(!/wq-cat-grid/.test(html), 'boxed quiz category grid must be gone');
  assert(/wine-concept-card wc-row/.test(html), 'concept accordions must use the row modifier');
  const css = read('styles.css');
  assert(/\.wine-concept-card\.wc-row\{[^}]*border-bottom:1px solid rgba\(28,42,34,\.1\)/.test(css),
    'wc-row must be a hairline row');
  assert(/wfp-count\" > \' \+ r\.wines\.length|wfp-count\">' \+ r\.wines\.length/.test(html),
    'map origin pills must use the fine mono count');
  assert(!/\(' \+ r\.wines\.length \+ '\)/.test(html), 'paren counts must be gone from map pills');
});

test('vinos sub-screens finished in the premium language', () => {
  // No wine section title may carry flanking ✦/◇ glyphs — the ornament is the
  // fine rule under the title (the carta pattern).
  assert(!/wine-section-title">[✦◇]|wine-section-title">\$\{[^}]*\?'[✦◇]/.test(html),
    'wine section titles must not open with a flanking glyph');
  assert(!/[✦◇] \$\{_en\?'Learn about Wine|[✦◇] \$\{_en\?'Wine Parchments/.test(html),
    'aprende/pergaminos titles must be clean');
  // Sommelier hub: unified deep-gold stat trio (was gold/sage/azure), and the
  // hub verse speaks Cormorant.
  const hub = html.slice(html.indexOf('wine-hub-stats'), html.indexOf('wine-hub-stats') + 1800);
  assert(!/var\(--sage\)|var\(--azure\)/.test(hub),
    'sommelier stat trio must not mix sage/azure — deep gold only');
  const css = read('styles.css');
  assert(/\.wine-hub-verse\{[^}]*Cormorant Garamond/.test(css),
    'sommelier verse must use Cormorant');
  // Discover-today featured card uses the carta language (dot, spaced price, wc-story).
  const disc = html.slice(html.indexOf('Descubre Hoy'), html.indexOf('Descubre Hoy') + 2600);
  assert(/wc-type-dot/.test(disc) && /wc-price/.test(disc) && /wc-story/.test(disc),
    'featured wine card must use the carta card classes');
});

test('vinos hero is compact and venue-aware', () => {
  const css = read('styles.css');
  // Hero spacing: header + intro tightened so the first wine lands sooner.
  assert(/\.wine-section-header\{[^}]*margin-bottom:1rem/.test(css),
    'wine section header must keep the tightened 1rem gap');
  assert(/\.wine-storybook-intro\{[^}]*border-left:2px solid rgba\(196,154,60,\.45\)/.test(css),
    'storybook intro must be the left pull-quote');
  // The hero byline must come from the active venue (multi-restaurant), with
  // the exact Txoko copy preserved as the default.
  assert(/ACTIVE_VENUE\.id!=='txoko'\) \? escapeHTML\(ACTIVE_VENUE\.name/.test(html)
    && /: 'TXOKO by Martín Berasategui'\}/.test(html),
    'vinos hero byline must be venue-aware with the Txoko copy as default');
});

test('dashboard polish: readable progress hexes, capitalized alert, collapsed achievements', () => {
  // Progress hex center % used colDark (dark red/blue/purple) on the dark
  // green card — unreadable. Both the % and the n/6 subtext must use colLight.
  assert(/fill="\$\{pct>=100\?'#fff':colLight\}"/.test(html),
    'progress hex percentage must use the light topic tone');
  assert(!/font-size="6" fill="\$\{colDark\}"/.test(html),
    'progress hex subtext must not use colDark on the dark card');
  // The SRS alert title is capitalized like its sibling alerts.
  assert(/'Plato para repasar':'Platos para repasar'/.test(html),
    'SRS alert title must be capitalized');
  // Achievements collapse to a showcase with a view-all toggle; the toggle is
  // presentational only (unlock logic untouched).
  assert(/function _toggleAchievements\(/.test(html) && /id="achSection"/.test(html),
    'achievements section must collapse with a toggle');
  assert(/_achShowAll \? ACHIEVEMENTS/.test(html),
    'expanded view must still show the full canonical grid');
});

test('section heroes share one ornament language (no flanking glyphs)', () => {
  // Exam's ◆ EVALUACIÓN ◆ and Juegos' ◇ Juegos ◇ came from CSS pseudo-elements;
  // the app-wide hero ornament is the thin gradient line (sup-hero-sub style).
  const css = read('styles.css');
  assert(!/games-header-title::(before|after)\{content:'◇'/.test(css),
    'games hero title must not flank with ◇ glyphs');
  assert(!/exam-setup-crown-orn::(before|after)[^}]*content:'◆'/.test(css),
    'exam crown must not flank with ◆ glyphs');
  // The shared thin-line ornament stays.
  assert(/\.sup-hero-sub::before/.test(css) && /\.games-header-sub::before/.test(css),
    'hero subtitles must keep their gradient-line ornament');
});

test('exam setup: one-tap start, folded customize, drill role, dark mastery panel', () => {
  // Owner feedback: the exam screen was overwhelming (20+ elements, 4 decisions
  // before starting) and "Modo Examen" duplicated the tab name.
  assert(/examSetupTitle: 'Examen',/.test(html) && /examSetupTitle: 'Exam',/.test(html),
    'title must be Examen/Exam, not Modo Examen');
  assert(/examConfig=\{topic:'mixed',cat:'all',count:10\};startExam\(\)/.test(html),
    'quick-start button must launch a mixed 10-question exam in one tap');
  assert(/id="examCustom" style="display:none"/.test(html) && /function _examToggleCustom\(/.test(html),
    'topic/category/count pickers must fold behind Personalizar');
  assert(/Simulacro de Alérgenos/.test(html) && /aquí se entrena la seguridad, no la memoria/.test(html),
    'the allergen drill must be renamed and explain its role');
  const css = read('styles.css');
  assert(/\.exam-dom-panel\{/.test(css) && /class="exam-dom-panel"/.test(html),
    'mastery must live in the dark dom-panel');
  assert(/\.exam-dom-panel \.exam-stat-lbl\{color:rgba\(244,237,226/.test(css),
    'dom-panel stats must use light ink on the dark card');
  assert(/\.exam-orient\{/.test(css) && /class="exam-orient"/.test(html),
    'the review-vs-exam orientation line must exist');
});

test('allergen drill: three action-frames per question, no fixed traps', () => {
  // The old drill used three FIXED trap texts and a correct answer whose
  // yes/no polarity was unique — solvable by option style after one round.
  // Every question now carries the same three real courses of action whose
  // truth depends on the dish, plus one rotating trap from a bank.
  const fn = html.slice(html.indexOf('function buildAllergenQuestions'), html.indexOf('function buildAllergenQuestions') + 12000);
  assert(/_trapBank/.test(fn) && /_comandaBank/.test(fn), 'rotating trap/comanda banks missing');
  assert(/optServe/.test(fn) && /optAdapt/.test(fn) && /optBlock/.test(fn),
    'the three action-frames must exist');
  assert(/state === 'absent' \? optServe : state === 'adapt' \? optAdapt : optBlock/.test(fn),
    'the correct answer must be the frame matching the dish truth');
  assert(!/es mínimo y no supone riesgo/.test(html),
    'the old fixed trap texts must be gone');
  assert(!/firme una exención/.test(html), 'old waiver trap must be gone');
  assert(/_lqaShuffle\(questions\)\.slice\(0, 10\)/.test(fn),
    'question shuffle must be unbiased (_lqaShuffle)');
});

test('tartar gluten is a removable side (pan carasau) — owner-reported correction', () => {
  // The gluten in the tomato and sirloin tartares comes ONLY from the carasau
  // bread, which is served on the side: without it the dish is gluten-free.
  // Notes must say so in one drill-parsable segment (no ·/— between the word
  // "gluten" and the removal phrase) so the drill classifies it as ADAPT.
  const need = [
    // ES — both tartares
    'Gluten SOLO en las tostas de pan carasau, que se sirven aparte: se puede retirar y el plato queda SIN GLUTEN. Comandar SIN PAN CARASAU.',
    'Gluten SOLO en el pan carasau, que se sirve aparte: se puede retirar y el plato queda SIN GLUTEN. Comandar SIN PAN CARASAU.',
    // EN — both tartares
    'Gluten ONLY in the carasau bread toasts, served on the side and removable: the dish can be served without them and is then GLUTEN-FREE. Order WITHOUT CARASAU BREAD.',
    'Gluten ONLY in the carasau bread, served on the side and removable: the dish can be served without it and is then GLUTEN-FREE. Order WITHOUT CARASAU BREAD.'
  ];
  for (const s of need) assert(html.includes(s), `tartar gluten note lost or reworded: "${s.slice(0, 60)}…"`);
  // The generator must extract EN comanda instructions too ("Order WITHOUT …"),
  // otherwise the correct adapt answer shows a fake generic instruction in EN.
  assert(html.includes('(?:Comandar|Order) ([^.]+)\\.'),
    'comanda-instruction regex must accept both Comandar (ES) and Order (EN)');
});

test('smart review v2: unified frames, no set-fingerprint, smarter scenarios', () => {
  // Measured before the rebuild: DeclaredAllergy and Vegetarian revealed the
  // answer through their option SET in 100% of questions (each truth state
  // had its own texts), and CrossContamination / MultipleAllergies had the
  // same correct answer 100% of the time. The v2 frames must stay unified.
  assert(!html.includes("'Sí, tal como se emplata'"), 'old per-state DeclaredAllergy option set is back');
  assert(!html.includes("'Sí, es totalmente seguro'"), 'old per-state DeclaredAllergy option set is back (safe)');
  assert(!html.includes('(ej. Boletus)'), 'Vegetarian correct option leaks the flavour again');
  assert(!html.includes("'Solo sin la guarnición'"), 'old per-state Vegetarian option set is back');
  const da = html.slice(html.indexOf('function _scenarioDeclaredAllergy'), html.indexOf('function _scenarioDeclaredAllergy') + 4500);
  assert(/const optYes\b/.test(da) && /const optMod\b/.test(da) && /const optNo\b/.test(da) && /trapBank/.test(da),
    'DeclaredAllergy must use unified frames + rotating trap bank');
  assert(/dishProfileKeys/.test(da), 'DeclaredAllergy must bias the allergen toward the dish (polarity balance)');
  const cc = html.slice(html.indexOf('function _scenarioCrossContamination'), html.indexOf('function _scenarioCrossContamination') + 3500);
  assert(/optRisk\b/.test(cc) && /optClean\b/.test(cc), 'CrossContamination must have both truth polarities');
  const ma = html.slice(html.indexOf('function _scenarioMultipleAllergies'), html.indexOf('function _scenarioMultipleAllergies') + 4000);
  assert(/bothClear/.test(ma), 'MultipleAllergies must include the shareable (yes) polarity');
  // Modification echo guard: allergen named in the question must not appear
  // inside the comanda answer (measured 16% echo before).
  assert(/_hintToks/.test(html) && /hintEchoes|!_hintToks\.some/.test(html.slice(html.indexOf('function _scenarioModification'))),
    'Modification allergen-echo guard missing');
  // New smarter scenario types exist and are wired into the generator.
  for (const fn of ['_scenarioWhichAdaptable', '_scenarioWaitTime', '_scenarioIngredientWhere']) {
    assert(html.includes(`function ${fn}(`), `${fn} missing`);
    assert(html.includes(`${fn}(dish, dd, _en)`), `${fn} not wired into _srGenerateQuiz`);
  }
  // Correct-first dedupe: a same-named wrong option must never evict the
  // correct dish (produced correctIdx = -1 → unanswerable question).
  assert(!/_simDedupeOptions\(_djShuffle\(\[correct,/.test(html) && !/_simDedupeOptions\(_djShuffle\(\[dish,/.test(html),
    'dedupe must receive the correct option FIRST (shuffle after), or correctIdx can be -1');
});

test('Repaso Inteligente landing is a real Pip-Boy tube (monochrome CRT)', () => {
  // Owner: "haz que parezca mucho más a un pip-boy". The device illusion dies
  // with any non-green accent inside the screen, serif type, or missing CRT
  // furniture — lock the invariants.
  const css = read('styles.css');
  const smart = html.slice(html.indexOf('function renderSmartReview'), html.indexOf('function _riSetDifficulty'));
  assert(!/#dc5a32|#c49a3c/.test(smart), 'orange/gold accents are back inside the Pip-Boy stats');
  assert(smart.includes('ri-topbar'), 'device boot strip (TXOKO·OS) missing');
  const cssPip = css.slice(css.indexOf('Pip-Boy / Fallout reskin'), css.indexOf('Hero greeting with radial progress'));
  assert(/ri-crt-sweep/.test(cssPip), 'CRT sweep beam missing');
  assert(/repeating-linear-gradient\(0deg,rgba\(0,0,0,\.14\)/.test(cssPip), 'scanlines missing or weakened');
  assert(/\.ri-console \.ri-greet-name\{[^}]*DM Mono/.test(cssPip), 'greeting must be terminal mono, not serif');
  assert(/ri-cursor/.test(cssPip), 'blinking terminal cursor missing');
  // Motion must be gated for staff with vestibular sensitivity — the Pip-Boy
  // ambient animations live in the GLOBAL atmospheric freeze list.
  const rmIdx = css.indexOf('ATMOSPHERIC LAYER — prefers-reduced-motion guard');
  const rmBlock = css.slice(rmIdx, rmIdx + 3000);
  for (const sel of ['.ri-console::before', '.ri-topbar .ri-sys::before', '.ri-console .ri-greet-name::after']) {
    assert(rmBlock.includes(sel), `${sel} missing from the reduced-motion freeze list`);
  }
});

test('smart review owner-reported fixes: header leak, agua), Txipiron≠ron', () => {
  // 1. The Smart Review card header names the current dish, so cross-carta
  //    questions must never use it as the hidden answer.
  const iw = html.slice(html.indexOf('function _scenarioIngredientWhere'), html.indexOf('function _scenarioIngredientWhere') + 4200);
  assert(/for\(const target of _djShuffle\(sibs\)\)/.test(iw), 'IngredientWhere must target a SIBLING, not the header dish');
  const wa = html.slice(html.indexOf('function _scenarioWhichAdaptable'), html.indexOf('function _scenarioWhichAdaptable') + 3200);
  assert(/d\.id!==dish\.id && _simDishName\(d\)\.toLowerCase\(\)!==_curName/.test(wa),
    'WhichAdaptable must exclude the header dish (by id AND display name)');
  const wt = html.slice(html.indexOf('function _scenarioWaitTime'), html.indexOf('function _scenarioWaitTime') + 3600);
  assert(!/opts\.map\(d=>_simDishName\(d\)\)/.test(wt), 'WaitTime must use duration-shaped options, not dish names');
  // Owner-stated house rule: a main ordered WITHOUT starters carries ~40 min.
  // The old "Ninguna — su ficha no indica espera especial" answer taught
  // something false and must stay removed.
  assert(/label\(40\)/.test(wt) && /SIN entrantes/.test(wt), 'WaitTime 40-min house rule (main without starters) missing');
  assert(/Norma de Txoko/.test(wt) && /Forbes\/LQA/.test(wt), 'WaitTime explanation must cite the house norm and Forbes pacing');
  assert(!/no indica espera especial/.test(wt), 'false "no special wait" answer is back in WaitTime');
  // 2. Ingredient extraction must strip parentheses ("¿lleva agua)?" bug).
  assert(/replace\(\/\[\(\)\]\/g/.test(html.slice(html.indexOf('function _simExtractIngredients'), html.indexOf('function _simExtractIngredients') + 900)),
    'ingredient extractor must strip parentheses before filtering');
  // 3. Liquor detection must be word-bounded: /ron/ matched inside Txipiron.
  assert(!/\(flamb\|brandy\|coñac\|ron\|whisky/.test(html), 'unbounded liquor regex is back (ron ⊂ Txipiron)');
  assert(/\\bflamb\\w\*\|\\b\(brandy\|coñac\|ron\|whisky\|vodka\|porto\|oporto\|sake\)\\b/.test(html),
    'word-bounded liquor regex missing');
  // 4. Beer/wine in fried or baked preparations loses its alcohol
  //    (owner-confirmed: Calamares tempura) — pregnancy must exempt it.
  assert(/tempura\|rebozado\|masa\|frit/.test(html), 'cooked beer/wine exemption missing in pregnancy scenario');

  // Huevo a baja temperatura = poco cocinado → embarazada NO (owner, jul 2026)
  const preg = html.slice(html.indexOf('function _scenarioPregnancy'), html.indexOf('function _scenarioChildFriendly'));
  assert(/baja temperatura/.test(preg), 'pregnancy scenario must treat low-temperature egg as undercooked');
});

test('exam surfaces shuffle options: LQA exam/situations + wine quiz shape guard', () => {
  // LQA exam & situations rendered the AUTHORED option order: measured on the
  // real data, 44% of situation answers sat on option 2, so position alone
  // scored. Both must build session copies with options shuffled in lockstep.
  assert(/function _lqaShuffledExamQ\(/.test(html), '_lqaShuffledExamQ missing');
  assert(/_lqaShuffle\(LQA_EXAM_QUESTIONS\)\.slice\(0,10\)\.map\(_lqaShuffledExamQ\)/.test(html),
    'LQA exam questions must be session-shuffled');
  assert(/function _lqaShuffledSituation\(/.test(html), '_lqaShuffledSituation missing');
  assert(/_lqaPickFresh\(LQA_SITUATIONS, recent, 10\)\.map\(_lqaShuffledSituation\)/.test(html),
    'LQA situations must be session-shuffled');
  // Philosophy tags are keyed by AUTHORED option index — the answer handler
  // must translate the displayed index back through _map.
  assert(/_lqaTagFor\(sc\.id, sc\._map \? sc\._map\[idx\] : idx\)/.test(html),
    'situation answer must map displayed index back to authored index for tags');
  // Wine quiz shape guard: a sentence correct among bare-term wrongs (36% of
  // EN questions) revealed the answer by shape; and the correct was the
  // longest option ~50% of the time.
  const wq = html.slice(html.indexOf('function _generateWineChoices'), html.indexOf('function _generateWineChoices') + 9000);
  assert(/isSentence/.test(wq) && /mergedPool/.test(wq), 'wine quiz shape guard missing');
  assert(/_inWindow/.test(wq) && /strictLen/.test(wq), 'wine quiz length-window two-pass pick missing');
});

test('exam anti-echo: ingredients/history questions are reversed and redacted', () => {
  // Measured on the real menu: the correct option leaked dish-name words in
  // 74% (ingredients) / 83% (history) of questions. Those topics now ask in
  // reverse with the passage masked of all candidates' name tokens.
  assert(/function _examRedact\(/.test(html) && /function _examNameTokens\(/.test(html),
    'redaction helpers missing');
  assert(/topic\.key==='ingredients' \|\| topic\.key==='history'/.test(html),
    'ingredients/history must branch into the reversed builder');
  assert(/rev:true,passage/.test(html), 'reversed questions must carry the redacted passage');
  assert(/qIngredientsRev/.test(html) && /qHistoryRev/.test(html),
    'reversed question labels missing (ES/EN)');
  // The renderer must show the passage, not the dish name, for reversed questions.
  assert(/q\.rev\s*\n?\s*\?/.test(html) && /escapeHtml\(q\.passage\)/.test(html),
    'renderer must show the redacted passage for reversed questions');
});

test('floating FABs hide behind the open nav sheet / search', () => {
  // The sound toggle + sync pill float above #screenApp and otherwise overlap
  // the bottom-sheet options; they must hide while the nav or search is open.
  const css = read('styles.css');
  assert(/body:has\(#mainNavDD\.open\)\s+\.sound-toggle/.test(css),
    'sound toggle must hide when the nav sheet is open');
  assert(/body:has\(#gsOverlay\.open\)\s+\.sound-toggle/.test(css),
    'sound toggle must hide when global search is open');
});

test('global search phase 2: LQA situations searchable + read-only card', () => {
  // The search must index LQA situations (both languages + category) and open
  // a read-only reference card — never the quiz, never awarding XP.
  assert(/function _gsLqaIndex\(/.test(html), 'LQA search index missing');
  assert(/s\.scn, s\.scn_en, s\.q, s\.q_en, s\.expl, s\.expl_en/.test(html),
    'LQA index must cover ES+EN scenario, question and explanation');
  assert(/data\/lqa-situations\.json'[^)]*\{ silent:true \}/.test(html),
    'openGlobalSearch must silently lazy-load the LQA data');
  assert(/Situaciones LQA/.test(html), 'results must group LQA situations');
  assert(/function _gsShowLqaSituation\(/.test(html) && /id = 'gsLqaOverlay'/.test(html),
    'LQA result must open the reference overlay');
  // Read-only: the card body must not touch quiz state or award XP.
  const card = html.slice(html.indexOf('function _gsShowLqaSituation'), html.indexOf('function _gsShowLqaSituation') + 5200);
  assert(!/awardXP|lqaSitState|lqaExamState/.test(card),
    'the reference card must not award XP or touch quiz state');
  assert(/showTab\('protocolo'\)/.test(card), 'card must link to practice in LQA');
});

test('global search: entry, overlay and deep-link wiring', () => {
  const css = read('styles.css');
  // one-tap entry lives at the top of the nav sheet
  assert(/id="navSearchEntry"[^>]*onclick="openGlobalSearch\(\)"/.test(html),
    'the search entry button must call openGlobalSearch()');
  // overlay + input exist and the input is >=16px (no iOS zoom) via .gs-input
  assert(/id="gsOverlay"/.test(html) && /id="gsInput"/.test(html),
    'search overlay + input must exist');
  // The overlay MUST be hidden by an inline style so a stale styles.css in the
  // PWA cache can never render it as a full-screen unstyled block over the app.
  assert(/id="gsOverlay"[^>]*style="display:none"/.test(html),
    'search overlay must be inline-hidden (stale-CSS safety)');
  assert(/ov\.style\.display='flex'/.test(html) && /ov\.style\.display='none'/.test(html),
    'openGlobalSearch/closeGlobalSearch must toggle the inline display');
  assert(/\.gs-input\{[^}]*font-size:16px/.test(css),
    'search input must be >=16px so iOS does not zoom on focus');
  // engine + deep-links into the real detail views
  assert(/function openGlobalSearch\(/.test(html) && /function _gsRender\(/.test(html),
    'search engine functions missing');
  // Los resultados de plato abren la FICHA RÁPIDA (foto + info), no el viaje;
  // el recorrido guiado queda como botón opcional dentro de la ficha.
  assert(/if\(type==='dish'\)\{ if\(typeof _emplOpen==='function'\) _emplOpen\(id\)/.test(html),
    'dish results must open the quick sheet (_emplOpen), not force the journey');
  assert(/class="empl-ov-journey" onclick="[^"]*launchDishJourney\(\$\{d\.id\}\)"/.test(html),
    'the quick sheet must offer the guided journey as an optional button');
  assert(/_showWineDetail\(id,/.test(html),
    'wine results must deep-link into _showWineDetail');
  // accent-insensitive index so "lacteos" matches "Lácteos", "gluten" the allergen
  assert(/normalize\('NFD'\)\.replace\(\/\[\\u0300-\\u036f\]\/g,''\)/.test(html),
    'search must fold accents for allergen/name matching');
});

test('sub-tab navigation is VISIBLE chips (owner: the dropdown hid the subsections)', () => {
  // Jul 2026: el desplegable cerrado parecía un título y nadie descubría
  // Emplatado/Flashcards/Videos. _subTabBar renderiza ahora chips visibles
  // con scroll horizontal. Vinos conserva su desplegable propio.
  assert(/class="subtab-chips" role="tablist"/.test(html),
    '_subTabBar must render the visible chips row');
  assert(!/return _subTabDropdown\(tabs, activeTab,/.test(html),
    '_subTabBar must NOT delegate to the closed dropdown anymore');
  assert(/_chipsBar\(tabs, sub, id=>`_vinoSubTab/.test(html),
    'the Vinos bar must use the SAME chips language (uniform design, owner request)');
  assert(!/_subTabDropdown\(/.test(html), 'the dead dropdown component must be fully removed');
  const css = read('styles.css');
  assert(/\.subtab-chips\{[^}]*overflow-x:auto/.test(css), 'chips row must scroll horizontally');
  assert(/\.subtab-chip\.on\{[^}]*var\(--gold\)/.test(css), 'active chip must be gold-filled');
  assert(/\.subtab-chip\.on\.subtab-chip--green\{[^}]*#0c3a22/.test(css),
    'Repaso Inteligente active chip keeps its Pip-Boy green');
  assert(/parentTab==='aprender' && activeTab==='smart' \? 'smart' : null/.test(html),
    'green variant must be scoped to Repaso Inteligente only');
});

test('Aprender → Técnicas: glosario de técnicas de cocina cableado y derivado de la carta', () => {
  // Pedido por el chef (jul 2026): que el equipo aprenda qué es cada técnica.
  // Datos + renderer + subpestaña, con enlaces a platos calculados en runtime.
  assert(/const TECNICAS\s*=\s*\[/.test(html) && /const TECNICA_FAMS\s*=\s*\[/.test(html),
    'faltan los datos de técnicas (TECNICAS / TECNICA_FAMS)');
  // repertorio de alta cocina: el aire y las familias de vanguardia/húmeda/pastelería
  assert(/es:'Aire \(aire de lecitina\)'/.test(html) && /es:'Esferificación'/.test(html),
    'faltan técnicas de vanguardia (aire, esferificación)');
  assert(/k:'vanguardia'/.test(html) && /k:'humeda'/.test(html) && /k:'pasteleria'/.test(html),
    'faltan las familias de alta cocina (vanguardia, húmeda, pastelería)');
  // técnicas de escuela de hostelería (sugeridas por el chef): prep + clásicas
  assert(/k:'prep'/.test(html) && /es:'Bridar \(embridar\)'/.test(html) && /es:'Saltear'/.test(html) &&
         /es:'Gratinar'/.test(html) && /es:'Desglasar'/.test(html) && /es:'Clarificar'/.test(html),
    'faltan las técnicas clásicas de escuela (bridar, saltear, gratinar, desglasar, clarificar)');
  // la nota "En el Txoko" es opcional (técnicas aspiracionales sin plato en carta)
  assert(/\$\{t\.txoko\?`<div class="tec-txoko"/.test(html),
    'la nota En el Txoko debe ser opcional (solo cuando hay plato real)');
  assert(/function renderTecnicas\(\)/.test(html), 'falta el renderer renderTecnicas');
  // subpestaña cableada en los 5 puntos del enrutado de Aprender
  assert(/\['tecnicas',_en\?'Techniques':'Técnicas'/.test(html), 'la subpestaña Técnicas no está en la barra de chips');
  assert(/const APR = \['aprender','repaso','tecnicas'/.test(html), 'tecnicas no está en la lista APR');
  assert(/tecnicas:'aprender'/.test(html), 'tecnicas no está en parentMap');
  assert(/tecnicas:renderAprender/.test(html), 'tecnicas no está en renderMap');
  assert(/tecnicas:renderTecnicas/.test(html), 'renderAprender no despacha a renderTecnicas');
  // los platos NO se escriben a mano: se buscan por palabra clave en las fichas
  assert(/function _tecDishes\(kw,kwx\)/.test(html) && /kw\.some\(k=>hay\.includes\(k\)\)/.test(html),
    'los enlaces a platos deben derivarse de DISHES en runtime, no hardcodearse');
  // kwx: exclusión de falsos positivos (p.ej. "horno de carbón"/josper NO es
  // "asado al horno"; "grasa infiltrada...a baja temperatura" del entrecot de
  // wagyu describe la grasa, no una cocción a baja temperatura)
  assert(/kwx && kwx\.some\(k=>hay\.includes\(k\)\)/.test(html),
    'falta la exclusión kwx en _tecDishes');
  assert(/kwx:\['horno de carbón'\]/.test(html), 'Asado al horno debe excluir "horno de carbón" (josper=brasa)');
  assert(/kwx:\['grasa infiltrada'\]/.test(html), 'Baja temperatura debe excluir "grasa infiltrada" (entrecot wagyu)');
  assert(/kw:\['brasa','parrilla','horno de carbón'\]/.test(html),
    'las carnes de horno de carbón (josper) deben enlazarse en Brasa y parrilla');
  // el emparejamiento cubre nombre+ingredientes+historia+NOTAS (p.ej. gratinado
  // del parmentier o filetones al horno solo aparecen en las notas)
  assert(/const hay=\(\(d\.name\|\|''\)\+' '\+\(d\.ingredients\|\|''\)\+' '\+\(d\.history\|\|''\)\+' '\+\(d\.notes\|\|''\)\)/.test(html),
    'el emparejamiento de técnicas debe incluir las notas de la ficha');
  // los fondos (fumet, bisque, caldos) están como técnica
  assert(/es:'Fondos y caldos'/.test(html), 'falta la técnica de fondos y caldos');
  // profundidad "Tipos · saber más": render desplegable + tipos de fondo
  assert(/<details class="tec-mas"><summary>/.test(html) && /t\.mas\.map\(m=>/.test(html),
    'falta el desplegable de tipos (tec-mas) en las técnicas');
  assert(/masT:\{es:'Tipos de fondo'/.test(html) && /t:'Fondo blanco'/.test(html) &&
         /t:'Fondo oscuro'/.test(html) && /t:'Fumet'/.test(html) && /t:'Court-bouillon/.test(html),
    'faltan los tipos de fondo (blanco, oscuro, fumet, court-bouillon)');
  // toca un plato → abre su ficha en La Carta
  assert(/onclick="_aprenderOpenDish\(\$\{d\.id\}\)"/.test(html), 'los chips de plato deben abrir la ficha');
  // color de texto correcto para tarjetas claras (usar --parchment, no --ink)
  const css = read('styles.css');
  assert(/\.tec-card-h\{[^}]*color:var\(--parchment\)/.test(css) && /\.tec-def\{[^}]*color:var\(--parch2\)/.test(css),
    'el texto de las técnicas debe usar el color oscuro (--parchment/--parch2) sobre parchment');
});

test('Aprender lands on Emplatado and lists it first (owner request, jul 2026)', () => {
  // La guía visual es lo más consultado en servicio: primera opción y
  // subtab por defecto.
  const bar = html.match(/_subTabBar\(\[\s*([\s\S]*?)\]\s*,\s*_subTab\.aprender \|\| 'emplatado'\s*,\s*'aprender'\)/);
  assert(bar, 'aprender _subTabBar call not found');
  const empIdx = bar[1].indexOf("'emplatado'");
  const smartIdx = bar[1].indexOf("'smart'");
  assert(empIdx !== -1 && smartIdx !== -1, 'emplatado/smart tabs missing');
  assert(empIdx < smartIdx, 'Emplatado must be the FIRST Aprender sub-tab');
  assert(/_subTab\.aprender\s*\|\|\s*'emplatado'/.test(html),
    "Aprender default sub-tab must be 'emplatado'");
  // el inicializador manda: '|| emplatado' nunca dispara porque _subTab.aprender
  // siempre es truthy una vez inicializado
  assert(/let _subTab = \{ aprender:'emplatado'/.test(html),
    "_subTab must initialise aprender to 'emplatado', else the old default wins");
});

test('smart review leads with the simulation CTA, no live-case block', () => {
  // Owner request: the "ENTRAR EN SIMULACIÓN" CTA moves to the top of the
  // smart-review body, and the "EN VIVO · MESA AHORA" single-case block is
  // removed (redundant with the simulation).
  const start = html.indexOf('function renderSmartReview()');
  assert(start !== -1, 'renderSmartReview not found');
  const fn = html.slice(start, start + 12000);
  assert(!/class="ri-case-quote"/.test(fn) && !/id="riCaseQuote"/.test(fn),
    'the EN VIVO / MESA AHORA case block markup is back');
  const ctaIdx = fn.indexOf('class="ri-cta-wrap"');
  const statsIdx = fn.indexOf('class="ri-stats-row"');
  assert(ctaIdx !== -1 && statsIdx !== -1, 'cta or stats row missing');
  assert(ctaIdx < statsIdx,
    'simulation CTA must render above the stats row (lead action)');
});

test('video accordion tabs are tappable with legible labels', () => {
  // renderVideoAccordion built tab buttons with a ~32px tap target,
  // .58rem labels, and label colours that failed contrast (gold/red/
  // orange 2.4-3.3:1). Now 44px tap, .64rem labels, dark colours.
  const fn = html.match(/function renderVideoAccordion\([\s\S]*?\n\}/);
  assert(fn, 'renderVideoAccordion not found');
  const body = fn[0];
  assert(/min-height:44px/.test(body),
    'video accordion tab buttons must have a 44px tap target');
  assert(/font-size:\.64rem/.test(body),
    'video accordion labels must be .64rem (were .58rem ~9px)');
  assert(/#a04848/.test(body) && /#7d5c2f/.test(body),
    'video accordion label colours must use the dark WCAG palette');
});

test('profile stat numbers clear large-text contrast', () => {
  // The gold/orange/blue stat numbers were 2.42 / 2.39 / 2.89:1 on the
  // cream tiles — below even the 3:1 large-text floor. Darkened to >=4:1
  // while keeping the hue (tile border-left stays the vivid token).
  const css = read('styles.css');
  const base = (css.match(/\.stat-num\s*\{([^}]*)\}/) || [])[1] || '';
  assert(/color:\s*#9a7340/.test(base),
    '.stat-num base must be darkened gold #9a7340 (var(--gold) was 2.42:1)');
  assert(/\.stat-tile:nth-child\(2\) \.stat-num\{color:#b06828\}/.test(css),
    'tile 2 number must be darkened orange #b06828');
  assert(/\.stat-tile:nth-child\(4\) \.stat-num\{color:#3d7a96\}/.test(css),
    'tile 4 number must be darkened blue #3d7a96');
});

test('sommelier search input is >=16px (no iOS zoom)', () => {
  // 4th input with the iOS auto-zoom trap (after svc-search,
  // maridajeSearch, login). The camarero uses it tableside.
  const css = read('styles.css');
  const rule = (css.match(/\.sommelier-input\s*\{([^}]*)\}/) || [])[1] || '';
  const m = rule.match(/font-size:\s*([\d.]+)(px|rem)/);
  assert(m, '.sommelier-input has no font-size');
  const px = m[2] === 'px' ? parseFloat(m[1]) : parseFloat(m[1]) * 16;
  assert(px >= 16, `.sommelier-input font-size is ${px}px (<16) — iOS will zoom on focus`);
});

test('leaderboard scores are WCAG-legible and names truncate', () => {
  // Score colours were gold/sage/rose on cream — 2.4 / 4.1 / 3.3:1, all
  // failing. Now dark green/gold/red. And long names must ellipsis, not
  // wrap and blow up the row.
  const css = read('styles.css');
  assert(/\.lb-score\.mid\s*\{[^}]*color:\s*(?:#7d5c2f|var\(--gold-deep\))/.test(css),
    '.lb-score.mid must be dark gold #7d5c2f / var(--gold-deep) (var(--gold) was 2.4:1 on cream)');
  assert(/\.lb-score\.lo\s*\{[^}]*color:\s*#a04848/.test(css),
    '.lb-score.lo must be dark red #a04848 (rose was 3.3:1)');
  const name = (css.match(/\.lb-name\s*\{([^}]*)\}/) || [])[1] || '';
  assert(/text-overflow:\s*ellipsis/.test(name) && /min-width:\s*0/.test(name),
    '.lb-name must truncate long names (ellipsis + min-width:0)');
});

test('login inputs are >=16px so iOS does not zoom on focus', () => {
  // .login-input (name / PIN / password) was .9rem (14.4px) — iOS Safari
  // auto-zooms inputs under 16px on focus, shifting the whole login. Must
  // stay at the 16px floor, like svc-search / maridajeSearch.
  const css = read('styles.css');
  const rule = (css.match(/\.login-input\s*\{([^}]*)\}/) || [])[1] || '';
  const m = rule.match(/font-size:\s*([\d.]+)(px|rem)/);
  assert(m, '.login-input has no font-size');
  const px = m[2] === 'px' ? parseFloat(m[1]) : parseFloat(m[1]) * 16;
  assert(px >= 16, `.login-input font-size is ${px}px (<16) — iOS will zoom on focus`);
});

test('exam results ring is a real progress ring with result colour', () => {
  // The results ring was a decorative gold border with a gold % at
  // 2.25:1 on cream. Now it's a conic-gradient that fills to the score
  // and the % takes the result colour (green/gold/red, all WCAG-legible).
  const css = read('styles.css');
  const ring = (css.match(/\.results-ring\s*\{([^}]*)\}/) || [])[1] || '';
  assert(/conic-gradient/.test(ring),
    '.results-ring lost its conic-gradient progress fill — back to a decorative circle');
  const pct = (css.match(/\.results-pct\s*\{([^}]*)\}/) || [])[1] || '';
  assert(/color:\s*var\(--sc/.test(pct),
    '.results-pct must take the result colour var(--sc), not flat gold (gold was 2.25:1 on cream)');
  // markup must pass the score colour + percent into the ring
  assert(/--sc:\$\{scoreCol\}/.test(html) && /--p:\$\{pct\}/.test(html),
    'results markup must feed --sc and --p into the ring');
});

test('exam progress bar is visible and feedback colours clear WCAG', () => {
  // On the cream exam bg the gold "Correcto" feedback was 2.25:1 and the
  // 2px progress bar was near-invisible. Fixed: 6px bar, and success/error
  // feedback in dark green/red that clear 4.5:1.
  const css = read('styles.css');
  const track = (css.match(/\.exam-track\s*\{([^}]*)\}/) || [])[1] || '';
  const h = (track.match(/height:\s*(\d+)px/) || [])[1];
  assert(h && parseInt(h) >= 4, `.exam-track height ${h}px is too thin to see on a phone`);
  assert(/\.exam-feedback\.ok\s*\{[^}]*color:\s*(?:#2d6a3e|var\(--green-deep\))/.test(css),
    '.exam-feedback.ok must be dark green #2d6a3e / var(--green-deep) (gold was 2.25:1 on cream, failed WCAG)');
  assert(/\.exam-feedback\.ko\s*\{[^}]*color:\s*#a04848/.test(css),
    '.exam-feedback.ko must be dark red #a04848 (light red failed WCAG on cream)');
});

test('sub-tabs are tappable and use the flat (Sobria) active style', () => {
  // .tunic-stab tap target was ~34px; the "Sobria" redesign sets a 44px
  // min-height and a legible label, and drops the heavy pulsing aura on
  // the active tab (no tunic-stab-aura animation).
  const css = read('styles.css');
  const base = (css.match(/\.tunic-stab\s*\{([^}]*)\}/) || [])[1] || '';
  assert(/min-height:\s*44px/.test(base),
    '.tunic-stab lost its 44px min tap target');
  const lblSize = (base.match(/font-size:\s*([\d.]+)rem/) || [])[1];
  assert(lblSize && parseFloat(lblSize) >= 0.64,
    `.tunic-stab font-size ${lblSize}rem fell below the legible floor (.64rem)`);
  const active = (css.match(/\.tunic-stab\.active\s*\{([^}]*)\}/) || [])[1] || '';
  assert(!/tunic-stab-aura/.test(active),
    'the pulsing aura animation came back to the active sub-tab — Sobria removed it');
});

test('flashcard hint + rating buttons stay legible and accessible', () => {
  // Flip hint was .52rem (~8px) with no flip affordance; rating buttons
  // packed a decorative keyboard glyph and the "Repasar" red failed WCAG
  // (4.33:1). Guard the legibility bump, the flip icon, the removed glyph,
  // and the darker red.
  const css = read('styles.css');
  const hint = (css.match(/\.fc-flip-hint\s*\{([^}]*)\}/) || [])[1] || '';
  const hintSize = (hint.match(/font-size:\s*([\d.]+)rem/) || [])[1];
  assert(hintSize && parseFloat(hintSize) >= 0.6,
    `.fc-flip-hint font-size ${hintSize}rem fell below the legible floor (.6rem)`);
  assert(/\.fc-flip-hint svg\s*\{/.test(css),
    'flip-hint lost its ↻ icon — the turn gesture is no longer signalled');
  assert((html.match(/fc-rate-kbd"/g) || []).length === 0,
    'the decorative keyboard glyph came back to the rating buttons');
  assert(/\.fc-rate-again\s*\{[^}]*color:\s*#a04848/.test(css),
    '.fc-rate-again red must stay #a04848 (the old #b55858 was 4.33:1, below WCAG)');
});

test('dashboard stat label stays legible (Limpia redesign)', () => {
  // The stat label was .5rem (~8px) — too small. The "Limpia" redesign
  // bumped it and dropped the em-dash ::before/::after and the corner
  // marks. Guard the legible floor and that the decorations stay gone.
  const css = read('styles.css');
  const lbl = (css.match(/\.dash-stat-lbl\s*\{([^}]*)\}/) || [])[1] || '';
  const size = (lbl.match(/font-size:\s*([\d.]+)rem/) || [])[1];
  assert(size && parseFloat(size) >= 0.58,
    `.dash-stat-lbl font-size ${size}rem dropped below the legible floor (.58rem)`);
  assert(!/\.dash-stat-lbl::(before|after)\s*\{/.test(css),
    'the em-dash ::before/::after on the stat label came back — Limpia removed them');
  assert((html.match(/dash-stat-corner/g) || []).length === 0,
    'dash-stat-corner spans are back in the markup — Limpia removed them');
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
  assert(/color:\s*(?:#7d5c2f|var\(--gold-deep\))/.test(rule[1]),
    '.btn-secondary text must be dark gold #7d5c2f / var(--gold-deep) (lighter gold fails WCAG on cream)');
  // Still used in the markup — guard against the class being renamed away.
  assert((html.match(/class="btn-secondary/g) || []).length >= 1,
    'no .btn-secondary usages found — was the class renamed?');
});

test('Explorar is a TUNIC manual page (statline + ledger categories)', () => {
  // Same de-boxing as dashboard/LQA: the boxed stats banner and the seven
  // ~200px category tiles became a mono stat line and hairline ledger rows.
  const rep = html.slice(html.indexOf('const cards=activeCats.map'), html.indexOf('function searchRepaso'));
  assert(/dash-row" aria-label[^>]*onclick="openRepasoCat/.test(rep),
    'categories must render as ledger rows');
  assert(/repaso-statline/.test(rep), 'overview must be the mono stat line');
  assert(!/repaso-cat-tile|repaso-orient-stat/.test(rep), 'old boxed tiles/banner must be gone');
  const css = read('styles.css');
  assert(/\.repaso-statline\{/.test(css), 'repaso statline style missing');
});

test('LQA hub is a TUNIC manual page (banner + index + ledger categories)', () => {
  // Same de-boxing language as the dashboard: the 9 colored cards became one
  // flagship Ghost banner, a 2-col mode index and hairline category rows.
  const lqa = html.slice(html.indexOf('LQA hub — TUNIC manual page'), html.indexOf('function renderLqaCategory'));
  assert(lqa.length > 100, 'LQA hub block missing');
  assert(/hub-banner[^>]*startGhostInspection/.test(lqa), 'Ghost banner must stay the flagship');
  assert(/dash-index-entry" onclick="lqaView='info'/.test(lqa)
    && /dash-index-entry" onclick="startLqaExam\(\)/.test(lqa)
    && /dash-index-entry" onclick="startLqaSituations\(\)/.test(lqa)
    && /dash-index-entry" onclick="startLqaAuditor\(\)/.test(lqa),
    'the four LQA modes must live in the manual index');
  assert(/dash-row" onclick="renderLqaCategory/.test(lqa),
    'categories must render as ledger rows');
  assert(!/hub-qa"|lqa-cat-card/.test(lqa), 'old boxed hub cards must be gone');
});

test('dashboard alerts are hairline ledger rows (TUNIC de-boxing)', () => {
  // The colored .dash-alert cards + .dash-num badges became .dash-row ledger
  // rows: ink numeral, hairline separator, semantic color only on numerals.
  const css = read('styles.css');
  assert(/\.dash-row\{[^}]*border-bottom:1px solid rgba\(28,42,34,\.1\)/.test(css),
    '.dash-row must separate with a hairline, not a card box');
  assert(/\.dash-row-num\{[^}]*Cinzel/.test(css), 'ledger numeral style missing');
  const rows = (html.match(/class="dash-row[" ]/g) || []).length;
  assert(rows >= 5, `expected >=5 dashboard ledger rows, found ${rows}`);
  // Study section must be the 2-column index, not the boxed hub grid.
  assert(/dash-index-entry/.test(html) && !/dash-hub-grid/.test(html),
    'study must render as the manual index, not boxed hub cards');
});

test('exam .choice has high-contrast state badge + check/cross mark', () => {
  // Ported "Claridad" redesign: on answer the letter badge must go to the
  // DARK green/red (white letter legible) and a ✓/✕ mark must appear so the
  // result isn't communicated by colour alone. The mark is CSS-injected via
  // ::after keyed on the state class, so the markup just needs the span.
  const css = read('styles.css');
  assert(/\.choice\.correct\s+\.choice-ltr\s*\{[^}]*background:\s*(?:#2d6a3e|var\(--green-deep\))/.test(css),
    '.choice.correct badge must use dark green #2d6a3e / var(--green-deep) (light sage fails WCAG on white text)');
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

test('Service Mode stays removed (no FAB, no show call)', () => {
  // Owner removed Service Mode. The FAB (its only entry point) must not be
  // rendered and _svcShowFab() must not be called; the _svc* code is kept
  // but unreferenced, like the Servicio Fantasma removal.
  assert(!/id="svcFab"/.test(html),
    'the Service Mode FAB button is back in the markup');
  assert(!/[^n] _svcShowFab\(\)/.test(html.replace(/function _svcShowFab\(\)/g, 'function DEFN')),
    '_svcShowFab() is being called again — Service Mode FAB would reappear');
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

// ─── 6y. EL TURNO — survivors mini-game overlay guards ──────────
// New full-screen game overlay (canvas + joystick + WebAudio). Guards its
// three risk areas: (1) it exists and is entry-pointed from the games hub,
// (2) it never leaks — every listener/rAF/AudioContext it opens must be
// torn down on exit, (3) it stays scoped — no unprefixed id/class collides
// with pre-existing app selectors (.screen, .card, .pill, .row, #stage...).
console.log('\nEL TURNO mini-game guards');

test('launchElTurno() is defined exactly once', () => {
  const defs = (html.match(/function\s+launchElTurno\s*\(\)/g) || []).length;
  assert(defs === 1, `expected exactly 1 launchElTurno definition, found ${defs}`);
});

test('games hub (renderTxoko) has a card launching Camarero Survivors', () => {
  const hubStart = html.indexOf('function renderTxoko(');
  const hubEnd = html.indexOf('function renderTxTop10(');
  assert(hubStart !== -1 && hubEnd > hubStart, 'could not locate renderTxoko body');
  const hub = html.slice(hubStart, hubEnd);
  assert(hub.includes('launchElTurno()'), 'no game-card in renderTxoko() calls launchElTurno()');
  assert(hub.includes('Camarero Survivors'), 'Camarero Survivors card title missing from games hub');
});

test('Camarero Survivors: 14 alérgenos de la UE + objetivo visible (jul 2026)', () => {
  const s = html.indexOf('const ALLERGENS=[');
  assert(s !== -1, 'no se encontró el array ALLERGENS');
  const arr = html.slice(s, html.indexOf('];', s));
  const nuevos = ['cacahuete','apio','mostaza','sesamo','molusco','altramuz'];
  for (const k of nuevos) assert(arr.includes("key:'"+k+"'"), 'falta el alérgeno '+k+' en ALLERGENS');
  // los 8 originales siguen presentes → total 14 (los oficiales de la UE)
  const claves = (arr.match(/key:'[a-z]+'/g)||[]);
  assert(claves.length === 14, 'deberían ser 14 alérgenos (UE), hay '+claves.length);
  // mapas de sprites preparados para el arte de Grok (foe/boss por clave)
  for (const k of nuevos) {
    assert(html.includes('boss-'+k+'.webp'), 'falta el sprite boss de '+k);
    assert(html.includes('foe-'+k+'.webp'), 'falta el sprite foe de '+k);
  }
  // cada jefe nuevo tiene habilidad definida (no cae en el volley por defecto)
  const ab = html.slice(html.indexOf('const BOSS_ABIL='), html.indexOf('const BOSS_ABIL=')+420);
  for (const k of nuevos) assert(ab.includes(k+':'), 'BOSS_ABIL sin entrada para '+k);
  // OBJETIVO visible: barra de progreso al cierre + contador de chefs + misión
  assert(/id="etObjfill"/.test(html) && /id="etChefTxt"/.test(html),
    'falta la barra de objetivo o el contador de chefs en el HUD');
  assert(/chefsKilled/.test(html), 'no se cuentan los chefs despachados (objetivo)');
  assert(/TU MISIÓN/.test(html), 'la pantalla de inicio no comunica la misión');
  const css = read('styles.css');
  assert(/\.et-obj\{/.test(css) && /\.et-objfill\{/.test(css), 'falta el CSS de la barra de objetivo');
});

test('Camarero Survivors: LA MÁNAGER aliada suelta una botella que explota (jul 2026)', () => {
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 130000);
  // estado + temporizador de aparición
  assert(/manager:null, nextMgr:/.test(body), 'falta el estado de la mánager (manager/nextMgr)');
  assert(/mgrBottles:\[\]/.test(body), 'falta el array de botellas de la mánager');
  // cruza volando y suelta una botella hacia un enemigo
  assert(/G\.manager=\{/.test(body) && /dropped:false/.test(body), 'la mánager no aparece/cruza');
  assert(/G\.mgrBottles\.push\(/.test(body), 'la mánager no suelta la botella');
  // la botella EXPLOTA dañando enemigos (reusa hurtEnemy + explosión) y NO toca al héroe
  assert(/for\(let i=G\.mgrBottles\.length-1[\s\S]{0,400}hurtEnemy\(e,/.test(body),
    'la botella de la mánager no daña a los enemigos al explotar');
  assert(/G\.mgrBottles\.length-1[\s\S]{0,700}G\.explosions\.push/.test(body),
    'la botella de la mánager no genera la onda de explosión');
  // se reprograma para volver a pasar
  assert(/G\.nextMgr=G\.time\+/.test(body), 'la mánager no se reprograma tras salir');
  // sprite con respaldo dibujado
  assert(/const ET_HELPER_SPRITE=/.test(html) && /MGR_IMG/.test(body),
    'falta el sprite de la mánager o su respaldo');
});

test('Camarero Survivors: armas nuevas — tenedor asta + pimentero pesado (jul 2026)', () => {
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 150000);
  // cartas de mejora y evoluciones
  assert(/t:'Tenedor gigante'/.test(body) && /t:'Pimentero'/.test(body), 'faltan las cartas de tenedor/pimentero');
  assert(/'Trinche real'/.test(body) && /'Pimienta negra'/.test(body), 'faltan las evoluciones de las armas nuevas');
  // estado
  assert(/fork:0, forkT:0/.test(body) && /pepper:0, pepperT:0/.test(body), 'falta el estado de las armas nuevas');
  assert(/pClouds:\[\]/.test(body), 'falta el array de nubes de pimienta');
  assert(/pepShots:\[\]/.test(body), 'falta el array de molinillos en vuelo');
  // TENEDOR: estocada al más cercano que atraviesa la línea y empuja
  assert(/WEAPON — TENEDOR/.test(body) && /G\.forkFx=1/.test(body), 'falta la lógica del tenedor (estocada)');
  // PIMENTERO: el molinillo SALE VOLANDO y explota al impactar (área + nube DoT)
  assert(/WEAPON — PIMENTERO/.test(body) && /G\.pepShots\.push/.test(body), 'el molinillo no sale volando');
  assert(/G\.pClouds\.push\(\{x:m\.x,y:m\.y/.test(body) && /G\.explosions\.push\(\{x:m\.x,y:m\.y/.test(body),
    'el molinillo no explota en el punto de impacto');
  assert(/for\(const e of G\.enemies\)\{ if\(Math\.hypot\(e\.x-c\.x,e\.y-c\.y\)<c\.r\) hurtEnemy/.test(body),
    'la nube de pimienta no hace daño por segundo');
  // pimentero MARRÓN (no salero blanco): icono SVG marrón de respaldo, nunca 🧂
  assert(/const PEPPER_IC='<svg/.test(body) && /fill="#7a4a1e"/.test(body) && !/🧂/.test(body),
    'el pimentero debe ser un SVG marrón, no el salero blanco 🧂');
  // sprites ilustrados (tenedor plateado + molinillo de madera) con loader _ok y
  // respaldo vectorial; existen en disco y se cachean en la runtime estable
  assert(/const ET_FORK_SPRITE='img\/sprites\/fork-weapon\.webp'/.test(html) &&
         /const ET_PEPPER_SPRITE='img\/sprites\/pepper-mill\.webp'/.test(html),
    'faltan las constantes de sprite de tenedor/molinillo');
  assert(existsSync(join(ROOT, 'img/sprites/fork-weapon.webp')), 'img/sprites/fork-weapon.webp missing on disk');
  assert(existsSync(join(ROOT, 'img/sprites/pepper-mill.webp')), 'img/sprites/pepper-mill.webp missing on disk');
  assert(/const FORK_IMG=new Image\(\); FORK_IMG\.onload=\(\)=>\{ FORK_IMG\._ok=true; \}/.test(body) &&
         /const PEPPER_IMG=new Image\(\); PEPPER_IMG\.onload=\(\)=>\{ PEPPER_IMG\._ok=true; \}/.test(body),
    'faltan los loaders de sprite de las armas nuevas');
  // el tenedor se dibuja con el sprite rotado (con respaldo vectorial)
  assert(/if\(FORK_IMG && FORK_IMG\._ok\)\{[\s\S]{0,200}ctx\.rotate\(G\.forkAng\)/.test(body),
    'el tenedor no dibuja el sprite rotado hacia el enemigo');
  // el molinillo se muestra al golpear (pepperFx) con su sprite
  assert(/G\.pepperFx=1;/.test(body) && /PEPPER_IMG && PEPPER_IMG\._ok/.test(body),
    'el molinillo no se muestra en el golpe pesado');
  // la carta usa el molinillo ilustrado, con respaldo (onerror) al SVG marrón
  assert(body.includes('const PEPPER_CARD_IC=\'<img src="') && body.includes("ic:PEPPER_CARD_IC,t:'Pimentero'") &&
         body.includes('this.outerHTML=this.dataset.fb'),
    'la carta del pimentero debe usar el sprite del molinillo con respaldo SVG');
});

test('launchElTurno() is idempotent (guards against a second overlay)', () => {
  const i = html.indexOf('function launchElTurno(');
  assert(i !== -1, 'launchElTurno not found');
  const body = html.slice(i, html.indexOf('\nfunction ', i + 10));
  assert(/if\(document\.getElementById\('etOverlay'\)\)\s*return;/.test(body),
    'launchElTurno lacks an early-return guard when #etOverlay already exists — re-invoking it (e.g. a double tap on the card) would mount a second game on top of the first');
});

test('EL TURNO teardown fully unmounts: cancels rAF, removes all its listeners, closes AudioContext, removes overlay', () => {
  const i = html.indexOf('function launchElTurno(');
  assert(i !== -1, 'launchElTurno not found');
  const end = html.indexOf('\n// ── Game flow', i);
  const body = html.slice(i, end > i ? end : i + 40000);
  const teardownMatch = body.match(/function teardown\(\)\{[\s\S]*?\n  \}/);
  assert(teardownMatch, 'no teardown() function found inside launchElTurno');
  const td = teardownMatch[0];
  assert(/cancelAnimationFrame\(rafId\)/.test(td), 'teardown does not cancel the game rAF loop — it would keep running after exit');
  assert(/window\.removeEventListener\('resize'/.test(td), 'teardown does not remove the window resize listener');
  assert(/window\.removeEventListener\('keydown'/.test(td), 'teardown does not remove the window keydown listener');
  assert(/window\.removeEventListener\('keyup'/.test(td), 'teardown does not remove the window keyup listener');
  assert(/stage\.removeEventListener\('touchstart'/.test(td), 'teardown does not remove the stage touchstart listener');
  assert(/stage\.removeEventListener\('touchmove'/.test(td), 'teardown does not remove the stage touchmove listener');
  assert(/stage\.removeEventListener\('touchend'/.test(td), 'teardown does not remove the stage touchend listener');
  assert(/AC\.close\(\)/.test(td), 'teardown does not close the AudioContext — it would leak an open audio node per play session');
  assert(/overlay\.remove\(\)/.test(td), 'teardown does not remove the overlay element from the DOM');
});

test('every game has a uniform, working "back to games" control', () => {
  // Petición del propietario: los juegos no tenían botón de volver uniforme (o
  // no funcionaba). Ahora todos usan la misma píldora .game-back → showTab('txoko').
  // (1) shared style exists
  assert(/\.game-back\{/.test(read('styles.css')), 'the shared .game-back button style must exist');
  // (2) Duelo, Ruleta, Mr. Shoesmith intro + question screen all carry .game-back
  for (const fn of ['renderDuel(', 'renderRuleta(', 'txShowIntro(', 'txRender(']) {
    const i = html.indexOf('function ' + fn);
    assert(i !== -1, `${fn} not found`);
    const body = html.slice(i, html.indexOf('\nfunction ', i + 10));
    assert(/class="game-back"/.test(body), `${fn} must render the unified .game-back control`);
  }
  // (3) Mr. Shoesmith mid-run exit stops the patience timer, then navigates
  const q = html.indexOf('function txQuit(');
  assert(q !== -1, 'txQuit() must exist');
  const qbody = html.slice(q, q + 180);
  assert(/clearInterval\(txokoTimer\)/.test(qbody) && /showTab\('txoko'\)/.test(qbody),
    'txQuit() must stop the patience timer and return to the games hub');
  // (4) Camarero Survivors (overlay) keeps its own exit button
  const e = html.indexOf('function launchElTurno(');
  assert(/id="etExitBtn"/.test(html.slice(e, e + 60000)), 'Camarero Survivors must keep its in-game exit button');
  // (5) El botón Salir debe quedar POR ENCIMA de .et-screen: las pantallas
  // (inicio/pausa/etc.) cubren toda la superficie con fondo translúcido, así
  // que si el botón está por debajo la pantalla se traga el clic y "Salir" no
  // funciona (bug reportado por el propietario, jul 2026).
  const gcss = read('styles.css');
  const exitZ = (gcss.match(/#etExitBtn\{[^}]*z-index:(\d+)/) || [])[1];
  const screenZ = (gcss.match(/\.et-screen\{[^}]*z-index:(\d+)/) || [])[1];
  assert(exitZ && screenZ, 'no se pudo leer el z-index de #etExitBtn o .et-screen');
  assert(Number(exitZ) > Number(screenZ),
    `#etExitBtn (z-index ${exitZ}) debe estar por encima de .et-screen (z-index ${screenZ}) o el clic de Salir no llega`);
});

test('character sprite: dashboard mascot removed, no stray SVG mascot leftovers', () => {
  // La mascota DECORATIVA del dashboard se retiró (petición del propietario:
  // no capturaba la esencia Funko). El sprite vectorial TXOKO_MASCOT_SVG que
  // usaba EL TURNO fue reemplazado por fotogramas reales (ver test del ciclo
  // de carrera) y se eliminó por completo — dead code, no relicto sin usar.
  assert(!/TXOKO_MASCOT_SVG/.test(html), 'TXOKO_MASCOT_SVG must be fully removed (replaced by the real run-cycle sprite)');
  assert(!/class="dash-mascot"/.test(html),
    'the decorative dashboard mascot must be removed from the hero');
  assert(!/\.dash-mascot\{/.test(read('styles.css')),
    'the .dash-mascot CSS rule must be removed');
});

test('Camarero Survivors: héroe con ciclo de carrera de fotogramas reales (jul 2026)', () => {
  // Segunda mejora gráfica pedida por el propietario (tras La Crítica): el
  // protagonista era una mascota vectorial estática; ahora corre con 2
  // fotogramas reales (vídeo Grok, cámara fija) sincronizados con el rebote
  // vertical ya existente — sin tocar la mecánica de dash (reutiliza el mismo
  // fotograma vía _etHeroFrame, con estela fantasma coherente).
  assert(/const ET_HERO_RUN=\[/.test(html), 'ET_HERO_RUN frame array missing');
  // Transparencia obligatoria (el JPEG dejaba caja de fondo — bug real);
  // desde jul 2026 son ARCHIVOS webp con alfa, no base64 inline.
  assert(html.includes("const ET_HERO_RUN=['img/sprites/hero-a.webp','img/sprites/hero-b.webp']"),
    'ET_HERO_RUN must wire the 2 run-cycle files');
  for (const f of ['hero-a', 'hero-b']) assert(existsSync(join(ROOT, `img/sprites/${f}.webp`)), `img/sprites/${f}.webp missing on disk`);
  const e = html.indexOf('function launchElTurno(');
  const loaderSrc = html.slice(e, e + 150000);
  assert(/const HERO=ET_HERO_RUN\.map\(/.test(loaderSrc), 'HERO must be built from the ET_HERO_RUN frames, not a single SVG image');
  assert(/function _etHeroFrame\(G\)\{ return G\.moving\?\(Math\.sin\(G\.time\*13\)>=0\?0:1\):0; \}/.test(loaderSrc),
    'the frame picker must sync leg-swap to the existing vertical bob phase, and hold frame 0 when idle');
  // Ambos puntos de dibujo (jugador + estela del dash) deben indexar el array,
  // no dibujar un HERO a secas — y la estela debe fijar el fotograma al empujar
  // el punto (para no desincronizarse mientras la estela se desvanece).
  assert(/ctx\.drawImage\(HERO\[_etHeroFrame\(G\)\]/.test(loaderSrc), 'the main player draw must pick the active run-cycle frame');
  assert(/G\.trail\.push\(\{x:G\.px,y:G\.py,life:1,face:G\.face,frame:_etHeroFrame\(G\)\}\)/.test(loaderSrc),
    'dash trail points must capture the frame active at push time');
  assert(/ctx\.drawImage\(HERO\[t\.frame\|\|0\]/.test(loaderSrc), 'the ghost trail must draw the frame captured for that point');
});

test('Mr. Shoesmith: reactive face sprites wired, intro framed (no hex crop)', () => {
  // El juego Txoko usa el personaje Mr. Shoesmith (asset del propietario) con 5
  // caras reactivas por vidas + un plano para el intro, incrustados como imagen.
  assert(/const SHOESMITH_FACES\s*=\s*\[/.test(html), 'SHOESMITH_FACES array missing');
  // Archivos desde jul 2026 (antes base64 inline; el HTML adelgazó ~713KB).
  for (let k = 0; k < 5; k++) {
    assert(html.includes(`img/sprites/shoe-f${k}.jpg`), `shoe face ${k} path missing`);
    assert(existsSync(join(ROOT, `img/sprites/shoe-f${k}.jpg`)), `img/sprites/shoe-f${k}.jpg missing on disk`);
  }
  // txClientFace must return the sprite image (not the old inline SVG faces).
  // Generalizado por persona (jul 2026, segundo personaje La Crítica): lee
  // p.faces[mood] desde el registro TX_PERSONAS en vez del array a secas —
  // el guard fija que la persona Shoesmith siga apuntando al array real.
  const i = html.indexOf('function txClientFace(lives, pct)');
  assert(i !== -1, 'txClientFace not found');
  const body = html.slice(i, html.indexOf('\n}', i) + 2);
  assert(/p\.faces\[mood\]/.test(body) && /tx-shoe-face/.test(body) && /const p=txPersona\(\)/.test(body),
    'txClientFace must return an <img class="tx-shoe-face"> from the active persona\'s faces');
  assert(!/return \[f0,f1,f2,f3,f4\]/.test(body), 'old inline-SVG faces must be gone');
  assert(/shoesmith:\{[\s\S]*?faces:SHOESMITH_FACES/.test(html), 'the shoesmith persona must still wire SHOESMITH_FACES');
  assert(/critic:\{[\s\S]*?faces:CRITIC_FACES/.test(html), 'the critic persona must wire CRITIC_FACES');
  // Intro portrait uses the framed photo, not the hexagon clip-path crop.
  const intro = html.slice(html.indexOf('function txShowIntro'), html.indexOf('function txShowIntro') + 3000);
  assert(/p\.intro/.test(intro), 'intro must render the active persona\'s intro portrait');
  assert(/shoesmith:\{[\s\S]*?intro:SHOESMITH_INTRO/.test(html), 'the shoesmith persona must still wire SHOESMITH_INTRO');
  assert(html.includes("const SHOESMITH_INTRO='img/sprites/shoe-intro.jpg'") && existsSync(join(ROOT, 'img/sprites/shoe-intro.jpg')),
    'SHOESMITH_INTRO must point to the repo file');
  assert(!/clip-path:polygon\(50% 0%,100% 25%/.test(intro), 'intro portrait must not use the hexagon crop');
  const css = read('styles.css').replace(/\s+/g,' ');
  assert(/\.tx-shoe-face\{[^}]*object-fit:cover/.test(css), '.tx-shoe-face needs object-fit:cover framing');
});

test('Txoko question screen (txRender) shows Mr. Shoesmith BIG, not the old generic waiter icon', () => {
  // Owner redesign: rubber-hose/Cuphead-vintage skin. The reactive face must
  // be large and framed next to the question bubble — the small HUD icon and
  // the generic <svg> waiter avatar are gone.
  const i = html.indexOf('function txRender(');
  assert(i !== -1, 'txRender not found');
  const body = html.slice(i, html.indexOf('\nfunction txGameOver', i));
  assert(/class="tx-rh-face-frame[ "]/.test(body), 'txRender must wrap the big face in .tx-rh-face-frame');
  assert(/id="txokoClientFace"[^>]*>\$\{txClientFace\(lives,\s*pct\)\}/.test(body),
    'txRender must render the reactive face via txClientFace(lives, pct) into #txokoClientFace');
  assert(!/txoko-waiter-avatar/.test(body), 'the old generic <svg> waiter avatar must be removed — the real face replaces it');
  assert(/class="txoko-game tx-rh-stage"/.test(body), 'txRender root must carry the tx-rh-stage rubber-hose scope');
  // Structural ids the game loop depends on (txTick/txAnswer) must survive the reskin.
  for (const id of ['txokoPatienceFill', 'txokoTimeLeft', 'txokoStreak', 'txokoChoices', 'txokoFeedback']) {
    assert(body.includes(`id="${id}"`), `txRender must keep id="${id}" — the game loop reads/writes it directly`);
  }
});

test('Games hub: Mr. Shoesmith card shows the real character photo, not the old placeholder SVG face', () => {
  const hubStart = html.indexOf('function renderTxoko(');
  const hubEnd = html.indexOf('function renderTxTop10(');
  assert(hubStart !== -1 && hubEnd > hubStart, 'could not locate renderTxoko body');
  const hub = html.slice(hubStart, hubEnd);
  assert(/class="tx-rh-hero-frame"><img src="\$\{SHOESMITH_FACES\[0\]\}"/.test(hub),
    'the Mr. Shoesmith game-card must render SHOESMITH_FACES[0] inside .tx-rh-hero-frame');
  assert(!/Mini Mr\. Shoesmith face/.test(hub), 'the old placeholder SVG face (ellipse/path sketch) must be gone');
  assert(hub.includes('class="txoko-wrap tx-rh-hub"'), 'the hub wrapper must carry the tx-rh-hub rubber-hose scope');
  // structure/behaviour untouched — every card must still be present and wired
  // Puntos Débiles (startErrorMode) fue retirado del hub a petición del
  // propietario: los exámenes ya cubren el repaso de fallos.
  for (const onclick of ['txStart()', 'renderDuel()', 'renderRuleta()', 'launchElTurno()']) {
    assert(hub.includes(onclick), `hub must still wire up ${onclick} — reskin must not drop a game card`);
  }
  assert(!hub.includes('startErrorMode()'), 'Puntos Débiles card must be removed from the games hub');
});

test('tx-rh rubber-hose CSS exists, is scoped, and covers every class the markup uses', () => {
  const css = read('styles.css');
  // Every tx-rh-* class name referenced by the JS templates must have a rule.
  const usedClasses = new Set();
  for (const m of html.matchAll(/class="([^"]*tx-rh-[^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c.startsWith('tx-rh-')) usedClasses.add(c);
  }
  assert(usedClasses.size >= 15, `expected many tx-rh- classes in the markup, found ${usedClasses.size}`);
  const missing = [...usedClasses].filter(c => !css.includes('.' + c));
  assert(missing.length === 0, `tx-rh- classes used in markup but never styled: ${missing.join(', ')}`);
  // Scoping: every rule the TX-RH section adds for a shared/legacy class name
  // (txoko-choice, txoko-streak, txoko-dish-badge, txoko-feedback, game-card,
  // games-header) must be nested under .tx-rh-stage or .tx-rh-hub, so none of
  // it can leak into any other screen. Only look at CSS added after the
  // section marker — the original base rules for these classes predate this
  // redesign and are intentionally left as-is.
  const markerIdx = css.indexOf('TX-RH —');
  const endIdx = css.indexOf('/TX-RH', markerIdx);
  assert(markerIdx !== -1, 'TX-RH rubber-hose CSS section marker not found in styles.css');
  assert(endIdx !== -1 && endIdx > markerIdx, 'TX-RH rubber-hose CSS section end marker (/TX-RH) not found');
  const rhLines = css.slice(markerIdx, endIdx).split('\n').filter(l => l.includes('{'));
  for (const legacy of ['txoko-choice', 'txoko-streak', 'txoko-dish-badge', 'txoko-feedback', 'game-card', 'games-header']) {
    const wordBoundary = new RegExp(`\\.${legacy}\\b(?!-)`);
    const hits = rhLines.filter(l => wordBoundary.test(l));
    assert(hits.length > 0, `expected the TX-RH section to restyle .${legacy}`);
    const unscoped = hits.filter(l => !l.trim().startsWith('.tx-rh-stage') && !l.trim().startsWith('.tx-rh-hub'));
    assert(unscoped.length === 0, `.${legacy} rubber-hose override must be scoped under .tx-rh-stage/.tx-rh-hub, found unscoped: ${unscoped.join(' | ')}`);
  }
  // Tap targets: option buttons must clear the 44px touch minimum.
  const rhBlock = css.slice(markerIdx, endIdx);
  assert(/\.tx-rh-stage\s+\.txoko-choice\{[^}]*min-height:44px/.test(rhBlock),
    'rubber-hose option buttons must keep a 44px minimum tap target');
});

test('EL TURNO scene: escenarios rubber hose que rotan por nivel, con fundido (jul 2026)', () => {
  // Evolución del fondo: sepia oscuro → retícula procedural → lámina única →
  // TRES escenarios ilustrados ("qué tal cambiar de escenario después de X
  // niveles"): comedor → cocina (nv 5) → bodega (nv 10), rotando en niveles
  // altos, con fundido de ~1s y banner al cambiar. El ajedrezado queda SOLO
  // como respaldo mientras carga la lámina activa.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 130000);
  for (const f of ['et-comedor', 'et-cocina', 'et-bodega']) {
    assert(body.includes(`img/${f}.webp`), `scene artwork img/${f}.webp must be wired`);
    assert(existsSync(join(ROOT, `img/${f}.webp`)), `img/${f}.webp must exist on disk`);
  }
  assert(/const ET_BGS=\[/.test(body) && /b\.img\.src=b\.src/.test(body), 'scene loader array missing');
  // Selección por nivel + fundido + banner.
  assert(/Math\.floor\(G\.level\/5\)%ET_BGS\.length/.test(body), 'active scene must derive from level bands of 5, cycling');
  assert(/G\.bgPrev=G\.bgIdx; G\.bgIdx=_si; G\.bgFade=1; flash\(ET_BGS\[_si\]\.banner/.test(body),
    'scene switch must start the crossfade and announce the new room');
  assert(/¡A LA COCINA!/.test(body) && /¡A LA BODEGA!/.test(body) && /¡DE VUELTA AL COMEDOR!/.test(body),
    'each scene needs its banner');
  assert(/G\.bgFade-=dt\*0\.02/.test(body), 'the crossfade must decay over ~1s');
  // Render: lámina activa con paralaje; la anterior encima desvaneciéndose.
  assert(/\*1\.07/.test(body) && /\(G\.px-W\/2\)\*0\.05/.test(body),
    'the artwork must render with the 7% cover margin and the soft parallax offset');
  assert(/ctx\.globalAlpha=Math\.min\(1,G\.bgFade\); _bgDraw\(_bgOld\.img\)/.test(body),
    'the previous scene must fade out on top of the new one');
  assert(/\} else \{[\s\S]{0,120}const TS=54/.test(body),
    'the warm checkerboard must remain ONLY as the not-yet-loaded fallback');
  assert(!/furnished dining room: orderly grid/.test(body) && !/const CELL=178/.test(body),
    'the old procedural furniture grid must be gone (the artwork brings its own tables)');
  const css = read('styles.css');
  const stage = css.slice(css.indexOf('#etStage{'), css.indexOf('#etStage{') + 500);
  assert(/rgba\(255,236,180/.test(stage) && !/#3a2616 0%,#241609/.test(stage),
    '#etStage must keep the bright warm gradient, not the old dark sepia');
});

test('Camarero Survivors: monstruos-alérgeno ilustrados con respaldo (hoja del propietario, jul 2026)', () => {
  // Tercera mejora gráfica: los 8 enemigos dejan el círculo+emoji por sprites
  // reales recortados de UNA hoja Grok (estilo anclado con el sprite del héroe).
  // El dibujo por código queda como respaldo hasta que carga cada imagen.
  assert(/const ET_FOE_SPRITES=\{/.test(html), 'ET_FOE_SPRITES map missing');
  const mapSrc = html.slice(html.indexOf('const ET_FOE_SPRITES={'), html.indexOf('};', html.indexOf('const ET_FOE_SPRITES={')));
  const spriteKeys = [...mapSrc.matchAll(/([a-z]+):'img\/sprites\/foe-([a-z]+)\.webp'/g)].map(m => m[1]);
  // Arte en disco para los 14 alérgenos de la UE (los 6 nuevos recortados de la
  // hoja Grok del propietario, jul 2026). Si algún día se añade un alérgeno sin
  // sprite, el motor ya lo dibuja con el respaldo disco+emoji.
  for (const k of spriteKeys) assert(existsSync(join(ROOT, `img/sprites/foe-${k}.webp`)), `img/sprites/foe-${k}.webp missing on disk`);
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 90000);
  // Las claves del mapa deben cubrir EXACTAMENTE el roster de ALLERGENS del juego.
  // roster = SOLO el array ALLERGENS (EL CHEF también define {key:'chef',...}
  // como pseudo-alérgeno y no debe contarse aquí)
  const rosterSrc = body.slice(body.indexOf('const ALLERGENS=['), body.indexOf('];', body.indexOf('const ALLERGENS=[')));
  const roster = [...rosterSrc.matchAll(/\{key:'([a-z]+)',\s*name:/g)].map(m => m[1]);
  assert(roster.length === 14, `expected 14 allergen foes (UE) in the roster, found ${roster.length}`);
  for (const k of roster) assert(spriteKeys.includes(k), `foe sprite missing for allergen '${k}'`);
  assert(spriteKeys.length === roster.length, 'ET_FOE_SPRITES must not carry unused sprites');
  // Cableado: loader por clave, dibujo del sprite con squash heredado y respaldo íntegro.
  assert(/FOES\[a\.key\]=img/.test(body), 'per-key foe image loader missing');
  assert(/\(_bsp&&_bsp\._ok\)\?_bsp:FOES\[e\.a\.key\]/.test(body) && /ctx\.drawImage\(_sp,-_sw\/2,-_sh\/2,_sw,_sh\)/.test(body),
    'enemy draw must render the sprite scaled to the body radius');
  // +10% visual solo en enemigos normales (jul 2026, "un poco pequeños"):
  // el radio de colisión no cambia y jefes/CHEF conservan su escala.
  assert(/const _sh=e\.r\*\(e\.boss\?2\.55:2\.8\)/.test(body),
    'normal foes must draw 10% larger while bosses keep their approved scale');
  assert(/\} else \{[\s\S]{0,80}ctx\.beginPath\(\); ctx\.fillStyle=e\.a\.col/.test(body),
    'the code-drawn circle body must remain as the not-yet-loaded fallback');
  assert(/if\(!\(_sp&&_sp\._ok\)\)\{ ctx\.font=/.test(body),
    'the emoji emblem must draw ONLY in the fallback (the sprite already carries the identity)');
  // La leyenda de inicio enseña el sprite real, no el emoji.
  assert(/et-lg"><img src="\$\{ET_FOE_SPRITES\[a\.key\]\}"/.test(body),
    'the start-screen legend must show the real sprites');
  // El lenguaje visual heredado sigue: sombra, aro de élite, corona del jefe, flash.
  for (const token of ['e.elite', 'corona del jefe', 'e.flash>0']) {
    assert(body.includes(token), `inherited visual language missing: ${token}`);
  }
});

test('Camarero Survivors: JEFES alérgeno con arte propio y más grandes (jul 2026)', () => {
  // Cuarta mejora gráfica: cada jefe es la versión monstruosa (estilo jefes de
  // Cuphead) de su alérgeno — no un utensilio genérico (descartado por el
  // propietario) — y sale más grande (r 46→54, "un poco más grandes").
  assert(/const ET_BOSS_SPRITES=\{/.test(html), 'ET_BOSS_SPRITES map missing');
  const mapSrc = html.slice(html.indexOf('const ET_BOSS_SPRITES={'), html.indexOf('};', html.indexOf('const ET_BOSS_SPRITES={')));
  const bossKeys = [...mapSrc.matchAll(/([a-z]+):'img\/sprites\/boss-([a-z]+)\.webp'/g)].map(m => m[1]);
  // Arte de jefe en disco para los 14 alérgenos de la UE (los 6 nuevos de la hoja
  // Grok del propietario, jul 2026), con respaldo del motor para cualquier futuro.
  for (const k of bossKeys) assert(existsSync(join(ROOT, `img/sprites/boss-${k}.webp`)), `img/sprites/boss-${k}.webp missing on disk`);
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 90000);
  // roster = SOLO el array ALLERGENS (EL CHEF también define {key:'chef',...}
  // como pseudo-alérgeno y no debe contarse aquí)
  const rosterSrc = body.slice(body.indexOf('const ALLERGENS=['), body.indexOf('];', body.indexOf('const ALLERGENS=[')));
  const roster = [...rosterSrc.matchAll(/\{key:'([a-z]+)',\s*name:/g)].map(m => m[1]);
  assert(roster.length === 14 && bossKeys.length === 14, 'boss sprite map must cover the 14-allergen roster exactly');
  for (const k of roster) assert(bossKeys.includes(k), `boss sprite missing for allergen '${k}'`);
  // Cableado: loader propio + el dibujo del jefe PREFIERE su sprite de jefe.
  assert(/BOSSES\[a\.key\]=img/.test(body), 'per-key boss image loader missing');
  assert(/const _bsp=e\.boss&&!e\.chef\?BOSSES\[e\.a\.key\]:null;/.test(body) && /\(_bsp&&_bsp\._ok\)\?_bsp:FOES\[e\.a\.key\]/.test(body),
    'boss draw must prefer the boss sprite, falling back to the regular foe sprite');
  // Tamaño: el jefe nace con r=54.
  assert(/kind:'boss',flash:0,boss:true/.test(body) && /r:54,spd:0\.5,kind:'boss'/.test(body),
    'boss must spawn at r=54 (owner: "un poco más grandes")');
});

test('Camarero Survivors: EL CHEF, jefe final desde la foto del propietario (jul 2026)', () => {
  // Jefe final único: la persona de la foto del propietario convertida a
  // rubber hose (parecido iterado en Grok: complexión real, botones a punto
  // de explotar, barriga a la vista). Entra en el minuto 3 y cada 3 minutos.
  assert(/const ET_CHEF_SPRITES=\{/.test(html), 'ET_CHEF_SPRITES missing');
  const mapSrc = html.slice(html.indexOf('const ET_CHEF_SPRITES={'), html.indexOf('};', html.indexOf('const ET_CHEF_SPRITES={')));
  assert(/calm:'img\/sprites\/chef-calm\.webp'/.test(mapSrc) && /attack:'img\/sprites\/chef-attack\.webp'/.test(mapSrc),
    'the chef needs his two pose files wired');
  for (const f of ['chef-calm', 'chef-attack']) assert(existsSync(join(ROOT, `img/sprites/${f}.webp`)), `img/sprites/${f}.webp missing on disk`);
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 120000);
  assert(/CHEF_SPR\[k\]=img/.test(body), 'chef sprite loader missing');
  // Aparición: minuto 3, y cada 180s después. Más grande y más duro que un jefe.
  assert(/nextChef:180/.test(body), 'chef timer must start at 180s (minute 3)');
  assert(/if\(G\.time>=G\.nextChef\)\{ G\.nextChef\+=180; spawnChef\(\); \}/.test(body), 'chef must respawn every 180s');
  assert(/function spawnChef\(/.test(body) && /r:64/.test(body) && /\*1\.9\)/.test(body) && /chef:true/.test(body),
    'spawnChef must create the bigger (r=64), tougher (×1.9 hp) final boss');
  assert(/¡EL CHEF!/.test(body), 'the chef needs his own announcement banner');
  // Poses: furioso con el cucharón al telegrafiar/embestir; imponente si no.
  assert(/const _csp=e\.chef\?CHEF_SPR\[\(e\.tele>0\|\|e\.dashing>0\)\?'attack':'calm'\]:null;/.test(body),
    'chef must swap to the attack pose while telegraphing/lunging');
  // Sin corona (se le reconoce) y con rótulo propio en la barra de jefe.
  assert(/if\(e\.boss&&!e\.chef&&!e\.inspec\)\{ \/\/ corona/.test(body), 'the crown must be skipped for the chef (and the inspector)');
  assert(/boss\.chef\?'★ EL CHEF ★'/.test(body), 'the boss bar must carry the chef\'s own label');
});

test('Camarero Survivors: propinas como monedas y bandejas de plata con estela (jul 2026)', () => {
  // Quinta pieza gráfica: los pickups de XP dejan el rombo abstracto y pasan a
  // MONEDAS que giran (oro = objetivo del chef/élite/jefe, plata = normal — el
  // color seguía significando algo y la metáfora ahora es de camarero), y los
  // proyectiles son bandejas de plata con reflejo giratorio y estela.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 95000);
  assert(/const gold=g\.col==='#e0a02c'/.test(body),
    'coin tint must derive from the existing gem color signal (gold = bonus XP)');
  assert(/const R=4\.5\+\(g\.val\|\|1\)\*0\.9/.test(body), 'coin size must grow with gem value');
  assert(/ctx\.ellipse\(0,0,R\*sqz,R,0,0,6\.29\)/.test(body), 'coins must spin via the squashed-ellipse phase');
  assert(!/ctx\.moveTo\(g\.x,g\.y-5\)/.test(body), 'the old abstract diamond gem must be gone');
  // (jul 2026: la bandeja se rediseñó como óvalo fijo — ver el test del
  // rediseño más abajo — pero la estela y el reflejo giratorio se conservan)
  assert(/estela: dos ecos desvanecidos/.test(body) && /ctx\.ellipse\(-k\*8,0,10\.5,6\.5,0,0,6\.29\)/.test(body),
    'trays must leave a two-ghost motion trail');
  assert(/ctx\.ellipse\(0,0,9\.6,5\.8,0,b\.rot\*1\.7,b\.rot\*1\.7\+0\.8\)/.test(body),
    'trays must carry the rotating glint arc');
  assert(/b\.pierce>0/.test(body) && /#ffe9b0/.test(body), 'piercing trays must stay golden (evolution signal)');
  // Segunda vuelta a las propinas (propietario, jul 2026): juice de arcade.
  assert(/halo pulsante SOLO en las de oro/.test(body) && /ctx\.arc\(0,0,R\*1\.9,0,6\.29\)/.test(body),
    'gold coins must carry the pulsing halo (they are the valuable ones)');
  assert(/if\(sqz>0\.78\)\{/.test(body), 'the TXOKO diamond engraving must show only when the coin faces the player');
  assert(/const tw=Math\.sin\(G\.time\*7\+g\.x\*1\.7\+g\.y\*0\.9\)/.test(body) && /tw>0\.9/.test(body),
    'coins must twinkle intermittently (arcade sparkle)');
  assert(/G\.dmgs\.push\(\{x:g\.x,y:g\.y-9,val:'\+'\+g\.val,life:1,col:/.test(body),
    'collecting a coin must float a metal-tinted "+N"');
  assert(/ctx\.fillStyle=n\.col\|\|'#fff'/.test(body), 'damage-number renderer must honor the per-float color');
});

test('Camarero Survivors: ranking rubber-hose de mejores turnos (jul 2026)', () => {
  // "Vamos a añadir un ranking con diseño rubber-hose": tablón de papel torcido
  // con medallas-moneda en la pantalla de inicio. Reutiliza la tabla genérica
  // 'scores' de Supabase con topic='elturno' (cero migraciones) y el esquema
  // local-primero + refresco remoto del Top 10 de Mr. Shoesmith.
  assert(/async function supaInsertEtRecord\(/.test(html) && /topic: 'elturno'/.test(html),
    'record insert must reuse the generic scores table with topic=elturno');
  assert(/async function supaFetchEtTop\(/.test(html) && /topic=eq\.elturno/.test(html),
    'top fetch must filter the scores table by topic=elturno');
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 110000);
  // Guardado por empleado al morir: local (etRecord) + Supabase + refresco del tablón.
  assert(/_emp\.etRecord=\{secs:Math\.floor\(G\.time\),orders:G\.score\}/.test(body) && /saveDB\(\)/.test(body),
    'gameOver must persist the per-employee record locally');
  assert(/supaInsertEtRecord\(currentUser,Math\.floor\(G\.time\),G\.score\)/.test(body),
    'gameOver must push the new record to Supabase');
  // Tablón: markup en la pantalla de inicio + render local-primero + fusión remota.
  assert(/<div id="etRank"><\/div>/.test(body), 'start screen must carry the ranking board slot');
  assert(/function _etRankHtml\(/.test(body) && /function _etRenderRank\(/.test(body), 'ranking renderers missing');
  assert(/el\.innerHTML=_etRankHtml\(local\)/.test(body) && /supaFetchEtTop\(\)\.then\(/.test(body),
    'board must render local data instantly and merge the remote top afterwards');
  assert(/b\.secs-a\.secs/.test(body) && /slice\(0,5\)/.test(body), 'ranking must sort by seconds survived, top 5');
  assert(/Nadie ha sobrevivido aún/.test(body), 'empty state must invite the first run');
  // CSS rubber-hose: papel torcido, contorno grueso, medallas oro/plata/bronce.
  const css = read('styles.css');
  assert(/\.et-rank\{[^}]*border:3px solid var\(--et-ink\)/.test(css) && /\.et-rank\{[^}]*rotate\(-\.7deg\)/.test(css),
    '.et-rank must be the thick-outlined, slightly tilted paper board');
  assert(/\.et-rank-pos\.g\{background:#e8b83a\}/.test(css) && /\.et-rank-pos\.s\{background:#ccd4dc\}/.test(css) && /\.et-rank-pos\.b\{background:#cd7c32/.test(css),
    'medal coins must come in gold/silver/bronze');
});

test('Camarero Survivors: la botella de cava SE VE (diana, volteo, burbujas, onda larga) (jul 2026)', () => {
  // Reporte del propietario: "la botella de cava no hace nada". Verificado
  // empíricamente que SÍ dispara y daña (26 dibujos por vuelo, instrumentando
  // fillText) — el fallo era de percepción: emoji de 20px volando 0,4s y onda
  // de 0,28s, invisibles sobre la lámina. Arreglo de presencia visual:
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 130000);
  assert(/ctx\.arc\(b\.tx,b\.ty,26-10\*k,0,6\.29\)/.test(body), 'each bomb must show its dashed landing target');
  assert(/ctx\.rotate\(k\*7\)/.test(body) && /ctx\.font='26px Georgia'; ctx\.fillText\('🍾'/.test(body),
    'the bottle must tumble mid-air at 26px');
  assert(/vy:-0\.5-Math\.random\(\),life:0\.6,col:'#ffe9b0'/.test(body), 'the bottle must trail golden bubbles');
  assert(/x\.life-=dt\*0\.03/.test(body), 'the blast ring must last ~0.55s (was 0.28s, gone before the eye caught it)');
  assert(/ctx\.arc\(x\.x,x\.y,x\.r\*0\.7,0,6\.29\)/.test(body), 'the blast must carry the inner white ring');
  // La mecánica en sí no se toca: cadencia, daño en área y evolución intactos.
  assert(/G\.cavaT=Math\.max\(70,150-G\.cava\*12\)/.test(body) && /const R=55\+G\.cava\*9, D=22\+G\.cava\*10/.test(body),
    'cava cadence and AoE damage formulas must stay untouched');
});

test('Dieta del HTML: ningún sprite en base64 inline — siempre archivos del repo (jul 2026)', () => {
  // Adelgazamiento aprobado por el propietario ("4 y 5"): los sprites en
  // base64 engordaron el index.html ~713KB que TODO el equipo pagaba en la
  // primera carga 4G. Ahora son archivos en img/sprites/ (el SW los cachea al
  // vuelo y los juegos precargan los suyos). Este guard impide la vuelta
  // atrás: ni un solo data:image base64 en el HTML.
  assert(!/data:image\/(jpeg|png|webp);base64,/.test(html),
    'inline base64 images are banned — ship sprites as repo files under img/sprites/');
  // La precarga de personas existe (los swaps de animación no esperan a la red).
  assert(/window\._txSpritesWarm/.test(html) && /Object\.values\(TX_PERSONAS\)\.forEach/.test(html),
    'the persona-sprite warm-up preloader must run when the picker opens');
});

test('Camarero Survivors: la campana de salud SE RECOGE al contacto y parece una campana (jul 2026)', () => {
  // Reporte del propietario: "cuando pasas por los objetos que dan salud, el
  // personaje no los recoge" — solo se recogían estando herido. Ahora el
  // contacto recoge SIEMPRE: cura si falta vida; a tope de vida da +2 XP con
  // su flotante verde (nunca se siente muerto). Y el rediseño aprovechado:
  // campana de plata con halo, vapor, plato base, pomo y corazón.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 130000);
  assert(/if\(d<G\.pr\+14\)\{/.test(body), 'contact radius must collect regardless of health');
  assert(/G\.xp\+=2; G\.dmgs\.push\(\{x:p\.x,y:p\.y-9,val:'\+2',life:1,col:'#6ad46a'\}\)/.test(body),
    'full-health pickup must convert to a small XP bonus with its green float');
  assert(/G\.hp=Math\.min\(G\.maxhp,G\.hp\+p\.heal\)/.test(body), 'healing when hurt must stay untouched');
  assert(/d<G\.pickR && G\.hp<G\.maxhp/.test(body), 'the magnet must still pull only when hurt');
  // Rediseño: halo, vapor, plato base, cúpula, pomo, corazón.
  assert(/ctx\.arc\(p\.x,p\.y\+bob-2,15,0,6\.29\)/.test(body), 'pickup needs its pulsing green halo');
  assert(/quadraticCurveTo\(p\.x\+sx\+Math\.sin\(ph\)\*3/.test(body), 'pickup needs its wavy steam wisps');
  assert(/ctx\.ellipse\(p\.x,p\.y\+bob\+1,13,3\.6,0,0,6\.29\)/.test(body), 'pickup needs its base plate');
  assert(/ctx\.arc\(p\.x,p\.y\+bob-11,2\.4,0,6\.29\)/.test(body), 'pickup needs its brass knob');
});

test('Camarero Survivors: cuchillos orbitales de chef con estela de giro (jul 2026)', () => {
  // "Mejora las gráficas de los objetos que giran alrededor del héroe": los
  // triángulos de 9px son ahora cuchillos de chef (hoja curva con línea de
  // filo, mango con remache) con estela de giro; la evolución dorada y +25%.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 130000);
  assert(/ctx\.arc\(G\.px,G\.py,kR,ang-0\.55,ang-0\.10\)/.test(body), 'each knife must trail a spin arc on its orbit');
  assert(/ctx\.quadraticCurveTo\(4\.2,-4,3\.4,3\.6\)/.test(body), 'the blade must be the curved chef-knife shape');
  assert(/ctx\.fillRect\(-2\.2,4,4\.4,7\)/.test(body) && /ctx\.arc\(0,7\.5,0\.9,0,6\.29\)/.test(body),
    'the knife needs its wooden handle and brass rivet');
  assert(/ctx\.moveTo\(1\.6,-7\.5\); ctx\.lineTo\(2\.6,1\.5\)/.test(body), 'the blade needs its bright edge line');
  assert(/if\(kevo\) ctx\.scale\(1\.25,1\.25\)/.test(body) && /kevo\?'#ffe9b0':'#e4e9ee'/.test(body),
    'the evolved knives must be golden and 25% larger');
  assert(!/ctx\.moveTo\(0,-9\); ctx\.lineTo\(3\.5,5\)/.test(body), 'the old 9px triangle must be gone');
  // La mecánica no cambia: radio de órbita y daño intactos.
  assert(/const kR=G\.evoKnives\?66:48/.test(body), 'orbit radii must stay untouched');
});

test('Duelos/Retos: ningún enunciado de alérgenos en formato sí/no (las opciones son listas) (jul 2026)', () => {
  // Anotado por el auditor y aprobado por el propietario ("4 y 5"): tres tallos
  // de WAITER_MSGS preguntaban sí/no («¿Los tiene X?», «…si contiene
  // crustáceos», «¿tiene alérgenos X?») pero las opciones son SIEMPRE listas
  // completas de alérgenos — desajuste pregunta/respuesta. Reformulados
  // conservando la escena; este guard veta el patrón sí/no en todo el pool.
  const wm = html.slice(html.indexOf('const WAITER_MSGS={'), html.indexOf('const SHOESMITH_MSGS={'));
  assert(wm.length > 100, 'WAITER_MSGS block not found');
  for (const bad of ['¿Los tiene', 'pregunta si', '¿tiene alérgenos', 'Does <strong>${d}</strong> contain', 'asks if', 'does <strong>${d}</strong> have allergens']) {
    assert(!wm.includes(bad), `yes/no-style stem must not return to WAITER_MSGS: «${bad}»`);
  }
  assert(wm.includes('Repasa la ficha: ¿qué alérgenos lleva') && wm.includes('recita los alérgenos de'),
    'the reworded stems must keep the scene while asking for the full list');
});

test('Camarero Survivors gameplay: health pickups, damage curve, knockback, spawn grace, low-HP warning', () => {
  // Cinco mejoras de la auditoría de daño (petición del propietario: "cómo lo
  // podemos mejorar" → "aplica todo"). Guardan que cada mecánica sigue cableada.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 130000);
  // (1) health pickups: dropped on kill, collected to heal, drawn, and in game state
  assert(/pickups:\[\]/.test(body), 'game state must include a pickups[] array (health drops)');
  assert(/G\.pickups\.push\(\{x:e\.x,y:e\.y,heal:/.test(body), 'enemies must be able to drop a health pickup on death');
  assert(/G\.hp=Math\.min\(G\.maxhp,G\.hp\+p\.heal\)/.test(body), 'collecting a pickup must heal (capped at maxhp)');
  // (2) spawn grace: fresh spawns can't damage for a beat
  assert(/grace:18/.test(body) && /grace:24/.test(body), 'enemies and boss must spawn with an invulnerability-grace window');
  assert(/e\.grace<=0/.test(body), 'contact damage must be gated behind the spawn-grace check');
  // (3) knockback on hit
  assert(/knockback/.test(body) && /o\.x\+=\(o\.x-G\.px\)\/od\*push/.test(body), 'taking a hit must knock nearby enemies back so the player can escape');
  // (4) damage curve (not a flat 8/18 anymore)
  assert(/damage curve/.test(body) && /Math\.min\(e\.boss\?9:6, G\.time\*0\.05\)/.test(body), 'contact damage must ramp with time (fair curve), not a flat constant');
  // (5) low-HP warning element toggled + CSS pulse
  assert(/lowEl\.classList\.toggle\('on'/.test(body) && /G\.hp<25/.test(body), 'the low-HP danger overlay must toggle under 25 HP');
  const css = read('styles.css');
  assert(/#etLow\.on\{[^}]*etLowPulse/.test(css) && /@keyframes etLowPulse/.test(css), 'styles.css must define the pulsing low-HP danger vignette');
});

test('Camarero Survivors AAA: dash, racha, élites, oleadas, jefe con embestida, evoluciones, música y pausa', () => {
  // Pasada "estudio AAA" (petición del propietario): fija cada sistema nuevo
  // para que ninguna refactorización futura los deje caer en silencio.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 140000);
  // (1) esquiva: helper con cooldown + botón táctil + tecla espacio
  assert(/function tryDash\(\)/.test(body) && /G\.dashCd>0\) return/.test(body), 'dash: tryDash() with cooldown gate must exist');
  assert(/id="etDashBtn"/.test(body), 'dash: the touch button must be in the overlay markup');
  assert(/e\.key===' '.*tryDash\(\)/.test(body), 'dash: Space must trigger the dash on keyboard');
  // (2) racha de comandas: contador, ventana de decaimiento y gemas extra
  assert(/G\.combo\+\+; G\.comboT=150/.test(body), 'combo: kills must extend the chain window');
  assert(/if\(G\.comboT<=0\) G\.combo=0/.test(body), 'combo: the chain must reset when the window dries up');
  // (3) élites y oleadas del director de ritmo
  assert(/function spawnEnemy\(kind,elite,pos\)/.test(body) && /elite:!!elite/.test(body), 'elites: spawnEnemy must support the elite variant');
  assert(/function surge\(\)/.test(body) && /G\.nextSurge\+=55/.test(body), 'surges: the telegraphed ring wave must exist');
  assert(/const lull=/.test(body), 'pacing: the breather window (lull) must modulate spawn pressure');
  // (4) jefe con embestida telegrafiada
  assert(/e\.tele-=dt/.test(body) && /e\.dashing=32/.test(body), 'boss: the telegraphed lunge state machine must exist');
  // (5) evoluciones de arma (cartas doradas condicionales)
  assert(/const EVOS=\[/.test(body) && /evoPierce/.test(body) && /evoKnives/.test(body) && /evoCava/.test(body), 'evolutions: the EVOS pool and its three flags must exist');
  assert(/et-evo/.test(body), 'evolutions: the gold card class must be applied in the level-up render');
  // (6) música + silencio + limpieza en teardown
  assert(/function musicTick\(\)/.test(body) && /musicIv=setInterval\(musicTick,138\)/.test(body), 'music: the WebAudio sequencer must start with the run');
  assert(/clearInterval\(musicIv\)/.test(body), 'music: teardown must stop the sequencer');
  assert(/if\(muted\) return;/.test(body), 'audio: the mute flag must gate sfx');
  // (7) pausa (botón + auto-pausa al ir a segundo plano, listener limpiado)
  assert(/id="etPause"/.test(body) && /function setPaused\(/.test(body), 'pause: the pause screen and helper must exist');
  assert(/document\.addEventListener\('visibilitychange',onVis\)/.test(body) && /document\.removeEventListener\('visibilitychange',onVis\)/.test(body),
    'pause: the visibilitychange listener must be added and removed in teardown');
  // (8) hit-stop + haptics + HUD de jefe
  assert(/G\.hitStop/.test(body) && /function vibe\(/.test(body), 'juice: hit-stop and haptics helpers must exist');
  assert(/id="etBossbar"/.test(body), 'HUD: the boss health bar must be in the overlay markup');
  // (9) fin de servicio con estadísticas + mejor turno persistente
  assert(/etBestTime/.test(body) && /Chefs/.test(body), 'game over: run stats + persistent best time must render');
  // CSS de los sistemas nuevos
  const css = read('styles.css');
  for (const sel of ['#etDashBtn', '#etCombo', '#etBossbar', '.et-pick.et-evo', '.et-statgrid']) {
    assert(css.includes(sel), `styles.css must style ${sel}`);
  }
});

test('Camarero Survivors: primer jefe abatible — vida por jefes caídos, sin apilar jefes y con respiro (jul 2026)', () => {
  // Ajuste de dificultad (propietario: "los usuarios no pasan del primer
  // jefe"): (1) la vida del jefe ya no crece solo con el reloj (548 HP en el
  // 0:38) sino con los jefes ya abatidos — el primero ronda 200; (2) nunca
  // hay dos jefes de sala a la vez; (3) el director suelta menos morralla
  // durante la pelea para que las bandejas (apuntan al más cercano) lleguen
  // al jefe; (4) la embestida avisa ~0,7s y carga más lento; (5) el golpe de
  // contacto del jefe baja de 15 a 12 de base.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 120000);
  assert(/const hp=Math\.round\(\(65\+G\.time\*3\.5\)\*\(1\+G\.bosses\*0\.4\)\)/.test(body),
    'boss hp must scale with bosses already defeated, not just the clock (gentle first boss)');
  assert(/if\(bossUp\) G\.nextBoss=G\.time\+8; else \{ G\.nextBoss=G\.time\+40; spawnBoss\(\); \}/.test(body),
    'a new room boss must wait while another boss is still alive (no boss stacking)');
  assert(/const bossUp=G\.enemies\.some\(e=>e\.boss\);/.test(body) && /\(bossUp\?1\.8:1\)/.test(body),
    'the spawn director must ease off the trash-mob pressure while a boss is alive');
  assert(/if\(!bossUp&&G\.time>25/.test(body),
    'the bonus double-spawn must pause during a boss fight');
  assert(/e\.tele=42/.test(body) && /spdMul=3\.8/.test(body),
    'the boss lunge must telegraph ~0.7s and charge at 3.8 (was 28 frames / 4.4)');
  assert(/e\.boss\?12:5/.test(body),
    'boss contact damage must start at 12 base, not 15');
});

test('Camarero Survivors: la bandeja PARECE bandeja y cada jefe tiene habilidad especial (jul 2026)', () => {
  // (1) Reporte de usuarios: "las bandejas parecen platos pequeños o
  // monedas". El culpable era el giro de canto (el mismo squash de elipse
  // que usan las propinas-moneda). Ahora la bandeja es un óvalo ancho
  // SIEMPRE, con pocillo interior, servilleta y tres canapés a bordo.
  // (2) Habilidades de jefe por familia de alérgeno (propietario): abanico
  // de proyectiles (gluten/huevo/pescado), refuerzos mini (frutos/crust) o
  // charco que frena y quema (lácteos/soja/sulfitos); EL CHEF barre en
  // radial. Todas avisan con un aro dorado de carga y se esquivan.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 130000);
  // — bandeja: óvalo fijo con comida a bordo; el squash de moneda se fue —
  assert(/ctx\.ellipse\(0,0,11,7,0,0,6\.29\)/.test(body),
    'tray must be a wide oval platter (never edge-on like a coin)');
  assert(/servilleta \+ tres canapés a bordo/.test(body),
    'tray must carry the napkin + canapés that make it read as a tray');
  assert(!/ctx\.ellipse\(0,0,6\.5,6\.5\*sq/.test(body),
    'the old coin-spin tray (edge-on squash) must be gone');
  // — sprite de bandeja (vídeo Grok del propietario, jul 2026 → fotograma
  //   recortado): preferido en el dibujo, con el respaldo por código detrás —
  assert(existsSync(join(ROOT, 'img/sprites/tray.webp')), 'img/sprites/tray.webp missing on disk');
  assert(/const TRAY=new Image\(\); TRAY\.onload=\(\)=>\{ TRAY\._ok=true; \}; TRAY\.src='img\/sprites\/tray\.webp'/.test(body),
    'the illustrated tray loader must be wired (sprite-preferred)');
  assert(/if\(TRAY\._ok\)\{/.test(body),
    'tray draw must prefer the sprite and keep the code-drawn platter as fallback');
  // — habilidades de jefe: mapa por alérgeno + las tres familias cableadas —
  assert(/const BOSS_ABIL=\{gluten:'volley',huevo:'volley',pescado:'volley',frutos:'summon',crust:'summon',lacteos:'zone',soja:'zone',sulfitos:'zone',chef:'volley',/.test(body),
    'every allergen family (and the chef) must map to its boss ability');
  // los 6 alérgenos nuevos (UE) también tienen habilidad de jefe definida
  for (const k of ['cacahuete','apio','mostaza','sesamo','molusco','altramuz'])
    assert(new RegExp(k + ":'(volley|summon|zone)'").test(body), `BOSS_ABIL sin habilidad para ${k}`);
  assert(/function bossAbility\(e\)/.test(body) && /eshots:\[\], zones:\[\]/.test(body),
    'bossAbility() and the eshots/zones state arrays must exist');
  assert(/e\.wind-=dt; spdMul=0\.15; if\(e\.wind<=0\) bossAbility\(e\);/.test(body),
    'abilities must be telegraphed by a windup that slows the boss');
  assert(/jefe cargando su habilidad: aro dorado/.test(body),
    'the golden windup ring must be drawn so the special never comes from nowhere');
  assert(/G\.eshots\.push\(/.test(body) && /G\.zones\.push\(\{x:G\.px,y:G\.py/.test(body) && /spawnMini\(e\.x\+Math\.cos/.test(body),
    'the three ability families (volley / zone / summon) must be wired');
  assert(/G\.hp-=8; G\.ifr=30;/.test(body),
    'boss shots must deal modest damage and grant i-frames (dodgeable, never a shred-loop)');
  assert(/pvx\*=0\.6; pvy\*=0\.6;/.test(body) && /G\.hp-=0\.06\*dt/.test(body),
    'active puddles must slow the player and burn slowly (not instantly kill)');
  assert(/if\(G\.enemies\.length<70\)/.test(body),
    'the summon ability must respect an enemy-count cap (no flooding)');
});

test('Camarero Survivors: meta-progresión — propinas persistentes, tienda, oficios y otra ronda (jul 2026)', () => {
  // El bucle de retención de Vampire Survivors ("vamos con todo" del
  // propietario): las propinas se GUARDAN al morir (cada derrota es
  // progreso), compran mejoras permanentes en la tienda de inicio, hay 4
  // oficios de sala con arranque distinto y un cambio de cartas por partida
  // (ampliable en la tienda). Los récords del ranking no se tocan.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 150000);
  // cartera por empleado y dispositivo + tienda
  assert(/localStorage\.getItem\('etMeta:'\+currentUser\)/.test(body) && /localStorage\.setItem\('etMeta:'\+currentUser/.test(body),
    'the tips wallet must persist per employee+device (same pattern as etBestTime)');
  assert(/const ET_PERKS=\[/.test(body) && /const ET_PERK_COST=\[25,60,140,320,700\]/.test(body),
    'the permanent-perk catalog and its cost curve must exist');
  assert(/function _etRenderShop\(\)/.test(body) && /Mejoras del oficio/.test(body),
    'the shop panel must render on the start screen');
  // ganancia al morir + botón de tienda en el fin de servicio
  assert(/_mm\.tips\+=_earn; _etMetaSave\(_mm\); _etRenderShop\(\);/.test(body),
    'gameOver must bank the earned tips and refresh the shop');
  assert(/G\.closed\?60:0/.test(body), 'reaching the closing time must pay a fat tip bonus');
  assert(/id="etShopBtn"/.test(body), 'the game-over screen must link back to the shop');
  // lo permanente entra en newGame (perks + oficio elegido)
  assert(/for\(const p of ET_PERKS\)\{ const n=_m\.up\[p\.k\]\|\|0; if\(n\) p\.fx\(G,n\); \}/.test(body),
    'newGame must apply the purchased perk levels');
  assert(/const ET_CHARS=\[/.test(body) && /\(ET_CHARS\.find\(c=>c\.k===_m\.char\)\|\|ET_CHARS\[0\]\)\.fx\(G\);/.test(body),
    'newGame must apply the selected trade (oficio)');
  const chars = [...body.slice(body.indexOf('const ET_CHARS=['), body.indexOf('];', body.indexOf('const ET_CHARS=['))).matchAll(/\{k:'([a-z]+)'/g)].map(m => m[1]);
  assert(chars.length === 4 && chars.includes('camarero') && chars.includes('sumiller') && chars.includes('cortador') && chars.includes('maitre'),
    'there must be exactly 4 trades: camarero/sumiller/cortador/maitre');
  // otra ronda: botón en el level-up, gastable, ampliable con el perk 'ronda'
  assert(/id="etReroll"/.test(body) && /G\.rerolls<=0\) return; G\.rerolls--;/.test(body),
    'the level-up reroll button must exist and burn a charge per use');
  assert(/\{k:'ronda'/.test(body) && /g\.rerolls\+=n/.test(body), 'the shop must sell extra rerolls');
  // CSS de tienda y oficios
  const css = read('styles.css');
  for (const sel of ['.et-shop{', '.et-shop-buy', '.et-char{', '.et-char.on']) {
    assert(css.includes(sel), `styles.css must style ${sel}`);
  }
});

test('Camarero Survivors: carrito de postres del jefe y cloche con pregunta de la carta REAL (jul 2026)', () => {
  // (1) El cofre de VS: el jefe abatido suelta un carrito dorado; recogerlo
  // abre una ceremonia tragaperras que regala 1 mejora (2 si era EL CHEF).
  // (2) El cloche misterioso: pregunta Sí/No derivada de DISHES (la carta
  // real — mismos nombres de alérgeno que el roster del juego); acertar paga
  // gordo (limpieza/imán/banquete) y fallar deja la lección a la vista.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 150000);
  // carrito: drop en la muerte del jefe + ceremonia + limpieza del interval
  assert(/G\.pickups\.push\(\{x:e\.x,y:e\.y,chest:true,dbl:!!e\.chef,life:9999\}\)/.test(body),
    'a defeated boss must drop the dessert cart (chef: guaranteed double)');
  assert(/function showChest\(dbl\)/.test(body) && /id="etChest"/.test(body),
    'the chest ceremony overlay must exist');
  assert(/_etChestIv=setInterval\(/.test(body) && (body.match(/clearInterval\(_etChestIv\)/g) || []).length >= 3,
    'the slot-machine interval must be cleaned on settle, on start and in teardown');
  // cloche: solo con datos de carta, ventana de spawn, pregunta 50/50 honesta
  assert(/typeof DISHES!=='undefined'&&DISHES\.length/.test(body),
    'the cloche must only spawn when the real menu data is present');
  assert(/G\.time>=G\.nextClo&&G\.time<560/.test(body), 'the cloche must not spawn during the closing stretch');
  assert(/const askYes=has\.length>0&&\(Math\.random\(\)<0\.5\|\|!not\.length\)/.test(body),
    'the question must be a fair 50/50 between allergens the dish has and lacks');
  assert(/dish\.allergens\|\|\[\]\)\.includes\(a\.name\)/.test(body),
    'the answer key must derive from the dish allergen list (same names as the roster)');
  // recompensas + feedback educativo siempre
  assert(/¡LIMPIEZA DE SALA!/.test(body) && /¡PROPINA TOTAL!/.test(body) && /¡BANQUETE!/.test(body),
    'the three cloche rewards must be wired');
  assert(/lleva: <b>\$\{escapeHTML\(full\)\}/.test(body),
    'both outcomes must show the dish\'s full allergen list (the lesson always lands)');
  // los overlays de decisión mandan sobre la pausa
  assert(/for\(const id of \['etLevelup','etChest','etQuiz'\]\)/.test(body),
    'pause must defer to the level-up/chest/quiz overlays');
  const css = read('styles.css');
  for (const sel of ['.et-quiz-dish', '.et-quiz-btns', '.et-slot .et-pick-ic']) {
    assert(css.includes(sel), `styles.css must style ${sel}`);
  }
});

test('Camarero Survivors: CIERRE DEL LOCAL a las 10:00 — la inspectora imbatible y SERVICIO COMPLETO (jul 2026)', () => {
  // El final de partida de VS (la Muerte a los 30:00), versión sala: aviso a
  // las 9:30, LA INSPECTORA entra a las 10:00 (inmune, acelera sin tregua),
  // los eventos programados se apagan y llegar al cierre es la victoria.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 150000);
  assert(/if\(!G\.warned&&G\.time>=570\)/.test(body) && /CIERRE EN 30s/.test(body),
    'the 30-second warning must fire at 9:30');
  assert(/if\(!G\.closed&&G\.time>=600\)\{ G\.closed=true; spawnInspectora\(\); \}/.test(body),
    'the inspector must arrive exactly at closing time');
  assert(/function spawnInspectora\(\)/.test(body) && /hp:1e9,maxhp:1e9/.test(body) && /inspec:true/.test(body),
    'the inspector must spawn effectively unkillable');
  assert(/if\(e\.inspec\) return;\s+\/\/ la inspectora no se negocia/.test(body),
    'hurtEnemy must ignore the inspector entirely (no damage, no flash)');
  assert(/if\(e\.inspec\) e\.spd\+=dt\*0\.0011/.test(body),
    'the inspector must accelerate relentlessly (the end always arrives)');
  assert(/if\(G\.time<600\)\{/.test(body),
    'scheduled events (elites/surges/bosses/chef) must stop at closing time');
  assert(/boss\.inspec\?'★ LA INSPECTORA · CIERRE ★'/.test(body),
    'the boss bar must announce the inspector');
  assert(/G\.closed\?'¡SERVICIO COMPLETO!'/.test(body),
    'surviving to the close must be celebrated as SERVICIO COMPLETO');
});

test('Camarero Survivors: música v2 — swing, batería sintetizada, lead que respira, modos jefe y cierre (jul 2026)', () => {
  // El loop viejo eran 16 pasos idénticos con un blip de 2600 Hz por batería.
  // La v2 sigue sin archivos (CSP-safe) pero suena a servicio: compás doble
  // Am7→D9 con bajo caminante, swing, bombo/escobilla/ride sintetizados,
  // comping, lead que calla un loop de cada dos, tritono con jefe y +5
  // semitonos con ride a semicorcheas en el cierre. Compresor propio.
  const i = html.indexOf('function launchElTurno(');
  const body = html.slice(i, i + 150000);
  assert(/const M_SWING=0\.045/.test(body) && /sw=\(st%4===2\)\?M_SWING:0/.test(body),
    'weak eighths must be delayed by the swing constant');
  assert(/const M_WALK=\[0,3,7,10, 5,9,12,11\]/.test(body),
    'the walking bass must vamp Am7→D9 with a chromatic approach note');
  assert(/function mDrum\(kind,when,vol\)/.test(body) && /exponentialRampToValueAtTime\(42,when\+\.09\)/.test(body),
    'the kick must be a pitch-dropping sine, not a beep');
  assert(/mNoiseBuf=b/.test(body) && /f\.type='highpass'; f\.frequency\.value=7000/.test(body) && /f\.type='bandpass'; f\.frequency\.value=1900/.test(body),
    'ride and brush must be filtered noise from a generated buffer');
  assert(/mComp=AC\.createDynamicsCompressor\(\)/.test(body),
    'music must run through its own compressor so it never fights the sfx');
  assert(/const M_BOSS_BASS=\[0,6\]/.test(body), 'boss mode must ride the tritone ostinato');
  assert(/closing\?5:0/.test(body) && /closing&&st%2===1/.test(body),
    'the closing stretch must transpose up and double the ride to 16ths');
  assert(/if\(mLoop%2===0\)/.test(body), 'the lead must breathe: silent every other loop');
  assert(/mStep=0; mLoop=0;/.test(body), 'start() must reset both sequencer counters');
  assert(/musicIv=setInterval\(musicTick,138\)/.test(body) && /clearInterval\(musicIv\)/.test(body),
    'the sequencer lifecycle (start with run, die in teardown) must stay intact');
});

test('Quiz del día antiguo (5 preguntas): RETIRADO — solo existe el Reto del día (jul 2026)', () => {
  // Decisión del propietario: el quiz de 5 preguntas convivía con el nuevo
  // «Reto del día» (1 pregunta compartida, racha y liga) y el nombre casi
  // idéntico confundía. Se retiró entero: tile, vistas, temporizador, RNG
  // propio y escritura de scores (topic=quizdia). Este guard evita que
  // vuelva por una caché vieja o un copy-paste.
  assert(!/renderQuizDia|id="qdTile"|_qdTileSync|_qdDayKey|_qdState|_qdTimer/.test(html),
    'el quiz del día antiguo debe seguir retirado (tile, vistas y estado)');
  assert(!/topic: 'quizdia'|topic=eq\.quizdia/.test(html),
    'nada puede volver a escribir o leer scores con topic=quizdia');
  // El sustituto sigue vivo: el Reto del día con su generador determinista.
  assert(/function _dqQuestion\(/.test(html) && /openDailyReto/.test(html),
    'el Reto del día (1 pregunta compartida) debe seguir siendo la mecánica diaria');
});

test('SW: la recarga por versión nueva no interrumpe una sesión en curso (jul 2026, doble pantalla de carga)', () => {
  // El handler de controllerchange recargaba la página al activarse un SW
  // nuevo. Si el auto-login ya había corrido, la carga se veía DOS veces. Se
  // guarda para no recargar cuando el usuario ya entró (currentUser set).
  const h = html.slice(html.indexOf("addEventListener('controllerchange'"), html.indexOf("addEventListener('controllerchange'") + 400);
  assert(/if \(typeof currentUser !== 'undefined' && currentUser\) return;/.test(h),
    'the controllerchange reload must bail out when a session is already active (no double loading screen)');
  assert(/if \(_swReloaded\) return;/.test(h) && /_swReloaded = true;/.test(h),
    'the once-only reload guard must remain');
});

test('sync: el upsert de empleado es MONÓTONO — nunca pisa la nube con ceros (jul 2026, pérdida de Alexis)', () => {
  // Bug real: al entrar en un origen nuevo (meseo.es) sin datos locales, si la
  // restauración desde la nube fallaba un instante, el login creaba una ficha
  // a cero y el upsert la subía con merge-duplicates, BORRANDO xp/known/exam
  // del usuario. El upsert ahora lee la nube primero y fusiona sin reducir.
  const fn = html.slice(html.indexOf('async function supaUpsertEmployee'), html.indexOf('async function supaFetchAllEmployees'));
  assert(fn.length > 400, 'supaUpsertEmployee not found');
  // (1) lee la nube antes de escribir (columnas sin pin: _EMP_COLS)
  assert(/employees\?name=ilike\.\$\{encodeURIComponent\(name\)\}&select=\$\{_EMP_COLS\}/.test(fn),
    'the upsert must read the current cloud row before writing');
  // (2) aborta si no puede leer la nube y la ficha local está vacía
  assert(/const _localEmpty =/.test(fn) && /if\(!cloudReadOk && _localEmpty\) \{[^}]*return;/.test(fn),
    'the upsert must abort when the cloud is unreadable AND local is empty (never clobber with zeros)');
  // (3) fusión monótona: max en números, unión en mapas
  assert(/xp=Math\.max\(xp, cloud\.xp\|\|0\)/.test(fn) && /_etMergeMap\(JSON\.parse\(cloud\.known_dishes/.test(fn),
    'numeric fields must take max(local,cloud) and maps must merge (union)');
  // (4) el upsert ya NO toca el pin (el hash vive en el servidor; se fija/verifica
  //     por RPC). No debe leerlo del cloud ni enviarlo en el payload.
  assert(!/cloud\.pin/.test(fn) && !/\bpin:/.test(fn),
    'the upsert must not read or write the pin (server-side now)');
  // (5) el helper de fusión de mapas existe y hace max por clave
  assert(/function _etMergeMap\(a, b\)\{/.test(html) && /Math\.max\(av, bv\)/.test(html),
    'the _etMergeMap helper must do per-key max');
});

test('supervisor: "Conectados Hoy" usa lastActiveAt (además de lastLoginTs) y el login siempre sincroniza', () => {
  // Bug real (verificado con datos reales en Supabase): Alexis y Sol tenían
  // last_active_at DE HOY (el PATCH ligero de supaUpdateLastActive, que
  // SIEMPRE se manda al entrar, había funcionado) pero last_login de días
  // atrás (el PATCH pesado de supaUpsertEmployee — topic_scores, known_dishes,
  // sessions… — puede fallar en silencio con el WiFi de sala). El panel de
  // supervisor solo miraba last_login → las mostraba como "sin conectarse
  // hoy" pese a haber usado la app. Faride (0 XP) ni siquiera tenía
  // last_login: el login lo saltaba del todo para empleados sin XP.
  assert(/lastActiveAt: r\.last_active_at \|\| null/.test(html),
    'supaFetchAllEmployees debe mapear last_active_at (antes se descartaba)');
  const sup = html.slice(html.indexOf('function renderSupervisor('), html.indexOf('function renderSupervisor(') + 30000);
  assert(/const _supSeen = n => \{ const a=allEmps\[n\]\.lastLoginTs, b=allEmps\[n\]\.lastActiveAt;/.test(sup),
    'falta el helper _supSeen (la marca más reciente de login/actividad)');
  assert(/connectedToday = empNames\.filter\(n => \{\s*const lt = _supSeen\(n\);/.test(sup),
    '"Conectados Hoy" debe filtrar con _supSeen, no solo lastLoginTs');
  assert(!/if\(emp\.xp && emp\.xp > 0\) supaUpsertEmployee\(currentUser\);/.test(html),
    'el login ya no debe saltarse la sincronización para empleados con 0 XP');
});

test('logros: el registro de logros desbloqueados se sincroniza en la nube (no se re-disparan entre dispositivos)', () => {
  // Bug real (propietario): al entrar en otro dispositivo re-saltaban las
  // notificaciones de logros ya desbloqueados, porque emp.achievements solo
  // vivía en local. El dispositivo nuevo restauraba el XP alto pero con el
  // ledger vacío → checkNewAchievements() los trataba a todos como nuevos.
  assert(/const _EMP_COLS='[^']*\bachievements\b[^']*'/.test(html),
    '_EMP_COLS debe incluir achievements para leer el ledger de la nube');
  assert(/achievements: JSON\.stringify\(ach\)/.test(html),
    'supaUpsertEmployee debe escribir el ledger de logros en la nube');
  // La restauración reconstruye el ledger (nube ⊕ local ⊕ logros ya ganados por
  // stats) antes de entrar, para que un dispositivo nuevo no re-notifique.
  const restore = html.slice(html.indexOf('async function supaRestoreEmployee('),
    html.indexOf('async function supaRestoreEmployee(') + 7000);
  assert(/JSON\.parse\(r\.achievements\|\|'\[\]'\)/.test(restore),
    'supaRestoreEmployee debe leer r.achievements de la nube');
  assert(/getUnlockedAchievements\(emp\)\.map\(a=>a\.id\)/.test(restore),
    'la restauración debe sembrar el ledger con los logros que ya corresponden a las stats (usuarios existentes con ledger vacío en la nube)');
});

test('reto del día + liga semanal: pregunta compartida determinista y XP semanal sincronizado (jul 2026)', () => {
  // Enganche diario pedido por el propietario: «no logramos que los usuarios
  // se enganchen y la usen a diario». Reto del día = la MISMA pregunta para
  // todo el equipo (generador sembrado con la fecha — sin Math.random, o cada
  // móvil vería una pregunta distinta) + Liga semanal que se reinicia cada
  // lunes (el ranking histórico solo motivaba a los 2 primeros).
  const dq = html.slice(html.indexOf('function _dqQuestion('), html.indexOf('function _dqIsDone('));
  assert(dq.length > 100 && !/Math\.random\(/.test(dq),
    '_dqQuestion debe ser determinista: PROHIBIDA la llamada Math.random() (rompería la pregunta compartida)');
  assert(/function _mulberry32\(/.test(html), 'falta el PRNG sembrado _mulberry32');
  assert(/_wkEnsure\(emp\); emp\.wkXP=\(emp\.wkXP\|\|0\)\+granted/.test(html),
    'awardXP debe acumular el XP ganado en la liga semanal (wkXP)');
  assert(/const _EMP_COLS='[^']*\bextras\b[^']*'/.test(html),
    '_EMP_COLS debe incluir extras (estado de liga y reto en la nube)');
  assert(/extras: _extrasCompose\(emp\)/.test(html),
    'supaUpsertEmployee debe escribir extras (liga + reto) en la nube');
  const restore = html.slice(html.indexOf('async function supaRestoreEmployee('),
    html.indexOf('async function supaRestoreEmployee(') + 8000);
  assert(/_extrasMergeInto\(emp, r\.extras\)/.test(restore),
    'la restauración debe heredar liga/reto de la nube (evita repetir el reto de hoy en otro dispositivo)');
  assert(/Liga semanal/.test(html) && /weekMap/.test(html) && /se reinicia cada lunes/.test(html),
    'el ranking debe mostrar la Liga semanal con reinicio los lunes');
  assert(/openDailyReto\(\)/.test(html) && /Reto del día/.test(html),
    'el inicio debe ofrecer el Reto del día');
});

test('El Código del Camarero: manual de oficio consultable (jul 2026)', () => {
  // Petición del propietario: «crear el mejor camarero del mundo… eso que solo
  // te enseñan los años y la experiencia». No es un examen: es un manual de
  // campo — la lectura de la mesa, qué decir, qué hacer, nunca, y el porqué.
  const raw = read('data/codigo-camarero.json');
  let data;
  try { data = JSON.parse(raw); } catch(e){ assert(false, 'codigo-camarero.json debe ser JSON válido: '+e.message); }
  assert(Array.isArray(data.cats) && data.cats.length >= 8, 'debe haber al menos 8 categorías del código');
  assert(Array.isArray(data.cards) && data.cards.length >= 50, 'debe haber al menos 50 códigos (hay '+(data.cards||[]).length+')');
  const catIds = new Set(data.cats.map(c=>c.id));
  for(const card of data.cards){
    for(const k of ['t','t_en','read','read_en','steps','steps_en','why','why_en']){
      assert(card[k] && (!Array.isArray(card[k]) || card[k].length), `código #${card.id} («${card.t}») sin campo ${k} — cada ficha va completa y bilingüe`);
    }
    assert(catIds.has(card.cat), `código #${card.id} con categoría desconocida: ${card.cat}`);
  }
  assert(/function startCodigo\(/.test(html) && /codigo-camarero\.json/.test(html),
    'la app debe cargar el Código (lazy) con startCodigo()');
  assert(/El Código del Camarero/.test(html) && /startCodigo\(\)/.test(html),
    'el hub de Protocolo debe tener la entrada al Código del Camarero');
  // Regla del propietario: «que ningún código actúe en contra del estándar de
  // Forbes». La vista lo declara y los códigos sensibles lo respetan (p. ej.
  // la cuenta se OFRECE con prisa, nunca se planta sin pedirla).
  assert(/ante la duda, manda el estándar/.test(html),
    'la vista del Código debe declarar que ante la duda manda el estándar Forbes/LQA');
  assert(/la cuenta está lista/.test(raw) && !/Lleva la cuenta preparada con el último pase, sin que la pidan/.test(raw),
    'con prisa la cuenta se OFRECE (estándar: se presenta al pedirla) — no se lleva sin pedirla');
});

test('auditoría de botones: nada de tinta oscura sobre el fondo oscuro de la página (jul 2026)', () => {
  // Bug real (propietario): «en auditoría los botones para volver atrás no se
  // ven bien». El fondo de la página es oscuro (#1c2a22); un botón transparente
  // con color var(--parch*) (tinta oscura, pensada para tarjetas claras) es
  // invisible. 28 botones (← volver de LQA/supervisor/editor/Código, «Volver
  // al menú», pestañas de turno apagadas) pasaron a dorado tenue. Este guard
  // bloquea el patrón entero: transparente + borde tenue + tinta = prohibido.
  assert(!/color:var\(--parch\d?\);cursor:pointer[^>]*>\s*←\s*</.test(html),
    'ningún botón ← de volver puede usar tinta oscura (var(--parch*)) sobre fondo transparente');
  assert(!/background:transparent;border:1px solid var\(--line\);border-radius:var\(--r2?\);padding:\.4rem \.8rem;font-size:\.75rem;color:var\(--parch/.test(html),
    'patrón de botón de volver con tinta oscura detectado — usa dorado tenue rgba(228,190,104,.85)');
});

test('Rebranding Meseo: la app se llama Meseo; TXOKO queda solo como venue (jul 2026)', () => {
  // Propietario: «evitar demandas — la app es multi-restaurante; Txoko puede
  // aparecer como uno de los restaurantes a escoger, pero el nombre de la
  // app debe ser otro». La identidad del restaurante (TXOKO, Ritz-Carlton,
  // Berasategui) vive SOLO en data/themes.json (venue) y en el contenido de
  // los platos; la app se presenta como Meseo (meseo.es) en manifest,
  // título, icono, login por defecto, créditos, push y compartir.
  const man = JSON.parse(read('manifest.json'));
  assert(man.short_name === 'Meseo' && /^Meseo/.test(man.name), 'manifest must carry the Meseo identity');
  assert(!/txoko|berasategui|ritz/i.test(man.name + man.short_name + man.description),
    'manifest must not present the app as any restaurant brand');
  assert(/<title>Meseo · Formación de sala<\/title>/.test(html), 'the base tab title must be Meseo');
  assert(/id="loginLogoName">Meseo</.test(html) && /id="loginEyebrow">Formación de sala</.test(html),
    'login defaults must be neutral Meseo — venue identity arrives only via themes.json');
  assert(!/Uso exclusivo Txoko/.test(html) && /app-credit[^>]*>© 2026 [^<]*Meseo/.test(html),
    'the footer credit must be Meseo, not a restaurant');
  assert(/%cMeseo · v/.test(html), 'the console banner must be Meseo');
  assert(/no está afiliada, patrocinada ni respaldada/.test(html) && /sus respectivos titulares/.test(html),
    'the legal modal must keep the trademark disclaimer, generalized to all venues');
  const themes = read('data/themes.json');
  assert(/"title": "Meseo · TXOKO"/.test(themes), 'venue tab titles must compose app brand + venue');
  const icon = read('icon.svg');
  assert(/>M<\/text>/.test(icon) && !/TXOKO/i.test(icon) && !/MESEO/.test(icon),
    'the icon must be Meseo-branded (cloche + M monogram), never Txoko');
  assert(/title: 'Meseo'/.test(read('sw.js')), 'the push fallback title must be Meseo');
  assert(/https:\/\/meseo\.es\//.test(html) && !/github\.io\/Txoko-Formacion/.test(html),
    'the share link must point at meseo.es, not the old repo URL');
  // Segunda vuelta (reporte del propietario: «aparece txoko, parpadea meseo
  // y vuelve a txoko»): el héroe del login ya NO se tematiza con el venue —
  // la app se presenta SIEMPRE como Meseo y el restaurante vive en el
  // selector, que ahora se muestra en cuanto hay al menos un venue.
  const themeFn = html.slice(html.indexOf('function applyTheme'), html.indexOf('function _venueTriggerSync'));
  assert(!/loginLogoName|loginEyebrow|loginSubtitle/.test(themeFn),
    'applyTheme must not restyle the login hero (it stays Meseo — no more brand flicker)');
  assert(/if\(all\.length\) renderVenuePicker\(all, current\.id\);/.test(html),
    'the venue picker must render even with a single venue (Txoko as a choice, not as the face)');
  // Tercera vuelta (reporte: «meseo no pertenece a Martín Berasategui»): el
  // sincronizador de idioma (applyLangToApp) era una SEGUNDA fuente que
  // re-inyectaba el subtítulo del venue en el héroe, con el mismo gating >1
  // del selector. El literal del subtítulo del venue no puede existir en el
  // JS de la app — solo en data/themes.json como dato del venue.
  assert(!/by Martín Berasategui · Formación de Equipo|by Martín Berasategui · Team Training/.test(html),
    'no app JS may hardcode a venue subtitle (the login hero is always Meseo)');
  assert(/if\(_all\.length && ACTIVE_VENUE\) renderVenuePicker\(_all, ACTIVE_VENUE\.id\);/.test(html),
    'the language re-render must keep the single-venue picker visible too');
  assert(/is not affiliated with, sponsored by or officially endorsed/.test(html) && /their respective owners/.test(html),
    'the EN legal modal must carry the generalized multi-venue disclaimer like the ES one');
});

test('Mr. Shoesmith está VIVO: respiración en reposo, enfado inmediato por error, celebración y temblor', () => {
  // Petición del propietario: el personaje debe estar animado y cambiar de
  // humor con cada error. Las animaciones antiguas apuntaban a `svg` (muertas
  // desde que el rostro es <img>); este guard fija el sistema vivo.
  // (1) el tick NO reemplaza la imagen cada 100ms (mataría las animaciones CSS)
  const tick = html.slice(html.indexOf('function txTick('), html.indexOf('function txAnswer('));
  assert(/if\(oldMood !== newMood\)\{\s*[\r\n]+\s*txApplyMood\(faceEl/.test(tick),
    'txTick must only swap the face img when the mood actually changes');
  assert(/tx-face-tense'?,\s*pct<=30\)/.test(tick), 'txTick must toggle the low-patience tremble class');
  // (2) el error cambia la cara AL INSTANTE y dispara la reacción de enfado
  const ans = html.slice(html.indexOf('function txAnswer('), html.indexOf('function txAnswer(') + 4000);
  assert(/playSound\('wrong'\)[\s\S]*?txApplyMood\(faceEl,txokoState\.lives/.test(ans),
    'a wrong answer must swap to the angrier face immediately (not wait for the next tick)');
  assert(/tx-face-bad/.test(ans), 'a wrong answer must trigger the tx-face-bad rage reaction');
  assert(/tx-face-ok/.test(ans), 'a correct answer must trigger the tx-face-ok celebration');
  assert(!/shoe-mood-change/.test(html), 'the dead shoe-mood-change hook must be gone');
  // (3) CSS: marioneta viva y sin selectores muertos sobre svg
  const css = read('styles.css');
  assert(/\.tx-rh-face-frame\.tx-mood-calm \.tx-shoe-face\{animation:shoeIdle/.test(css),
    'the face must breathe at rest (shoeIdle via tx-mood-calm) — and WITHOUT an #id in the selector, or the state animations (tremble/nod/rage) lose the specificity war and never run');
  for (const kf of ['@keyframes shoeIdle', '@keyframes shoeFidget', '@keyframes shoeFume', '@keyframes shoeBoil', '@keyframes shoeRage', '@keyframes shoeNod', '@keyframes shoeTremble', '@keyframes shoeFlash']) {
    assert(css.includes(kf), `styles.css must define ${kf}`);
  }
  assert(!/#txokoClientFace svg/.test(css), 'dead svg-based animation selectors must be removed');
  // (4) el humor cambia el COMPORTAMIENTO (calm/mid/mad) y el ENCUADRE (m3/m4)
  assert(/function txMoodClass\(lives\)/.test(html) && /function txApplyMood\(/.test(html),
    'mood-tier helpers (txMoodClass/txApplyMood) must exist');
  assert(/tx-shoe-m'\+mood/.test(html), 'txClientFace must tag the sprite with its per-mood crop class');
  assert(/\.tx-rh-face-frame \.tx-shoe-m3\{/.test(css) && /\.tx-rh-face-frame \.tx-shoe-m4\{/.test(css),
    'the angry poses (m3/m4) need their own framing — a single crop leaves them off-centre');
});

test('Mr. Shoesmith: animación por FOTOGRAMAS (parpadeo, habla, guiño, gruñido, grito alternado)', () => {
  // Hoja de 5 fotogramas del propietario (jul 2026). El personaje alterna
  // poses reales: parpadea en calma, habla al dictar la pregunta, guiña al
  // acierto, mastica su rabia a 2 vidas y grita alternando A/B a 1 vida.
  assert(/const SHOESMITH_ANIM=\{/.test(html), 'SHOESMITH_ANIM frame set missing');
  for (const k of ['blink', 'talk', 'wink', 'growl', 'scream', 'bored', 'irked']) {
    assert(html.includes(`${k}:'img/sprites/shoe-${k}.jpg'`), `SHOESMITH_ANIM must wire the ${k} frame file`);
    assert(existsSync(join(ROOT, `img/sprites/shoe-${k}.jpg`)), `img/sprites/shoe-${k}.jpg missing on disk`);
  }
  const i = html.indexOf('function txAnimTick(');
  assert(i !== -1, 'txAnimTick scheduler missing');
  const body = html.slice(i, html.indexOf('\nfunction txRender(', i));
  assert(/img\.setAttribute\('src',src\)/.test(html.slice(html.indexOf('function _txSetFrame'), html.indexOf('function _txSetFrame') + 300)),
    'frame swaps must touch img.src only (innerHTML would reset the CSS animations)');
  // Generalizado por persona (jul 2026): lee p.anim.xxx desde la persona activa,
  // con guarda de existencia (La Crítica no trae parpadeo). El guard fija que
  // CADA fotograma sigue existiendo por su clave y que Shoesmith los tiene todos.
  assert(/st\.lives<=1 && p\.anim\.scream/.test(body), 'at 1 life he must scream alternating A/B');
  assert(/st\.lives===2 && p\.anim\.growl/.test(body), 'at 2 lives he must chew his rage in a loop');
  assert(/p\.anim\.bored/.test(body) && /p\.anim\.irked/.test(body),
    'at 4/3 lives he must run the slow idle micro-loop (same-camera video frames)');
  assert(/p\.blinkTier && st\.lives===p\.blinkTier && p\.anim\.blink/.test(body), 'at calm he must blink occasionally (only if his persona has a blink frame)');
  assert(/txAnimTick\(\);/.test(html.slice(html.indexOf('function txTick('), html.indexOf('function txAnswer('))),
    'txTick must drive the frame scheduler');
  assert(/\w+\.anim\.wink/.test(html.slice(html.indexOf('function txAnswer('), html.indexOf('function txAnswer(') + 4200)),
    'a correct answer must show the active persona\'s wink frame when available');
  assert(/txAnimOnce\(\['talk'/.test(html.slice(html.indexOf('function txNext('), html.indexOf('function txTick('))),
    'a new question must trigger the talking sequence');
  // Ambas personas siguen aportando su set completo por la clave (registro).
  for (const anim of ['SHOESMITH_ANIM', 'CRITIC_ANIM']) {
    const re = new RegExp('const ' + anim + '=\\{');
    assert(re.test(html), `${anim} frame set missing`);
  }
  for (const k of ['talk', 'bored', 'irked', 'growl', 'scream']) {
    assert(html.includes(`${k}:'img/sprites/critic-${k}.jpg'`), `CRITIC_ANIM must wire the ${k} frame file`);
    assert(existsSync(join(ROOT, `img/sprites/critic-${k}.jpg`)), `img/sprites/critic-${k}.jpg missing on disk`);
  }
});

test('Guía de emplatado: mapa de fotos íntegro, sección cableada, overlay y CSS', () => {
  // El personal leía el PDF del plating guide; esta sección lo sustituye con
  // las fotos reales del propietario. Guard: integridad del mapa + cableado.
  const map = JSON.parse(read('data/dish-photos.json'));
  const keys = Object.keys(map);
  assert(keys.length >= 50, `expected ≥50 dish photos, found ${keys.length}`);
  // Regresión (jul 2026, reporte del propietario): el emparejador difuso por
  // nombre de página coló dos fotos de OTROS platos por coincidencia parcial
  // de palabras ("Tarta de limón"→"Tarta de queso" id 105, "Salsa Bearnesa"→
  // "Salsa de hongos" id 38). Ninguno de los dos tiene foto real en los PDF
  // originales — deben quedar sin foto, no con una equivocada.
  assert(!('38' in map), 'dish 38 (Salsa de hongos) must stay photo-less — its only PDF match was a mislabeled Salsa Bearnesa photo');
  assert(!('105' in map), 'dish 105 (Tarta de queso) must stay photo-less — its only PDF match was a mislabeled Tarta de limón photo');
  // cada ruta del mapa debe existir físicamente en el repo
  for (const [id, p] of Object.entries(map)) {
    assert(/^img\/platos\/[a-z0-9-]+\.webp$/.test(p), `photo path malformed for dish ${id}: ${p}`);
    assert(existsSync(join(ROOT, p)), `mapped photo file missing on disk: ${p}`);
  }
  // cada clave debe ser un plato real de DISHES
  const ids = new Set([...html.matchAll(/\{id:(\d+),cat:'/g)].map(m => m[1]));
  for (const id of keys) assert(ids.has(id), `dish-photos.json maps unknown dish id ${id}`);
  // sección cableada como subtab de Aprender + overlay + búsqueda
  assert(/\['emplatado',_en\?'Plating':'Emplatado'/.test(html), 'Emplatado subtab missing from Aprender hub');
  assert(/emplatado:renderEmplatado/.test(html), 'renderEmplatado not wired into the Aprender dispatch');
  // CADA subtab de Aprender debe existir en el enrutador global: _subTabBar
  // conmuta con showTab('<subkey>'), así que renderMap y parentMap deben
  // conocer todas las claves (bug real en producción: "renderMap[tab] is not
  // a function" al tocar Emplatado).
  // La barra vive en _aprChipsBar (extraída de renderAprender para poder
  // re-inyectarla tras los re-renders internos — «se desaparecieron las
  // subcategorías»).
  const hubSrc = html.slice(html.indexOf('function _aprChipsBar('), html.indexOf('function _aprEnsureChips('));
  const subkeys = [...hubSrc.matchAll(/\['([a-z]+)',/g)].map(m => m[1]);
  assert(subkeys.length >= 5, `expected ≥5 Aprender subtabs, found ${subkeys.length}`);
  const renderMapSrc = html.slice(html.indexOf('const renderMap = {'), html.indexOf('const renderMap = {') + 600);
  const parentMapSrc = html.slice(html.indexOf('const parentMap = {'), html.indexOf('const parentMap = {') + 300);
  for (const k of subkeys) {
    assert(renderMapSrc.includes(k + ':'), `Aprender subtab '${k}' missing from showTab renderMap — tapping it crashes`);
    if (k !== 'smart') assert(parentMapSrc.includes(k + ':'), `Aprender subtab '${k}' missing from showTab parentMap — nav highlight breaks`);
  }
  assert(/function renderEmplatado\(/.test(html) && /function _emplOpen\(/.test(html), 'guide renderer/overlay functions missing');
  assert(/loadLazyData\('data\/dish-photos\.json'/.test(html), 'photo map must lazy-load like other data files');
  assert(/loading="lazy"/.test(html), 'grid images must lazy-load');
  assert(/_shiftDishes\(DISHES\)/.test(html.slice(html.indexOf('function _emplRender'), html.indexOf('function _emplRender') + 800)),
    'the guide must respect the active shift filter');
  // y el selector de turno debe REFRESCARLA al instante (bug real: emplatado
  // faltaba en la lista blanca de _setStudyShift y el cambio no se veía)
  assert(/const _shiftTabs = \{[^}]*emplatado:1/.test(html),
    "_setStudyShift's instant-refresh whitelist must include 'emplatado'");
  // el aviso de platos sin foto es SOLO para el propietario (dispositivo que
  // ha desbloqueado el panel de supervisor con PIN)
  assert(/missing\.length && _isSupDevice\(\)/.test(html),
    'the missing-photos notice must be gated behind _isSupDevice()');
  assert(/function _isSupDevice\(/.test(html) && /txk_sup_device/.test(html),
    '_isSupDevice must exist and persist via the supervisor-PIN device mark');
  const css = read('styles.css');
  for (const sel of ['.empl-grid{', '.empl-card{', '.empl-ov-card{', '.empl-chip{']) {
    assert(css.includes(sel), `styles.css must style ${sel}`);
  }
});

test('Flashcards cómodas: volteo reversible y altura fija (nada empuja el layout)', () => {
  // Quejas del propietario (jul 2026): al entrar a ingredientes no se podía
  // volver, y la cara trasera crecía empujando los botones fuera de pantalla.
  // (1) volteo reversible: tocar la tarjeta volteada vuelve a la delantera
  const fc = html.slice(html.indexOf('let _fcAnimating'), html.indexOf('let _fcAnimating') + 1600);
  assert(/function unflipCard\(\)/.test(fc), 'unflipCard must exist');
  assert(/if\(fcFlipped\)\{ unflipCard\(\); return; \}/.test(fc),
    'tapping a flipped card must flip it back (it used to be a dead tap)');
  assert(/toca la tarjeta para volver/.test(html), 'the back face must hint that tapping goes back');
  // (2) altura FIJA con scroll interno: el volteo no mueve el layout
  const css = read('styles.css');
  assert(/\.fc-scene\{[^}]*height:clamp\(280px,44vh,400px\)/.test(css),
    'the card scene must have a FIXED height (front and back identical — no layout jump)');
  assert(/\.fc-face\{[^}]*overflow:hidden/.test(css.slice(css.indexOf('.fc-face{'), css.indexOf('.fc-face{') + 600)),
    'the face clips; scrolling lives in the back content wrapper');
  assert(/id="fcBackScroll"[^>]*overflow-y:auto/.test(html),
    'long ingredients must scroll INSIDE the card, not grow the page');
});

test('Fotos en toda la app: helper precargado + Explorar + ficha + flashcard + ambas búsquedas', () => {
  // Petición del propietario (jul 2026): fotos en todas las superficies de
  // CONSULTA. Nunca en exámenes/juegos donde el nombre del plato sea la
  // respuesta (chivarían la solución).
  assert(/function dishPhotoSrc\(id\)/.test(html), 'dishPhotoSrc helper missing');
  assert(/loadDishPhotos\(\);/.test(html.slice(html.indexOf('function closePinAndEnter('), html.indexOf('function closePinAndEnter(') + 900)),
    'the photo map must preload on login so sync renders can use it');
  // Explorar: la foto vive dentro del hexágono de la fila
  const topic = html.slice(html.indexOf('function renderRepasoTopic('), html.indexOf('function renderRepasoDishDetail('));
  assert(/repaso-row-icon">\$\{_ph\?`<img loading="lazy"/.test(topic), 'Explorar rows must show the dish photo in the hex icon');
  // Ficha: foto-plato circular con respaldo al plato SVG decorativo
  const det = html.slice(html.indexOf('function renderRepasoDishDetail('), html.indexOf('function renderRepasoDishDetail(') + 9000);
  assert(/dish-hero-photo/.test(det) && /`:`[\s\S]{0,40}<svg width="\$\{plateSize\}"/.test(det),
    'dish detail must show the real photo with the SVG plate as fallback');
  // Flashcard: foto circular sobre el nombre
  assert(/class="fc-photo"/.test(html), 'flashcard front must show the dish photo when available');
  // Búsqueda global + búsqueda de Aprender: miniaturas
  assert(/gs-hit-ph/.test(html), 'global search dish hits must show photo thumbnails');
  assert(/_aprenderOpenDish\(\$\{d\.id\}\)/.test(html) && /dishPhotoSrc\(d\.id\)\)\?`<img loading="lazy"[^`]*width:36px/.test(html),
    'Aprender quick-search results must show photo thumbnails');
  const css = read('styles.css');
  for (const sel of ['.repaso-row-icon img{', '.dish-hero-photo{', '.fc-photo{', '.gs-hit-ph{']) {
    assert(css.includes(sel), `styles.css must style ${sel}`);
  }
});

test('Fotos del equipo: subida con moderación (guía completa, ficha "foto mejor", cola del supervisor)', () => {
  // Jul 2026: cualquier camarero sube la foto desde el pase; el supervisor
  // aprueba desde su panel; la aprobada pisa a la del repo al instante.
  // (1) subida: picker + compresión + storage + insert pending
  assert(/function _dishPhotoPick\(/.test(html) && /function _dishPhotoUpload\(/.test(html), 'upload helpers missing');
  assert(/_chatDownscale\(file,1100/.test(html), 'uploads must compress client-side (reuses the chat downscaler)');
  assert(/storage\/v1\/object\/dish-photos\//.test(html), 'uploads must go to the dish-photos bucket');
  assert(/rest\/v1\/dish_photo_submissions/.test(html), 'submissions must be recorded in dish_photo_submissions');
  // (2) merge en runtime: aprobadas pisan al repo; pendientes marcadas
  const lp = html.slice(html.indexOf('async function loadDishPhotos('), html.indexOf('async function loadDishPhotos(') + 1600);
  assert(/status=in\.\(pending,approved\)/.test(lp) && /DISH_PHOTO_PENDING/.test(lp),
    'loadDishPhotos must merge approved submissions and track pending ones');
  // (3) guía: TODOS los platos — placeholder con botón de subir o "en revisión"
  assert(/empl-card-nophoto/.test(html) && /empl-upload-btn/.test(html) && /empl-pend/.test(html),
    'the guide must show placeholder cards with upload button / in-review state');
  // (4) ficha ampliada: "¿tienes una foto mejor?"
  assert(/empl-ov-upload/.test(html), 'the dish overlay must offer submitting a better photo');
  // (4b) LA INFORMACIÓN CONSTRUIDA MANDA (propietario, jul 2026): la ficha
  // ampliada muestra la matriz validada de adaptaciones con comanda exacta
  // (DISH_ACTIONS), las notas de servicio y el salto a la ficha completa —
  // la foto puede quedar vieja; la ficha es la fuente de verdad.
  const ov = html.slice(html.indexOf('function _emplOpen('), html.indexOf('function _emplOpen(') + 5000);
  assert(/DISH_ACTIONS\[d\.id\]/.test(ov) && /empl-ov-adapt/.test(ov),
    'the overlay must render the validated adaptation matrix, not just allergen chips');
  assert(/act\.r===1/.test(ov) && /Se adapta/.test(ov) && /Estructural/.test(ov),
    'each allergen must show its verdict (adaptable + comanda / structural)');
  assert(/empl-ov-note/.test(ov), 'service notes must surface in the overlay when present');
  assert(/empl-ov-ficha/.test(ov) && /repasoView='dish'/.test(ov),
    'the overlay must link to the full dish sheet (the built knowledge)');
  // (5) panel supervisor: cola de moderación cableada
  assert(/fotos: \(\)=>renderSupPhotoQueue\(\)/.test(html) && /_supTool\('fotos'\)/.test(html),
    'the supervisor panel must expose the photo moderation queue');
  assert(/function renderSupPhotoQueue\(/.test(html) && /function _supPhotoModerate\(/.test(html), 'moderation functions missing');
  assert(/status=eq\.pending/.test(html) && /reviewed_at/.test(html), 'moderation must PATCH status + reviewed_at');
  const css = read('styles.css');
  for (const sel of ['.empl-card-nophoto{', '.empl-upload-btn{', '.sup-photo-card{', '.sup-photo-actions button.rej{']) {
    assert(css.includes(sel), `styles.css must style ${sel}`);
  }
});

test('Ficha ampliada: la información vital no se pierde ni se tergiversa (jul 2026)', () => {
  // «Que no se pierda información vital» (propietario, jul 2026). Tres cierres:
  const i = html.indexOf('function _emplOpen(');
  const ov = html.slice(i, i + 5000);
  // (1) La matriz se consulta con los alérgenos CANÓNICOS (d.allergens, ES).
  //     dd.allergens llega TRADUCIDO en modo inglés («Dairy» vs clave «Lácteos»):
  //     el lookup fallaba siempre y 61 alérgenos adaptables se mostraban como
  //     «Structural — not suitable» — dato de seguridad FALSO. Nunca más.
  assert(/d\.allergens&&d\.allergens\.length/.test(ov) && /d\.allergens\.map/.test(ov),
    'overlay must key DISH_ACTIONS with canonical d.allergens (ES)');
  assert(!/dd\.allergens\.map/.test(ov),
    'localized dd.allergens must NEVER key the matrix (EN-mode false "not suitable" verdicts)');
  // (2) Sin dato en la matriz NO se inventa veredicto: «estructural» exige
  //     r===0 explícito; el hueco se manda a cocina, no se afirma.
  assert(/act&&act\.r===0/.test(ov), 'structural verdict requires explicit r===0');
  assert(/empl-ov-adapt unk/.test(ov) && /Consultar con cocina/.test(ov) && /Check with the kitchen/.test(ov),
    'missing matrix data must render "consultar con cocina", never an invented verdict');
  // (3) La ficha abre AUNQUE el plato no tenga foto — la información construida
  //     no depende de la foto (y las tarjetas sin foto también la abren).
  assert(!/if\(!d\|\|!DISH_PHOTOS\) return/.test(ov), 'overlay must not require a photo to open');
  assert(/empl-ov-nophoto/.test(ov), 'photo-less dishes get a placeholder hero with the info intact');
  const grid = html.slice(html.indexOf('function _emplRender('), i);
  const noph = grid.slice(grid.indexOf('empl-card-nophoto'));
  assert(/onclick="_emplOpen\(\$\{d\.id\}\)"/.test(noph) && /role="button"/.test(noph),
    'no-photo cards must open the expanded sheet too');
  assert(/event\.stopPropagation\(\);_dishPhotoPick/.test(noph),
    'the upload button inside the card must not also trigger the overlay');
  const css = read('styles.css');
  assert(css.includes('.empl-ov-adapt.unk') && css.includes('.empl-ov-nophoto{'),
    'styles.css must style the unknown verdict + the photo-less hero');
});

test('Aprender: la barra de subcategorías sobrevive a la navegación interna (jul 2026)', () => {
  // «Se desaparecieron las subcategorías» (propietario, captura): los renderers
  // internos de Explorar/Flashcards/Repaso Inteligente reescriben appContent
  // ENTERO al navegar dentro de su subpestaña y borraban la barra de chips.
  // Dos capas: _aprEnsureChips (re-inyección idempotente) + navegación interna
  // enrutada por el host (renderAprender).
  assert(/function _aprChipsBar\(/.test(html) && /function _aprEnsureChips\(/.test(html),
    'chips bar builder + idempotent re-injector must exist');
  const ens = html.slice(html.indexOf('function _aprEnsureChips('), html.indexOf('function _aprEnsureChips(') + 600);
  assert(/querySelector\('\.subtab-chips'\)/.test(ens), '_aprEnsureChips must be idempotent (skip if bar present)');
  // renderRepaso re-asegura la barra tras CUALQUIER re-render interno de Explorar
  const rr = html.slice(html.indexOf('function renderRepaso('), html.indexOf('function renderRepaso(') + 700);
  assert(/_aprEnsureChips\(\)/.test(rr), 'renderRepaso must re-ensure the chips bar');
  // openRepasoCat entra por renderRepaso (no salta directo a renderRepasoTopic)
  assert(/function openRepasoCat\(cat\)\{repasoCat=cat;repasoView='topic';renderRepaso\(\);\}/.test(html),
    'openRepasoCat must route through renderRepaso');
  // Flashcards y Repaso Inteligente re-renderizan por el host
  assert(/function changeFcCat\(cat\)\{initFlashcards\(fcTopic,cat\);renderAprender\(\);\}/.test(html)
      && /function changeFcTopic\(t\)\{fcTopic=t;initFlashcards\(t\);renderAprender\(\);\}/.test(html),
    'flashcard cat/topic switches must re-render via renderAprender');
  assert(!/onclick="initFlashcards\(fcTopic,'all'\);renderFlashcards\(\)"/.test(html),
    'the new-deck button must not call renderFlashcards() directly');
  assert(!/onclick="renderSmartReview\(\)"/.test(html),
    'the reshuffle button must not call renderSmartReview() directly');
});

test('Dashboard: tarjeta de acceso directo a la Guía de Emplatado (1 toque desde el inicio)', () => {
  // La guía es consulta, no formación: debe estar a 1 toque de abrir la app.
  // Tarjeta premium con abanico de fotos reales, cableada por la ruta enrutada.
  assert(/class="dash-plating"/.test(html), 'dashboard must render the plating quick-access card');
  assert(/dash-plating"[^>]*onclick="_subTab\.aprender='emplatado';showTab\('emplatado'\)"/.test(html.replace(/\s+/g,' ')),
    'the card must navigate via the ROUTED path (_subTab + showTab emplatado)');
  // las 3 fotos del abanico deben existir físicamente
  const strip = [...html.matchAll(/dash-plating-strip[\s\S]{0,400}?<\/div>/g)][0][0];
  const photos = [...strip.matchAll(/src="(img\/platos\/[^"]+)"/g)].map(m => m[1]);
  assert(photos.length === 3, `the fan must show 3 photos, found ${photos.length}`);
  for (const p of photos) assert(existsSync(join(ROOT, p)), `fan photo missing on disk: ${p}`);
  const css = read('styles.css');
  for (const sel of ['.dash-plating{', '.dash-plating-strip img{', '.dash-plating-shine{']) {
    assert(css.includes(sel), `styles.css must style ${sel}`);
  }
  assert(/"Guía de emplatado"/.test(read('manifest.json')), 'the icon shortcut must be renamed to match its landing');
});

test('Acceso en 1 toque: sesión deslizante 90d, banner de instalación, hoja iOS, atajos del manifest', () => {
  // Fricción reportada por el propietario (jul 2026): el personal leía el PDF
  // porque abrir la app costaba. Este guard fija el paquete anti-fricción.
  // (1) sesión deslizante: 90 días y renovación del sello en cada apertura
  const al = html.slice(html.indexOf('(function autoLogin('), html.indexOf('(function autoLogin(') + 1400);
  assert(/90\*24\*60\*60\*1000/.test(al), 'session must be valid for 90 days (was 30 — monthly re-login killed the habit)');
  assert(/txoko_session', JSON\.stringify\(\{user, hash, ts: Date\.now\(\)\}\)/.test(al),
    'auto-login must RENEW the session timestamp on each open (sliding session)');
  // (2) banner de instalación en el dashboard, con snooze y detección standalone
  assert(/function renderInstallBanner\(/.test(html) && /\$\{renderInstallBanner\(\)\}/.test(html),
    'the dashboard must render the install banner');
  assert(/function _isStandalone\(/.test(html) && /display-mode: standalone/.test(html),
    'the banner must hide when already installed (standalone detection)');
  assert(/txk_install_snooze/.test(html) && /14\*24\*60\*60\*1000/.test(html),
    'dismissing the banner must snooze it for 14 days (not forever, not never)');
  // (3) hoja visual de pasos (iOS no tiene prompt nativo; el alert() era hostil)
  assert(/function showInstallSheet\(/.test(html) && /Añadir a pantalla de inicio/.test(html),
    'the iOS/generic install sheet with visual steps must exist');
  assert(!/alert\(LANG==='en'\s*\?\s*'On iPhone/.test(html), 'the old hostile alert() fallback must be gone');
  // (4) atajos del icono (long-press) via #tab= (el boot ya los procesa)
  const mf = read('manifest.json');
  assert(/"shortcuts"\s*:/.test(mf) && /#tab=aprender/.test(mf) && /#tab=txoko/.test(mf),
    'manifest.json must define home-screen shortcuts deep-linking via #tab=');
  // CSS del banner y la hoja
  const css = read('styles.css');
  for (const sel of ['.install-banner{', '.install-sheet{', '.install-step{']) {
    assert(css.includes(sel), `styles.css must style ${sel}`);
  }
});

test('Camarero Survivors UX: invisible joystick base + plain-language upgrade descriptions', () => {
  // Petición del propietario: no mostrar el círculo oscuro del joystick al
  // mover, y una breve explicación de lo que hace cada habilidad al escoger.
  const css = read('styles.css');
  const joy = css.slice(css.indexOf('#etJoy{'), css.indexOf('#etJoy{') + 220);
  assert(/border:none/.test(joy) && /background:none/.test(joy) && /box-shadow:none/.test(joy),
    'the joystick base (#etJoy) must be invisible — no dark disc over the player');
  const i = html.indexOf('const UPGRADES=[');
  const ups = html.slice(i, i + 1400);
  // upgrade blurbs must be full sentences, not terse tokens like "+1 bandeja"
  assert(/Lanzas una bandeja más a la vez/.test(ups), 'upgrade descriptions must explain what the ability does in plain language');
  assert(/Cuchillos que orbitan y cortan al tocar/.test(ups) && /Te mueves \+14% más rápido/.test(ups),
    'each upgrade must carry its plain-language explanation');
});

test('EL TURNO markup/CSS is fully scoped under an et- prefix — no collision with app-wide selectors', () => {
  const i = html.indexOf('function launchElTurno(');
  assert(i !== -1, 'launchElTurno not found');
  const end = html.indexOf('\n// ── Game flow', i);
  const body = html.slice(i, end > i ? end : i + 40000);
  // every id/class the overlay creates must carry the et prefix
  const bareIds = body.match(/id="(?!et[A-Z])[a-zA-Z][^"]*"/g) || [];
  assert(bareIds.length === 0, `unprefixed id(s) inside launchElTurno risk colliding with existing app ids: ${bareIds.slice(0,5).join(', ')}`);
  assert(body.includes("overlay.id = 'etOverlay'"), 'overlay root id missing');
  assert(body.includes("class=\"et-screen\""), 'et-screen class missing — game screens are not scoped');
  // the CSS file must define #etOverlay scoped at high z-index, not a bare .screen/.card that would hit app-wide rules
  const css = read('styles.css');
  assert(css.includes('#etOverlay{'), 'styles.css has no #etOverlay rule');
  assert(!/^\.screen\{[^}]*100000/m.test(css), 'the game overlay z-index leaked onto the generic .screen rule');
});

// ─── 6z. Correctness audit guards (owner-reported, Jul 2026) ────
// Five owner reports in one week, all the same two defect classes:
// multiple-correct options and false claims from regex heuristics.
// These guards EXECUTE the real generators on the real carta.
console.log('\nQuestion correctness (owner bugs 1-6, Jul 2026)');

function _xFn(name) {
  const i = html.indexOf('function ' + name + '(');
  assert(i !== -1, `function ${name} not found`);
  let k = html.indexOf('{', i), depth = 0;
  for (;;) {
    const ch = html[k];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (!depth) return html.slice(i, k + 1); }
    k++;
  }
}
function _xConst(name, closer) {
  const i = html.indexOf('const ' + name + ' =');
  assert(i !== -1, `const ${name} not found`);
  const j = html.indexOf(closer, i);
  return html.slice(i, j + closer.length);
}
let SIM = null;
test('real generators extract and run (harness sanity)', () => {
  const src = [
    "let LANG='es'; const t=()=>''; let WINES=null;",
    _xConst('DISHES_EN', '\n];'),
    _xFn('getDish'),
    _xConst('DISHES', '\n];'),
    _xFn('_djShuffle'),
    _xFn('_simPick'),
    _xFn('_simExtractIngredients'),
    _xFn('_simNonRemovableAllergens'),
    _xFn('_scenarioModification'),
    _xFn('_scenarioVegetarian'),
    'return {DISHES, DISHES_EN, getDish, _simExtractIngredients, _simNonRemovableAllergens, _scenarioModification, _scenarioVegetarian};'
  ].join('\n');
  SIM = new Function(src)(); // eslint-disable-line no-new-func
  assert(SIM.DISHES.length > 50, 'DISHES extraction failed');
});

test('bug 1: no Modification option may be a valid comanda of the dish (Tartar de solomillo)', () => {
  // Owner screenshot: "¿Cómo se comanda?" offered BOTH "SIN MOSTAZA SAVORA"
  // (correct) and "SIN EL PAN" — but the card also says "Comandar SIN PAN
  // CARASAU", so two options were right. The collision sets are now seeded
  // with EVERY real pair and word-overlapping fakes are excluded.
  const tartar = SIM.DISHES.find(d => d.id === 16);
  assert(tartar, 'Tartar de solomillo (id 16) missing');
  for (let i = 0; i < 300; i++) {
    const q = SIM._scenarioModification(tartar, tartar, false);
    assert(q && q.correctIdx >= 0 && new Set(q.options).size === 4, 'malformed modification question');
    q.options.forEach((opt, oi) => {
      if (oi === q.correctIdx) return;
      assert(!/\bPAN\b|CARASAU|MOSTAZA|SAVORA/i.test(opt),
        `distractor overlaps a real comanda of the dish: "${opt}" (correct: "${q.options[q.correctIdx]}")`);
    });
  }
});

test('bug 2: vegetarian variant claim requires REAL variant data', () => {
  // Owner: "Ravioli solo hay de pularda y de espinaca, no hay de boletus."
  // The old heuristic matched the word "boletus" inside the FILLING and told
  // vegetarians that a Boletus ravioli exists. The variant verdict now needs
  // a `variants` array with a verifiably vegetarian flavour.
  const ravioli = SIM.DISHES.find(d => d.id === 23);
  const qv = SIM._scenarioVegetarian(ravioli, ravioli, false);
  assert(qv, 'vegetarian scenario must fire for Ravioli de pularda');
  assert(/^No — lleva productos animales/.test(qv.options[qv.correctIdx]),
    `Ravioli de pularda must be a plain NO, got: "${qv.options[qv.correctIdx]}"`);
  assert(!/Boletus/i.test(qv.explain), 'explain must not invent a Boletus ravioli');
  const croq = SIM.DISHES.find(d => d.id === 1);
  const qc = SIM._scenarioVegetarian(croq, croq, false);
  assert(qc && /variantes|sabores/.test(qc.options[qc.correctIdx]),
    'Croquetas Premium must keep the variant verdict (it HAS a Boletus variant)');
  assert(/Boletus/.test(qc.explain), 'Croquetas explain must name Boletus from the variant DATA');
});

test('bug 3: no oil may ever be an ingredient question subject', () => {
  // Owner: "La mayoría de platos están hechos con aceite de Oliva, no usamos
  // otro aceite" — oil compounds (Aceite de oliva / olive oil / Aceite Dauro)
  // slipped past the bare-word pantry filter and produced unanswerable
  // questions ("¿cuál llevaba aceite de oliva?").
  for (const d of [...SIM.DISHES, ...SIM.DISHES_EN]) {
    for (const ing of SIM._simExtractIngredients(d)) {
      assert(!/^aceite\b/i.test(ing) && !/\boil\b/i.test(ing),
        `oil leaked as a question target: "${ing}" (${d.name})`);
    }
  }
});

test('bug 4: substitution vocabulary counts as retirability (ostras, tartar, drill)', () => {
  // Owner: "El gluten se puede evitar. Se prepararía la selección de ostras
  // sin la frita con panko." The card says "se puede sustituir" — posRe now
  // recognizes preparation/substitution phrasings.
  const ostras = SIM.DISHES.find(d => d.id === 10);
  const nrO = SIM._simNonRemovableAllergens(ostras);
  for (const a of ['Gluten', 'Huevos', 'Soja']) {
    assert(!nrO.includes(a), `Selección de ostras: ${a} must be REMOVABLE (se puede sustituir / SIN PANKO)`);
  }
  const tartar = SIM.DISHES.find(d => d.id === 16);
  assert(!SIM._simNonRemovableAllergens(tartar).includes('Apio'),
    'Tartar de solomillo: Apio must be removable (puede prepararse sin mostaza savora)');
  assert(/sustituir\|cambiar\|evitar/.test(html), 'posRe substitution vocabulary missing');
  // The allergen drill must use the same clause-scoped parser — its old
  // segment heuristic said "blocked" while the adapt option quoted the real
  // comanda (two defensible answers on screen).
  const drill = html.slice(html.indexOf('function buildAllergenQuestions'), html.indexOf('function startAllergenTest'));
  assert(/_simNonRemovableAllergens\(dish\)/.test(drill), 'drill must classify retirability via _simNonRemovableAllergens');
  assert(/_fakeBank = _comandaBank\.filter/.test(drill), "drill fake comanda must exclude the dish's own comandas");
  assert(/_ownComandas/.test(drill), 'drill adapt verdict must quote a real comanda of THIS dish');
});

test('bug 5+6: recommendations exclude side-named twins; avoid/adapt pools are twin-safe and removability-aware', () => {
  // Owner: "No está bien recomendar una guarnición como sustituto de un
  // entrante o principal" — lunch/dinner copies of Guarniciones items pass
  // the category filter, so recommendation pools filter by display name too.
  // And a dish the guest "should avoid" must carry the allergen NON-removably
  // (SharedAllergen once said Selección de ostras' gluten "no se puede
  // retirar" — false premise) for EVERY dish sharing the display name (both
  // tatakis are "Tuna tataki" in EN with different cards).
  assert(/function _simIsSideNamed\(/.test(html), '_simIsSideNamed helper missing');
  assert(/function _simDisplayTwins\(/.test(html) && /function _simTwinsAll\(/.test(html), 'display-twin helpers missing');
  const sa = html.slice(html.indexOf('function _scenarioSafeAlternative'), html.indexOf('function _srShuffleOpts'));
  assert(/_simOfferable\(d\)/.test(sa), 'SafeAlternative must offer only offerable dishes (no sides, no kids menu, no Vegetariano)');
  assert(/_simTwinsAll\(d, t=>t\.allergens && t\.allergens\.includes\(allergen\) && _simNonRemovableAllergens\(t\)\.includes\(allergen\)\)/.test(sa),
    'SafeAlternative wrongs must be non-removable carriers for every twin');
  const sh = html.slice(html.indexOf('function _scenarioSharedAllergen'), html.indexOf('function _scenarioWinePairing'));
  assert(/_simNonRemovableAllergens\(t\)\.includes\(a\)/.test(sh) && /_simTwinsAll/.test(sh),
    'SharedAllergen correct pool must be twin-safe non-removable carriers');
  const wa = html.slice(html.indexOf('function _scenarioWhichAdaptable'), html.indexOf('function _srWaitMins'));
  assert(/(_simOfferable\(d\)|!_simIsSideNamed\(d\))/.test(wa) && /_simTwinsAll/.test(wa),
    'WhichAdaptable must exclude side-named dishes and be twin-safe');
  const iw = html.slice(html.indexOf('function _scenarioIngredientWhere'), html.indexOf('function _srGenerateQuiz'));
  assert(/_simTwinsAll\(target/.test(iw) && /_simTwinsAll\(s/.test(iw), 'IngredientWhere must be twin-safe on target and clean pool');
});

test('exam reversed questions: identical passages / duplicate names cannot yield two corrects', () => {
  // Data audit: embutidos/jamón/cecina share one history verbatim; lunch and
  // dinner twins share ingredient lists; Ensalada verde exists twice. A
  // distractor with the same answer text or display name as the correct dish
  // made two options right in "which dish is this?" questions.
  // Ampliado jul 2026 (reporte del propietario, tomates con/sin ventresca): la
  // guarda de nombre pasó de igualdad exacta (_seenNames) a gemelo de nombre
  // (_acceptedNames + _txNameTwin) para excluir también variantes veg / turnos /
  // prefijos indistinguibles como opciones.
  const ex = html.slice(html.indexOf('function startExam'), html.indexOf('function renderExamQuestion'));
  assert(/_correctAns/.test(ex) && /_acceptedNames/.test(ex) && /_txNameTwin\(/.test(ex) && /_twNorm\(a\.replace/.test(ex),
    'startExam reversed twin/duplicate guard missing');
});

// ─── Navigation restructure (v7.196): clean categories/subcategories ──
console.log('\nNavigation IA (v7.196)');

test('vinos: Flash+Quiz merged into a single Práctica subtab with mode toggle', () => {
  // Owner approved merging the two practice chips — the Vinos bar overflowed
  // with 8 chips and Flash/Quiz are the same activity (practice).
  assert(!/\['wineFlash','Flash',''\]/.test(html) && !/\['wineQuiz','Quiz',''\]/.test(html),
    'old wineFlash/wineQuiz chips must be gone from the Vinos bar');
  assert(/\['practica',_en\?'Practice':'Práctica',''\]/.test(html),
    'the Práctica chip must exist (ES/EN)');
  assert(/function _renderWinePractica\(/.test(html) && /sub === 'practica'/.test(html),
    'renderVinos must dispatch practica to _renderWinePractica');
  // Legacy deep links ('wineFlash'/'wineQuiz') normalize instead of 404ing
  // into the carta fallback.
  assert(/sub==='wineFlash' \|\| sub==='wineQuiz'/.test(html) && /_vinoSubTab = 'practica'/.test(html),
    'legacy wineFlash/wineQuiz values must normalize to practica');
  // The toggle is part of the bar string so both renderers keep it on re-render.
  const wp = html.slice(html.indexOf('function _renderWinePractica'), html.indexOf('function _renderWineFlashcards'));
  assert(/wine-practice-toggle/.test(wp) && /_renderWineQuiz\(c, bar \+ seg\)/.test(wp) && /_renderWineFlashcards\(c, bar \+ seg\)/.test(wp),
    'practica must inject the mode toggle into the bar for both modes');
  // Sommelier quick-access entries route through the merged subtab.
  assert(/_vinoSubTab='practica';_vinoPractica='flash';renderVinos\(\)/.test(html)
      && /_vinoSubTab='practica';_vinoPractica='quiz';renderVinos\(\)/.test(html),
    'quick-access index must deep-link into practica modes');
  const css = read('styles.css');
  assert(/\.wine-practice-toggle\{/.test(css) && /\.wp-seg\.on\{/.test(css),
    'practice toggle styles missing');
});

test('nav tab renamed LQA → Auditoría (labels only, ids/routes intact)', () => {
  // "LQA" was internal jargon; the tab is named after what you do there.
  assert(/<\/svg> Auditoría<\/button>/.test(html), 'nav button label must be Auditoría');
  assert(!/<\/svg> LQA<\/button>/.test(html), 'nav button must not say LQA anymore');
  assert(/navProtocolo: LANG==='en'\?'Audit':'Auditoría',/.test(html),
    'applyLangToApp must localize the tab as Audit/Auditoría');
  // Internal wiring unchanged — localStorage compat and deep links.
  assert(/id="navProtocolo" onclick="showTab\('protocolo'\)"/.test(html),
    'button id and protocolo route must not change');
  assert(/'Practicar en Auditoría →'/.test(html),
    'global-search LQA card must point at the renamed tab');
  // LQA remains as the real standard name INSIDE the section.
  assert(/Leading Quality Assurance/.test(html), 'the LQA hub hero keeps the standard name');
});

test('allergen drill moved from Examen to Aprender → Repaso Inteligente', () => {
  // Training belongs in Aprender; Examen stays pure evaluation.
  const exam = html.slice(html.indexOf('function renderExamSetup'), html.indexOf('function _examToggleCustom'));
  assert(!/startAllergenTest/.test(exam), 'renderExamSetup must no longer offer the drill');
  const smart = html.slice(html.indexOf('function renderSmartReview'), html.indexOf('function _aprenderGlobalSearch'));
  assert(/class="ri-drill"/.test(smart) && /startAllergenTest\(null\)/.test(smart),
    'Repaso Inteligente must host the drill as a terminal mission');
  assert(/SIMULACRO DE ALÉRGENOS/.test(smart) && /ALLERGEN DRILL/.test(smart),
    'drill card must be bilingual');
  // Results screen returns to its new home, not to Examen.
  const res = html.slice(html.indexOf('function renderAllergenResults'), html.indexOf('function renderSupAnalytics'));
  assert(/_subTab\.aprender='smart';showTab\('aprender'\)/.test(res),
    'drill results must navigate back to Aprender (smart)');
  assert(!/renderExam\(\)/.test(res), 'drill results must not route back to Examen');
  const css = read('styles.css');
  assert(/\.ri-drill\{/.test(css) && /\.ri-drill-title\{/.test(css),
    'ri-drill terminal styles missing');
  assert(/@media \(prefers-reduced-motion:reduce\)\{\.ri-drill-icon\{animation:none\}\}/.test(css),
    'drill blink must freeze under reduced motion');
});

test('ranking hub aggregates game records (local-first + Supabase merge)', () => {
  // Owner: "toda la competición en un solo sitio" — the Ranking tab now
  // aggregates the Mr. Shoesmith and Camarero Survivors boards; the
  // in-context boards (Juegos hub, game start screen) stay where they are.
  assert(/function _renderRankingGames\(/.test(html), '_renderRankingGames missing');
  assert(/id="rankingGames"/.test(html), 'renderRanking must include the games host div');
  const fn = html.slice(html.indexOf('function _renderRankingGames'), html.indexOf('function renderRanking()'));
  assert(/supaFetchTxokoTop10/.test(fn) && /supaFetchEtTop/.test(fn),
    'both game leaderboards must be fetched');
  // Local paint must happen BEFORE the remote fetch resolves (instant UI).
  assert(fn.indexOf('paint(shoeLocal, etLocal)') < fn.indexOf('Promise.all'),
    'must paint local records before awaiting Supabase');
  assert(/if\(!document\.getElementById\('rankingGames'\)\) return;/.test(fn),
    'remote repaint must bail if the user navigated away');
  assert(/class="tx-top10"/.test(fn), 'boards must reuse the tx-top10 style');
});

test('onboarding guide matches the real Juegos hub (no Modo Error promise)', () => {
  // The guide promised "Modo Error" inside Juegos but the mode only lives in
  // the dashboard "Débiles" shortcut; the games page now lists what exists.
  assert(!/Modo Error/.test(html) && !/Error Mode/.test(html),
    'guide must not promise Modo Error anywhere');
  const games = html.slice(html.indexOf("title_es:'Juegos y Duelos'"), html.indexOf("title_es:'Juegos y Duelos'") + 900);
  assert(/Camarero Survivors/.test(games), 'games guide page must mention Camarero Survivors');
  // Dead leftovers of the removed Modo Error card must stay gone.
  const hub = html.slice(html.indexOf('function renderTxoko()'), html.indexOf('function renderTxTop10()'));
  assert(!/getFailedDishes|failedLabel/.test(hub), 'renderTxoko must not compute unused failed-dish counters');
  // The mode itself still exists from the dashboard shortcut.
  assert(/onclick="startPersonalErrorMode\(\)"/.test(html), 'dashboard Débiles shortcut must survive');
});

test('the simulation carries ONE name everywhere: Simulación', () => {
  // IA audit (A1): the same activity was "Simulación Contextual" in the
  // guide, "Repaso Inteligente" on the chip and "ENTRAR EN SIMULACIÓN" on
  // the CTA — three names, zero findability.
  assert(/\['smart',_en\?'Simulation':'Simulación',_srsCount>0\?'🟢'/.test(html),
    'Aprender chip must say Simulación/Simulation');
  assert(/title_es:'Simulación',title_en:'Simulation'/.test(html),
    'onboarding page must use the same name');
  assert(/Aprender → Simulación/.test(html) && /Learn → Simulation/.test(html),
    'onboarding must say WHERE the simulation lives');
  assert(/\$\{_en\?'SIMULATION':'SIMULACIÓN'\}/.test(html),
    'the Pip-Boy screen header must match the chip name');
  assert(!/'Smart Review' : 'Repaso Inteligente'/.test(html),
    'XP toasts must not use the old name');
});

test('dashboard «Hoy»: héroe pergamino de dos estados + stats + filas numeradas (rediseño jul 2026)', () => {
  // Exploración de diseño aprobada por el propietario: UNA tarjeta pergamino
  // dominante con dos estados (Reto del día pendiente ⇄ Plato del día al
  // terminarlo), tira de stats (racha · precisión · liga) y filas numeradas
  // compactas; el detalle sigue en el acordeón #hoyDetail (fila 03).
  const dash = html.slice(html.indexOf('function renderDashboard()'), html.indexOf('// ═══════ FLASHCARDS'));
  assert(/\$\{_en\?'Today':'Hoy'\}/.test(dash), 'the Hoy divider must exist');
  assert(/_pddHeroHTML\(emp,_en\)/.test(dash), 'el héroe de dos estados debe renderizarse en Hoy');
  // El héroe: estado A = reto pendiente (CTA Empezar), estado B = plato del día.
  const hero = html.slice(html.indexOf('function _pddHeroHTML('), html.indexOf('function _pddAsyncFill('));
  assert(/_dqIsDone\(emp\)/.test(hero) && /openDailyReto\(\)/.test(hero),
    'estado A del héroe: reto pendiente con CTA Empezar');
  assert(/_pddDishOfDay\(todayStr\(\)\)/.test(hero) && /_emplOpen\(\$\{d\.id\}\)/.test(hero),
    'estado B del héroe: plato del día con Ver ficha');
  assert(/RETO HECHO ✓/.test(hero), 'el estado B debe mostrar el sello RETO HECHO');
  // Plato del día determinista: mismo día ⇒ mismo plato para todo el equipo.
  const pdd = html.slice(html.indexOf('function _pddDishOfDay('), html.indexOf('function _pddTecFor('));
  assert(/_mulberry32\(/.test(pdd) && !/Math\.random\(/.test(pdd),
    '_pddDishOfDay debe ser determinista (semilla por fecha, sin Math.random)');
  // Chips honestos: SIN GLUTEN ✓ solo si el plato NO declara gluten.
  assert(/!al\.includes\('Gluten'\)/.test(hero), 'el chip SIN GLUTEN solo sale si no hay gluten declarado');
  // Tira de stats + filas numeradas + acordeón.
  assert(/class="hoy-stats"/.test(dash) && /id="hoyLigaPos"/.test(dash),
    'la tira de stats (racha · precisión · liga) debe existir');
  assert(/class="hoy-numrow"/.test(dash) && /_hoyToggle\(\)/.test(dash),
    'las filas numeradas deben existir y la 03 abre el acordeón');
  assert(/id="hoyDetail" style="display:none/.test(dash), 'detail must start collapsed');
  assert(/\$\{renderWeeklyChallenge\(\)\}\s*\$\{_m\.rows\}/.test(dash),
    'challenge and mission rows must live inside #hoyDetail');
  assert(!/'Needs practice':'Necesita práctica'/.test(dash),
    'the redundant weak-topic alert row must stay removed');
  // «Próximo rango» is passive context — it moved to «Tu progreso».
  const progIdx = dash.indexOf("'Your progress':'Tu progreso'");
  const rankIdx = dash.indexOf('_rankProg ? `');
  assert(progIdx !== -1 && rankIdx > progIdx, 'next-rank row must live under Tu progreso, not in Hoy');
  // renderDailyMissions exposes per-mission state for the rows/detail.
  assert(/return \{ rows, done: doneCount, total: missions\.length, list \};/.test(html),
    'renderDailyMissions must return the per-mission list');
  assert(/function _hoyToggle\(\)/.test(html), '_hoyToggle accordion missing');
  // Rellenos asíncronos: foto (dish-photos), maridaje (wines) y liga (nube).
  assert(/_pddAsyncFill\(\);/.test(dash), 'renderDashboard debe disparar _pddAsyncFill tras pintar');
  const fill = html.slice(html.indexOf('function _pddAsyncFill('), html.indexOf('// ═══ LIGA SEMANAL'));
  assert(/loadDishPhotos/.test(fill) && /_pddWineFor/.test(fill) && /_ligaPosCache/.test(fill),
    '_pddAsyncFill debe rellenar foto, maridaje y posición de liga (con caché)');
  const css = read('styles.css');
  assert(/\.pdd-hero\{/.test(css) && /\.hoy-stats\{/.test(css) && /\.hoy-numrow\{/.test(css),
    'estilos del héroe/stats/filas numeradas ausentes');
});

test('vinos: Sensorial+Mapa merged under Estudio — the bar holds 5 chips', () => {
  // IA audit (C2+A2): 7 chips overflowed on a phone and "Aprende" clashed
  // with the main "Aprender" tab. Estudio = Conceptos · Sensorial · Mapa.
  assert(!/\['sensorial',_en\?'Sensory':'Sensorial',''\]/.test(html) && !/\['mapa',_en\?'Map':'Mapa',''\]/.test(html),
    'sensorial/mapa chips must be gone from the Vinos bar');
  assert(/\['aprende',_en\?'Study':'Estudio',''\]/.test(html),
    'the Estudio chip must exist (no more Aprende/Aprender clash)');
  assert(/function _renderWineStudy\(/.test(html) && /sub === 'aprende'\)\{ _renderWineStudy\(c, bar\); \}/.test(html),
    'renderVinos must dispatch aprende to _renderWineStudy');
  assert(/sub==='sensorial' \|\| sub==='mapa'/.test(html) && /_vinoAprendeView = sub/.test(html),
    'legacy sensorial/mapa values must normalize into Estudio');
  const ws = html.slice(html.indexOf('function _renderWineStudy'), html.indexOf('function _renderWinePractica'));
  assert(/wine-practice-toggle wp3/.test(ws) && /_renderSensoryMap\(c, bar \+ seg\)/.test(ws)
      && /_renderWineMap\(c, bar \+ seg\)/.test(ws) && /_renderWineLearn\(c, bar \+ seg\)/.test(ws),
    'Estudio must delegate to the three views with the toggle in the bar');
  const css = read('styles.css');
  assert(/\.wine-practice-toggle\.wp3\{grid-template-columns:1fr 1fr 1fr\}/.test(css),
    'wp3 three-column toggle style missing');
});

test('EN mode: stats known-by-category bars are localized', () => {
  // Same class of bug as the Emplatado dividers (v7.198), other screen.
  const st = html.slice(html.indexOf('function renderStats()'), html.indexOf('function renderVideos()'));
  assert(/catLocal\(cat\):cat\}<\/span><div class="t-stat-track">/.test(st),
    'renderStats category bars must localize via catLocal');
});

test('EN mode: ranking chips and plating category dividers are localized', () => {
  // EN sweep (v7.198): the Ranking hub chip said "Estadísticas" and the
  // Emplatado guide grouped dishes under raw Spanish category keys.
  assert(/\['stats',LANG==='en'\?'Stats':'Estadísticas','◇'\]/.test(html),
    'ranking Stats chip must localize');
  const empl = html.slice(html.indexOf('function _emplRender'), html.indexOf('function _emplOpen'));
  assert(/catLocal\(cat\)/.test(empl),
    'plating dividers must localize the canonical category key via catLocal');
  // Canonical key must still drive the grouping/icons (only the label localizes).
  assert(/CAT_ICONS\[dd\.cat\]/.test(empl), 'CAT_ICONS must keep using the canonical key');
});

test('nav sheet: grouped into Consulta/Formación/Equipo (labels only)', () => {
  // UX audit: 8 flat root options read as 3 chunks — no added taps/depth.
  assert(/id="navGrpConsulta"/.test(html) && /id="navGrpFormacion"/.test(html) && /id="navGrpEquipo"/.test(html),
    'the three nav group labels must exist');
  const nav = html.slice(html.indexOf('id="appNav"'), html.indexOf('</nav>'));
  const order = ['navSearchEntry','navGrpConsulta','navDashboard','navGrpFormacion','navAprender','navExam','navProtocolo','navVinos','navGrpEquipo','navTxoko','navRanking','navChat'];
  let last = -1;
  for (const id of order) {
    const i = nav.indexOf('id="' + id + '"');
    assert(i > last, 'nav order broken at ' + id);
    last = i;
  }
  assert(/id="navChat" onclick="showTab\('chat'\)"/.test(nav), 'chat route/id must not change');
  assert(/navGrpFormacion: LANG==='en'\?'Training':'Formación'/.test(html), 'group labels must localize');
  const css = read('styles.css');
  assert(/\.nav-group-lbl\{/.test(css), 'nav group label style missing');
});

test('renames: Terraza / La Carta / Repasar fallos (labels only)', () => {
  // One place, one name: the tab matches the screen (La Terraza); the dish
  // browser mirrors Vinos ("Carta"); the error-mode shortcut says what it does.
  assert(/<\/svg> Terraza<\/button>/.test(html) && !/<\/svg> Chat<\/button>/.test(html),
    'nav tab must say Terraza');
  assert(/navChat: LANG==='en'\?'Terrace':'Terraza'/.test(html), 'applyLangToApp must localize Terraza');
  assert(/\['repaso',_en\?'The Menu':'La Carta',''\]/.test(html), 'Aprender chip must say La Carta');
  assert(/'Review misses':'Repasar fallos'/.test(html),
    'dashboard error-mode shortcut must say Repasar fallos');
  assert(/'Abrir Terraza'/.test(read('sw.js')), 'push action must match the tab name');
});

test('Logros live as a Ranking chip; Inicio keeps a one-row summary', () => {
  // The 42-gem gallery was buried at the bottom of the longest screen.
  assert(/\['logros',LANG==='en'\?'Achievements':'Logros','◆'\]/.test(html),
    'Logros chip missing from Ranking hub');
  assert(/logros:renderLogros/.test(html) && /function renderLogros\(/.test(html), 'renderLogros not wired');
  assert(/logros:renderRankingHub/.test(html), 'logros route missing from renderMap');
  assert(/stats:'ranking', logros:'ranking'/.test(html), 'logros parent mapping missing (nav highlight breaks)');
  const dash = html.slice(html.indexOf('function renderDashboard()'), html.indexOf('function checkActiveLiveSession'));
  assert(!/\$\{renderAchievementsSection\(\)\}/.test(dash), 'the full gallery must leave the dashboard');
  assert(/_subTab\.ranking='logros';showTab\('logros'\)/.test(dash),
    'dashboard summary row must deep-link to Ranking → Logros');
  assert(/function renderAchievementsSection\(/.test(html) && /function _toggleAchievements\(/.test(html),
    'gallery renderer and its toggle must survive (they render inside renderLogros now)');
});

test('wine map degrades gracefully without maplibre (offline)', () => {
  // P2: with the CDN unreachable the map died silently; now a note replaces
  // the frame and the D.O.s render as a static list grouped by region.
  const idx = html.indexOf('async function _initWineLeafletMap');
  const init = html.slice(idx, idx + 4500);
  assert(/typeof maplibregl === 'undefined'/.test(init), 'offline guard missing');
  assert(/wineDOList/.test(init) && /regionDots\.filter/.test(init),
    'offline fallback must render the region/D.O. list');
  assert(init.indexOf("typeof maplibregl === 'undefined'") < init.indexOf('_webglOk'),
    'offline guard must run before the WebGL check');
});

test('Hook F1: record cards, crowns, duel juice and the overtaken trigger', () => {
  // The social bridge Juegos → Ranking → Terraza: records stop dying on the
  // player's own screen. 1-tap opt-in sharing; auto-post ONLY when taking #1.
  assert(/function _refreshChampions\(/.test(html) && /function _txCrownFor\(/.test(html)
      && /function _txShareRecord\(/.test(html) && /function _txRecordMsg\(/.test(html)
      && /function _txThroneCheck\(/.test(html) && /function _hoyCheckOvertaken\(/.test(html),
    'social-loop helpers missing');
  assert(/_txShareRecord\(_txRecordMsg\('shoesmith',\$\{txokoState\.score\}\),this\)/.test(html),
    'Mr. Shoesmith record screen must offer the share button');
  assert(/id="etShareBtn"/.test(html) && /_txRecordMsg\('survivors',_secs,_ord\)/.test(html),
    'Camarero Survivors game over must offer the share button');
  assert(/_txRecordMsg\('duelo','\$\{dScore\}-\$\{cScore\}',remoteDuelState\.rivalName\)/.test(html),
    'duel victory must offer the share button');
  assert(/if\(isRecord\) _txThroneCheck\('txoko', txokoState\.score\);/.test(html)
      && /_txThroneCheck\('elturno', Math\.floor\(G\.time\)\)/.test(html),
    'taking the #1 must auto-post the crown card');
  // The Terrace dresses [récord] messages as cards and crowns the champions.
  assert(/chat-record-card/.test(html) && /\[récord\] /.test(html),
    'chat must style [récord] messages as cards');
  assert(/chat-author">\$\{_chatEsc\(m\.employee\)\}\$\{_txCrownFor\(m\.employee\)\}/.test(html),
    'chat authors must wear the champion crown');
  assert(/\$\{escapeHTML\(emp\.name\)\}\$\{_txCrownFor\(emp\.name\)\}/.test(html),
    'ranking XP rows must wear the champion crown');
  assert(/<div class="chat-title">La Terraza<\/div>/.test(html),
    'the chat screen title must match the tab (La Terraza)');
  // Duel victory juice: confetti + streak (loss resets, draw keeps it).
  assert(/if\(iWon && typeof launchConfetti==='function'\) launchConfetti/.test(html),
    'duel win must fire confetti');
  assert(/emp\.duelStreak=\(emp\.duelStreak\|\|0\)\+1/.test(html) && /else if\(cWins\)\{ emp\.duelStreak=0; \}/.test(html),
    'duel streak must grow on win and reset on loss');
  assert(/duel-victory-ico/.test(html) && /duel-streak/.test(html),
    'victory trophy/streak visuals missing');
  // Overtaken trigger on the dashboard.
  assert(/id="hoyOvertaken"/.test(html) && /_hoyCheckOvertaken\(\);/.test(html),
    'dashboard must host and fire the overtaken check');
  const css = read('styles.css');
  assert(/\.chat-record-card\{/.test(css) && /\.tx-crown\{/.test(css) && /\.tx-share-btn\{/.test(css)
      && /\.hoy-overtaken\{/.test(css) && /\.duel-victory-ico\{/.test(css),
    'hook-loop styles missing');
  // Anti-spam: record cards must NOT blast push notifications.
  const share = html.slice(html.indexOf('async function _txShareRecord'), html.indexOf('function _txThroneCheck'));
  assert(!/send-push/.test(share), 'record cards must not send mass push');
});

// ─── Recuperación de PIN por correo ─────────────────────────────
console.log('\nRecuperación de PIN por correo');
test('backend reset-pin existe y cubre las tres acciones', () => {
  assert(existsSync(join(ROOT, 'supabase/functions/reset-pin/index.ts')),
    'falta supabase/functions/reset-pin/index.ts');
  const fn = read('supabase/functions/reset-pin/index.ts');
  for (const a of ["'set-email'", "'request'", "'confirm'"])
    assert(fn.includes(a), `la Edge Function debe manejar la acción ${a}`);
  // set-email exige que el hash del PIN coincida (prueba de identidad)
  assert(/emp\.pin\s*!==\s*pinHash/.test(fn) && /'auth'/.test(fn),
    'set-email debe rechazar (auth) si el PIN no coincide');
  // los tokens se guardan HASHEADOS, nunca en claro
  assert(/token_hash/.test(fn) && /sha256hex\(token\)/.test(fn),
    'los tokens deben guardarse como sha256(token)');
  // los correos NO viven en employees (allow_all público) sino en la tabla protegida
  assert(/employee_recovery/.test(fn), 'los correos deben ir a employee_recovery (tabla protegida)');
  // request no debe filtrar si un correo existe (siempre ok:true)
  assert(/no revelar existencia/.test(fn) || /no filtrar/.test(fn),
    'request no debe revelar si el correo existe');
});
test('la app cablea recuperación de PIN sin enviar el PIN en claro', () => {
  // helpers de red
  for (const f of ['supaSetRecoveryEmail', 'supaRequestPinReset', 'supaConfirmPinReset',
                   'openPinRecovery', 'showPinReset', 'promptRecoveryEmail'])
    assert(html.includes('function ' + f), `falta la función ${f}`);
  // deep-link #reset= capturado en el arranque y disparado en autoLogin
  assert(/#reset=/.test(html) && /_pendingPinReset/.test(html),
    'debe capturarse el deep-link #reset= y guardarlo en _pendingPinReset');
  assert(/if\(_pendingPinReset\)\{[\s\S]*showPinReset/.test(html),
    'autoLogin debe abrir showPinReset cuando hay token pendiente');
  // la clave nueva se cifra en el cliente antes de confirmar (hashPin → hash)
  const reset = html.slice(html.indexOf('function showPinReset'), html.indexOf('function promptRecoveryEmail'));
  assert(/await hashPin\(a\)/.test(reset) && /supaConfirmPinReset\(token,\s*h\)/.test(reset),
    'showPinReset debe hashear la clave en el cliente y enviar solo el hash');
  // la pantalla de reset acepta contraseña de texto libre (sirve a ambos flujos)
  assert(/id="pinResNew"/.test(reset) && /id="pinResConf"/.test(reset),
    'showPinReset debe usar campos de contraseña de texto libre');
  // el correo se guarda con el hash del PIN como prueba (nunca sin verificar)
  assert(/supaSetRecoveryEmail\(name,\s*pinHash,\s*email\)/.test(html),
    'set-email debe llevar el hash del PIN como prueba de identidad');
  // el enlace "olvidaste" solo aparece al INTRODUCIR el PIN, no al configurarlo
  const modal = html.slice(html.indexOf('function showPinModal'), html.indexOf('// ═══════ RECUPERACIÓN'));
  assert(/pinStep==='enter'/.test(modal) && /openPinRecovery\(\)/.test(modal),
    'el enlace de recuperación solo debe mostrarse en el paso "enter"');
});
test('filtro de turno (DISH_SERVICE) coherente con las cartas reales', () => {
  const m = html.match(/const DISH_SERVICE = (\{[^}]*\});/);
  assert(m, 'no se encontró DISH_SERVICE');
  const SV = eval('(' + m[1] + ')');
  // valores válidos únicamente
  for (const [id, v] of Object.entries(SV))
    assert(v === 'a' || v === 'c' || v === 'ambos', `#${id} tiene servicio inválido: ${v}`);
  // gemelos por turno (recetas distintas) — cada uno a SU carta
  assert(SV[69] === 'a' && SV[109] === 'c', 'Fish&chips: 69 almuerzo · 109 cena');
  assert(SV[78] === 'a' && SV[9] === 'c', 'Tataki: 78 almuerzo · 9 cena');
  assert(SV[103] === 'a' && SV[119] === 'a', 'Helados B&J son de almuerzo');
  // lunch-only reales (no deben salir en cena)
  for (const id of [95, 96, 97, 92, 93, 94, 73, 74, 84, 102, 104, 105, 86, 91])
    assert(SV[id] === 'a', `#${id} debe ser solo ALMUERZO`);
  // dinner-only reales (no deben salir en almuerzo) — incluye veg de solo-cena
  for (const id of [23, 24, 25, 26, 40, 41, 34, 17, 18, 19, 20, 21, 22, 112, 48, 49, 52, 53, 54])
    assert(SV[id] === 'c', `#${id} debe ser solo CENA`);
  // vegetarianos de solo-almuerzo
  for (const id of [120, 121]) assert(SV[id] === 'a', `#${id} debe ser solo ALMUERZO`);
  // reparto razonablemente equilibrado (no todo 'ambos')
  const cnt = { a: 0, c: 0, ambos: 0 };
  for (const v of Object.values(SV)) cnt[v]++;
  assert(cnt.a >= 30 && cnt.c >= 30, `reparto desequilibrado: ${JSON.stringify(cnt)}`);
});
test('zona de Ajustes: entrada, perfil, correo, cambio de clave', () => {
  // botón de entrada en la cabecera
  assert(/id="ajustesBtn"[^>]*onclick="openAjustes\(\)"/.test(html),
    'la cabecera debe tener el botón ⚙ que abre openAjustes()');
  assert(html.includes('function openAjustes('), 'falta la función openAjustes');
  // helpers de red para estado de correo y cambio de clave
  assert(html.includes('function supaEmailStatus') && html.includes('function supaChangePin'),
    'faltan los helpers supaEmailStatus / supaChangePin');
  const aj = html.slice(html.indexOf('function openAjustes'), html.indexOf('// Sync visible dots from hidden input'));
  // secciones clave presentes
  assert(/ajEmail/.test(aj) && /ajPass1/.test(aj) && /ajPass2/.test(aj) && /ajLogout/.test(aj) && /ajAvatar/.test(aj),
    'Ajustes debe incluir correo, cambio de clave, avatar y cerrar sesión');
  // el cambio de clave se cifra en el cliente y usa el hash actual como prueba
  assert(/await hashPin\(a\)/.test(aj) && /supaChangePin\(currentUser,\s*pinHash,\s*h\)/.test(aj),
    'cambiar clave debe hashear en cliente y probar identidad con el hash actual');
  // el correo se guarda con prueba de identidad (mismo helper que la recuperación)
  assert(/supaSetRecoveryEmail\(currentUser,\s*pinHash,\s*email\)/.test(aj),
    'guardar correo en Ajustes debe llevar el hash del PIN como prueba');
  // backend cubre las acciones nuevas
  const fn = read('supabase/functions/reset-pin/index.ts');
  assert(/'email-status'/.test(fn) && /'change-pin'/.test(fn),
    'la Edge Function debe manejar email-status y change-pin');
  assert(/maskEmail/.test(fn), 'el estado del correo debe devolverse enmascarado');
});
test('la recuperación está cableada también en el login por contraseña', () => {
  // enlace "¿Olvidaste tu PIN o contraseña?" en el formulario visible
  assert(/id="loginForgotLink"[^>]*onclick="openPinRecovery\(\)"/.test(html) ||
         (/id="loginForgotRow"/.test(html) && /id="loginForgotLink"/.test(html) && /openPinRecovery\(\)/.test(html)),
    'el login por contraseña debe ofrecer "¿Olvidaste tu PIN o contraseña?"');
  // se muestra al iniciar sesión y se oculta al crear cuenta
  assert(/forgot\.style\.display\s*=\s*'block'/.test(html) && /forgot\.style\.display\s*=\s*'none'/.test(html),
    'el enlace de recuperación debe alternarse con el modo del login');
  // usuario nuevo por contraseña → se le ofrece el correo de recuperación
  assert(/promptRecoveryEmail\(_rn,\s*_rh\)/.test(html),
    'un usuario nuevo (contraseña) debe recibir el prompt de correo');
  // usuario existente → aviso único por dispositivo
  assert(/recEmailAsked:/.test(html) && /promptRecoveryEmail\(userName,\s*hashedPin\)/.test(html),
    'un usuario existente debe recibir el aviso de correo una sola vez por dispositivo');
  // ...pero NO si la cuenta ya tiene correo en el servidor (evita re-preguntar
  // al entrar desde otro dispositivo, donde la bandera local no existe)
  assert(/const st=await supaEmailStatus\(userName, hashedPin\)[\s\S]{0,120}hasEmail=!!st\.data\.hasEmail/.test(html) &&
         /if\(!hasEmail\)\{ setTimeout\(\(\)=>\{ try\{ promptRecoveryEmail\(userName, hashedPin\)/.test(html),
    'el aviso de correo debe comprobar el servidor (email-status) antes de pedirlo');
});

// ─── Endurecimiento de seguridad ────────────────────────────────
console.log('\nSeguridad');
test('custom_dishes: escrituras por Edge Function gateada, no anon directo', () => {
  // backend con verificación de supervisor
  assert(existsSync(join(ROOT, 'supabase/functions/manage-content/index.ts')),
    'falta supabase/functions/manage-content/index.ts');
  const fn = read('supabase/functions/manage-content/index.ts');
  assert(/verify_supervisor_pin/.test(fn) && /'dish-upsert'/.test(fn) && /'dish-delete'/.test(fn),
    'manage-content debe verificar el PIN de supervisor y cubrir upsert/delete');
  assert(/error:\s*'auth'/.test(fn), 'manage-content debe rechazar sin PIN de supervisor');
  // cliente: las escrituras van por manage-content, NO por el POST directo a la tabla
  const up = html.slice(html.indexOf('async function supaUpsertCustomDish'), html.indexOf('async function syncCustomDishesFromCloud'));
  assert(/functions\/v1\/manage-content/.test(up) && /supPin/.test(up),
    'supaUpsertCustomDish debe llamar a manage-content con el PIN de supervisor');
  assert(!/rest\/v1\/custom_dishes[^?]*`,\s*\{\s*method:\s*'POST'/.test(up),
    'no debe quedar escritura directa (POST) a rest/v1/custom_dishes');
  // el PIN de supervisor se guarda en memoria al autenticar y se borra al salir
  assert(/let _supPin\s*=\s*null/.test(html) && /_supPin\s*=\s*entered/.test(html) && /_supPin\s*=\s*null;/.test(html),
    '_supPin debe fijarse al autenticar y limpiarse al salir');
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
