import { z } from "zod";

// Invoice extraction boundary (PRD §6 step 2). Numeric fields are kept "as written"
// (strings) for fidelity + grammar-friendliness; canonical minor-unit math happens
// later in C3/C4 against the ERP — never trusting the document.
export const lineItemSchema = z.object({
  description: z.string(),
  quantity: z.string(),
  unitPrice: z.string(),
  amount: z.string(),
});

export const invoiceExtractionSchema = z.object({
  vendorName: z.string(),
  invoiceAmount: z.string(),
  currency: z.string(),
  dueDate: z.string(),
  providedWallet: z.string(),
  lineItems: z.array(lineItemSchema),
});

export type InvoiceExtraction = z.infer<typeof invoiceExtractionSchema>;

// Grammar-facing JSON Schema for the SDK's `responseFormat: { type: "json_schema" }`.
// Hand-written to stay simple (all-required strings, additionalProperties:false — no
// anyOf/null that the llama.cpp grammar dislikes) and kept in sync with the Zod schema.
export const INVOICE_JSON_SCHEMA = {
  type: "object",
  properties: {
    vendorName: { type: "string" },
    invoiceAmount: { type: "string" },
    currency: { type: "string" },
    dueDate: { type: "string" },
    providedWallet: { type: "string" },
    lineItems: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          quantity: { type: "string" },
          unitPrice: { type: "string" },
          amount: { type: "string" },
        },
        required: ["description", "quantity", "unitPrice", "amount"],
        additionalProperties: false,
      },
    },
  },
  required: ["vendorName", "invoiceAmount", "currency", "dueDate", "providedWallet", "lineItems"],
  additionalProperties: false,
} as const;

export interface ExtractionReview {
  needsReview: boolean;
  reasons: string[];
  checks: { amountInOcr: boolean; vendorInOcr: boolean; walletInOcr: boolean };
}

const digits = (s: string): string => s.replace(/[^0-9]/g, "");

/**
 * Cross-check the vision extraction against the independent OCR text (Threat-Model
 * #26: adversarial OCR/vision perturbation, e.g. 5000 -> 50000). A field the OCR
 * text does not corroborate is marked needs-review and must NOT auto-settle.
 */
export function crossCheckAgainstOcr(
  x: InvoiceExtraction,
  ocrText: string,
  gate0Flagged: boolean,
): ExtractionReview {
  const hayLower = ocrText.toLowerCase();
  const hayDigits = digits(ocrText);

  const amtDigits = digits(x.invoiceAmount);
  const amountInOcr = amtDigits.length >= 2 && hayDigits.includes(amtDigits);

  const vendorTokens = x.vendorName.toLowerCase().split(/\s+/).filter((t) => t.length >= 3);
  const vendorInOcr = vendorTokens.length > 0 && vendorTokens.some((t) => hayLower.includes(t));

  const wallet = x.providedWallet.toLowerCase().trim();
  // OCR often mangles long hex; corroborate on a prefix rather than exact equality.
  const walletInOcr = wallet.length >= 8 && hayLower.replace(/\s+/g, "").includes(wallet.slice(0, 8));

  const reasons: string[] = [];
  if (!amountInOcr) reasons.push("invoiceAmount not found in OCR text (possible OCR/vision mismatch — threat #26)");
  if (!vendorInOcr) reasons.push("vendorName not corroborated by OCR text");
  if (!walletInOcr) reasons.push("providedWallet not corroborated by OCR text");
  if (gate0Flagged) reasons.push("Gate-0 flagged a decoded imperative in the document text");

  return { needsReview: reasons.length > 0, reasons, checks: { amountInOcr, vendorInOcr, walletInOcr } };
}
