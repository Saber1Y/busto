import type Database from "better-sqlite3";
import { addressEquals, toChecksumAddress, logInference, type PaymentIntent } from "../../shared/src/index.ts";
import { recordSettlement, isDuplicateInvoice } from "../../orchestrator/src/erp.ts";
import { openEdgeWallet, CHAIN } from "./wallet.ts";

// Settlement on the Edge node, behind Gates 3/4/5 (threat-model D). The recipient is
// re-checked against the DB, human approval is required, and the on-chain send pins
// chain + token, uses an exact-amount transfer, and waits for confirmations.

export interface SettleResult {
  status: "settled" | "blocked" | "reverted";
  reason: string;
  txHash?: string;
  explorerUrl?: string;
  confirmations?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function blockNumber(rpc: string): Promise<number> {
  try {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: "eth_blockNumber", params: [], id: 1 }) });
    const j = (await r.json()) as { result?: string };
    return j.result ? parseInt(j.result, 16) : 0;
  } catch { return 0; }
}

export async function settleIntent(
  db: Database.Database,
  ctx: { intent: PaymentIntent; vendorId: number; poId: number; approve: boolean; confirmations?: number },
): Promise<SettleResult> {
  const { intent, vendorId, poId } = ctx;
  const need = ctx.confirmations ?? 2;

  // Gate 3 — hard recipient re-check against the (re-fetched) DB known_wallet (#61).
  const vrow = db.prepare("SELECT known_wallet FROM vendors WHERE id = ?").get(vendorId) as { known_wallet: string } | undefined;
  if (!vrow || !addressEquals(intent.to, vrow.known_wallet)) {
    return { status: "blocked", reason: "Gate 3: intent.to !== DB known_wallet" };
  }
  // Gate 5 pins — chain id + token address (#58/#59/#64).
  if (intent.chainId !== CHAIN.id) return { status: "blocked", reason: `Gate 5: chainId ${intent.chainId} != ${CHAIN.id}` };
  if (!addressEquals(intent.token, CHAIN.usdt)) return { status: "blocked", reason: `Gate 5: token ${intent.token} not pinned` };
  // Replay guard (#41) — before any send.
  if (isDuplicateInvoice(db, intent.invoiceRef)) return { status: "blocked", reason: `duplicate invoice_ref ${intent.invoiceRef}` };
  // Gate 4 — explicit human approval.
  if (!ctx.approve) return { status: "blocked", reason: "Gate 4: human approval required — no send" };

  const wallet = await openEdgeWallet();
  try {
    // Pre-flight balance check (#72) — never broadcast a doomed send.
    const balance = await wallet.account.getTokenBalance(toChecksumAddress(intent.token));
    if (balance < BigInt(intent.amount)) {
      return { status: "blocked", reason: `insufficient USD₮ balance (have ${balance}, need ${intent.amount})` };
    }
    // Exact-amount ERC-20 transfer — no unbounded approve (#65); token + recipient pinned/checksummed.
    const result = await wallet.account.transfer({
      token: toChecksumAddress(intent.token),
      recipient: toChecksumAddress(intent.to),
      amount: BigInt(intent.amount),
    });
    const txHash = result.hash;
    const explorerUrl = `https://sepolia.etherscan.io/tx/${txHash}`;
    logInference({ node: "edge", op: "settle-broadcast", model: "wdk", delegated: false, event: `tx ${txHash} ref ${intent.invoiceRef}` });

    // Gate 5 — wait N confirmations; abort on revert (#57).
    let confirmations = 0;
    for (let i = 0; i < 80; i++) {
      const receipt = await wallet.account.getTransactionReceipt(txHash);
      if (receipt) {
        if (Number(receipt.status) === 0) return { status: "reverted", reason: "on-chain revert", txHash, explorerUrl };
        confirmations = (await blockNumber(wallet.rpcs[0])) - Number(receipt.blockNumber) + 1;
        if (confirmations >= need) break;
      }
      await sleep(3000);
    }

    recordSettlement(db, poId, intent.invoiceRef, BigInt(intent.amount), txHash, new Date().toISOString());
    logInference({ node: "edge", op: "settle-confirmed", model: "wdk", delegated: false, event: `tx ${txHash} conf=${confirmations} ref ${intent.invoiceRef}` });
    return { status: "settled", reason: "ok", txHash, explorerUrl, confirmations };
  } finally {
    wallet.dispose();
  }
}
