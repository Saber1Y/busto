# Custos — C3 Report · ERP + Verification → Deterministic Verdict

**Phase:** C3 · **Node:** Orchestrator "Vault" (M1 · QVAC Metal) · PRD §6 step 3 + §11 · Threat-model C (36–54).

## What shipped

| File | Role |
|---|---|
| [packages/orchestrator/src/erp.ts](../packages/orchestrator/src/erp.ts) | real SQLite ERP (better-sqlite3): `vendors`, `purchase_orders`, `settlements` + `sqlite-vec` PO-description vectors. Deterministic, parameterized-SQL query functions. |
| [packages/shared/src/address.ts](../packages/shared/src/address.ts) | EIP-55 (keccak256 via `@noble/hashes`): `isValidAddress`, `toChecksumAddress`, `isChecksumValid`, `addressEquals`. |
| [packages/shared/src/money.ts](../packages/shared/src/money.ts) | canonical integer **minor-units** parse/format (USD₮ = 6 decimals). |
| [packages/orchestrator/src/verdict.ts](../packages/orchestrator/src/verdict.ts) | **`computeVerdict`** — the deterministic PASS/REJECT gate. |
| [packages/orchestrator/src/tools.ts](../packages/orchestrator/src/tools.ts) | QVAC native tool definitions + the LLM verification agent. |

Deterministic functions: `lookupVendor` (NFKC canonical-name exact match — homoglyph spoofs simply don't match, #36), `matchPurchaseOrder` (EXACT vendor+amount+currency authorizes; `sqlite-vec` RAG only *suggests*, #37/#38), `verifyWallet` (EIP-55 equality, #45/#48/#49), `isDuplicateInvoice` (#41). `tsc --noEmit` clean.

## Result (`npm run c3:demo`) — all five correct

| Case | Verdict | Why |
|---|---|---|
| CLEAN | ✅ **PASS** | Acme active · PO-1042 matches 5,000.00 USDT · wallet == DB · not duplicate |
| wrong vendor | 🛑 **REJECT** | "Unknown Vendor Inc" not in ERP |
| amount ≠ PO (7,777) | 🛑 **REJECT** | no exact PO; RAG *nearest* PO-1042 (d=0.151) but exact gate rejects |
| poisoned wallet (DAI addr) | 🛑 **REJECT** | valid checksum but ≠ DB known_wallet (vendor+PO still matched) |
| C2 OCR-mangled wallet | 🛑 **REJECT** | not a valid 0x40-hex address |

**QVAC native tool-calling (Qwen3-1.7B) — real on-device agentic chain:** the LLM called `lookup_vendor("ACME Robotics Ltd")` → used the returned `vendorId:1` → `match_purchase_order` (matched PO-1042 + RAG candidates) → `verify_wallet` (match:true). Trace + verdict rows in [inference-log.jsonl](./inference-log.jsonl).

## Design notes
- **The LLM never decides.** It calls tools to gather facts (threat #18: handlers are deterministic, DB-derived); `computeVerdict` makes the PASS/REJECT call in plain code from the DB facts. Confidence/argument-spoofing can't bypass it (#53).
- **Exact match authorizes; RAG suggests.** `sqlite-vec` KNN over GTE-large embeddings retrieves candidate POs by description, but only an exact vendor+amount+currency+open match passes (#38). The 7,777 case shows RAG pointing at PO-1042 while the gate still rejects.
- **Money is integer minor-units, never float** (#39/#60): "5,000.00 USD" → `5000000000n` @6dp; over-precise inputs are rejected, not rounded.
- **Wallet equality is EIP-55, not string compare** (#48): both sides normalized to checksum form; invalid/mangled addresses (C2's OCR output) fail closed.
- **Same functions back the tools and the verdict** — one source of truth; no drift between what the LLM sees and what the gate enforces.

## Wiring to C4
On a PASS, `computeVerdict` returns `{ matchedPO, knownWallet }` — C4 builds the PaymentIntent with the recipient = **`knownWallet` (from the DB, not the document)**, re-checks `intent.to === knownWallet` at the key-holder (Gate 3), and records a `settlements` row (UNIQUE `invoice_ref` already enforced) to block replays.
