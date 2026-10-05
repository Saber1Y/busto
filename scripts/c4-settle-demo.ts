// Busto · C4 demo — REAL test USD₮ settlement on Sepolia, behind every gate.
// Clean verified invoice → on-chain tx hash. Poisoned invoice → blocked, no send.
// Set BUSTO_APPROVE=I-APPROVE to authorize the live send (Gate 4).
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { mkdirSync, rmSync } from "node:fs";
import { loadEnvSafe, logInference, buildPaymentIntent, toMinorUnits, type InvoiceExtraction } from "../packages/shared/src/index.ts";
import { openErp, ensureSchema, seedErp, lookupVendor } from "../packages/orchestrator/src/erp.ts";
import { computeVerdict } from "../packages/orchestrator/src/verdict.ts";
import { openEdgeWallet, CHAIN } from "../packages/edge/src/wallet.ts";
import { settleIntent } from "../packages/edge/src/settle.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DB_PATH = resolve(REPO, "data/erp.db");
const APPROVE = process.env.BUSTO_APPROVE === "I-APPROVE";
const INVOICE_REF = "INV-C4-001";

loadEnvSafe();
mkdirSync(resolve(REPO, "data"), { recursive: true });
for (const f of [DB_PATH, `${DB_PATH}-wal`, `${DB_PATH}-shm`]) rmSync(f, { force: true });

const db = openErp(DB_PATH);
ensureSchema(db);
await seedErp(db); // no embed — exact-match verdict needs no models

// signer + funds (keys on Edge only)
const wallet = await openEdgeWallet();
const ethBal = await wallet.account.getBalance();
const usdtBal = await wallet.account.getTokenBalance(CHAIN.usdt);
console.log(`Edge signer: ${wallet.address}`);
console.log(`  ETH ${(Number(ethBal) / 1e18).toFixed(4)} · USD₮ ${(Number(usdtBal) / 1e6).toFixed(2)} · token ${CHAIN.usdt}`);
console.log(`  approval: ${APPROVE ? "GRANTED (BUSTO_APPROVE=I-APPROVE)" : "NOT granted — Gate 4 will block the send"}\n`);
wallet.dispose();

const acme = lookupVendor(db, "Acme Robotics Ltd");
const poId = (db.prepare("SELECT id FROM purchase_orders WHERE po_number = 'PO-TEST'").get() as { id: number }).id;

// ── 1. CLEAN verified invoice → settle ───────────────────────────────────────
const clean: InvoiceExtraction = {
  vendorName: "ACME Robotics Ltd", invoiceAmount: "1.00", currency: "USDT", dueDate: "2026-07-15",
  providedWallet: "0x8ba1f109551bD432803012645Ac136ddd64DBA72",
  lineItems: [{ description: "C4 live-settlement test order", quantity: "1", unitPrice: "1.00", amount: "1.00" }],
};
console.log("[1] CLEAN invoice — verify then settle:");
const verdict = await computeVerdict(db, clean, INVOICE_REF);
console.log(`    verdict: ${verdict.decision} (PO ${verdict.matchedPO}, knownWallet ${verdict.knownWallet})`);
logInference({ node: "orchestrator", op: "verdict", model: "deterministic", delegated: false, event: `${verdict.decision} ${INVOICE_REF}` });

if (verdict.decision === "PASS" && verdict.knownWallet) {
  const intent = buildPaymentIntent({
    knownWallet: verdict.knownWallet, // recipient from the DB, NOT the document
    amountMinor: toMinorUnits(clean.invoiceAmount, CHAIN.usdtDecimals)!,
    token: CHAIN.usdt, chainId: CHAIN.id, invoiceRef: INVOICE_REF, memo: "Busto settlement PO-TEST",
  });
  console.log(`    intent: to=${intent.to} amount=${intent.amount} (1 USD₮) token=${intent.token} chain=${intent.chainId}`);
  console.log(APPROVE ? "    sending (this is a REAL on-chain transfer)..." : "    (no approval — Gate 4 will block)");
  const r = await settleIntent(db, { intent, vendorId: acme.vendorId!, poId, approve: APPROVE, confirmations: 2 });
  console.log(`    => ${r.status.toUpperCase()}: ${r.reason}`);
  if (r.txHash) console.log(`       tx: ${r.txHash}\n       explorer: ${r.explorerUrl}\n       confirmations: ${r.confirmations}`);

  // ── 3. DUPLICATE replay → blocked ──────────────────────────────────────────
  if (r.status === "settled") {
    console.log("\n[3] DUPLICATE replay of the same invoice_ref:");
    const dup = await settleIntent(db, { intent, vendorId: acme.vendorId!, poId, approve: APPROVE, confirmations: 2 });
    console.log(`    => ${dup.status.toUpperCase()}: ${dup.reason}`);
  }
} else {
  console.log("    clean invoice did not PASS — aborting settle.");
}

// ── 2. POISONED invoice → blocked, no send ───────────────────────────────────
console.log("\n[2] POISONED invoice (wallet-lookalike from C-sec) — verify then attempt settle:");
const poisoned: InvoiceExtraction = { ...clean, providedWallet: "0x8ba1f10900000000000000000000000000DBA72" };
const pv = await computeVerdict(db, poisoned, "INV-C4-EVIL");
console.log(`    verdict: ${pv.decision} — ${pv.reasons.find((x) => x.startsWith("REJECT")) ?? ""}`);
logInference({ node: "orchestrator", op: "verdict", model: "deterministic", delegated: false, event: `${pv.decision} INV-C4-EVIL` });
console.log(`    settle not attempted (verdict != PASS): no funds moved.`);

// Gate 3 directly: a forged intent that slipped past with to=attacker is still blocked.
console.log("\n    Gate-3 spot-check — forged intent with attacker recipient:");
const forged = buildPaymentIntent({ knownWallet: "0x000000000000000000000000000000000000dEaD", amountMinor: 1000000n, token: CHAIN.usdt, chainId: CHAIN.id, invoiceRef: "INV-C4-FORGE", memo: "x" });
const fr = await settleIntent(db, { intent: forged, vendorId: acme.vendorId!, poId, approve: APPROVE, confirmations: 2 });
console.log(`    => ${fr.status.toUpperCase()}: ${fr.reason}`);

db.close();
console.log("\n✅ C4 done.");
process.exit(0);
