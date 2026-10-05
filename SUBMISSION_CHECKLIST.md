# Submission checklist — QVAC Hackathon I (DoraHacks)

## DoraHacks form

| Field | Value |
|---|---|
| Project name | **Busto** |
| One-liner | Air-gapped agentic accounts-payable: reads invoices locally via QVAC, verifies against an internal ERP, settles real on-chain USD₮ — zero cloud. |
| Team | Tim (`@winsznx`) + Anu (`@svector`) |
| Tracks | **General Purpose** (≤32 GB) + **Build in Public** |
| Hashtag | `#Busto` (tag `@QVAC` on every post) |
| Repo | [github.com/winsznx/busto](https://github.com/winsznx/busto) — Apache-2.0 |
| Video | `<unlisted YouTube URL>` (≤5 min) |

## Evidence inventory (in the repo)

- **Real settlement:** [`0xa3ed0f33…f79cd30`](https://sepolia.etherscan.io/tx/0xa3ed0f33fcfa685287185284079884c0ea0c3a260149443bfd945f083f79cd30) (Sepolia, 1 USD₮, block 11,103,356).
- **Audit log:** [evidence/inference-log.jsonl](./evidence/inference-log.jsonl) + [.csv](./evidence/inference-log.csv) (480 rows as of 2026-07-23, profiler-raw, `gpu`; append-only — the count grows with every run, so check the file rather than trusting this number).
- **Profiler export:** [evidence/profiler-summary.txt](./evidence/profiler-summary.txt).
- **Remote calls:** [remote_apis.json](./remote_apis.json) (non-AI only; inference 100% local).
- **Gate-0 battery:** `npm run csec:test` → 17/17 ([ADVERSARIAL-TESTING.md](./ADVERSARIAL-TESTING.md)).
- **Hardware:** [evidence/hardware/specs.md](./evidence/hardware/specs.md).
- **UI screenshots:** [evidence/ui/](./evidence/ui/).
- **Per-phase reports:** `evidence/p0-report.md … c9-…` (one per build phase).
- **Docs:** [README](./README.md), [ARCHITECTURE](./ARCHITECTURE.md), [SECURITY](./SECURITY.md), [THREAT-MODEL](./THREAT-MODEL.md), [LICENSE](./LICENSE) (Apache-2.0).

## Reproduce (judge, no secrets needed)

```bash
npm install && npm i @qvac/sdk @tetherto/wdk-wallet-evm
npm run serve          # http://localhost:4173 — full pipeline + all gates, stops at Gate 4 (demo mode)
npm run csec:test      # Gate-0 battery, 17/17
```
First run downloads the models from the QVAC registry. A real settlement needs your own
funded Sepolia wallet (`BUSTO_WALLET_SEED` in `.env`).

## Human steps (yours)

- [ ] **Two `system_profiler` screenshots** → `evidence/hardware/m1pro-profiler.png`, `evidence/hardware/intel2019-profiler.png`.
- [ ] **Intel CPU baseline row** — on the Intel Mac: `BUSTO_NODE=edge npm run smoke` (run twice); the delta vs the M1 row is the offload datapoint.
- [ ] Optional: run the two-machine P2P bridge (`npm run provider` on M1, `npm run consumer -- <key>` on Intel) and paste output (commands in [evidence/c1-report.md](./evidence/c1-report.md)).
- [ ] **Record the ≤5-min video** ([DEMO_SCRIPT.md](./DEMO_SCRIPT.md)) — terminals + console visible; open the tx live on Etherscan.
- [ ] **Push the repo public** (confirm no `.env`/seed — `git ls-files | grep -E '\.env|seed'` is empty).
- [ ] **Submit** on DoraHacks with the fields above; put `#Busto` in the form; tag `@QVAC`.

## Build-in-Public posts

| Day | Post |
|---|---|
| Join | "shipping **Busto** for @QVAC — confidential accounts-payable that never touches the cloud. #Busto" |
| Bridge | "QVAC P2P delegation working: a hard-stop consumer delegates inference to the provider over an E2E link — `delegated:true`, profiler-raw, in the audit log. Proven single-host; cross-machine transport is the next step. #Busto" |
| Security | "drop a poisoned invoice → Gate 0 decodes the hidden instruction and blocks it. 17/17. #Busto" |
| Settlement | "real test USD₮ settled on Sepolia, behind six gates: `0xa3ed0f33…`. #Busto" |
| Video | "≤5-min demo — read, verify, settle, on-device. #Busto" |
