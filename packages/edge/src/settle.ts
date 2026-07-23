import type Database from "better-sqlite3";
import { addressEquals, toChecksumAddress, fromMinorUnits, logInference, type PaymentIntent } from "../../shared/src/index.ts";
import { recordSettlement, isDuplicateInvoice } from "../../orchestrator/src/erp.ts";
import { openEdgeWallet, CHAIN } from "./wallet.ts";

// Settlement on the Edge node, behind Gates 3/4/5 (threat-model D). The recipient is
// re-checked against the DB, human approval is required, and the on-chain send pins
// chain + token, uses an exact-amount transfer, and waits for confirmations.

export interface SettleResult {
  // "pending" = broadcast, but the required confirmations were not observed in the
  // wait window. Funds are committed on-chain; the outcome is simply not known yet.
  status: "settled" | "pending" | "blocked" | "reverted";
  reason: string;
  txHash?: string;
  explorerUrl?: string;
  confirmations?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const CONFIRM_POLLS = 80;
const CONFIRM_INTERVAL_MS = 3000;
const ERC20_TRANSFER_GAS = 65_000n; // a plain USD₮ transfer; measured sends land well under this
const GAS_HEADROOM = 2n; // basefee can climb between preflight and inclusion
const FALLBACK_GAS_WEI = 500_000_000_000_000n; // 0.0005 ETH, used only if eth_gasPrice is unreachable

async function rpcCall(rpc: string, method: string, params: unknown[] = []): Promise<string | null> {
  try {
    const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }) });
    const j = (await r.json()) as { result?: string };
    return j.result ?? null;
  } catch { return null; }
}
async function blockNumber(rpc: string): Promise<number> {
  const r = await rpcCall(rpc, "eth_blockNumber");
  return r ? parseInt(r, 16) : 0;
}
// Wei → ETH, trimmed to 6 decimals. The full 18 are unreadable on a shared screen.
const eth = (wei: bigint): string => {
  const [whole, frac = ""] = fromMinorUnits(wei, 18).split(".");
  const short = frac.slice(0, 6).replace(/0+$/, "");
  return short ? `${whole}.${short}` : whole;
};

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
    // Pre-flight (#72) — never broadcast a doomed send. Both balance reads are RPC
    // calls: an unreachable node gets its own named failure rather than a raw throw,
    // because this text lands on a shared screen.
    let usdt: bigint;
    let gas: bigint;
    try {
      usdt = await wallet.account.getTokenBalance(toChecksumAddress(intent.token));
      gas = await wallet.account.getBalance();
    } catch (e) {
      logInference({ node: "edge", op: "settle-preflight", model: "wdk", delegated: false, event: `rpc unreachable ref ${intent.invoiceRef}: ${String((e as Error)?.message ?? e)}` });
      return { status: "blocked", reason: "Couldn't read the wallet balance — the Sepolia RPC didn't respond. Nothing was sent." };
    }
    if (usdt < BigInt(intent.amount)) {
      return { status: "blocked", reason: `Not enough USD₮ — the wallet holds ${fromMinorUnits(usdt, CHAIN.usdtDecimals)} but this invoice needs ${fromMinorUnits(BigInt(intent.amount), CHAIN.usdtDecimals)}. Nothing was sent.` };
    }
    // An ERC-20 transfer costs ETH even though the value moved is USD₮. A wallet with
    // plenty of USD₮ and no ETH otherwise fails deep inside the signer mid-demo.
    const gasPrice = await rpcCall(wallet.rpcs[0], "eth_gasPrice");
    const gasNeeded = gasPrice ? BigInt(gasPrice) * ERC20_TRANSFER_GAS * GAS_HEADROOM : FALLBACK_GAS_WEI;
    if (gas < gasNeeded) {
      logInference({ node: "edge", op: "settle-preflight", model: "wdk", delegated: false, event: `gas short have=${gas} need=${gasNeeded} ref ${intent.invoiceRef}` });
      return { status: "blocked", reason: `Not enough ETH for gas — the wallet holds ${eth(gas)} ETH but needs about ${eth(gasNeeded)} to send this transfer. Top up ${wallet.address} from a Sepolia faucet. Nothing was sent.` };
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

    // The broadcast — not the confirmation — is the irreversible act, so the replay
    // guard has to close here. Recording now makes a second approve of this invoice_ref
    // impossible (settlements.invoice_ref is UNIQUE) even while the tx is still in
    // flight. Waiting until confirmation would leave a ~4-minute window in which the
    // same invoice could be approved again and paid twice.
    recordSettlement(db, poId, intent.invoiceRef, BigInt(intent.amount), txHash, new Date().toISOString());

    // Gate 5 — wait N confirmations; abort on revert (#57).
    const waitT0 = performance.now();
    let confirmations = 0;
    let mined = false;
    for (let i = 0; i < CONFIRM_POLLS; i++) {
      const receipt = await wallet.account.getTransactionReceipt(txHash);
      if (receipt) {
        mined = true;
        if (Number(receipt.status) === 0) {
          logInference({ node: "edge", op: "settle-reverted", model: "wdk", delegated: false, event: `tx ${txHash} ref ${intent.invoiceRef}` });
          return { status: "reverted", reason: `The transfer reverted on-chain — no USD₮ moved. ${intent.invoiceRef} stays recorded against this tx; clear it manually before retrying.`, txHash, explorerUrl, confirmations: 0 };
        }
        confirmations = (await blockNumber(wallet.rpcs[0])) - Number(receipt.blockNumber) + 1;
        if (confirmations >= need) break;
      }
      await sleep(CONFIRM_INTERVAL_MS);
    }

    // Never report SETTLED on an unconfirmed transfer. The funds are committed, so this
    // is not a "blocked" outcome — it is an unknown one, and it has to read as unknown.
    if (confirmations < need) {
      const waited = Math.round((performance.now() - waitT0) / 1000);
      logInference({ node: "edge", op: "settle-unconfirmed", model: "wdk", delegated: false, event: `tx ${txHash} conf=${confirmations}/${need} waited=${waited}s ref ${intent.invoiceRef}` });
      return {
        status: "pending",
        reason: `Broadcast, but only ${confirmations} of ${need} confirmations after ${waited}s. ${mined ? "The transfer is mined and should finalise shortly." : "The transfer has not been mined yet."} Check the explorer before re-sending — ${intent.invoiceRef} is already recorded, so Custos will not send it a second time.`,
        txHash, explorerUrl, confirmations,
      };
    }

    logInference({ node: "edge", op: "settle-confirmed", model: "wdk", delegated: false, event: `tx ${txHash} conf=${confirmations} ref ${intent.invoiceRef}` });
    return { status: "settled", reason: "ok", txHash, explorerUrl, confirmations };
  } finally {
    wallet.dispose();
  }
}
