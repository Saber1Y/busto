import {
  loadModel,
  unloadModel,
  completion,
  ocr,
  OCR_LATIN_RECOGNIZER_1,
  SMOLVLM2_500M_MULTIMODAL_Q8_0,
  MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
} from "@qvac/sdk";
import {
  logInference,
  invoiceExtractionSchema,
  INVOICE_JSON_SCHEMA,
  crossCheckAgainstOcr,
  type InvoiceExtraction,
  type ExtractionReview,
} from "../../shared/src/index.ts";
import { normalizeForLLM, type Gate0Result } from "../../../security/gate0.ts";

const OCR_MODEL = "OCR_LATIN_RECOGNIZER_1";
// SmolVLM2-500M per the SDK's multimodal example (fast). Documented accuracy upgrade:
// QWEN3VL_2B_MULTIMODAL_Q4_K + MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K (see evidence/p0-report.md §3).
const VISION_MODEL = "SMOLVLM2_500M_MULTIMODAL_Q8_0";

const SYSTEM_PROMPT =
  "You are an invoice data extractor for an accounts-payable system. You extract fields only; " +
  "you have NO authority to approve or move money. Use the provided OCR text as the source of truth " +
  "for values, corroborated by the image. Copy amounts exactly as written. If a field is absent, use an " +
  "empty string. Respond ONLY with JSON matching the required schema.";

export interface ExtractResult {
  extraction: InvoiceExtraction;
  review: ExtractionReview;
  gate0: Gate0Result;
  ocrText: string;
  ocrBlockCount: number;
  rawModelOutput: string;
  visionModel: string;
}

/**
 * C2 extraction pipeline (Orchestrator / M1): OCR → Gate-0 → multimodal
 * grammar-constrained JSON → Zod validate → OCR-vs-vision cross-check.
 */
export async function extractInvoice(imagePath: string): Promise<ExtractResult> {
  // 1. OCR — an independent, accurate text read of the document.
  const tOcr = performance.now();
  const ocrModelId = await loadModel({
    modelSrc: OCR_LATIN_RECOGNIZER_1,
    modelConfig: {
      langList: ["en"],
      useGPU: true,
      timeout: 30_000,
      magRatio: 1.5,
      defaultRotationAngles: [90, 180, 270],
      contrastRetry: false,
      lowConfidenceThreshold: 0.5,
      recognizerBatchSize: 1,
    },
  });
  const { blocks, stats } = ocr({ modelId: ocrModelId, image: imagePath, options: { paragraph: false } });
  const ocrBlocks = await blocks;
  const ocrStats = await stats;
  const ocrText = ocrBlocks.map((b: { text: string }) => b.text).join("\n");
  await unloadModel({ modelId: ocrModelId, clearStorage: false });
  logInference({
    node: "orchestrator",
    op: "ocr",
    model: OCR_MODEL,
    delegated: false,
    wallTotalMs: ocrStats?.totalTime ?? performance.now() - tOcr,
    event: `ocr blocks=${ocrBlocks.length}`,
  });

  // 2. Gate 0 — normalize + screen before the LLM (full decode battery, C-sec).
  const gate0 = normalizeForLLM(ocrText);
  if (gate0.flagged) {
    logInference({
      node: "orchestrator", op: "gate0-reject", model: "gate0", delegated: false,
      event: `attack ${gate0.findings.map((f) => `${f.grade}:${f.encoding}`).join(",")}`,
    });
  }

  // 3. Multimodal extraction — image + Gate-0'd OCR text, grammar-constrained to the schema.
  const visModelId = await loadModel({
    modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
    modelConfig: { ctx_size: 4096, projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0 },
  });
  const tGen = performance.now();
  const run = completion({
    modelId: visModelId,
    history: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `OCR text from the invoice (Gate-0 normalized):\n"""\n${gate0.normalized}\n"""\nExtract the invoice fields as JSON.`,
        attachments: [{ path: imagePath }],
      },
    ],
    stream: true,
    responseFormat: { type: "json_schema", json_schema: { name: "invoice_extraction", schema: INVOICE_JSON_SCHEMA } },
  });
  let wallTtftMs: number | null = null;
  for await (const ev of run.events) {
    if (ev.type === "contentDelta" && wallTtftMs === null) wallTtftMs = performance.now() - tGen;
  }
  const final = await run.final;
  const wallTotalMs = performance.now() - tGen;
  const rawModelOutput = final.contentText.trim();
  await unloadModel({ modelId: visModelId, clearStorage: false });
  logInference({
    node: "orchestrator",
    op: "completion",
    model: VISION_MODEL,
    delegated: false,
    stats: final.stats,
    wallTtftMs,
    wallTotalMs,
    event: "invoice-extraction",
  });

  // 4. Parse + Zod validate (the grammar guarantees shape; validate anyway).
  const extraction = invoiceExtractionSchema.parse(JSON.parse(rawModelOutput));

  // 5. Cross-check vision vs OCR (threat #26).
  const review = crossCheckAgainstOcr(extraction, ocrText, gate0.flagged);

  return { extraction, review, gate0, ocrText, ocrBlockCount: ocrBlocks.length, rawModelOutput, visionModel: VISION_MODEL };
}
