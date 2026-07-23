// Custos · reset the demo to a clean slate between rehearsals.
//
// Clears uploaded invoice images and re-seeds the ERP (which drops the settlements
// table, so an invoice settled in a previous run can be demoed again).
//
// NEVER touches evidence/ — the inference log is append-only ground truth and is not
// demo state. Sample invoices in data/sample are inputs, not state, and are left alone.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readdirSync, rmSync, existsSync } from "node:fs";
import { openErp, ensureSchema, seedErp } from "../packages/orchestrator/src/erp.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UPLOADS = resolve(REPO, "data/uploads");
const DB_PATH = resolve(REPO, "data/erp.db");

console.log("\nCUSTOS DEMO RESET\n");

let removed = 0;
if (existsSync(UPLOADS)) {
  for (const f of readdirSync(UPLOADS)) {
    if (!f.endsWith(".png")) continue;
    rmSync(resolve(UPLOADS, f), { force: true });
    removed++;
  }
}
console.log(`  uploads   cleared ${removed} .png file(s) from data/uploads`);

const db = openErp(DB_PATH);
ensureSchema(db);
const before = (db.prepare("SELECT COUNT(*) AS n FROM settlements").get() as { n: number }).n;
await seedErp(db); // wipes settlements + purchase_orders + vendors, then re-seeds
const counts = {
  vendors: (db.prepare("SELECT COUNT(*) AS n FROM vendors").get() as { n: number }).n,
  pos: (db.prepare("SELECT COUNT(*) AS n FROM purchase_orders").get() as { n: number }).n,
  settlements: (db.prepare("SELECT COUNT(*) AS n FROM settlements").get() as { n: number }).n,
};
db.close();

console.log(`  erp       re-seeded ${DB_PATH}`);
console.log(`            cleared ${before} prior settlement row(s)`);
console.log(`            now: ${counts.vendors} vendors · ${counts.pos} purchase orders · ${counts.settlements} settlements`);
console.log("  evidence  untouched (the inference log is append-only ground truth)\n");
console.log("Ready. Start the console with `npm run serve`.\n");
process.exit(0);
