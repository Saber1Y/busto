// Busto · C6 evidence — run a full extraction with the QVAC profiler enabled and
// every call routed through the audit wrappers, proving the inference log is complete
// (load → ocr → unload → load → completion → unload) and profiler-backed. Exports the
// raw profiler summary to evidence/profiler-summary.txt.
import { close } from "@qvac/sdk";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { loadEnvSafe, enableQvacAudit, exportProfilerSummary } from "../packages/shared/src/index.ts";
import { extractInvoice } from "../packages/orchestrator/src/extract.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
loadEnvSafe();
enableQvacAudit(); // QVAC profiler ON before any model loads

const img = resolve(REPO, "data/sample/ui-clean.png");
console.log("→ audited extraction (every QVAC call logged from the profiler)…");
const r = await extractInvoice(img);
console.log(`  extracted: ${r.extraction.vendorName} · ${r.extraction.invoiceAmount} ${r.extraction.currency} · ${r.visionModel}`);

const summary = exportProfilerSummary();
writeFileSync(resolve(REPO, "evidence/profiler-summary.txt"), summary + "\n");
console.log("\n--- QVAC profiler summary (raw → evidence/profiler-summary.txt) ---\n" + summary);

await close();
process.exit(0);
