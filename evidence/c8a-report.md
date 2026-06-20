# Custos — C8a Report · On-device explainer (grounded)

**Phase:** C8a · a read-only assistant that explains the current invoice's verdict to a
non-technical clerk. It explains; it never makes, changes, or authorizes anything.

## What shipped
[packages/orchestrator/src/explain.ts](../packages/orchestrator/src/explain.ts) —
`explainInvoice(question, context)`. Read-only by construction: it receives the
already-computed `context` (verdict + gate results + ERP facts) and returns prose. It has
no DB or settlement surface and does not re-run verification.

- The **question is untrusted text** → screened through Gate 0 (`normalizeForLLM`); a
  flagged question is refused safely.
- Runs **Qwen3-1.7B** (`QWEN3_1_7B_INST_Q4`) through the **C6 audit wrapper** — every call
  lands in [inference-log.jsonl](./inference-log.jsonl) (`event:"explain"`, `metrics_source:"profiler-raw"`, `gpu`).
- `predict` capped at 400; `/no_think` + a strip pass keep Qwen3's reasoning out of the
  answer.
- Grounding system prompt injects the facts as data and forbids deciding: "Use ONLY the
  FACTS… you do NOT make decisions, change the verdict, or authorize payment."

## Proven on real verdicts (`npm run c8a:demo`)
The demo computes a **real** verdict (`computeVerdict`) for each case, then explains it.

| Case | Verdict | Q → A (excerpt) |
|---|---|---|
| Amount mismatch (4,242) | REJECT | "Why was this blocked?" → "no open Purchase Order matching the amount of 4,242 USDT for Acme Robotics Ltd… this mismatch prevented approval." |
| Injection invoice | REJECT | "What happened?" → "rejected because it contained an obfuscated/decoded imperative in the document text… flagged by Gate-0." |
| Clean (1 USD₮) | PASS | "What happens if I approve?" → "1 USDT will be credited to Acme Robotics Ltd… A human approval is required before the payment is finalized." |
| — | PASS | "What does Custos do?" → grounded summary of the vendor/amount/wallet/duplicate checks. |
| None loaded | — | "Is this safe to pay?" → "Load an invoice first." (no LLM call) |

## Design notes
- **Facts, not authority.** The agent is handed the verdict + ERP facts and produces an
  explanation. Even a prompt-injected *question* cannot move money — the agent has no tool
  that does.
- **Grounded to the loaded invoice.** The prompt restricts the model to the provided facts
  and tells it to say what it can and cannot see; out-of-scope questions don't invent ERP data.
- UI wiring is C8b — this phase proves the agent logic + grounding only.
