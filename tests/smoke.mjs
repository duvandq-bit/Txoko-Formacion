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
  assert(/\.login-venue-dd\.open, \.tunic-dd\.open|\.tunic-dd\.open, \.nav-dd\.open, \.login-venue-dd\.open/.test(html),
    'click-outside handler must also close the venue dropdown');
  // Locked venues: rendered with a padlock + aria-disabled, and selectVenue
  // only accepts enabled venues (registry is the gate, not just the styling).
  assert(/aria-disabled="true" tabindex="-1"/.test(html), 'locked venues must be aria-disabled');
  assert(/Próximamente/.test(html), 'locked venues must read Próximamente');
  assert(/const v = _enabledVenues\(\)\.find\(x => x\.id === id\);\s*\n?\s*if\(!v\) return;/.test(html),
    'selectVenue must reject venues that are not enabled');
  // Long venue names scale down instead of overflowing the login logo.
  const css = read('styles.css');
  assert(/\.login-logo h1\.long\{/.test(css) && /classList\.toggle\('long'/.test(html),
    'long venue names need the .long auto-fit');
  assert(/\.login-venue-card\.on\{/.test(css), 'selected venue card style missing');
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
  assert(/renotify: data\.renotify/.test(sw) && /options\.image = data\.image/.test(sw),
    'SW push handler must support renotify + big-picture image');
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

test('dashboard: plan first, stats folded into the dark progress panel', () => {
  // TUNIC manual-page redesign (owner-approved): the standalone stats strip
  // is gone — the four figures live as a mono line inside the progress panel,
  // below the actionable plan.
  const dashStart = html.indexOf("document.getElementById('appContent').innerHTML=`", html.indexOf('function renderDashboard'));
  assert(dashStart !== -1, 'renderDashboard innerHTML template not found');
  const dashEnd = html.indexOf('`;', dashStart);
  const dashTpl = html.slice(dashStart, dashEnd);
  assert(dashTpl.indexOf('PLAN DE HOY') !== -1, 'PLAN DE HOY section missing');
  assert(dashTpl.indexOf('STATS STRIP') === -1, 'the boxed stats strip must stay removed');
  assert(/dash-statline/.test(dashTpl), 'stat line must live inside the progress panel');
  assert(dashTpl.indexOf('PLAN DE HOY') < dashTpl.indexOf('dash-statline'),
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

test('Repaso Inteligente uses a green dot, not a red one', () => {
  assert(/'Repaso Inteligente',_srsCount>0\?'🟢'/.test(html),
    'the SRS-due indicator on Repaso Inteligente must be a green dot, not red');
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
  assert(/class="tunic-dd-chev"[^>]*><svg/.test(html),
    'sub-tab trigger chevron must be an SVG, not a ▾ glyph');
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
  // Sub-tab trigger is light (hierarchy: dark main nav → light sub-selector);
  // the green Pip-Boy variant must still override it to dark.
  assert(/\.tunic-dd-trigger\{[^}]*background:#faf6ee/.test(css),
    'sub-tab trigger must be the light variant');
  assert(/\.tunic-dd--green \.tunic-dd-trigger\{[^}]*#0c3a22/.test(css),
    'green variant must keep its dark Pip-Boy trigger');
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
  assert(/\.nav-dd-trigger\{[^}]*min-height:44px/.test(css) && /\.tunic-dd-trigger\{[^}]*min-height:44px/.test(css),
    'both nav bars must be the slim 44px variant');
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
  assert(/if\(type==='dish'\)\{ if\(typeof launchDishJourney==='function'\) launchDishJourney\(id\)/.test(html),
    'dish results must deep-link into launchDishJourney');
  assert(/_showWineDetail\(id,/.test(html),
    'wine results must deep-link into _showWineDetail');
  // accent-insensitive index so "lacteos" matches "Lácteos", "gluten" the allergen
  assert(/normalize\('NFD'\)\.replace\(\/\[\\u0300-\\u036f\]\/g,''\)/.test(html),
    'search must fold accents for allergen/name matching');
});

test('sub-tab navigation is a dropdown, not a horizontal scroller', () => {
  // The scrolling .tunic-subtabs bar hid off-screen options. Both the
  // shared _subTabBar and the Vinos bar now render a .tunic-dd dropdown
  // via _subTabDropdown, so every option is reachable without swiping.
  assert(/function _subTabDropdown\(/.test(html),
    '_subTabDropdown helper missing');
  assert(/return _subTabDropdown\(tabs, activeTab,/.test(html),
    '_subTabBar must delegate to the dropdown helper');
  assert(/_subTabDropdown\(tabs, sub, id=>`_vinoSubTab/.test(html),
    'the Vinos bar must also use the dropdown helper');
  const css = read('styles.css');
  assert(/\.tunic-dd\.open \.tunic-dd-list\{display:flex/.test(css),
    'the dropdown open-state CSS is missing');
  // Tenet-style: active item gets a left accent bar; green variant exists
  // and is applied only on Repaso Inteligente (smart tab of Aprender).
  assert(/\.tunic-dd-item\.on\{[^}]*border-left-color:var\(--gold\)/.test(css),
    'active dropdown item must have the gold left accent bar (Tenet style)');
  assert(/\.tunic-dd--green /.test(css),
    'the green dropdown variant is missing');
  assert(/parentTab==='aprender' && activeTab==='smart'\) \? 'green'/.test(html),
    'green variant must be scoped to Repaso Inteligente only');
});

test('Aprender sub-tabs lead with Smart Review, then Explore', () => {
  // Owner request: Repaso Inteligente (smart) comes before Explorar
  // (repaso) in the Aprender sub-tab bar, and is the default sub-tab.
  const bar = html.match(/_subTabBar\(\[\s*([\s\S]*?)\]\s*,\s*sub\s*,\s*'aprender'\)/);
  assert(bar, 'aprender _subTabBar call not found');
  const smartIdx = bar[1].indexOf("'smart'");
  const repasoIdx = bar[1].indexOf("'repaso'");
  assert(smartIdx !== -1 && repasoIdx !== -1, 'smart/repaso tabs missing');
  assert(smartIdx < repasoIdx, 'Smart Review must come before Explore in the Aprender sub-tabs');
  assert(/_subTab\.aprender\s*\|\|\s*'smart'/.test(html),
    "Aprender default sub-tab must be 'smart' so the first tab is active on open");
  // the initial _subTab state must also be 'smart' — '|| smart' never fires
  // because _subTab.aprender is always truthy once initialised
  assert(/let _subTab = \{ aprender:'smart'/.test(html),
    "_subTab must initialise aprender to 'smart', else Explore stays the active default");
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
  const ex = html.slice(html.indexOf('function startExam'), html.indexOf('function renderExamQuestion'));
  assert(/_correctAns/.test(ex) && /_seenNames/.test(ex) && /_twNorm\(a\.replace/.test(ex),
    'startExam reversed twin/duplicate guard missing');
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
