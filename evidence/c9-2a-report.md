# C9-2a — Design system + brand identity + shell polish

The dashboard read as "white + one purple." This phase replaces that with a bespoke, considered
design language and a real brand — Claude-app-level polish with Custos's *own* identity. No UI-kit
defaults, no stock gradients, no AI-slop, air-gapped (system-safe type, no external CDN).

## The design language — "Vault Ledger"

Custos is the *guardian of the ledger*. The language is an **archival ledger**: warm bone/parchment
surfaces and warm graphite ink (not flat white, not blue-gray), a deep **pine** brand for authority
and money, a restrained **brass** seal accent for the guardian motif, and onyx + oxblood for a
blocked payment. Serious fintech-security, legible everywhere.

**Color is never the only signal:** cleared = `--ok` + a ✓ glyph + a "CLEARED" label; blocked = the
onyx inversion + an ✕ glyph + a "BLOCKED" label; caution = `--warn` + an icon. A monochrome reader
still reads every state.

## 1 · Design system

- **`packages/edge/ui/tokens.css`** — the single source of truth: a warm neutral ramp
  (`--bone` → `--ink`), brand (`--brand` Pine `#0e5247`) + accent (`--brass` `#9a7b3f`), semantic
  states (`--ok` / `--warn` / `--danger` / `--onyx`), a type scale (display → micro) with weights and
  tracking, 4px spacing, radius, three warm elevations, a shared focus ring, and motion/layout tokens.
  The only literal color values in the UI live here.
- **`dash.css`** consumes the tokens exclusively — **no one-off hex** in component CSS (verified: a
  grep for `#`/`rgb(`/`rgba(` in `dash.css` returns nothing).
- **`DESIGN-SYSTEM.md`** documents the palette, type, spacing/radius/elevation, the
  color-not-only-signal rule, and the brand assets.

## 2 · Brand identity — `packages/edge/ui/brand/`

- **`mark.svg`** — the Custos seal: an octagonal struck-medallion (coin / vault-bolt) with a brass
  rim, a guardian **"C"** embracing a **brass keystone** (the guarded asset). Geometric, precise,
  ownable — not clip-art, not an emoji.
- **Favicon** — `favicon.svg` (the mark on a bone app tile) + rasterized `favicon-32.png`,
  `apple-touch-icon.png` (180), `icon-512.png`.
- **`og.svg` → `og.png`** (1200×630) — the share card: the lockup + "Guardian of the ledger" on the
  pine brand surface, framed like a sealed document.
- The **lockup** (mark + CUSTOS wordmark) appears in the dashboard sidebar and the landing nav; the
  favicon + OG/twitter meta are wired into **both** `dash.html` and `index.html` (the landing).

## 3 · Applied to the existing shell + chat (re-skinned, logic untouched)

- Shell, conversational workspace (agent-left / user-right), reasoning trace, gate ladder, verdict /
  authorize / receipt cards, composer, nav, badges — all re-skinned from the tokens. The receipt now
  reads as a **sealed record** (brass). "White + purple" is gone.
- **Collapsible sidebar** — a toggle collapses it to an icon rail and **persists** to `localStorage`
  (`custos.sidebar`); a `?sidebar=` override exists for deterministic capture.
- **Responsive** — desktop / tablet / mobile. At ≤860px the sidebar becomes an off-canvas **drawer**
  (hamburger in the topbar, a scrim to dismiss, auto-close on nav); the thread stays legible and a
  fit-safety rule prevents horizontal overflow on narrow screens.
- **Routing** — `/` → dashboard, `/landing` → marketing page; clean links **both ways** (sidebar →
  "View the landing page"; landing wordmark → `/` and an "Open console →" button). No broken routes.

## Proof — live, via `npm run serve`

**Routes + assets** (all `200`, correct content-type):
```
/  text/html   ·  /landing  text/html
/tokens.css text/css  ·  /dash.css text/css  ·  /dash.js text/javascript
/brand/mark.svg image/svg+xml  ·  /brand/favicon.svg image/svg+xml
/brand/favicon-32.png image/png  ·  /brand/og.png image/png  ·  /brand/apple-touch-icon.png image/png
```
Head wiring present in `/`: `tokens.css`, `/brand/favicon.svg`, `og.png`, `mark.svg`, `#sideToggle`,
`#menuBtn`, `#scrim`. The path-traversal guard still allows `/brand/*` and `tokens.css`; a probe of
`/../../etc/passwd` → `404`.

**Screenshots** (headless capture of the live console):
- [evidence/ui/c9-2a-shell.png](ui/c9-2a-shell.png) — shell + brand lockup + intro + inbox picker
- [evidence/ui/c9-2a-clean.png](ui/c9-2a-clean.png) — clean thread: reasoning → VERIFIED ladder → Q&A → hold-to-authorize
- [evidence/ui/c9-2a-blocked.png](ui/c9-2a-blocked.png) — fraud thread: ✕ at the wallet → onyx BLOCKED → explain
- [evidence/ui/c9-2a-settled.png](ui/c9-2a-settled.png) — the sealed (brass) on-chain receipt
- [evidence/ui/c9-2a-collapsed.png](ui/c9-2a-collapsed.png) — sidebar collapsed to the icon rail
- [evidence/ui/c9-2a-mobile.png](ui/c9-2a-mobile.png) — mobile width: drawer shell + legible thread
- [evidence/ui/c9-2a-landing.png](ui/c9-2a-landing.png) — landing with the seal lockup + "Open console" cross-link
- [evidence/ui/og.png] is `packages/edge/ui/brand/og.png` — the share card

## Adversarial review

A 4-dimension adversarial review (contrast/legibility · responsive robustness · token-consistency /
no-slop / brand · routing + asset wiring + regression) ran across ~18 agents, each finding
independently re-verified against the code (contrast ratios recomputed from scratch). **7 findings
confirmed real; 6 fixed**, 1 deferred as a documented scope boundary. The chat/gate/settlement logic
was confirmed untouched and no routes broke.

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 1 | high | Focus ring invisible — `:focus-visible` removed the outline and replaced it with a ~1.2–1.35:1 tint ring (WCAG 2.2 SC 1.4.11 / 2.4.13 fail) across every control | Replaced with a real **`outline: 2px solid var(--brand)` + 2px offset** (pine ≈ 8–9:1 on light, and an outline isn't clipped by card `overflow:hidden`) |
| 2 | high | `--ink-4` (#a8a293) used for *meaningful* small text (nav-count, signer key, sample-expect, composer note, placeholder, gate-no, pending tag, signing label) at 2.08–2.54:1 | Those labels moved to the readable tier; `--ink-4` is now **decorative/disabled icons only** |
| 3 | med | `--ink-3` (#7b766b) itself failed AA on the warm surfaces (4.26:1 bone, 4.00:1 surface-2, 3.69:1 surface-3) | Darkened `--ink-3` → **#6b6456** (≥4.79:1 on every warm surface) and collapsed the temporary `--ink-meta` into it — one AA-safe tertiary tier |
| 4 | nit | Dead selector `.stat:not(.stat-signer-wrap)` (the class exists nowhere — worked by accident) | Simplified to `.stat, .top-div { display: none }` |
| 5 | nit | `--scrim` comment claimed "from --onyx" but the rgb didn't match | Comment corrected to "warm near-black" |
| 6 | nit | `#signer` shipped `href="#" target="_blank"` before `loadHeader` set the real href (a click in the load window could open a blank tab) | Removed the placeholder `href`; `loadHeader` adds the real one |
| 7 | med | **Landing (`index.html`) still uses the old editorial `app.css`** (Jetstream-blue tokens), so `/landing` doesn't share the new palette | **Deferred (scope):** the brief scoped the landing to favicon/OG/lockup/cross-links (shipped). The landing keeps its prior Heart-Aerospace language by earlier directive; a full token migration belongs to the landing-repurpose work — flagged below. |

The contrast-fix-verify pass re-confirmed the focus + ink-ramp fixes pass AA with no regression. Two
findings were **dismissed** on verification: "brand source SVGs are publicly fetchable" (intended —
they're served assets) and "encoded-traversal `%2e%2f` not decoded before the guard" (Node's http
doesn't percent-decode the path, so those reach `resolve()` as literal names, not traversal).

**Known follow-up (finding 7):** the dashboard (warm pine) and the landing (cool Jetstream blue) are
two visual languages sharing one brand mark. The dashboard is the C9-2a target and is fully migrated;
bringing the landing onto the tokens is the obvious next step for the landing repurpose.

## Notes / scope

- Screenshots are headless captures of the live dashboard via the `?demo=` replay hook (so the long
  thread renders without per-stage model latency); the chat/gate/settlement **logic is unchanged from
  C9-1** and remains proven by the C9-1 live transcripts.
- Out of scope (later): auth/login, profile, onboarding, chat avatars (C9-2b); the operational
  Inbox/History/Vendors/Settings pages (C9-3) remain stubs.
