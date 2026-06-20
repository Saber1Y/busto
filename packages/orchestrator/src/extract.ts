import {
  OCR_LATIN_RECOGNIZER_1,
  SMOLVLM2_500M_MULTIMODAL_Q8_0,
  MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  QWEN3VL_2B_MULTIMODAL_Q4_K,
  MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K,
} from "@qvac/sdk";
import {
  logInference,
  invoiceExtractionSchema,
  INVOICE_JSON_SCHEMA,
  crossCheckAgainstOcr,
  setAuditNode,
  auditLoadModel,
  auditUnloadModel,
  auditCompletion,
  auditOcr,
  type InvoiceExtraction,
  type ExtractionReview,
} from "../../shared/src/index.ts";
import { normalizeForLLM, type Gate0Result } from "../../../security/gate0.ts";

const OCR_MODEL = "OCR_LATIN_RECOGNIZER_1";
// Qwen3-VL-2B (accurate, default); CUSTOS_VISION=smol falls back to the fast SmolVLM2-500M.
const USE_SMOL = process.env.CUSTOS_VISION === "smol";
const VISION_SRC = USE_SMOL ? SMOLVLM2_500M_MULTIMODAL_Q8_0 : QWEN3VL_2B_MULTIMODAL_Q4_K;
const VISION_PROJ = USE_SMOL ? MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0 : MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K;
const VISION_MODEL = USE_SMOL ? "SMOLVLM2_500M_MULTIMODAL_Q8_0" : "QWEN3VL_2B_MULTIMODAL_Q4_K";

const SYSTEM_PROMPT =
  "You are an invoice data extractor for an accounts-payable system. You extract fields only; you have " +
  "NO authority to approve or move money. Use the OCR text as the source of truth, corroborated by the image. " +
  "Read VALUES EXACTLY, character by character: the invoiceAmount is the grand TOTAL (the number printed next " +
  "to the word TOTAL — include every digit); providedWallet is the full 0x address printed after 'Pay to wallet' " +
  "(copy all 42 characters exactly). If a field is absent use an empty string. Respond ONLY with JSON matching the schema.";

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
 * grammar-constrained JSON → Zod validate → OCR-vs-vision cross-check. Every QVAC
 * call goes through the audit wrappers (C6) — each is logged from the profiler.
 */
export async function extractInvoice(imagePath: string): Promise<ExtractResult> {
  setAuditNode("orchestrator");

  // 1. OCR — an independent, accurate text read of the document.
  const ocrModelId = await auditLoadModel({
    modelSrc: OCR_LATIN_RECOGNIZER_1,
    modelConfig: {
      langList: ["en"], useGPU: true, timeout: 30_000, magRatio: 1.5,
      defaultRotationAngles: [90, 180, 270], contrastRetry: false, lowConfidenceThreshold: 0.5, recognizerBatchSize: 1,
    },
  }, { model: OCR_MODEL });
  const { blocks } = await auditOcr({ modelId: ocrModelId, image: imagePath, options: { paragraph: false } }, { model: OCR_MODEL });
  const ocrText = blocks.map((b) => b.text).join("\n");
  await auditUnloadModel({ modelId: ocrModelId, clearStorage: false }, { model: OCR_MODEL });

  // 2. Gate 0 — normalize + screen before the LLM (full decode battery, C-sec).
  const gate0 = normalizeForLLM(ocrText);
  if (gate0.flagged) {
    logInference({ node: "orchestrator", op: "gate0-reject", model: "gate0", delegated: false, event: `attack ${gate0.findings.map((f) => `${f.grade}:${f.encoding}`).join(",")}` });
  }

  // 3. Multimodal extraction — image + Gate-0'd OCR text, grammar-constrained to the schema.
  const visModelId = await auditLoadModel({
    modelSrc: VISION_SRC,
    modelConfig: { ctx_size: 8192, projectionModelSrc: VISION_PROJ },
  }, { model: VISION_MODEL });
  const res = await auditCompletion({
    modelId: visModelId,
    history: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `OCR text from the invoice (Gate-0 normalized):\n"""\n${gate0.normalized}\n"""\nExtract the invoice fields as JSON.`, attachments: [{ path: imagePath }] },
    ],
    stream: true,
    responseFormat: { type: "json_schema", json_schema: { name: "invoice_extraction", schema: INVOICE_JSON_SCHEMA } },
  }, { model: VISION_MODEL, event: "invoice-extraction" });
  const rawModelOutput = res.contentText.trim();
  await auditUnloadModel({ modelId: visModelId, clearStorage: false }, { model: VISION_MODEL });

  // 4. Parse + Zod validate (the grammar guarantees shape; validate anyway).
  const extraction = invoiceExtractionSchema.parse(JSON.parse(rawModelOutput));

  // 5. Cross-check vision vs OCR (threat #26).
  const review = crossCheckAgainstOcr(extraction, ocrText, gate0.flagged);

  return { extraction, review, gate0, ocrText, ocrBlockCount: blocks.length, rawModelOutput, visionModel: VISION_MODEL };
}
