# TXOKO — Design System

A single source of truth for the look, feel, and motion of TXOKO Formación.
The goal is **Apple-level consistency**: clarity over decoration, speed over
ornament, predictable patterns over one-off styling — while preserving the
existing **TUNIC / Journey / Ghibli** atmospheric character.

> **Adoption is incremental.** All tokens live in `styles.css` `:root`. Defining
> a token changes nothing until a rule references it. New and refactored UI
> should use these tokens; existing inline styles and raw hex values are
> migrated phase by phase, behind the smoke-test safety net (`npm test`).

---

## 1. Principles

1. **Velocidad > estética.** Service Mode must never cost the user a beat under
   service pressure.
2. **Claridad > decoración.** The atmospheric layer is always *subordinate* to
   legibility and operability (see §7).
3. **Consistencia > creatividad aleatoria.** Reuse tokens and components; don't
   invent a new spacing or color value per screen.
4. **Navegación predecible.** Same patterns in the same places.

---

## 2. Color

### Primitives (palette — do not change casually)
Parchment/ink scale (`--ink`…`--ink5`), dark ground (`--parchment`,
`--parch2`…`--parch4`), gold (`--gold`, `--gold2`, `--gold3`), accents
(`--sage`, `--rose`, `--azure`), TUNIC candy pastels (`--candy-*`).

### Semantic tokens (prefer these in new/migrated UI)
| Token | Maps to | Use for |
|---|---|---|
| `--color-bg` | `--parchment` | app background |
| `--color-surface` | `--ink` | card / panel face |
| `--color-text` | `--ink` | text on dark bg |
| `--color-text-ink` | `--parchment` | text on light surface |
| `--color-accent` | `--gold` | primary accent, focus |
| `--color-accent-hi` | `--gold3` | accent highlight |
| `--color-success` | `--sage` | safe / correct |
| `--color-danger` | `--rose` | allergen / error |
| `--color-info` | `--azure` | informational |
| `--color-line` | `--line` | dividers, hairlines |

> Migration note: ~439 distinct raw hex values exist today (e.g. `#c49a3c`
> appears 114× → `--gold`/`--color-accent`; `#1c2a22` 44× → `--color-bg`).
> These are normalized incrementally; never hand-pick a new hex when a token fits.

---

## 3. Typography

Families: `--font-sans` (Quicksand, UI/body) · `--font-serif` (Cinzel,
ceremonial headings) · `--font-mono` (DM Mono, metadata/labels) · `--font-read`
(Cormorant Garamond, descriptive/story text).

Type scale (replaces 40+ ad-hoc sizes over time):

| Token | Size | Role |
|---|---|---|
| `--text-micro` | 0.55rem | mono metadata, pill labels |
| `--text-2xs` | 0.65rem | dense secondary labels |
| `--text-xs` | 0.72rem | captions, chips |
| `--text-sm` | 0.82rem | secondary body |
| `--text-base` | 0.92rem | body |
| `--text-lg` | 1.1rem | card titles |
| `--text-xl` | 1.4rem | section headings |
| `--text-2xl` | 1.85rem | screen titles |
| `--text-3xl` | 2.4rem | hero / numerals |

---

## 4. Spacing

4px base grid. Use for `margin`, `padding`, `gap` — stop hand-typing `.6rem`.

`--space-1` 4px · `--space-2` 8px · `--space-3` 12px · `--space-4` 16px ·
`--space-5` 24px · `--space-6` 32px · `--space-7` 48px · `--space-8` 64px

---

## 5. Radius & Elevation

Radius: `--radius-sm` (8px) · `--radius-md` (12px) · `--radius-lg` (16px) ·
`--radius-full` (pills). Aliases over the legacy `--r3/--r2/--r`.

Elevation (shadow ladder): `--elev-1` (subtle) · `--elev-2` (raised card) ·
`--elev-3` (modal/overlay). Aliases over `--shadow/2/3`.

---

## 6. Motion

Durations: `--motion-fast` 120ms (taps, toggles) · `--motion-base` 200ms
(cards, transitions) · `--motion-slow` 360ms (overlays, mode switch).
Easing: `--ease-standard` (most UI) · `--ease-emphasized` (enter/expand) ·
`--ease-decelerate` (incoming elements).

UI **state** transitions use these tokens. The ~189 atmospheric `@keyframes`
(god-rays, glows, breathing backgrounds) are a separate decorative layer and
must obey §7.

---

## 7. Atmospheric layer (visual only)

Inspiration: Journey (light, space, emotion), TUNIC (world, mystery), Ghibli
(cinematic, adult). Rules — **non-negotiable**:

- **Never reduces legibility.** Atmospheric effects sit behind content
  (`z-index:0`, `pointer-events:none`) and never lower text contrast below
  readable.
- **Always subordinate to operability**, especially in Service Mode (minimal
  motion, maximal scan speed).
- **Respects `prefers-reduced-motion`.** Decorative animation must degrade to
  static when the OS asks. (Comprehensive guard tracked as a follow-up phase.)

---

## 8. Dual mode

- **Service Mode** (`toggleServiceMode`, `_svc*`): real-time lookup of dishes,
  allergens, ingredients, wines. Scannable, zero friction, minimal motion.
- **Learning Mode** (Aprender / Vinos / Exam / LQA): immersive, storytelling,
  progressive. The atmospheric layer is fullest here.

Both consume the **same CORE** (recipes, wines, business logic) which is
intocable — the design system only governs presentation.

---

## 9. Components (conventions)

Reuse the existing class families rather than re-styling inline:
cards (`.card`, `.wine-card`, `.module-card`, `.dish-card`), buttons
(`.btn-primary`, `.btn-next`, `.btn-back`, …), service cards (`.svc-result`,
`.svc-wine-rec`), overlays (`.svc-overlay`, onboarding). Consolidating these
into a unified `.btn` base and reducing the ~1,659 inline styles is incremental
refactor work — each step verified by `npm test`.
