# CLAUDE.md — Custos

> You are the build agent for **Custos**. This file is authoritative and loads every session. Read it fully, then read the source-of-truth docs before doing anything.

## What Custos is

An **air-gapped agentic settlement** system. It reads a vendor invoice **locally** (QVAC OCR + multimodal LLM), verifies it against an internal ERP (QVAC tool-calling + RAG), and stages **real on-chain USD₮ settlement** via Tether's WDK — **zero cloud, zero data leakage.** Hackathon: QVAC Hackathon I (Tether/DoraHacks). Team: Tim (`@winsznx`) + Anu (`@svector`). License: **Apache-2.0**.

## Source of truth — READ FIRST, every session

1. **`Custos-PRD.md`** — full design, architecture, build order (C0–C7 + C-sec). Authoritative.
2. **`Custos-Threat-Model.md`** — the 5 gates, Gate-0 encoding battery, 100 attack vectors. Any code you write must preserve these gates.
3. **`HACKATHON.md`** — the full hackathon brief: rules, tracks, **judging criteria**, prizes, validation stages, deadlines, build-in-public. Read it for **what wins** — optimize every decision toward these criteria.
4. **`README.md`** — setup + hardware.
4. **`evidence/p0-report.md`** (after C0) — **locked ground truth from real hardware**: exact model IDs (Qwen3-VL-2B multimodal + mmproj, GTE-large embeddings, OCR CRAFT+Latin), real API names (`startQVACProvider`, `account.transfer({token,recipient,amount})`), and profiler stats fields (`generatedTokens` — NOT `completionTokens` — `timeToFirstToken`, `tokensPerSecond`). The installed SDK (0.13.5) is the ground truth, not doc references.

If anything you're about to do contradicts these, STOP and ask. Do not silently diverge.

## External docs — fetch and consult (do not guess APIs)

- QVAC SDK: **https://docs.qvac.tether.io** (loadModel, completion, tool calling, multimodal, `startQVACProvider`/delegate, heartbeat, profiler, `@qvac/ocr-onnx`, embeddings)
- WDK: **https://docs.wdk.tether.io** (`@tetherto/wdk`, `@tetherto/wdk-wallet-evm`, `@tetherto/wdk-secret-manager`; Sepolia test USD₮ via Pimlico/Candide faucets)

**Never invent a model ID, package export, or method name.** Verify it from the installed package (`node -e`, read `node_modules`) or the docs. If unverified, say so.

## Hardware / runtime (two-node mesh)

| Node | Role | Machine | Inference |
|---|---|---|---|
| **Orchestrator** "Vault" | heavy LLM, OCR, RAG, tool calling, builds PaymentIntent — **no keys** | M1 Pro · 32 GB · macOS 26.5.1 (arm64) | QVAC **Metal** |
| **Edge** "AP Clerk" | UI, routing, **holds WDK keys**, human approve + sign | Intel i5 · 16 GB · macOS 15.7.7 (x64) | QVAC **CPU** |

Develop primarily on the **M1 Pro**. The Edge package runs on the **Intel** for P2P tests (C1) and holds the wallet. Node ≥ 22.17, npm ≥ 10.9.

## HARD RULES (non-negotiable)

1. **All AI inference goes through `@qvac/sdk`.** LLM, multimodal, OCR, embeddings/RAG — no exceptions, no cloud AI APIs, ever.
2. **No mocks, no stub data, no demo fakery.** Real QVAC inference, real on-chain test USD₮, real SQLite, real files. If you can't do it for real yet, stop and say so — do not fake it.
3. **Production-grade from day one.** Typed (TypeScript), small modules, Zod-validated boundaries, parameterized SQL, errors handled.
4. **Keys live ONLY on the Edge node** (WDK self-custodial via `@tetherto/wdk-secret-manager`). The Orchestrator has **no** key API surface. Testnet only — never mainnet.
5. **Disclose every remote call** in `remote_apis.json`. Only **non-AI** services allowed (Sepolia RPC, optional WDK indexer). Inference must read as 100% local QVAC.
6. **Every QVAC call is logged** to `evidence/inference-log.jsonl` via the profiler (node, delegated?, model, prompt/completion tokens, TTFT, tok/s, load/unload). Metrics come from the profiler raw — never hand-write a number.
7. **Secrets never touch git.** Seeds in `.env` / secret-manager. `.gitignore` already blocks `secrets/ *.seed *.key *.gguf`.

## THE 5 GATES — preserve in all code (see threat model)

- **Gate 0** — Input Normalization & Decode: normalize + decode obfuscated text (Morse/base64/homoglyph/zero-width/nested) **before** the LLM; a decoded imperative is flagged + logged + REJECTED, never executed.
- **Gate 1** — Role bounding: the LLM extracts + proposes only; it has no settlement authority.
- **Gate 2** — Deterministic truth: vendor / PO / wallet come from the **SQLite ERP**, never the document.
- **Gate 3** — Hard recipient re-check on the key-holder: `intent.to === DB.known_wallet` (plain code, not the LLM) before signing.
- **Gate 4** — Human approval on the Edge node.
- **Gate 5** — On-chain safety: pinned chainId + token address, minor-unit/decimals math, EIP-55 checksum, exact-amount transfer (no unbounded approve), N confirmations, MEV-protected RPC.

A payment is impossible unless it clears every gate. No single component (least of all the LLM) can move funds.

## PER-PHASE RITUAL (do this for every component)

1. **Flow first (no code):** restate the mini data-flow + failure modes for this component, in a few lines. 
2. **Smallest slice:** implement the minimum that proves the component. Don't 1-shot; don't build ahead into the next phase.
3. **Prove it for real:** run it, show the actual output, append the QVAC rows to `evidence/inference-log.jsonl`.
4. **Explain choices:** 2–4 lines on the design decisions you made.
5. **Commit:** `git commit` with a clear `CN: …` message.
6. **STOP.** End your turn and wait for confirmation before the next component. Never auto-advance phases.

## Repo conventions

```
custos/
  packages/
    edge/          # Intel: UI + 1B routing + P2P consumer + WDK signer (keys)
    orchestrator/  # M1: provider + OCR + multimodal LLM + RAG + tools
    shared/        # PaymentIntent + log + types; Gate-0 normalizer lives here or in security/
  security/        # Gate-0 normalizer + adversarial corpus
  data/            # seed ERP + sample invoices (clean + adversarial)
  evidence/        # inference-log.jsonl/.csv, remote_apis.json, hardware/, p0-report.md
  scripts/         # smoke.js etc.
```
ESM (`"type": "module"`). Prefer `better-sqlite3` + `sqlite-vec`. Keep the UI barebones — backend correctness over polish.

## ANTI-GOALS (do not do)

- Don't add any cloud AI / hosted inference.
- Don't fabricate metrics, models, or "it works" claims — show real output.
- Don't put keys or signing on the Orchestrator.
- Don't skip the audit log or `remote_apis.json`.
- Don't 1-shot multiple phases. One component, prove, stop.
- Don't weaken or bypass a gate for convenience.

## Build order

**C0 (P0 gates)** → **C1** P2P bridge → **C2** multimodal extraction → **C3** ERP + verification tools → **C-sec** Gate-0 battery → **C4** WDK settlement → **C5** Edge UI → **C6** evidence/logging → **C7** ship (video + submit). Gate-0 (C-sec) lands **before** C4 so real money is only wired on a hardened pipeline.

## Phase-specific notes

- **C1 P2P networking:** the delegated round-trip needs the two machines to actually connect. **Same WiFi/LAN works** — hyperswarm discovers local peers and connects directly over the subnet. The failure mode is **two processes on the same host** (localhost hairpin → `HOLEPUNCH_ABORTED`/`PEER_NOT_FOUND`). If a same-LAN cross-machine run still aborts, put one Mac on a different network (e.g. phone hotspot → different NAT) or configure real `swarmRelays`. Never claim the delegated round-trip until it runs across two machines (Hard Rule 2).
- **C5 UI design source:** use `DESIGN.md` (the provided style reference) + the rules given at C5 time for the Edge UI's visual language. Keep the UI barebones-but-intentional.
- **Before the repo goes public (C7):** delete `DESIGN.md` and the empty `qvachack.md` — they are references/strays, not Custos artifacts, and the static review shouldn't see them.