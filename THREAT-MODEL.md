# Threat model — 100 vectors mapped to the gates

This maps the 100-vector catalogue to the six gates and the code that enforces each. The
full per-vector tables (attack → defense → tier) are in
[Custos-Threat-Model.md](./Custos-Threat-Model.md) — the single source. Encoding-battery
results: [ADVERSARIAL-TESTING.md](./ADVERSARIAL-TESTING.md) (17/17). Gate model:
[SECURITY.md](./SECURITY.md).

## Vectors by gate

| Gate | Vectors | Enforced in | Defense |
|---|---|---|---|
| **G0 — Input decode** | 1–22 (prompt injection & obfuscation: Morse, base64/32, hex, ROT13, leet, homoglyph, zero-width, nested) | [security/gate0.ts](./security/gate0.ts) | NFKC + strip invisibles + decode battery (depth 3); decoded imperative → flag + REJECT + log |
| **G1 — Role bounding** | 1, 16, 20, 22 (system-prompt leak, jailbreak, context-flood) | [extract.ts](./packages/orchestrator/src/extract.ts) | model output is a Zod object via `responseFormat: json_schema`; no money-moving tool; policy recomputed deterministically |
| **G2 — Deterministic truth** | 23–35 (multimodal/document channel), 36–54 (vendor/PO/wallet/amount) | [verdict.ts](./packages/orchestrator/src/verdict.ts), [erp.ts](./packages/orchestrator/src/erp.ts), [money.ts](./packages/shared/src/money.ts) | DB exact match; canonical names; integer minor-units; currency exact; OCR↔vision cross-check. RAG can only *suggest*, never authorize — and in the shipped server it is **inert**: the app seeds without embeddings, so the KNN branch never runs (exercised in `npm run c3:demo`) |
| **G3 — Recipient re-check** | 45, 46, 48, 49, 61, 62 (lookalike, checksum bypass, TOCTOU, clipboard) | [settle.ts](./packages/edge/src/settle.ts), [address.ts](./packages/shared/src/address.ts) | EIP-55 `addressEquals(intent.to, fresh DB known_wallet)` before signing |
| **G4 — Human approval** | 87, 88, 89 (spoofed dialog, clickjacking, approval fatigue) | [server.ts](./packages/edge/src/server.ts), [ui/](./packages/edge/ui/) | console binds `127.0.0.1` only (loopback — `/api/approve` signs real transfers); explicit hold-to-authorize; one settlement in flight at a time; no `.env` → stops here |
| **G5 — On-chain safety** | 55–74 (MEV, reorg, chain/decimals/token confusion, approve exploit, RPC MITM, nonce/replay) | [settle.ts](./packages/edge/src/settle.ts), [wallet.ts](./packages/edge/src/wallet.ts) | pinned chainId + token; pre-flight balance; exact-amount transfer; N confirmations; disclosed RPC |

## Cross-cutting

| Area | Vectors | Enforced in | Defense |
|---|---|---|---|
| P2P / delegation (Holepunch) | 75–84 | [provider.ts](./packages/orchestrator/src/provider.ts), [consumer.ts](./packages/edge/src/consumer.ts) | pinned provider key via `QVAC_HYPERSWARM_SEED`; firewall allowlist; E2E-encrypted link; consumer sets `fallbackToLocal: false` and **hard-stops** if the provider is unreachable, so there is no degraded path to mis-settle from (#82 satisfied trivially) |
| Key & wallet | 85–92 | [wallet.ts](./packages/edge/src/wallet.ts) | WDK self-custodial; seed in gitignored `.env`; Orchestrator has no key API (#92) |
| Supply chain & model integrity | 93–98 | `package-lock.json`, [tsconfig.json](./tsconfig.json) | pinned versions + lockfile; models load only from the QVAC registry (#94/#95) |
| Audit / log integrity | 99, 100 | [audit.ts](./packages/shared/src/audit.ts), [remote_apis.json](./remote_apis.json) | metrics from the SDK profiler raw (#99); every remote call disclosed, inference 100% local (#100) |

## Where each is proven

- G0 + obfuscation (1–22): `npm run csec:test` → 17/17 ([ADVERSARIAL-TESTING.md](./ADVERSARIAL-TESTING.md)).
- G2/G3 (36–54): `npm run c3:demo` → PASS + 3 REJECT ([evidence/c3-report.md](./evidence/c3-report.md)).
- G3/G4/G5 (55–74): `CUSTOS_APPROVE=I-APPROVE npm run c4:demo` → real tx
  [`0xa3ed0f33…f79cd30`](https://sepolia.etherscan.io/tx/0xa3ed0f33fcfa685287185284079884c0ea0c3a260149443bfd945f083f79cd30),
  plus poisoned/forged/duplicate blocked ([evidence/c4-report.md](./evidence/c4-report.md)).
- P2P (75–84): `npm run c1:demo` ([evidence/c1-report.md](./evidence/c1-report.md)) — runs both roles
  as two processes on **one host**. Check (a), the delegated round-trip, passes (`delegated:true`,
  profiler-raw in the audit log); check (c) still asserts the pre-hard-stop `degradedMode`
  expectation and therefore reports a failure that the current design makes unreachable. Separate
  physical machines require different NATs; that transport step is pending.
- Audit (99–100): [evidence/inference-log.csv](./evidence/inference-log.csv) +
  [profiler-summary.txt](./evidence/profiler-summary.txt) + [remote_apis.json](./remote_apis.json).
