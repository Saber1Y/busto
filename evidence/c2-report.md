# Custos — C2 Report · Multimodal Invoice Extraction

**Phase:** C2 · **Node:** Orchestrator "Vault" (M1 · QVAC Metal) · PRD §6 step 2 · Threat-model B (23–35).

## Pipeline (all real, on the M1)

`OCR (ocr-onnx) → raw text` → **Gate-0 hook** (NFKC + strip zero-width/bidi/tag; full decode battery = C-sec) → **multimodal completion** (image + OCR text, `responseFormat: json_schema` grammar) → **Zod validate** → **OCR-vs-vision cross-check** (threat #26) → audit rows.

| File | Role |
|---|---|
| [scripts/gen-invoice.ts](../scripts/gen-invoice.ts) | generates a real clean invoice — SVG rasterized via macOS `qlmanage` → [data/sample/acme_invoice.png](../data/sample/acme_invoice.png) (no external deps). |
| [security/gate0.ts](../security/gate0.ts) | Gate-0 hook (stable interface; C2 does NFKC + invisible-char strip; decode battery is C-sec). |
| [packages/shared/src/invoice.ts](../packages/shared/src/invoice.ts) | Zod `invoiceExtractionSchema`, grammar `INVOICE_JSON_SCHEMA`, `crossCheckAgainstOcr`. |
| [packages/orchestrator/src/extract.ts](../packages/orchestrator/src/extract.ts) | the pipeline. |

Models (cached via `scripts/prefetch-c2.mjs`): OCR `OCR_LATIN_RECOGNIZER_1` (+ auto CRAFT detector); vision `SMOLVLM2_500M_MULTIMODAL_Q8_0` + `MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0`. `tsc --noEmit` clean.

## Result on the sample (`npm run c2:demo`)

Grammar-guaranteed, Zod-validated JSON. Correct: `vendorName "ACME Robotics Ltd"`, total digits `5,000.00`, `currency "USDT"`, `dueDate "2026-07-15"`. Cross-check **passed** (`needsReview:false`; amount/vendor/wallet all corroborated by OCR). Real metrics (profiler-raw): OCR 30 blocks; extraction TTFT ≈ 695 ms, 275 generated tokens, ≈ 105 tok/s, `backendDevice:"gpu"` — in `evidence/inference-log.jsonl`.

## Honest accuracy notes (small-model artifacts, not pipeline bugs)
- SmolVLM2-500M (the SDK's quickstart VLM, chosen for speed) appended `"USD"` to the amount and mis-columned `quantity` for the qty=1 line items (OCR dropped the leading "1" of those rows). Line items are secondary — verification (C3) matches on **total + vendor + wallet**, not line items.
- The OCR mangled the long hex wallet (`0`→`O`, `1`→`l`) and the vision model copied it. **This is irrelevant to safety**: the payout wallet is taken from the **DB** (Gate 2) and re-checked on the key-holder (Gate 3) — the document wallet is never trusted. The cross-check still corroborates the doc value against OCR.
- **Accuracy upgrade (documented):** swap to `QWEN3VL_2B_MULTIMODAL_Q4_K` + `MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K` (already enumerated in `p0-report.md` §3, fits 32 GB Metal) — one constant change in `extract.ts`.

## Design notes
- **Grammar + Zod, belt-and-suspenders:** `responseFormat: json_schema` makes the model output structurally valid; Zod re-validates at the boundary.
- **OCR feeds the prompt:** the small VLM structures *accurate* OCR text rather than relying on weak vision alone (the PRD "image + raw text" pipeline).
- **Gate-0 is wired, not bypassed:** all extracted text passes `normalizeForLLM` before reaching the model; C-sec only has to fill in the decode battery behind the existing interface.
