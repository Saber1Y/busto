# Custos — Air-Gapped Agentic Settlement

> Reads vendor invoices **locally** via the QVAC SDK, verifies them against an internal ERP with on-device tool-calling + RAG, and stages **real on-chain USD₮ settlement** — **zero cloud, zero data leakage.** Built for QVAC Hackathon I (Tether).

**Team:** Tim (`@winsznx`) + Anu (`@svector`) · **Track:** General Purpose (≤32 GB) + Build in Public · **License:** Apache-2.0

All AI inference (LLM, multimodal, OCR, embeddings/RAG) runs through **`@qvac/sdk`**. The only remote calls are non-AI blockchain endpoints, fully disclosed in [`remote_apis.json`](./remote_apis.json).

## Hardware (two-node P2P mesh)

| Node | Role | Machine | Inference |
|---|---|---|---|
| **Edge** "AP Clerk" | UI · routing · holds keys · human approve+sign | MacBook Pro 13″ · Intel i5 · 16 GB · macOS 15.7.7 | QVAC CPU |
| **Orchestrator** "Vault" | heavy multimodal LLM · OCR · RAG · tool calling | MacBook Pro 14″ 2021 · M1 Pro · 32 GB · macOS 26.5.1 | QVAC Metal |

Connected by QVAC's built-in P2P (Holepunch) — the Intel node *delegates* heavy inference to the M1 over an E2E-encrypted link.

## Quickstart (smoke test — C0)

Requires **Node ≥ 22.17** and **npm ≥ 10.9**.

```bash
npm install            # then: npm i @qvac/sdk
# on the M1 Pro:
CUSTOS_NODE=orchestrator npm run smoke
# on the Intel Mac:
CUSTOS_NODE=edge npm run smoke
```

Each run prints one JSONL metrics row (`load_ms`, `ttft_ms`, `tok_per_sec`) — the seed of our auditable inference log.

## Status

Building in public. See `Custos-PRD.md` for the full design and `Custos-Threat-Model.md` for the 100-vector security model.
