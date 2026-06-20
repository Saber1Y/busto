# Custos — C1 Report · QVAC P2P Delegation Bridge

**Phase:** C1 · **Node under test:** Orchestrator "Vault" (M1 Pro · macOS 26.5.1 · arm64 · QVAC Metal)
**Built:** a reusable delegation client (TypeScript, run via Node 24 native type-stripping — no build step).

> PRD §6/§7 · Threat-model E (75–84) + #82. Grounded entirely in the installed `@qvac/sdk@0.13.5` (types + bundled `examples/delegated-inference/`), not assumptions.

## What shipped

| File | Role |
|---|---|
| [packages/shared/src/qvac.ts](../packages/shared/src/qvac.ts) | `runCompletion` (stream + profiler stats), `isDelegated(modelId)` — authoritative delegated-vs-fallback check via `getLoadedModelInfo().isDelegated`. |
| [packages/shared/src/log.ts](../packages/shared/src/log.ts) | profiler-backed audit logger — uses the REAL `generatedTokens`/`timeToFirstToken`/`tokensPerSecond` (fixes the `smoke.js` `completionTokens` bug). |
| [packages/shared/src/paths.ts](../packages/shared/src/paths.ts) | repo paths + `loadEnvSafe()` (built-in `process.loadEnvFile`). |
| [packages/orchestrator/src/provider.ts](../packages/orchestrator/src/provider.ts) | M1 provider: `QVAC_HYPERSWARM_SEED` → `startQVACProvider({firewall?})` → prints pinnable `Provider Public Key`. |
| [packages/edge/src/consumer.ts](../packages/edge/src/consumer.ts) | Intel consumer: `heartbeat` → `loadModel({delegate:{providerPublicKey,fallbackToLocal:true}})` → `isDelegated` → `completion` → audit row. Degraded ⇒ `autoSettleBlocked`. |
| [scripts/c1-local-demo.ts](../scripts/c1-local-demo.ts) | two-process M1 proof harness. |

Verified API (corrects earlier docs): provider entrypoint is **`startQVACProvider`** (not `startProvider`); delegate config is `{ providerPublicKey, timeout?, healthCheckTimeout?, fallbackToLocal?, forceNewConnection? }`; **`getLoadedModelInfo({modelId}).isDelegated`** is the authoritative delegated/fallback signal. `tsc --noEmit` is clean (0 errors).

## Proven on the M1 (`npm run c1:demo`)

| Case | Result | Evidence |
|---|---|---|
| Provider identity (stable, pinnable key) | ✅ | `Provider Public Key: d04ab232…778737` (deterministic from seed) |
| **(b) heartbeat detects offline** | ✅ | heartbeat to a bogus/dead key throws → logged `provider-offline` |
| **(c) `fallbackToLocal` degraded + never auto-settle** | ✅ | `isDelegated=false` → `degradedMode=true` → `autoSettleBlocked=true` (threat #82) |
| local M1 baseline | ✅ | TTFT ≈ 60–100 ms, ≈ 140 tok/s, `backendDevice:"gpu"` (real) |

Real rows appended to [inference-log.jsonl](./inference-log.jsonl) with profiler-raw metrics.

## (a) True delegated round-trip — **two-machine gate** (honest limitation)

On a **single host** the delegated round-trip cannot complete: hyperdht reports
`HOLEPUNCH_ABORTED` / `PEER_NOT_FOUND` because two peers behind the **same NAT can't
hairpin** without a swarm relay (`"0 swarm relay(s) configured"`). The provider *announces*
and is *discovered*; only the direct connection fails. The SDK's `swarmRelays` config needs
real relay servers ("mock keys won't work"), which we don't have. This is exactly why the
architecture is two-machine — so the real round-trip is proven across the M1 + Intel, where
the two hosts are on different NATs. Per Hard Rule 2, C1 does **not** claim (a) until that run.

The consumer code is correct and the path is exercised (it attempts delegation, then falls
back) — only the cross-host transport is pending.

## Exact two-machine commands (run these; paste output back)

**On the M1 (Orchestrator / provider):**
```bash
# stable identity → pinnable key. Generate ONCE and save to .env:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"  ->  QVAC_HYPERSWARM_SEED
npm run provider                       # reads QVAC_HYPERSWARM_SEED from .env
#   (or: npm run provider -- <64-hex-seed> [allowedConsumerPubKey])
# Copy the printed "Provider Public Key: <hex>".
```

**On the Intel (Edge / consumer):**
```bash
npm install && npm i @qvac/sdk          # if not already installed
npm run consumer -- <providerPublicKeyFromM1> "Read this invoice total: 5000 USDT"
# Expect: providerOnline:true, delegated:true, degradedMode:false, backend_device on the M1.
```

Then compare the Intel-side delegated row vs an Intel-local row (`CUSTOS_NODE=edge npm run smoke`) — that CPU→Metal delta is the real offload speedup.

## Design notes
- **`isDelegated` gate**, not a guess: degraded mode is detected from the SDK's own model registry, so the "never auto-settle on fallback" rule (threat #82) is enforced deterministically.
- **TypeScript without a build step**: Node 24 strips types natively; `tsc --noEmit` gates types in CI. One ambient declaration ([types/qvac-sdk.d.ts](../types/qvac-sdk.d.ts)) surfaces a real SDK constant that TS 6.0.3 drops from the SDK's 19k-line generated star-export — not a suppression.
- **Logger fixes the smoke.js bug** at the source: audit rows carry real `generatedTokens`, ready for C6.
