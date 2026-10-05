// Busto · C3 demo — seed a real SQLite ERP, then produce DETERMINISTIC PASS/REJECT
// verdicts for a clean invoice and three adversarial variants. Also demonstrates
// QVAC native tool-calling (the LLM gathers facts; the verdict is computed in code).
import { embed as qvacEmbed, loadModel, unloadModel, close, GTE_LARGE_FP16 } from "@qvac/sdk";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { loadEnvSafe, logInference, type InvoiceExtraction } from "../packages/shared/src/index.ts";
import { openErp, ensureSchema, seedErp, type EmbedFn } from "../packages/orchestrator/src/erp.ts";
import { computeVerdict } from "../packages/orchestrator/src/verdict.ts";
import { runVerificationAgent } from "../packages/orchestrator/src/tools.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(REPO, "data/erp.db");

loadEnvSafe();
mkdirSync(resolve(REPO, "data"), { recursive: true });
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) rmSync(f, { force: true });

const db = openErp(DB_PATH);
ensureSchema(db);

console.log("→ loading GTE-large (embeddings) and seeding ERP + PO vector store...");
const gteId = await loadModel({ modelSrc: GTE_LARGE_FP16, modelConfig: { gpuLayers: 99, device: "gpu" } });
const embed: EmbedFn = async (t) => (await qvacEmbed({ modelId: gteId, text: t })).embedding;
await seedErp(db, embed);
logInference({ node: "orchestrator", op: "embed", model: "GTE_LARGE_FP16", delegated: false, event: "seed-po-embeddings count=3" });

const CLEAN: InvoiceExtraction = {
  vendorName: "ACME Robotics Ltd",
  invoiceAmount: "5,000.00",
  currency: "USDT",
  dueDate: "2026-07-15",
  providedWallet: "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
  lineItems: [
    { description: "Industrial servo motors (NEMA-34)", quantity: "10", unitPrice: "350.00", amount: "3,500.00" },
    { description: "On-site installation & calibration", quantity: "1", unitPrice: "1,200.00", amount: "1,200.00" },
    { description: "Extended warranty (12 months)", quantity: "1", unitPrice: "300.00", amount: "300.00" },
  ],
};

const cases = [
  { label: "CLEAN (expect PASS)", ref: "INV-1042", x: CLEAN },
  { label: "wrong vendor (expect REJECT)", ref: "INV-9001", x: { ...CLEAN, vendorName: "Unknown Vendor Inc" } },
  { label: "amount != PO (expect REJECT)", ref: "INV-9002", x: { ...CLEAN, invoiceAmount: "7,777.00" } },
  { label: "poisoned wallet (expect REJECT)", ref: "INV-9003", x: { ...CLEAN, providedWallet: "0x6B175474E89094C44Da98b954EedeAC495271d0F" } },
  { label: "C2 OCR-mangled wallet (expect REJECT)", ref: "INV-9004", x: { ...CLEAN, providedWallet: "Ox8balfl09551bD432803012645Ac136ddd6" } },
];

console.log("\n=== Deterministic verdicts ===");
for (const c of cases) {
  const v = await computeVerdict(db, c.x, c.ref, embed);
  console.log(`\n[${c.label}]  ref=${c.ref}  ->  ${v.decision}`);
  for (const r of v.reasons) console.log("    " + r);
  console.log(`    matchedPO=${v.matchedPO}  knownWallet=${v.knownWallet}`);
  logInference({ node: "orchestrator", op: "verdict", model: "deterministic", delegated: false, event: `${v.decision} ${c.ref}` });
}

console.log("\n=== QVAC native tool-calling (Qwen3-1.7B) on the clean invoice ===");
const trace = await runVerificationAgent(db, CLEAN, embed, { maxTurns: 5 });
if (trace.length === 0) console.log("  (model emitted no tool calls)");
for (const t of trace) {
  console.log(`  → ${t.name}(${JSON.stringify(t.arguments)}) = ${JSON.stringify(t.result).slice(0, 180)}`);
}
logInference({ node: "orchestrator", op: "tool-calling", model: "QWEN3_1_7B_INST_Q4", delegated: false, event: `agent tool-calls=${trace.length}` });

await unloadModel({ modelId: gteId });
db.close();
await close();
console.log("\n✅ C3 done.");
process.exit(0);
