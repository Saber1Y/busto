# Custos — C6 Report · Evidence + Logging

**Phase:** C6 · PRD §12 · Threat-model H (#99–100). The evidence bundle is airtight.

## A logging wrapper around EVERY QVAC call

[packages/shared/src/audit.ts](../packages/shared/src/audit.ts) — `auditLoadModel`,
`auditUnloadModel`, `auditCompletion`, `auditEmbed`, `auditOcr`. Each wraps the SDK call
and appends one row to [inference-log.jsonl](./inference-log.jsonl) **+ mirrored to
[.csv](./inference-log.csv)**. Token / TTFT / throughput come **straight from the SDK
profiler** (`CompletionStats`: `generatedTokens`, `timeToFirstToken`, `tokensPerSecond`,
`backendDevice`) — `metrics_source: "profiler-raw"`, never hand-written (#99). The C2
pipeline now routes every call through these wrappers.

A full audited extraction (`npm run c6:evidence`) logs the complete, consistent sequence:

```
loadModel   OCR_LATIN_RECOGNIZER_1      load_ms=2236
ocr         OCR_LATIN_RECOGNIZER_1
unloadModel OCR_LATIN_RECOGNIZER_1
loadModel   QWEN3VL_2B_MULTIMODAL_Q4_K  load_ms=3026
completion  QWEN3VL_2B_MULTIMODAL_Q4_K  ttft=12554ms gen_tok=158 tok/s=67.96 dev=gpu src=profiler-raw
unloadModel QWEN3VL_2B_MULTIMODAL_Q4_K
```

The raw QVAC profiler export is written to
[evidence/profiler-summary.txt](./profiler-summary.txt) (model-execution, ttfb,
load/checksum/init timing, server breakdown) — the source of those numbers.

**Log to date:** 102 rows across C0–C5 — `smoke·2 heartbeat·2 loadModel·2 ocr·11
completion·14 embed·1 verdict·26 tool-calling·1 gate0-reject·37 settle-broadcast·2
settle-confirmed·2 unloadModel·2`. Backend `gpu` on the M1 throughout; the C4 settlement
rows carry the real tx hash.

## remote_apis.json
[remote_apis.json](../remote_apis.json) enumerates every remote call — **only non-AI**
(Sepolia RPC send/read, the pinned MEV-protected endpoint, the pinned USD₮ token) — with
the explicit assertion that **inference is 100% local QVAC, zero cloud AI** (#100).

## Hardware
[evidence/hardware/specs.md](./hardware/specs.md) — the M1 Pro captured for real (8 CPU /
14 GPU cores · 32 GB · Metal 4 · macOS 26.5.1) and the Intel node declared (capture its
`system_profiler` + smoke baseline on the box).

## README + LICENSE
[README.md](../README.md) is judge-ready (prerequisites → `npm run serve` → headless
demos → gates → evidence). [LICENSE](../LICENSE) is **Apache-2.0**.

## What's left
- `system_profiler` **screenshots** for both Macs (a manual capture) → `evidence/hardware/*.png`.
- Intel CPU smoke baseline row (`CUSTOS_NODE=edge npm run smoke`) — yours to run on the Intel Mac.
