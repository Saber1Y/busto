import type Database from "better-sqlite3";
import { QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";
import { auditUnloadModel, auditCompletion, fromMinorUnits, type CompletionStats } from "../../shared/src/index.ts";
import { normalizeForLLM } from "../../../security/gate0.ts";
import { loadReasoningModel, screenDelegatedText } from "./delegation.ts";

// General Workspace assistant (C9-2-fix). Answers ANY free-text message grounded in
// (a) what Custos IS + the six gates, and (b) a live snapshot of the air-gapped ERP
// (vendors, open POs, settlement history). READ-ONLY by construction: it receives facts
// and produces prose — it has no DB-mutating or settlement surface. The question is
// untrusted text and is screened through Gate 0 first. Every LLM call goes through the
// C6 audit wrapper, so it is logged. It never invents a vendor/PO/policy; if a fact is
// not in the snapshot it says so.

const ASSIST_MODEL = "QWEN3_1_7B_INST_Q4";
const MAX_TOKENS = 400;

const stripThinking = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();
// Qwen3 ignores "no markdown" and emits **bold**/# headers; the bubble is plain text, so strip the markers.
const cleanProse = (s: string): string => s.replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*\*/g, "").replace(/^\s{0,3}#{1,6}\s+/gm, "").trim();

export interface ErpSnapshot {
  vendors: Array<{ name: string; status: string; knownWallet: string }>;
  openPurchaseOrders: Array<{ vendor: string; poNumber: string; amount: string; currency: string; description: string }>;
  settlementHistory: Array<{ vendor: string; poNumber: string; amount: string; invoiceRef: string; txHash: string | null; at: string }>;
}

/** Prose answer + the profiler stats behind it (undefined for the no-inference
 *  early return). Lets the UI render the profiler footer from `profiler-raw`.
 *  `delegated` marks an answer whose completion ran on the provider (Vault). */
export interface AssistantAnswer { text: string; stats?: CompletionStats; delegated?: boolean; providerPublicKey?: string | null }

/** Read-only retrieval of the ERP facts the assistant is allowed to ground on. */
export function buildErpSnapshot(db: Database.Database): ErpSnapshot {
  const vendors = (db.prepare("SELECT name, status, known_wallet FROM vendors ORDER BY name")
    .all() as Array<{ name: string; status: string; known_wallet: string }>)
    .map((v) => ({ name: v.name, status: v.status, knownWallet: v.known_wallet }));

  const openPurchaseOrders = (db.prepare(
    "SELECT v.name AS vendor, p.po_number, p.amount_minor, p.currency, p.description FROM purchase_orders p JOIN vendors v ON v.id = p.vendor_id WHERE p.status = 'open' ORDER BY v.name, p.po_number",
  ).all() as Array<{ vendor: string; po_number: string; amount_minor: string; currency: string; description: string }>)
    .map((p) => ({ vendor: p.vendor, poNumber: p.po_number, amount: fromMinorUnits(BigInt(p.amount_minor), 6), currency: p.currency, description: p.description }));

  const settlementHistory = (db.prepare(
    "SELECT v.name AS vendor, p.po_number, s.amount_minor, s.invoice_ref, s.tx_hash, s.ts FROM settlements s JOIN purchase_orders p ON p.id = s.po_id JOIN vendors v ON v.id = p.vendor_id ORDER BY s.ts DESC",
  ).all() as Array<{ vendor: string; po_number: string; amount_minor: string; invoice_ref: string; tx_hash: string | null; ts: string }>)
    .map((s) => ({ vendor: s.vendor, poNumber: s.po_number, amount: fromMinorUnits(BigInt(s.amount_minor), 6), invoiceRef: s.invoice_ref, txHash: s.tx_hash, at: s.ts }));

  return { vendors, openPurchaseOrders, settlementHistory };
}

const CAPABILITIES = [
  "Read a vendor invoice on-device (local OCR + a multimodal LLM) and extract its fields.",
  "Verify the invoice against your internal ERP — vendor, purchase order, payout wallet, and duplicates.",
  "Run every invoice through six security gates before any payment can be proposed.",
  "Settle a fully verified invoice as real USD₮ on Ethereum Sepolia — but only after you approve.",
  "Answer questions about your vendors, their open purchase orders, and past settlements.",
  "Everything runs locally: air-gapped, on-device inference, zero cloud AI.",
];

const THE_SIX_GATES = [
  "Gate 0 — Input decode: obfuscated/hidden instructions in the document are decoded and rejected before the model sees them.",
  "Gate 1 — Role bounding: the AI only extracts fields and proposes; it has no authority to move money.",
  "Gate 2 — Deterministic truth: vendor, purchase order, and wallet come from the ERP, never from the document.",
  "Gate 3 — Recipient re-check: the payout wallet must match the verified wallet on file before anything is signed.",
  "Gate 4 — Human approval: a person approves on the Edge node with a deliberate hold-to-authorize.",
  "Gate 5 — On-chain safety: pinned network and token, exact amount, and on-chain confirmations.",
];

const GROUNDING =
  "You are Custos's assistant for a non-technical finance clerk. Custos is an AIR-GAPPED agentic " +
  "accounts-payable system: it reads vendor invoices on-device, verifies them against THIS internal ERP, " +
  "and settles real USD₮ on-chain only after a human approves every gate. You are READ-ONLY — you explain " +
  "and answer; you have NO tool that can move money or change the ERP. Answer the clerk's question in 2-5 " +
  "short, plain sentences using ONLY the Custos capabilities, the six gates, and the ERP FACTS below. NEVER " +
  "invent a vendor, purchase order, wallet, amount, or policy. If the answer is not in the facts, say plainly " +
  "that you can't see it. To verify a specific invoice, the clerk drops it in the workspace.\n" +
  "Field meanings — read carefully: 'openPurchaseOrders' are approved orders that have NOT been paid yet; " +
  "'settlementHistory' is the list of payments Custos has ALREADY made on-chain. If settlementHistory is empty, " +
  "or a vendor does not appear in it, then Custos has made NO payment to that vendor — say exactly that. NEVER " +
  "treat an open purchase order as a past payment.\n" +
  "Write warm, plain prose. Do NOT use markdown symbols (no **, #, or bullet characters); if you list the gates, " +
  "use simple numbered sentences.";

function factsBlock(snapshot: ErpSnapshot): string {
  return JSON.stringify({ whatCustosCanDo: CAPABILITIES, theSixGates: THE_SIX_GATES, erp: snapshot }, null, 2);
}

export async function assistChat(question: string, snapshot: ErpSnapshot, onToken?: (t: string) => void): Promise<AssistantAnswer> {
  // The message is untrusted text — screen it through Gate 0 like any input.
  const gq = normalizeForLLM(question);
  if (gq.flagged) {
    return { text: "That message contained an instruction-like pattern, so I won't follow it. I can explain how Custos works, your vendors and their open purchase orders, and past settlements — ask me about those, or drop an invoice to verify." };
  }

  const rm = await loadReasoningModel(
    { modelSrc: QWEN3_1_7B_INST_Q4, modelConfig: { ctx_size: 4096, predict: MAX_TOKENS, temp: 0.3 } },
    ASSIST_MODEL,
  );
  try {
    const res = await auditCompletion(
      {
        modelId: rm.modelId,
        history: [
          { role: "system", content: `${GROUNDING}\n\nFACTS for this workspace:\n${factsBlock(snapshot)}` },
          { role: "user", content: `${gq.normalized} /no_think` },
        ],
        stream: true,
      },
      { model: ASSIST_MODEL, event: "assist", delegated: rm.delegated, providerPublicKey: rm.providerPublicKey, onToken },
    );
    const clean = cleanProse(stripThinking(res.contentText)) || "I couldn't produce an answer for that.";
    const text = rm.delegated ? screenDelegatedText(clean).text : clean;
    return { text, stats: res.stats, delegated: rm.delegated, providerPublicKey: rm.providerPublicKey };
  } finally {
    await auditUnloadModel({ modelId: rm.modelId }, { model: ASSIST_MODEL, delegated: rm.delegated });
  }
}
