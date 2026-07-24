// FIX 2d: prove the preflight clean-sample-settled warning fires. Inserts a settlement for
// the clean sample's deterministic ref, checks isDuplicateInvoice (the exact preflight [5]
// logic), then leaves it for demo:reset to clean. No models.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { openErp, ensureSchema, isDuplicateInvoice, recordSettlement } from "../../packages/orchestrator/src/erp.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ref = `INV-${createHash("sha256").update(readFileSync(resolve(REPO, "data/sample/ui-clean.png"))).digest("hex").slice(0, 12).toUpperCase()}`;
console.log("clean-sample ref (preflight computes this exactly like server.ts):", ref);

const db = openErp(resolve(REPO, "data/erp.db"));
ensureSchema(db);
console.log("BEFORE — isDuplicate:", isDuplicateInvoice(db, ref), "(false on a clean/reset DB)");
const po = db.prepare("SELECT id FROM purchase_orders WHERE po_number='PO-TEST'").get() as { id: number };
recordSettlement(db, po.id, ref, 1_000_000n, "0xTESTHASH", new Date("2026-07-24").toISOString());
const dup = isDuplicateInvoice(db, ref);
db.close();
console.log("AFTER  — isDuplicate:", dup, "→ preflight [5] would", dup ? "FAIL loudly: 'ALREADY SETTLED — run demo:reset'" : "pass");
console.log(dup ? "\nPREFLIGHT WARNING FIRES (run demo:reset to clear the test row)" : "\n*** did not fire ***");
process.exit(dup ? 0 : 1);
