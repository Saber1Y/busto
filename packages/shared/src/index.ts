export { REPO_ROOT, LOG_PATH, loadEnvSafe } from "./paths.ts";
export { runCompletion, isDelegated } from "./qvac.ts";
export type { CompletionStats, RunResult } from "./qvac.ts";
export { logInference } from "./log.ts";
export type { InferenceRow, LogOpts } from "./log.ts";
export {
  invoiceExtractionSchema,
  lineItemSchema,
  INVOICE_JSON_SCHEMA,
  crossCheckAgainstOcr,
} from "./invoice.ts";
export type { InvoiceExtraction, ExtractionReview } from "./invoice.ts";
export { isValidAddress, toChecksumAddress, isChecksumValid, addressEquals } from "./address.ts";
export { toMinorUnits, fromMinorUnits } from "./money.ts";

/** 64-char hex Hyperswarm identity seed (NOT a wallet seed). */
export function generateHyperswarmSeed(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex");
}

/** A 64-char lowercase hex string (Hyperswarm public key / seed). */
export function isHex64(s: string | undefined): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/i.test(s);
}
