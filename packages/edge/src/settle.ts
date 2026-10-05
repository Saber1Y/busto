import type Database from "better-sqlite3";
import { encodeFunctionData } from "viem";
import {
  addressEquals,
  toChecksumAddress,
  fromMinorUnits,
  logInference,
  type PaymentIntent
} from "../../shared/src/index.ts";
import { recordSettlement, isDuplicateInvoice } from "../../orchestrator/src/erp.ts";
import {
  openEdgeWallet,
  signAndBroadcast,
  nextNonce,
  readTokenBalance,
  readAllowance,
  CHAIN,
  CHAIN_ID,
  USDT_ADDRESS,
  USDT_DECIMALS,
  EXPLORER_TX,
  type EdgeWallet
} from "./wallet.ts";

// Settlement on the Edge node, behind Gates 3/4/5 (threat-model D). The recipient is
// re-checked against the DB, human approval is required, and the on-chain send pins
// chain + token, uses an exact-amount approval, settles through BustoSettlement, and
// waits for confirmations.
//
// Settlement is CONTRACT-MEDIATED on BOT Chain Testnet. Funds move as:
//   approve(BustoSettlement, exactAmount)  ->  settleInvoice(invoiceRef, vendor, amount)
// The contract forwards the approved amount to the vendor in the same transaction and
// records an auditable on-chain settlement. The approval is for the exact invoice
// amount and is fully consumed, so no allowance survives the payment.

export interface SettleResult {
  // "pending" = broadcast, but the required confirmations were not observed in the
  // wait window. Funds are committed on-chain; the outcome is simply not known yet.
  status: "settled" | "pending" | "blocked" | "reverted";
  reason: string;
  txHash?: string;
  approveTxHash?: string;
  explorerUrl?: string;
  confirmations?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const CONFIRM_POLLS = 80;
const CONFIRM_INTERVAL_MS = 3000;
// approve + settleInvoice. Measured on BOT Chain Testnet: approve ~47k, settle ~241k.
const APPROVE_GAS = 80_000n;
const SETTLE_GAS = 320_000n;
const GAS_HEADROOM = 2n; // basefee can climb between preflight and inclusion
const FALLBACK_GAS_WEI = 500_000_000_000_000n; // used only if eth_gasPrice is unreachable

export const SETTLEMENT_CONTRACT = (process.env.BUSTO_SETTLEMENT_CONTRACT ??
  "0xf08790ceffd2521538f4be5cabad059631bd2eb2") as `0x${string}`;

const ERC20_ABI = [
  {
    type: "function",
    stateMutability: "view",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    stateMutability: "view",
    name: "allowance",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" }
    ],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ type: "bool" }]
  }
] as const;

const SETTLEMENT_ABI = [
  {
    type: "function",
    stateMutability: "nonpayable",
    name: "settleInvoice",
    inputs: [
      { name: "invoiceRef", type: "bytes32" },
      { name: "recipient", type: "address" },
      { name: "amount", type: "uint256" }
    ],
    outputs: [{ type: "bool" }]
  },
  {
    type: "function",
    stateMutability: "view",
    name: "settledInvoiceCount",
    inputs: [],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    stateMutability: "view",
    name: "totalSettledAmount",
    inputs: [],
    outputs: [{ type: "uint256" }]
  },
  {
    type: "function",
    stateMutability: "view",
    name: "settlementExists",
    inputs: [{ name: "invoiceRef", type: "bytes32" }],
    outputs: [{ type: "bool" }]
  }
] as const;

async function rpcCall(rpc: string, method: string, params: unknown[] = []): Promise<string | null> {
  try {
    const r = await fetch(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 })
    });
    const j = (await r.json()) as { result?: string };
    return j.result ?? null;
  } catch {
    return null;
  }
}

async function blockNumber(rpc: string): Promise<number> {
  const r = await rpcCall(rpc, "eth_blockNumber");
  return r ? parseInt(r, 16) : 0;
}

// BOT → trimmed to 6 decimals. The full 18 are unreadable on a shared screen.
const bot = (wei: bigint): string => {
  const [whole, frac = ""] = fromMinorUnits(wei, 18).split(".");
  const short = frac.slice(0, 6).replace(/0+$/, "");
  return short ? `${whole}.${short}` : whole;
};

/** Deterministic bytes32 replay-guard key derived from the Custos invoice reference. */
export function invoiceRefKey(invoiceRef: string): `0x${string}` {
  const trimmed = invoiceRef.trim();
  const hex = trimmed.startsWith("0x") ? trimmed.slice(2) : Buffer.from(trimmed, "utf8").toString("hex");
  const padded = hex.length > 64 ? hex.slice(0, 64) : hex.padEnd(64, "0");
  return `0x${padded}`;
}

export interface OnChainMetrics {
  contract: string;
  network: string;
  chainId: number;
  settledInvoiceCount: number;
  totalSettledAmount: string;
}

const METRICS_TIMEOUT_MS = Number(process.env.BUSTO_RPC_TIMEOUT_MS ?? 12_000);

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`${label} did not answer within ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

/**
 * Reads live settlement metrics from contract state. Never a cached counter.
 *
 * Bounded by a timeout on purpose: the BOT Chain RPC can stall, and a dashboard
 * that hangs on "Reading contract state..." forever is worse than one that says
 * the chain did not answer. The caller surfaces that as unavailable rather than
 * rendering zeros that would read as "nothing has ever settled".
 */
export async function readOnChainMetrics(chainId = CHAIN_ID): Promise<OnChainMetrics> {
  const wallet = await openEdgeWallet();
  try {
    const read = async (fn: "settledInvoiceCount" | "totalSettledAmount") =>
      withTimeout(
        wallet.publicClient.readContract({
          abi: SETTLEMENT_ABI,
          address: SETTLEMENT_CONTRACT,
          functionName: fn
        }) as Promise<bigint>,
        METRICS_TIMEOUT_MS,
        `BustoSettlement.${fn}()`
      );
    const [count, volume] = await Promise.all([read("settledInvoiceCount"), read("totalSettledAmount")]);
    return {
      contract: SETTLEMENT_CONTRACT,
      network: CHAIN.name,
      chainId,
      settledInvoiceCount: Number(count),
      totalSettledAmount: fromMinorUnits(volume, USDT_DECIMALS)
    };
  } finally {
    wallet.dispose();
  }
}

export async function settleIntent(
  db: Database.Database,
  ctx: { intent: PaymentIntent; vendorId: number; poId: number; approve: boolean; confirmations?: number }
): Promise<SettleResult> {
  const { intent, vendorId, poId } = ctx;
  const need = ctx.confirmations ?? 2;

  // Gate 3 — hard recipient re-check against the (re-fetched) DB known_wallet (#61).
  const vrow = db.prepare("SELECT known_wallet FROM vendors WHERE id = ?").get(vendorId) as
    | { known_wallet: string }
    | undefined;
  if (!vrow || !addressEquals(intent.to, vrow.known_wallet)) {
    return { status: "blocked", reason: "Gate 3: intent.to !== DB known_wallet" };
  }
  // Gate 5 pins — chain id + token address (#58/#59/#64). BOT Chain Testnet only.
  if (intent.chainId !== CHAIN_ID) {
    return { status: "blocked", reason: `Gate 5: chainId ${intent.chainId} != ${CHAIN_ID} (BOT Chain Testnet)` };
  }
  if (!addressEquals(intent.token, USDT_ADDRESS)) {
    return { status: "blocked", reason: `Gate 5: token ${intent.token} not pinned to BOT Chain USDT` };
  }
  // Replay guard (#41) — before any send.
  if (isDuplicateInvoice(db, intent.invoiceRef)) {
    return { status: "blocked", reason: `duplicate invoice_ref ${intent.invoiceRef}` };
  }
  // Gate 4 — explicit human approval.
  if (!ctx.approve) return { status: "blocked", reason: "Gate 4: human approval required — no send" };

  const wallet = await openEdgeWallet();
  try {
    const amount = BigInt(intent.amount);

    // On-chain replay guard. The local DB guard can be lost or rolled back; the
    // contract's settlementExists is the durable check.
    const invoiceRef = invoiceRefKey(intent.invoiceRef);
    const alreadyOnChain = await wallet.publicClient
      .readContract({
        abi: SETTLEMENT_ABI,
        address: SETTLEMENT_CONTRACT,
        functionName: "settlementExists",
        args: [invoiceRef]
      })
      .catch(() => false);
    if (alreadyOnChain) {
      return {
        status: "blocked",
        reason: `${intent.invoiceRef} is already settled on BOT Chain. The contract replay guard rejected it.`
      };
    }

    // Pre-flight (#72) — never broadcast a doomed send.
    let usdt: bigint;
    let gas: bigint;
    try {
      usdt = await readTokenBalance(wallet, USDT_ADDRESS, wallet.address);
      gas = await wallet.publicClient.getBalance({ address: wallet.address });
    } catch (e) {
      logInference({
        node: "edge",
        op: "settle-preflight",
        model: "viem",
        delegated: false,
        event: `rpc unreachable ref ${intent.invoiceRef}: ${String((e as Error)?.message ?? e)}`
      });
      return {
        status: "blocked",
        reason: "Couldn't read the wallet balance — the BOT Chain RPC didn't respond. Nothing was sent."
      };
    }
    if (usdt < amount) {
      return {
        status: "blocked",
        reason: `Not enough USD₮ — the wallet holds ${fromMinorUnits(usdt, USDT_DECIMALS)} but this invoice needs ${fromMinorUnits(amount, USDT_DECIMALS)}. Nothing was sent.`
      };
    }
    // An ERC-20 approval costs BOT even though the value moved is USD₮.
    const gasPriceHex = await rpcCall(wallet.rpc, "eth_gasPrice");
    const gasPrice = gasPriceHex ? BigInt(gasPriceHex) : FALLBACK_GAS_WEI;
    const gasNeeded = gasPrice * (APPROVE_GAS + SETTLE_GAS) * GAS_HEADROOM;
    if (gas < gasNeeded) {
      logInference({
        node: "edge",
        op: "settle-preflight",
        model: "viem",
        delegated: false,
        event: `gas short have=${gas} need=${gasNeeded} ref ${intent.invoiceRef}`
      });
      return {
        status: "blocked",
        reason: `Not enough BOT for gas — the wallet holds ${bot(gas)} BOT but needs about ${bot(gasNeeded)} to approve and settle. Top up ${wallet.address} from the BOT testnet faucet. Nothing was sent.`
      };
    }

    // 1) Exact-amount approval for the settlement contract ONLY. Never unbounded.
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [SETTLEMENT_CONTRACT, amount]
    });
    const approveNonce = await nextNonce(wallet);
    const approveGas = await wallet.publicClient
      .estimateContractGas({
        abi: ERC20_ABI,
        address: USDT_ADDRESS,
        functionName: "approve",
        args: [SETTLEMENT_CONTRACT, amount],
        account: wallet.address,
        nonce: approveNonce
      })
      .catch(() => APPROVE_GAS);
    const approveTxHash = await signAndBroadcast(wallet, {
      to: USDT_ADDRESS,
      data: approveData as `0x${string}`,
      gas: (approveGas * 110n) / 100n,
      nonce: approveNonce
    });
    const approveReceipt = await wallet.publicClient.waitForTransactionReceipt({ hash: approveTxHash });
    if (approveReceipt.status !== "success") {
      return {
        status: "reverted",
        reason: `The USDT approval reverted on-chain — no USD₮ moved.`,
        approveTxHash,
        explorerUrl: EXPLORER_TX(approveTxHash)
      };
    }
    logInference({
      node: "edge",
      op: "settle-approve",
      model: "viem",
      delegated: false,
      event: `approve ${approveTxHash} ref ${intent.invoiceRef}`
    });

    // 2) Contract-mediated settlement. The contract pulls the exact allowance and
    //    forwards it to the verified vendor in this same transaction.
    const settleData = encodeFunctionData({
      abi: SETTLEMENT_ABI,
      functionName: "settleInvoice",
      args: [invoiceRef, toChecksumAddress(intent.to) as `0x${string}`, amount]
    });
    const settleNonce = await nextNonce(wallet);
    const settleGas = await wallet.publicClient
      .estimateContractGas({
        abi: SETTLEMENT_ABI,
        address: SETTLEMENT_CONTRACT,
        functionName: "settleInvoice",
        args: [invoiceRef, toChecksumAddress(intent.to) as `0x${string}`, amount],
        account: wallet.address,
        nonce: settleNonce
      })
      .catch(() => SETTLE_GAS);
    const txHash = await signAndBroadcast(wallet, {
      to: SETTLEMENT_CONTRACT,
      data: settleData as `0x${string}`,
      gas: (settleGas * 110n) / 100n,
      nonce: settleNonce
    });
    const explorerUrl = EXPLORER_TX(txHash);
    logInference({
      node: "edge",
      op: "settle-broadcast",
      model: "viem",
      delegated: false,
      event: `tx ${txHash} ref ${intent.invoiceRef}`
    });

    // The broadcast — not the confirmation — is the irreversible act, so the replay
    // guard closes here. Waiting until confirmation would leave a window in which the
    // same invoice could be approved again and paid twice.
    recordSettlement(db, poId, intent.invoiceRef, amount, txHash, new Date().toISOString());

    // Gate 5 — wait N confirmations; abort on revert (#57).
    const waitT0 = performance.now();
    let confirmations = 0;
    let mined = false;
    for (let i = 0; i < CONFIRM_POLLS; i++) {
      const receipt = await wallet.publicClient.getTransactionReceipt({ hash: txHash });
      if (receipt) {
        mined = true;
        if (Number(receipt.status) === 0) {
          logInference({
            node: "edge",
            op: "settle-reverted",
            model: "viem",
            delegated: false,
            event: `tx ${txHash} ref ${intent.invoiceRef}`
          });
          return {
            status: "reverted",
            reason: `The settlement reverted on-chain — no USD₮ moved. ${intent.invoiceRef} stays recorded against this tx; clear it manually before retrying.`,
            txHash,
            approveTxHash,
            explorerUrl,
            confirmations: 0
          };
        }
        confirmations = (await blockNumber(wallet.rpc)) - Number(receipt.blockNumber) + 1;
        if (confirmations >= need) break;
      }
      await sleep(CONFIRM_INTERVAL_MS);
    }

    // Never report SETTLED on an unconfirmed settlement.
    if (confirmations < need) {
      const waited = Math.round((performance.now() - waitT0) / 1000);
      logInference({
        node: "edge",
        op: "settle-unconfirmed",
        model: "viem",
        delegated: false,
        event: `tx ${txHash} conf=${confirmations}/${need} waited=${waited}s ref ${intent.invoiceRef}`
      });
      return {
        status: "pending",
        reason: `Broadcast, but only ${confirmations} of ${need} confirmations after ${waited}s. ${
          mined ? "The settlement is mined and should finalise shortly." : "The settlement has not been mined yet."
        } Check BOTScan before re-sending — ${intent.invoiceRef} is already recorded, so Busto will not pay it twice.`,
        txHash,
        approveTxHash,
        explorerUrl,
        confirmations
      };
    }

    logInference({
      node: "edge",
      op: "settle-confirmed",
      model: "viem",
      delegated: false,
      event: `tx ${txHash} conf=${confirmations} ref ${intent.invoiceRef}`
    });
    return { status: "settled", reason: "ok", txHash, approveTxHash, explorerUrl, confirmations };
  } finally {
    wallet.dispose();
  }
}