# Custos Design System — "Vault Ledger"

The visual language for the Custos Edge Console. One source of truth:
[`packages/edge/ui/tokens.css`](packages/edge/ui/tokens.css). Every screen reads from these
tokens — **no one-off hex** in component CSS. Bespoke and air-gapped (system-safe type, no
external CDN, no UI kit).

## Concept

Custos is the *guardian of the ledger* — air-gapped, deliberate, exacting. The language is an
**archival ledger**: warm bone/parchment surfaces and graphite ink (not flat white, not the
"white + one purple" default), a deep **pine** brand for authority and money, and a restrained
**brass** seal accent for the guardian motif. Severe where it should be (a blocked payment), warm
and legible everywhere else.

## Palette

| Token | Hex | Use |
|-------|-----|-----|
| `--bone` | `#faf8f3` | app background (warm paper) |
| `--surface` | `#ffffff` | cards / raised |
| `--surface-2` | `#f4f1e9` | sidebar / sunken |
| `--hair` / `--hair-strong` | `#e7e2d6` / `#d8d2c3` | borders |
| `--ink` / `--ink-2` / `--ink-3` | `#1b1a16` / `#4c483f` / `#6b6456` | warm graphite text ramp — all AA (`--ink-3` ≥4.79:1 on every warm surface) |
| `--ink-4` | `#a8a293` | faint — **decorative / disabled icons only**, never meaningful text |
| `--brand` (Pine) | `#0e5247` | primary interactive: buttons, links, active nav, focus |
| `--brand-strong` / `--brand-press` | `#0a3e36` / `#082f29` | hover / pressed |
| `--brass` | `#9a7b3f` | guardian/seal accent — logo, VERIFIED stamp, sparing detail |
| `--ok` | `#15715a` | cleared / verified |
| `--warn` | `#8a6314` | caution |
| `--danger` | `#9b2c2c` | block emphasis (oxblood, not alarm-red) |
| `--onyx` | `#16151a` | blocked surface (inversion) |

**Color is never the only signal.** Cleared = `--ok` + a ✓ glyph + a "CLEARED" label; blocked =
the onyx inversion + an ✕ glyph + a "BLOCKED" label; caution = `--warn` + an icon. A monochrome or
color-blind reader still reads every state.

## Type

System-safe, bespoke through discipline. Sans for UI, a serif (`--font-serif`, Iowan/Palatino/
Georgia) for archival accents (eyebrows, taglines), mono (`--font-mono`, SF Mono) for ledger data
(addresses, amounts, hashes). The CUSTOS **wordmark** is set as tracked text from these tokens; the
**mark** is bespoke SVG.

Scale: `--fs-display 30` · `--fs-h1 19` · `--fs-h2 15` · `--fs-title 13.5` · `--fs-body 14` ·
`--fs-sm 13` · `--fs-caption 12` · `--fs-micro 11`. Weights `--fw-regular 400` → `--fw-heavy 800`.
Tracking: `--track-tight`, `--track-snug`, `--track-label` (uppercase micro-labels).

## Spacing · radius · elevation

4px spacing scale (`--sp-1` … `--sp-16`). Radii `--r-xs 5` → `--r-xl 18`, `--r-pill`. Three
warm-tinted elevations (`--e-1` … `--e-3`) — never pure-black shadow. Focus is a single shared
ring (`--focus-ring`); hover/active/disabled are consistent across primitives.

## Brand assets — [`packages/edge/ui/brand/`](packages/edge/ui/brand/)

- `mark.svg` — the seal: an octagonal struck-medallion (coin / vault-bolt) with a brass rim, a
  guardian **"C"** embracing a **brass keystone** (the guarded asset). Geometric, precise, ownable.
- `favicon.svg` + `favicon-32.png` / `apple-touch-icon.png` (180) / `icon-512.png` — the mark on a
  bone app tile.
- `og.svg` + `og.png` (1200×630) — the share card: the lockup + "Guardian of the ledger" on the
  pine brand surface, framed like a sealed document.

The lockup (mark + wordmark) appears in the dashboard sidebar and the landing nav.

## Primitives (restyled from tokens)

Buttons (`.btn` primary/ghost, the hold-to-authorize), inputs/composer, cards, nav items, badges
& pills, the 6-gate ladder, chat bubbles, avatars, the reasoning trace — all derive from the
tokens above. Add new components by composing tokens; do not introduce raw values.
