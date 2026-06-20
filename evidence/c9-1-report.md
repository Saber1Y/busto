# C9-1 — Conversational dashboard core (the product surface)

"Claude, but local, for Custos." The AP clerk now works through a conversation: the agent
reasons visibly on the left, the clerk acts on the right — grounded in the real on-device
pipeline and the gate ladder. No theatre: every reasoning line is a real pipeline stage.

The conversation is the **interface only**. Deterministic gates still authorize; the agent has
no tool that moves money; the only money-mover is a deliberate human hold → the real C4 settle.

---

## What shipped

**App shell** (`/` — the product; the editorial page is preserved at `/landing`):
- Persistent left sidebar: **Workspace** (built fully) · Inbox · History · Vendors · Settings
  (inert stubs this round — real pages are C9-2). Inbox shows a live count of waiting invoices.
- Top bar: **Vault · on-device** (green — inference is local), **Air-gapped**, the **Edge signer**
  address + live USD₮ balance (from `/api/wallet`).
- Industry-grade SaaS density (Linear/Mercury), deliberately distinct from the editorial billboard.
  Dependency-free, system type, no build step.

**Conversational Workspace** (the centerpiece):
- A chat thread — agent messages left, clerk messages right, history persists in session.
- The clerk starts by dropping an invoice or picking one from the inbox.
- The agent **streams its reasoning as it actually happens**, sourced from real `/api/verify`
  stages: the heavy on-device read (Qwen3-VL + OCR — genuinely seconds, shows a live spinner),
  then the deterministic ERP checks (hidden-instructions / vendor / purchase-order / payout-wallet /
  duplicate) each resolving with a ✓/✗ and a plain-English reason. The read line shows the real
  model, OCR-block count, and wall-clock read time.
- On the verdict, the **6-gate ladder + VERIFIED/BLOCKED** renders inline as a structured card at
  app density.
- Follow-ups happen in-thread (the C8a `explainInvoice` agent, now conversational): suggested chips
  + free input, **streamed grounded answers**. Questions pass Gate 0 first; the assistant is
  read-only and says so.
- For a VERIFIED invoice, **hold-to-authorize (Gate 4)** appears in-thread; on a deliberate hold the
  real C4 settlement path runs → a **receipt card** with the tx hash + a live Sepolia explorer link.

**Server** (minimal, additive — the security-critical `verdict.ts` is untouched):
- Route remap: `/` and `/app` → the dashboard; `/landing` → the editorial page (kept for the later
  landing repurpose).
- A coarse, real wall-clock read time (`_readMs`) on the extraction event.
- Post-hoc `reason` NDJSON events derived from the **real** `verdict.checks`, emitted in order and
  **stopping at the first failing check** — mirroring "a payment is impossible unless every gate
  clears." Backward-compatible: the editorial `app.js` ignores the new event type.

---

## Proof — live, via `npm run serve`

**Routing**
```
GET /          -> dash.html   (Custos · Edge Console — the conversational product)
GET /landing   -> index.html  (editorial page, preserved)
GET /dash.js   -> 200, 29,857 b
```

**Clean invoice → real reasoning stream → VERIFIED** (`POST /api/verify {"sample":"ui-clean"}`):
```
EXTRACTION  read on-device in 27,275 ms (cold model load), QWEN3VL_2B_MULTIMODAL_Q4_K
REASON gate0     ok=true  — no hidden instructions in the document
REASON vendor    ok=true  — ACME ROBOTICS LTD is on file and active
REASON po        ok=true  — PO-TEST matches 1.00 USDT
REASON wallet    ok=true  — the payout wallet matches the verified wallet on file
REASON duplicate ok=true  — not seen before — no duplicate
FINAL  VERIFIED
```

**In-thread explain** (`POST /api/explain`, streamed, grounded) — Workspace chip "What does Custos check?":
> Custos checks if the invoice is valid by verifying the vendor's existence, the amount and currency
> match the purchase order, the wallet matches the database, and the invoice hasn't been previously
> settled.

(Also proven this session: "What happens if I approve?" and "Why was this blocked?" stream grounded
answers — same `/api/explain` endpoint the thread uses.)

**Settlement path** — the VERIFIED final returns `jobId` + the deterministic `intent`; the in-thread
hold-to-authorize is the only path to `/api/approve` (real C4 send behind G3/G5). **Not auto-fired**
here — the real on-chain send is the operator's deliberate action.

**Fraud invoice (swapped payout wallet) → reasoning halts at the wallet check → BLOCKED**
(`POST /api/verify {"sample":"ui-fraud"}`):
```
REASON gate0   ok=true  — no hidden instructions in the document
REASON vendor  ok=true  — ACME ROBOTICS LTD is on file and active
REASON po      ok=true  — PO-TEST matches 1.00 USDT
REASON wallet  ok=false — the payout wallet does not match the wallet on file
FINAL  BLOCKED @ G3        (stream stops at the failing check; no duplicate line emitted)
```
"Why was this blocked?" streams a grounded explanation in-thread; no authorize is offered.

**Screenshots** (headless capture of the live dashboard):
- [evidence/ui/c9-1-shell.png](ui/c9-1-shell.png) — shell + agent intro + inbox picker
- [evidence/ui/c9-1-clean-thread.png](ui/c9-1-clean-thread.png) — reasoning → VERIFIED ladder → Q&A → hold-to-authorize
- [evidence/ui/c9-1-fraud-thread.png](ui/c9-1-fraud-thread.png) — reasoning halts at wallet → BLOCKED @ G3 → "Why was this blocked?"
- [evidence/ui/c9-1-settled-thread.png](ui/c9-1-settled-thread.png) — full happy path ending in the on-chain receipt card

---

## Security & grounding (unchanged invariants)

- The conversation never authorizes. The only money-mover is the deliberate human hold → `/api/approve`;
  Gate 3 (recipient re-check) and Gate 5 (on-chain safety) are enforced server-side, as proven in C4.
- The explainer is read-only and its question is Gate-0 screened server-side.
- Model- and document-derived text is rendered via `textContent`; `innerHTML` is used only for trusted
  constant icon markup — a hostile invoice cannot inject UI.
- Keys/seed never touch this surface; all QVAC inference stays inside the C6 audit wrapper.
- `tsc --noEmit` clean. The editorial page and its consumers are unaffected (additive events, preserved route).

## Adversarial review

A 4-dimension adversarial review (security/gate-preservation · no-theatre grounding · frontend bugs ·
server integration) ran across 16 agents — each finding then independently re-verified against the
actual code. 12 raw findings → **10 confirmed real** (2 dismissed). The core security invariants held
under review: no money moves without the deliberate human hold, the gates still authorize server-side,
and no model/document text reaches `innerHTML`. The confirmed findings were UX/robustness/consistency
issues; **8 were fixed**, 2 were positive confirmations needing no change:

| # | Sev | Finding | Resolution |
|---|-----|---------|------------|
| 3 | high | `startVerify` NDJSON loop unguarded → a throw stranded `busy=true` and bricked the workspace | Wrapped the stream in `try/finally`; reset `busy`+composer in `finally`; check `res.ok`/`res.body`; guard per-line `JSON.parse` |
| 1 | med | `doAuthorize` never cleared the `signing` class on a refused/error settle → dead authorize button | Remove `signing` on the non-settled branch and in `catch` (kept inert only after a real `settled`) |
| 2 | med | Demo replay wired a live hold to the real `/api/approve` | Demo authorize button's hold is now a no-op — the replay never touches the settle path |
| 4 | low | Demo live hold + unbounded `jobs` map | Demo hold inert (above) **and** server now deletes a job once `settled` (anti-replay) |
| 8 | low | Duplicate-only reject: gate ladder showed all-cleared while verdict was BLOCKED | Folded the replay check into G2 ("deterministic truth") so a duplicate marks G2 blocked — ladder now agrees with the verdict |
| 7 | low | A second invoice dropped mid-verify was silently swallowed | The agent now replies "one verification at a time" instead of dropping it |
| 9 | nit | Pre-existing path-traversal in the static server | Added a containment guard: a resolved path outside the UI dir → 404 |
| 6 | nit | Dead `REASON_LABEL.amount` (amount folds into the PO line) | Removed |
| 5 | nit | "Keys never leave this machine" is a static trust claim | No change — the statement is true (keys are Edge-only, never sent) |
| 10 | nit | Editorial `app.js` unaffected by the new `reason` events | Positive confirmation — no change |

Dismissed (not real): the `_readMs`/`performance` usage (no issue) and "the reason stream has no
amount line" (by design — an amount-parse failure surfaces on the PO line).

Re-verified after the fixes: `tsc` clean, `node --check dash.js` clean, routes intact
(`/`, `/landing`, `/dash.js` → 200), path-traversal blocked (`/../../etc/passwd` → 404, no body), and
the clean reason stream + VERIFIED verdict still resolve end-to-end.

## Notes / honest limits

- The four screenshots are headless captures of the dashboard via a `?demo=` replay hook (so the long
  conversation renders without per-stage model latency); the **functional** behavior — real read → real
  reasoning stream → real grounded explanation → real settle path — is proven by the live `/api/verify`
  and `/api/explain` transcripts above. The demo hook uses copy captured verbatim from real runs and is
  visual-QA-only.
- Inbox/History/Vendors/Settings are intentionally stubs; the landing repurpose, identity/mesh detail,
  and voice are **not** in this round (C9-2 and later).
