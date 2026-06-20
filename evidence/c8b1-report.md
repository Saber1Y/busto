# C8b-1 — Productized verification console

Goal: turn the Edge SPA into a tool a non-technical AP clerk uses, not a landing page.
Per-invoice verification view, the agent's reasoning made visible, and the C8a explainer
wired in as an "Ask about this invoice" panel. Read-only — settlement stays exactly as
proven in C4 (hold-to-authorize Gate 4, real on-chain send is the human's action).

All inference is on-device. All claims below are backed by the live transcripts in this file
(captured against `npm run serve`, wallet configured) and the two screenshots.

---

## What shipped

**Verification view (`#bandPipeline`).** Per invoice, the console now shows:
- The extracted fields (vendor · invoice total · due date · wallet on document) read on-device
  by `QWEN3VL_2B_MULTIMODAL_Q4_K`.
- A plain-English **verification checklist** that resolves each step as the verdict computes —
  *No hidden instructions · Vendor recognised · Matches a purchase order · Pays the verified
  wallet · Not a duplicate* — each with a pass/fail value (Jetstream Blue for pass, Onyx for fail).
- The **6-gate ladder** (G0–G5) with operator-facing names and per-gate reasons.
- The verdict headline in the hero: **VERIFIED** / **BLOCKED**.

**Ask panel (`#bandAsk`).** The C8a `explainInvoice` agent, wired as a read-only assistant:
- Context-aware suggested questions — BLOCKED → *"Why was this blocked?"*; PASS → *"What happens
  if I approve?"*; always *"Is this vendor known?"* / *"What does Custos do?"*.
- Free-text input. The answer streams token-by-token (`POST /api/explain`, NDJSON), rendered in
  the Heart Aerospace type with a blinking cursor while thinking.
- The question is screened through Gate 0 server-side before it reaches the LLM; the panel cannot
  change the verdict or move money (copy states this explicitly).

**Operator microcopy.** "Verify an invoice", "What we found", "Ask about this invoice",
"Authorize payment", "HOLD TO AUTHORIZE PAYMENT", "Payment settled — view on-chain",
"Verify another invoice". No dev language on the surface.

**Settlement untouched.** Gate 4 hold-to-authorize and the real WDK settlement path from C4 are
unchanged. The VERIFIED final returns `jobId` + the deterministic `intent`; `/api/approve` is the
only path that signs, and it only fires on a deliberate human hold. Not auto-fired here.

---

## Proof — clean invoice (real pipeline)

`POST /api/verify {"sample":"ui-clean"}` → on-device read, then every gate clears:

```
extraction: ACME ROBOTICS LTD · 1.00 USDT · due 2026-07-15 · wallet read on-device
            (read with QWEN3VL_2B_MULTIMODAL_Q4_K, 16 OCR blocks)
verdict:    PASS
  ok: Gate-0: no obfuscated imperative detected
  ok: vendor "Acme Robotics Ltd" exists and is active
  ok: PO PO-TEST matches 1.00 USDT for "Acme Robotics Ltd"
  ok: provided wallet matches DB known_wallet (corroborates DB known_wallet, 0 OCR corrections)
  ok: invoice_ref "INV-UI-MQMXERLO" not previously settled
final:      VERIFIED  jobId=474b4c08-…  intent → 1000000 (1.00 USD₮) to the DB-verified wallet
```

`POST /api/explain {jobId, "What happens if I approve?"}` → streamed, grounded answer:

> If you approve, the invoice will be processed and the specified amount (1 USDT) will be
> transferred to the vendor's wallet. The transaction will be verified against the database and
> confirmed as unique. The payout wallet matches the one recorded in the system.

Hold-to-authorize → `/api/approve` settle path intact (the real on-chain send is the operator's
in-browser action and was **not** auto-fired here, per the C4 boundary).

Screenshot: [evidence/ui/c8b1-clean-verified.png](ui/c8b1-clean-verified.png)

---

## Proof — fraud invoice (payment wallet swapped)

`ui-fraud` is a genuine Acme invoice with the payout wallet swapped to an attacker address.
`POST /api/verify {"sample":"ui-fraud"}` → vendor and amount still match, recipient gate refuses:

```
extraction: ACME ROBOTICS LTD · 1.00 USDT · wallet 0x6B17…1d0F (attacker), read on-device
verdict:    REJECT
  ok: vendor "Acme Robotics Ltd" exists and is active
  ok: PO PO-TEST matches 1.00 USDT for "Acme Robotics Ltd"
  REJECT: wallet check failed — provided wallet does not corroborate DB known_wallet (drift 38)
final:      BLOCKED  blockedGate=G3 (Recipient)  jobId=29e032c5-…
```

`POST /api/explain {jobId, "Why was this blocked?"}` → streamed, grounded answer:

> The invoice was blocked because the wallet provided did not match the known wallet for the
> vendor, resulting in a drift of 38. Despite other checks passing, the wallet verification
> failed, leading to the rejection.

No funds moved — the block is on the recipient gate, before any human approval is offered.

Screenshot: [evidence/ui/c8b1-fraud-blocked.png](ui/c8b1-fraud-blocked.png)

---

## Audit & security

- Every explainer call goes through the C6 audit wrapper → `evidence/inference-log.{jsonl,csv}`
  (profiler-backed: load/TTFT/gen ms, tokens, tok/s, backend device).
- The clerk's question is untrusted text and is normalized through Gate 0 before the LLM; an
  instruction-like question is refused, not followed.
- `tsc --noEmit` clean.
- No secrets in the repo: `.env` / `*.seed` / `*.key` gitignored; the only "seed" strings in the
  tracked set are the env-var name `CUSTOS_WALLET_SEED` and the DB-seeding log event.

## Notes / honest limits

- Screenshots are captured headless against the deterministic `?preview=` hook so the productized
  layout renders without model latency; the **functional** behavior (real read → gates → grounded
  streamed explanation) is proven by the live `/api/verify` + `/api/explain` transcripts above.
- The on-device vision read can misread a character in the 42-char wallet (OCR); the recipient
  gate uses OCR-tolerant matching against the ERP, so a clean invoice still corroborates (drift 0)
  while the swapped wallet is far out of tolerance (drift 38) and is blocked.

Identity/mesh bar and history are intentionally **not** built here — that is C8b-2.
