# Custos — Hardware (two-node P2P mesh)

Real specs of the machines used. Add `system_profiler` screenshots alongside this
file (`m1pro-profiler.png`, `intel2019-profiler.png`) — capture with:
`system_profiler SPHardwareDataType SPDisplaysDataType` (⌘⇧4 the window, or
`screencapture`).

## Orchestrator "Vault" — M1 Pro (captured here, real)

| | |
|---|---|
| Model | MacBook Pro 14″ 2021 · `MacBookPro18,3` |
| Chip | **Apple M1 Pro** — 8 CPU cores (6 performance + 2 efficiency) |
| GPU | Apple M1 Pro — **14 GPU cores** · Metal 4 |
| Memory | **32 GB** |
| Storage | 460 GB (55 GB free at capture) |
| OS | macOS **26.5.1** (25F80) · arm64 |
| Runtime | Node v24.14.1 · npm 11.12.1 |
| QVAC inference | **Metal** (GPU-accelerated) — confirmed `backendDevice: "gpu"` in the log |

Role: heavy multimodal LLM (Qwen3-VL-2B), `@qvac/ocr-onnx`, embeddings + RAG, tool
calling, P2P **provider**. Holds **no keys**.

## Edge "AP Clerk" — Intel 2019 (declared; capture on the box)

| | |
|---|---|
| Model | MacBook Pro 13″ 2019 |
| Chip | Intel Core i5 (x86-64) |
| GPU | integrated — **QVAC CPU-only** (macOS-x64 has no QVAC iGPU acceleration) |
| Memory | 16 GB |
| OS | macOS 15.7.7 · x86-64 (≥ 14.0 required for QVAC) |
| QVAC inference | **CPU** |

Role: UI (the Edge console), Llama-3.2-1B routing, P2P **consumer**, **holds the WDK
wallet keys**, human approve + sign. Cannot run the heavy multimodal model at usable
speed on CPU — which is *why* it delegates to the Metal M1 over QVAC P2P (a real
hardware necessity, not staged; the inference log shows the CPU→Metal offload).

> To capture the Intel row for real: run `node -v && npm -v && sw_vers && uname -m`
> and `system_profiler SPHardwareDataType` on the Intel Mac, and paste the smoke
> baseline (`CUSTOS_NODE=edge npm run smoke`) — the delta vs the M1 row is the offload datapoint.
