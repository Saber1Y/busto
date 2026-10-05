// Busto · C-sec test — asserts Gate 0 blocks every adversarial Grade A–J, that the
// 4 bypass classics are REJECTed by the verdict, and that a clean invoice still passes
// both. Pure (no models) and fast. Exits non-zero on any failure.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { loadEnvSafe, logInference, type InvoiceExtraction } from "../packages/shared/src/index.ts";
import { normalizeForLLM } from "../security/gate0.ts";
import { openErp, ensureSchema, seedErp, recordSettlement } from "../packages/orchestrator/src/erp.ts";
import { computeVerdict } from "../packages/orchestrator/src/verdict.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADV = resolve(REPO, "data/adversarial");
loadEnvSafe();

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? `  — ${detail}` : ""}`); }
}

// ── 1. Gate-0 encoding battery (Grades A–J) ──────────────────────────────────
console.log("Gate-0 encoding battery — every adversarial input must be BLOCKED + logged:");
for (const file of readdirSync(ADV).filter((f) => f.startsWith("grade-")).sort()) {
  const r = normalizeForLLM(readFileSync(resolve(ADV, file), "utf8"));
  check(`${file.padEnd(26)} blocked  [${r.findings.map((x) => `${x.grade}:${x.encoding}`).join(", ")}]`, r.flagged, "not flagged");
  if (r.flagged) {
    logInference({ node: "orchestrator", op: "gate0-reject", model: "gate0", delegated: false, event: `${file} ${r.findings.map((x) => `${x.grade}:${x.encoding}`).join(",")}` });
  }
}

console.log("\nClean text must NOT be flagged (no false positive on real invoice language):");
const cleanNote = "INVOICE INV-1042 | ACME Robotics Ltd | Total 5,000.00 USDT | Due 2026-07-15 | " +
  "Pay to wallet (Ethereum): 0x8ba1f109551bD432803012645Ac136ddd64DBA72 | Industrial servo motors, on-site installation & calibration, extended warranty. Net 30.";
check("clean invoice not flagged", !normalizeForLLM(cleanNote).flagged, normalizeForLLM(cleanNote).findings.map((x) => x.grade).join(","));

// ── 2. Bypass classics — verdict must REJECT each; clean must PASS ────────────
console.log("\nVerdict bypass classics — each must REJECT; clean control must PASS:");
const readJson = (f: string): { invoiceRef: string; expect: string; extraction: InvoiceExtraction } =>
  JSON.parse(readFileSync(resolve(ADV, f), "utf8"));

const db = openErp(":memory:");
ensureSchema(db);
await seedErp(db); // no embed — exact-match verdict needs no models

const clean = readJson("clean-control.json");
const cleanVerdict = await computeVerdict(db, clean.extraction, clean.invoiceRef);
check("clean-control => PASS", cleanVerdict.decision === "PASS", cleanVerdict.reasons.filter((r) => r.startsWith("REJECT")).join("; "));

// settle INV-1042 so the replay case is genuinely a duplicate
const po = db.prepare("SELECT id, amount_minor FROM purchase_orders WHERE po_number = 'PO-1042'").get() as { id: number; amount_minor: string };
recordSettlement(db, po.id, "INV-1042", BigInt(po.amount_minor), "0xfeed0000000000000000000000000000000000000000000000000000000000ff", "2026-06-20T00:00:00Z");

for (const file of ["classic-homoglyph-vendor.json", "classic-split-amount.json", "classic-duplicate-replay.json", "classic-wallet-lookalike.json"]) {
  const c = readJson(file);
  const v = await computeVerdict(db, c.extraction, c.invoiceRef);
  check(`${file.padEnd(34)} => REJECT`, v.decision === "REJECT", "got PASS");
  logInference({ node: "orchestrator", op: "verdict", model: "deterministic", delegated: false, event: `${v.decision} ${c.invoiceRef} ${file}` });
}
db.close();

// ── summary ──────────────────────────────────────────────────────────────────
console.log(`\n${fail === 0 ? "✅" : "❌"} C-sec: ${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
