# Custos — P0 Bootstrap Report (C0)

**Phase:** C0 (P0 gates) · **Node under test:** Orchestrator "Vault" (M1 Pro · 32 GB · macOS 26.5.1 · arm64 · QVAC Metal)
**Date:** 2026-06-20 · **Scope:** verification + scaffolding only — **no feature code written this phase.**

> All metrics in this report come from real runs on real hardware (Hard Rule 2 + 6). Nothing is mocked. Where a fact could not be confirmed for real, it is labelled. Full external-API research is in [`p0-research.md`](./p0-research.md); the full model catalog is in [`qvac-catalog.tsv`](./qvac-catalog.tsv).

---

## 0. P0 gate scorecard

| # | Gate | Verdict | Evidence |
|---|------|---------|----------|
| 1 | **Environment** (Node ≥ 22.17, npm ≥ 10.9, macOS) | ✅ **PASS** | §1 — node v24.14.1 / npm 11.12.1 / macOS 26.5.1 arm64 |
| 2 | **QVAC smoke** (real Metal inference, profiler metrics) | ✅ **PASS** | §2 — real load/TTFT/tok-s captured, raw stats locked |
| 3 | **Model catalog** (vision+mmproj, embeddings, OCR) | ✅ **PASS** | §3 — 426 constants enumerated from installed 0.13.5 |
| 4 | **P2P delegation docs** (provider/delegate/heartbeat) | ✅ **PASS** | §4 — signatures quoted from official docs |
| 5 | **WDK wallet** (install, account, balance read) | ✅ **PASS** | §5 — wallet `0x5C6C…Be13`, balance read OK |

Supporting: Sepolia RPC reachable (balance read succeeded); seed stored only in gitignored `.env`; `.gitignore` blocks secrets/seeds/keys/gguf.

---

## 1. Environment

| Check | Required | Found | Verdict |
|---|---|---|---|
| `node -v` | ≥ 22.17 | **v24.14.1** | ✅ |
| `npm -v` | ≥ 10.9 | **11.12.1** | ✅ |
| `sw_vers` ProductVersion | macOS 26.5.1 (expected) | **26.5.1** (Build 25F80) | ✅ |
| `uname -m` | arm64 | **arm64** | ✅ |

Node is well above the floor — **no nvm action required.** (If it had been too old: `nvm install 22.17 && nvm use 22.17`.)

**Installed SDKs (versions pinned for reproducibility):**

| Package | Version | Notes |
|---|---|---|
| `@qvac/sdk` | **0.13.5** | PRD cites v0.11 — drift flagged (§7). 150 transitive pkgs incl. native ggml/llama/onnx engines + Holepunch `bare-*` runtime. |
| `@qvac/ocr-onnx` | 0.6.0 | hard dep of the SDK; present in `node_modules`. |
| `@tetherto/wdk` | 1.0.0-beta.12 | orchestrator |
| `@tetherto/wdk-wallet` | 1.0.0-beta.11 | base wallet |
| `@tetherto/wdk-wallet-evm` | 1.0.0-beta.13 | EVM wallet (Sepolia) |
| `@tetherto/wdk-secret-manager` | 1.0.0-beta.3 | **Bare-native** (see §5 caveat) |
| `@tetherto/wdk-failover-provider` | 1.0.0-beta.2 | multi-RPC failover |

---

## 2. QVAC smoke (Orchestrator / M1 Metal)

Command: `CUSTOS_NODE=orchestrator npm run smoke` (run twice — first run cold-downloads the 773 MB `Llama-3.2-1B-Instruct-Q4_0.gguf` from the QVAC registry into `~/.qvac/models/`).

**Result: real Metal (`backendDevice: "gpu"`) inference, both runs exit 0.** Model output was a coherent 3-point answer (full text in the run log). Two real runs:

| Run | `load_ms` | TTFT (raw `timeToFirstToken`) | `tokensPerSecond` (raw) | `promptTokens` | `generatedTokens` | device |
|---|---|---|---|---|---|---|
| **1 — cold** (incl. 773 MB GGUF download) | 348 511 | 461.9 ms | 99.02 | 55 | 116 | gpu |
| **2 — warm** (local cache) | **2 782** (server `loadModel` 1 619) | **139.8 ms** | **111.58** | 55 | 99 | gpu |

**Warm baseline for the inference log: load ≈ 2.78 s, TTFT ≈ 140 ms, ≈ 111.6 tok/s on M1 Metal.** Both rows are appended to [`inference-log.jsonl`](./inference-log.jsonl) using **profiler-raw** values (see note below). The first cold run's `load_ms` is dominated by the one-time download and is not the load baseline.

Verbatim `--- raw stats ---` block (warm run 2), proving the field names below:
```json
{ "timeToFirstToken": 139.76, "tokensPerSecond": 111.57645128279108,
  "cacheTokens": 0, "promptTokens": 55, "generatedTokens": 99, "backendDevice": "gpu" }
```

**Locked stats field names (for the C6 audit logger).** Source: installed `@qvac/sdk@0.13.5` `.d.ts` (`completionStatsSchema`), confirmed against the live `--- raw stats ---` block above.

| Metric | **Exact field on `final.stats`** | Type |
|---|---|---|
| Prompt tokens | `promptTokens` | number |
| **Output tokens** | **`generatedTokens`** ⚠️ *not* `completionTokens` | number |
| Time-to-first-token | `timeToFirstToken` | number (ms) |
| Throughput | `tokensPerSecond` | number |
| KV-cache reuse | `cacheTokens` | number |
| Backend device | `backendDevice` | `"cpu"` \| `"gpu"` |

Load timing is a **separate** struct (`LoadTimingStats { modelInitializationTimeMs, totalLoadTimeMs }`), not on `CompletionStats`. Profiler event kinds: `rpc | handler | download | load | delegation`; P2P delegation breakdown fields: `connectionMs, requestStringifyMs, serverWaitMs, responseJsonParseMs, totalDelegationMs` — these matter for the C1 offload measurement.

> ⚠️ **Bug in the provided `scripts/smoke.js`:** it reads `stats.completionTokens ?? stats.completion_tokens ?? stats.tokens` for output tokens — **none** of these match the real field `generatedTokens`, so `completion_tokens` logs as `null` and `tok_per_sec` silently falls back to the `chars/4` approximation. The C6 logger (and ideally `smoke.js`) must read `generatedTokens` / `promptTokens` / `timeToFirstToken` / `tokensPerSecond`. Captured raw stats above are the ground truth.

Streaming/API shape confirmed matches `smoke.js`: `completion({...})` returns a `CompletionRun` synchronously; iterate `run.events` (`event.type === "contentDelta"`, `event.text`); `await run.final` → `{ contentText, stats, stopReason, ... }`. Runtime note: `modelType: "llm"` is now a **deprecated alias** for `"llamacpp-completion"` (use the new value in C2+).

---

## 3. Model catalog (chosen IDs — from installed 0.13.5, not docs)

426 model constants are exported (full dump: [`qvac-catalog.tsv`](./qvac-catalog.tsv)). Models resolve via `registry://` (QVAC P2P Hyperswarm registry + s3/hf mirrors) — **not** `huggingface.co/qvac` (that org hosts only research repos). Selections for Custos:

| Role | Chosen constant(s) | Why |
|---|---|---|
| **Edge routing LLM** | `LLAMA_3_2_1B_INST_Q4_0` | the smoke/baseline model; tiny CPU-friendly classifier on Intel. Tool-calling variant: `LLAMA_TOOL_CALLING_1B_INST_Q4_K`. |
| **Orchestrator vision LLM (invoice read)** — primary | `QWEN3VL_2B_MULTIMODAL_Q4_K` + `MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K` | Qwen3-VL 2B — strongest small document/invoice VLM; ~2 GB, fits 32 GB Metal with headroom. |
| …more capable alt | `GEMMA4_4B_MULTIMODAL_Q4_K_M` + `MMPROJ_GEMMA4_4B_MULTIMODAL_F16` | Gemma-4 4B multimodal. |
| …fast/low-RAM fallback (docs default) | `SMOLVLM2_500M_MULTIMODAL_Q8_0` + `MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0` | 500 M; the QVAC multimodal quickstart model. |
| **Embeddings (RAG)** | `GTE_LARGE_FP16` (primary) or `EMBEDDINGGEMMA_300M_Q8_0` | `embed({ modelId, text })`. |
| **OCR** (`@qvac/ocr-onnx`) | detector `OCR_CRAFT_DETECTOR` + recognizer `OCR_LATIN_RECOGNIZER_1` | high-level `ocr({ modelId, image })`; detector and recognizer are **separate** constants (corrects docs). Dedicated VLM-OCR option: `OCR_0_6B_MULTIMODAL_Q4_K_M` + `MMPROJ_OCR_0_6B_MULTIMODAL_F16`. |

**How a vision model is loaded** (projection passed in `modelConfig`):
```js
const modelId = await loadModel({
  modelSrc: QWEN3VL_2B_MULTIMODAL_Q4_K,
  modelConfig: { ctx_size: 4096, projectionModelSrc: MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K },
});
// image via chat history: history:[{ role:"user", content:"…", attachments:[{ path:imgPath }] }]
```
`@qvac/ocr-onnx@0.6.0` confirmed installed; plugin id `PLUGIN_OCR = "@qvac/sdk/onnx-ocr/plugin"`. Embeddings/vision/whisper plugins also exported (`PLUGIN_EMBEDDING`, `PLUGIN_VLA`, `PLUGIN_WHISPER`).

---

## 4. QVAC P2P delegation API (C1 reference — docs-verified, no bridge code yet)

> **Correction:** the provider entrypoint is **`startQVACProvider`**, *not* `startProvider`. Source: `docs.qvac.tether.io/p2p-capabilities/delegated-inference/` + `/reference/api/`. All confirmed as real exports of the installed SDK (§3 API check).

**Provider (M1) — start + stable identity + allowlist:**
```js
process.env.QVAC_HYPERSWARM_SEED = seed; // 64-char hex → deterministic, pinnable publicKey
const res = await startQVACProvider({
  firewall: { mode: "allow", publicKeys: [allowedConsumerPublicKey] }, // only documented ACL primitive
});
// res.publicKey → the key consumers pin
```
**Consumer (Intel) — delegate at load time:**
```js
const modelId = await loadModel({
  modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
  delegate: { providerPublicKey, timeout: 60_000, fallbackToLocal: true, forceNewConnection: true },
}); // → Promise<string> & { requestId }
```
**Health check:**
```js
await heartbeat({ delegate: { providerPublicKey, timeout, healthCheckTimeout } }); // → HeartbeatResponse
```
**Resilience facts that shape C1:** delegated **streams are severed on `suspend()` and are NOT auto-resumed** — they must be re-issued after `resume()`. `requestId` (on the returned promise) is used for `cancel()`. No SDK-level session/replay nonce exists — the firewall allowlist + pinned `QVAC_HYPERSWARM_SEED` identity are the security primitives (maps to threat-model #75/#80/#83). `fallbackToLocal: true` is what powers the degraded-mode requirement — and Custos must **never auto-settle** in degraded mode (threat #82).

Unverified from docs (confirm in C1 by reading `node_modules/@qvac/sdk/dist`): full `HeartbeatResponse` / `ProvideParams` / `LoadModelOptions.delegate` type bodies; whether a `topic` delegate field exists.

---

## 5. WDK settlement API + test wallet (C4 reference)

> `@tetherto/wdk-wallet-evm` is the EVM path. Signatures below are quoted from the installed `.d.ts` (ground truth), not assumed.

**Create account on Sepolia + read balances:**
```js
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
const wallet  = new WalletManagerEvm(seed, { provider: rpcUrlOrArray, chainId: 11155111 });
const account = await wallet.getAccount(0);     // WalletAccountEvm
const addr    = account.address;                 // getter
const ethWei  = await account.getBalance();                 // bigint (native, wei)
const usdtRaw = await account.getTokenBalance(tokenAddress); // bigint (base units)
```
Orchestrator-style: `new WDK(seed).registerWallet("ethereum", WalletManagerEvm, { provider })` → `wdk.getAccount("ethereum", 0)`. Static helpers: `WDK.getRandomSeedPhrase(12|24)`, `WDK.isValidSeed(seed)`.

**Transfer USD₮ / ERC-20 — the real method is `transfer()` (NOT `sendTransaction`):**
```js
const { hash, fee } = await account.transfer({ token, recipient, amount }); // EvmTransferOptions
const { fee }       = await account.quoteTransfer({ token, recipient, amount }); // fee-only, no send
```
`sendTransaction`/`quoteSendTransaction` are for **native** ETH only. `approve({token,spender,amount})` throws on a non-zero USDT allowance (reset-to-zero rule) — Custos uses exact-amount `transfer`, no unbounded approve (Gate 5 / threat #65). `account.dispose()` zeroizes the key.

**Throwaway test wallet (created this phase — real, on Sepolia):**

| Field | Value |
|---|---|
| Address | **`0x5C6C9e12D49e28670E00AD1C05f24243ad77Be13`** |
| Chain | Ethereum Sepolia (`chainId 11155111`) |
| RPC used | `https://ethereum-sepolia-rpc.publicnode.com` |
| Native balance read | **OK** — `0 wei` (unfunded), ~1.0 s round-trip |
| Seed | 12-word BIP-39, stored **only** in gitignored `.env` (`CUSTOS_WALLET_SEED`) — never printed/committed |

**Fund it (Sepolia test USD₮ — no real send this phase):**
- Pimlico faucet: `https://dashboard.pimlico.io/test-erc20-faucet`
- Candide faucet: `https://dashboard.candide.dev/faucet`
- Sepolia test USD₮ token: **`0xd077a400968890eacc75cdc901f0356c943e4fdb`** · decimals **6** (doc comment; confirm via on-chain `decimals()` in C4)
- WDK-pinned RPC: `https://sepolia.drpc.org` · MEV-protected alt (Gate 5 / threat #55): `https://rpc-sepolia.flashbots.net`
- WDK warning (verbatim): testnet USD₮ is **not** redeemable and **not** a Tether Token.

**Seed-manager caveat:** `@tetherto/wdk-secret-manager` **fails to import under plain Node** (`require.addon is not a function`) — it's a Holepunch **Bare** native addon (libsodium `crypto_secretbox` + PBKDF2-SHA256). `WDK`/`WalletManagerEvm`/`WalletAccountEvm` import fine in Node; the encrypted seed store (`WdkSecretManager(passKey, salt?).generateAndEncrypt()/decrypt()`) runs under Bare and is wired in C4. For P0 the seed lives in `.env` exactly as instructed. Also: the beta.3 README documents an API the shipped binary doesn't expose — pin and introspect the exact version before writing key code.

---

## 6. Scaffold + repo state

```
custos/
  packages/{edge,orchestrator,shared}/package.json   # @custos/* stubs, ESM, private, Apache-2.0
  security/                                           # Gate-0 normalizer (C-sec)
  data/{sample,adversarial}/                          # invoices (C2/C-sec)
  evidence/                                           # p0-report.md, p0-research.md, qvac-catalog.tsv, inference-log.jsonl, hardware/
  scripts/{smoke.js,catalog.mjs}                      # smoke.js moved here from repo root
  .gitignore  .env.example                            # .gitignore CREATED this phase (was missing)
  .env                                                # gitignored — holds CUSTOS_WALLET_SEED, SEPOLIA_RPC_URL
```
- `scripts/smoke.js` relocated from repo root so `npm run smoke` (→ `node scripts/smoke.js`) resolves.
- `.gitignore` created (blocks `node_modules/ .env* secrets/ *.seed *.key *.gguf *.onnx`).
- WDK was installed/validated in an isolated `/tmp/custos-wdk` to parallelize over the slow link without `node_modules` contention; the project-level WDK install lands on the **Edge** package per topology.

---

## 7. Contradictions & doc issues flagged

1. **Chain: Base vs Ethereum Sepolia.** PRD §4 diagram/Mermaid say *Base Sepolia*; §10/§13/§16 + README + CLAUDE.md + BUILD_PROMPTS say **Ethereum Sepolia**. Operative = **Ethereum Sepolia** (decision text wins). Fix the §4 diagram so static review doesn't flag it.
2. **`scripts/smoke.js` output-token bug** (§2) — reads `completionTokens`, real field is `generatedTokens`. Recommend a one-line fix before C6.
3. **`.gitignore` did not exist** despite Hard Rule 7 / step 7 assuming it. Created.
4. **SDK version drift** — PRD cites v0.11; installed/locked at **0.13.5**.
5. **`startQVACProvider` vs `startProvider`** — PRD §5 + task wording say `startProvider`; real export is **`startQVACProvider`**.
6. **`wdk-secret-manager` is Bare-only** (not importable under Node) — affects where seed-encryption code runs (C4, under Bare).
7. **Stray repo files:** `DESIGN.md` is an unrelated "Heart Aerospace" UI style ref; `qvachack.md` is empty. Recommend removing before the public repo is pushed. (Dir was being edited externally during this phase.)
8. **"5 gates" vs six** — CLAUDE.md header says "5 GATES" but enumerates Gate 0–5 (six). Cosmetic.
9. **`remote_apis.json` location** — README → root, CLAUDE.md tree → `evidence/`. Deferred to C6.

---

## 8. Intel (Edge) node — exact commands for the CPU baseline

Run on the Intel Mac ("AP Clerk" · macOS 15.7.7 · x64 · QVAC CPU). The delta between that row and the M1 row in §2 is our first honest offload datapoint.

```bash
# 0. preflight (need Node ≥ 22.17, npm ≥ 10.9, macOS ≥ 14.0 for QVAC)
node -v ; npm -v ; sw_vers ; uname -m

# 1. get the repo onto the Intel box, then from the custos/ root:
npm install
npm i @qvac/sdk            # large native tree — allow time on a slow link

# 2. CPU smoke (QVAC CPU path). Run TWICE — first run cold-downloads the GGUF:
CUSTOS_NODE=edge npm run smoke
CUSTOS_NODE=edge npm run smoke

# 3. append the second (warm) JSONL row to the shared log:
CUSTOS_NODE=edge npm run smoke 2>/dev/null >> evidence/inference-log.jsonl
```
Expect `platform: darwin/x64`, `backendDevice: "cpu"`, and materially higher `timeToFirstToken` / lower `tokensPerSecond` than the M1 Metal row — that gap is the C1 delegation justification.

---

*End P0 report. Next: C1 — the QVAC P2P bridge (real Intel→M1 delegated inference). One component, prove for real, stop.*
