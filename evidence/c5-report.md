# Custos — C5 Report · Edge Settlement Console (UI)

**Phase:** C5 · **Node:** Edge "AP Clerk" · PRD §6 step 5. Local browser console that runs the **real** pipeline behind every gate. **Design language: `DESIGN.md` (Heart Aerospace) — followed entirely.**

## What shipped

| File | Role |
|---|---|
| [packages/edge/src/server.ts](../packages/edge/src/server.ts) | dependency-free `node:http` server: serves the SPA + `/api/verify` (NDJSON gate stream), `/api/approve` (settle), `/api/samples`, `/api/wallet`. In-memory job store; one-at-a-time verify lock. |
| [packages/edge/ui/](../packages/edge/ui/) | the SPA — `index.html`, `app.css`, `app.js` (vanilla, no build step). |
| [scripts/gen-ui-samples.ts](../scripts/gen-ui-samples.ts) | three input invoices: clean (settles), prompt-injection, amount-mismatch. |

Run: `npm run serve` → `http://localhost:4173`.

## Flow (real pipeline, streamed live)
Drop an invoice (or pick a sample) → **OCR + Qwen3-VL extraction on-device** → **Gate 0** decode/normalize → **Gate 2** ERP verify → **Gate 3** recipient → if all clear, **Gate 4** a deliberate *hold-to-authorize* human signature → **Gate 5** real on-chain USD₮ transfer → settlement receipt with tx hash + explorer link. The six gates animate as the invoice descends them; a block stops the ladder.

## Proven through the live server (read-only verify)
| Sample | Result |
|---|---|
| Clean invoice | ✅ **VERIFIED** — G0–G3 clear; awaits human approval (then settles, same path proven in C4) |
| Prompt injection | 🛑 **Gate 0** — "injection phrase — *ignore all previous instructions…*" |
| Amount mismatch (4,242 USD₮) | 🛑 **Gate 2** — no open PO matches |

Qwen3-VL-2B (the documented accuracy upgrade) reads the amount and the full wallet correctly; the verify path settled identically to C4's on-chain proof when authorized in-browser.

## Design — `DESIGN.md` followed entirely
- **Monumental Helvetica-Neue type over atmosphere.** The verdict IS the headline — `AWAITING → READING → VERIFYING → VERIFIED / BLOCKED → SIGNING → SETTLED` at display scale, left-anchored.
- **Atmospheric Stratosphere→Cloud gradient** hero; **Cloud** content bands; **Onyx** footer. A blocked settlement **inverts to a stark Onyx band** — state conveyed by type + surface, never by red/green (palette is the brand's 4 colors).
- **Jetstream Blue `#001489` only as outlined/ghost actions** (gate "CLEARED" tags, the dropzone, the explorer link, the authorize key). **Zero border-radius. No cards, no shadows.** Flat full-bleed bands, 70px section gaps, 40px edge.
- The gate sequence is rendered as an **editorial numbered ladder**; **hold-to-authorize** (Gate 4) is a deliberate human act with a Jetstream-Blue progress line.

Screenshots (headless-Chrome captures): [evidence/ui/01-awaiting.png](./ui/01-awaiting.png) · [02-verified.png](./ui/02-verified.png) · [03-blocked.png](./ui/03-blocked.png) · [04-settled.png](./ui/04-settled.png).

## Robustness added for the UI
- **Reliable extraction:** switched to **Qwen3-VL-2B** (`CUSTOS_VISION=smol` falls back to SmolVLM2). It reads the amount and 42-char wallet exactly.
- **OCR-tolerant wallet corroboration** (`addressMatchTolerant`): folds confusable hex (O→0, l→1…) and accepts ≤2-char drift — recovers a legit OCR-noisy wallet while still rejecting an attacker/lookalike (forging within 2 chars of a fixed address is infeasible). Payout still uses the DB address (Gate 3, strict, at sign time).
- **Pre-flight balance gate** (#72) in `settle.ts` — never broadcast a doomed send.
- Cleaner Gate-0 evidence: findings now surface the offending phrase, not the document header.

> Keys never leave the Edge process. The browser only sees the gate verdicts and the signed receipt — the seed stays in gitignored `.env`.
