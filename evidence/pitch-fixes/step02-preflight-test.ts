// Step 2(a) proof — force the two pre-flight rejection branches of settleIntent using
// the REAL code path (real WDK wallet, real Sepolia RPC reads), never a mock.
//
// The throwaway wallet (hardhat "test…junk") holds 0 ETH and 0 USD₮ on Sepolia:
//   · amount 1 USD₮ → the USD₮ branch fires first
//   · amount 0 USD₮ → the USD₮ check passes (0 >= 0), so execution reaches the ETH-gas
//     branch, which is the one we need to see name itself.
// Everything else is the production path: Gate 3, the chain/token pins, the replay guard.
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { rmSync } from "node:fs";
import { buildPaymentIntent } from "../../packages/shared/src/index.ts";
import { openErp, ensureSchema, seedErp, lookupVendor } from "../../packages/orchestrator/src/erp.ts";
import { settleIntent } from "../../packages/edge/src/settle.ts";
import { CHAIN } from "../../packages/edge/src/wallet.ts";

process.env.CUSTOS_WALLET_SEED = "test test test test test test test test test test test junk";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DB = resolve(REPO, "data/step2-preflight-test.db");
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });

const db = openErp(DB);
ensureSchema(db);
await seedErp(db);
const acme = lookupVendor(db, "Acme Robotics Ltd");
const poId = (db.prepare("SELECT id FROM purchase_orders WHERE po_number = 'PO-TEST'").get() as { id: number }).id;

const run = async (label: string, amountMinor: bigint, ref: string): Promise<void> => {
  const intent = buildPaymentIntent({
    knownWallet: acme.knownWallet!, amountMinor, token: CHAIN.usdt,
    chainId: CHAIN.id, invoiceRef: ref, memo: "step2 preflight test",
  });
  const r = await settleIntent(db, { intent, vendorId: acme.vendorId!, poId, approve: true, confirmations: 2 });
  console.log(`\n[${label}]`);
  console.log(`  status : ${r.status.toUpperCase()}`);
  console.log(`  reason : ${r.reason}`);
  console.log(`  txHash : ${r.txHash ?? "(none — nothing was broadcast)"}`);
};

console.log(`signer seed → throwaway wallet (0 ETH, 0 USD₮ on Sepolia)`);
await run("A · 1 USD₮ requested, wallet has none", 1_000_000n, "INV-STEP2-USDT");
await run("B · 0 USD₮ requested, so execution reaches the ETH-gas check", 0n, "INV-STEP2-GAS");

db.close();
for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) rmSync(f, { force: true });
process.exit(0);
