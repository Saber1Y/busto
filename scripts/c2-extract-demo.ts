// Busto · C2 demo — run the extraction pipeline on a real sample invoice and
// print the validated JSON + OCR-vs-vision cross-check.
import { close } from "@qvac/sdk";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { loadEnvSafe } from "../packages/shared/src/index.ts";
import { extractInvoice } from "../packages/orchestrator/src/extract.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const image = process.argv[2] ?? resolve(REPO, "data/sample/acme_invoice.png");

loadEnvSafe();
if (!existsSync(image)) {
  console.error(`missing image: ${image}  (generate it: node scripts/gen-invoice.ts)`);
  process.exit(1);
}

console.log(`=== C2 invoice extraction · ${image} ===\n`);
const r = await extractInvoice(image);

console.log("--- OCR raw text ---\n" + r.ocrText + "\n");
console.log(`--- Gate-0 --- findings: ${JSON.stringify(r.gate0.findings)} · flagged: ${r.gate0.flagged}\n`);
console.log("--- validated extraction (Zod) ---");
console.log(JSON.stringify(r.extraction, null, 2));
console.log("\n--- cross-check (OCR vs vision, threat #26) ---");
console.log(JSON.stringify(r.review, null, 2));
console.log(`\nvision model: ${r.visionModel} · OCR blocks: ${r.ocrBlockCount}`);
console.log(r.review.needsReview ? "⚠️  NEEDS REVIEW — would NOT auto-settle." : "✅ all fields corroborated by OCR.");

await close();
process.exit(0);
