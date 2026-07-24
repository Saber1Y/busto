// Prove the cross-check actually BLOCKS a real OCR-vs-vision disagreement (threat #26),
// not just that the clean samples pass. Pure logic — no models. Feeds computeVerdict a
// clean, PO-matching extraction with three different review states.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { rmSync } from "node:fs";
import { openErp, ensureSchema, seedErp } from "../../packages/orchestrator/src/erp.ts";
import { computeVerdict } from "../../packages/orchestrator/src/verdict.ts";
import type { InvoiceExtraction, ExtractionReview } from "../../packages/shared/src/index.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB = resolve(REPO, "data/crosscheck-test.db");
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
const db = openErp(DB);
ensureSchema(db);
await seedErp(db); // no embed — exact match only

const CLEAN: InvoiceExtraction = {
  vendorName: "Acme Robotics Ltd", invoiceAmount: "1.00", currency: "USDT", dueDate: "2026-07-15",
  providedWallet: "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
  lineItems: [{ description: "unit", quantity: "1", unitPrice: "1.00", amount: "1.00" }],
};
const review = (amountInOcr: boolean, vendorInOcr: boolean, walletInOcr: boolean): ExtractionReview => ({
  needsReview: !(amountInOcr && vendorInOcr && walletInOcr), reasons: [], checks: { amountInOcr, vendorInOcr, walletInOcr },
});

const cases = [
  { label: "reads AGREE (amount+vendor+wallet all corroborate)", review: review(true, true, true), expect: "PASS" },
  { label: "AMOUNT disagreement (vision≠OCR, threat #26)", review: review(false, true, true), expect: "REJECT" },
  { label: "VENDOR disagreement", review: review(true, false, true), expect: "REJECT" },
  { label: "WALLET-only mismatch (OCR-mangled hex — must NOT block; Gate 3's job)", review: review(true, true, false), expect: "PASS" },
  { label: "no review supplied (synthetic extraction, no OCR)", review: undefined, expect: "PASS" },
];

let fails = 0;
for (const c of cases) {
  const v = await computeVerdict(db, CLEAN, `INV-CC-${c.label.length}-${Math.round(performance.now())}`, undefined, false, c.review);
  const ok = v.decision === c.expect;
  if (!ok) fails++;
  const reason = v.reasons.find((r) => r.includes("disagree")) ?? "";
  console.log(`${ok ? "PASS" : "*** FAIL ***"}  ${c.expect.padEnd(6)} got ${v.decision.padEnd(6)}  crossCheckOk=${v.checks.crossCheckOk}  — ${c.label}`);
  if (reason) console.log(`         reason: ${reason.replace(/^REJECT:\s*/, "")}`);
}
db.close();
console.log(`\n${fails === 0 ? "CROSS-CHECK FIRES CORRECTLY (blocks disagreement, ignores OCR hex noise)" : fails + " FAILED"}`);
process.exit(fails === 0 ? 0 : 1);
