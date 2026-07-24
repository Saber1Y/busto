import { z } from "zod";
import { QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";
import type Database from "better-sqlite3";
import { lookupVendor, matchPurchaseOrder, verifyWallet, type EmbedFn } from "./erp.ts";
import { toMinorUnits, setAuditNode, auditLoadModel, auditUnloadModel, auditCompletion, type InvoiceExtraction } from "../../shared/src/index.ts";

// QVAC native tool-calling layer. The LLM calls these to GATHER facts; the handlers
// are deterministic code (threat #18: tool results are DB-derived, never LLM-set). The
// settlement decision is computed separately in verdict.ts — the LLM never decides.

const TOOL_MODEL = "QWEN3_1_7B_INST_Q4";
const TOOL_MAX_TOKENS = 512; // Hard Rule 8 — cap every completion turn.

const lookupVendorSchema = z.object({ name: z.string().describe("vendor name exactly as on the invoice") });
const matchPoSchema = z.object({
  vendor_id: z.number().describe("vendor id returned by lookup_vendor"),
  amount: z.string().describe("invoice total exactly as written, e.g. '5,000.00'"),
  currency: z.string().describe("invoice currency, e.g. USDT"),
  description: z.string().describe("line-item description text"),
});
const verifyWalletSchema = z.object({
  vendor_id: z.number().describe("vendor id returned by lookup_vendor"),
  provided_wallet: z.string().describe("the 0x wallet address printed on the invoice"),
});

export interface ToolCallRecord { name: string; arguments: unknown; result: unknown }

/** Fired once per completed tool call, in order, so a caller (the UI) can stream the
 *  trace live. The record is the same deterministic {name, arguments, result} that is
 *  returned in the final trace — captured at the single source, never re-derived. */
export type OnToolCall = (record: ToolCallRecord) => void;

export function buildErpTools(db: Database.Database, embed: EmbedFn | undefined, onCall?: OnToolCall) {
  const calls: ToolCallRecord[] = [];
  const tools = [
    { name: "lookup_vendor", description: "Look up a vendor by name in the ERP. Returns { exists, vendorId, knownWallet, status }.", parameters: lookupVendorSchema },
    { name: "match_purchase_order", description: "Find an OPEN purchase order matching vendor_id + amount + currency. Returns { matched, poNumber }.", parameters: matchPoSchema },
    { name: "verify_wallet", description: "Check whether provided_wallet equals the vendor's known wallet under EIP-55. Returns { match }.", parameters: verifyWalletSchema },
  ];

  async function execute(name: string, rawArgs: unknown): Promise<unknown> {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    let result: unknown;
    if (name === "lookup_vendor") {
      result = lookupVendor(db, String(args.name ?? ""));
    } else if (name === "match_purchase_order") {
      const minor = toMinorUnits(String(args.amount ?? ""), 6);
      result = minor === null
        ? { matched: false, error: "unparseable amount" }
        : await matchPurchaseOrder(db, Number(args.vendor_id), minor, String(args.currency ?? ""), String(args.description ?? ""), embed);
    } else if (name === "verify_wallet") {
      result = verifyWallet(db, Number(args.vendor_id), String(args.provided_wallet ?? ""));
    } else {
      result = { error: `unknown tool ${name}` };
    }
    const record: ToolCallRecord = { name, arguments: args, result };
    calls.push(record);
    onCall?.(record);
    return result;
  }

  return { tools, execute, calls };
}

function descriptionFor(x: InvoiceExtraction): string {
  return x.lineItems.map((li) => li.description).filter(Boolean).join("; ") || x.vendorName;
}

/**
 * QVAC native tool-calling: the LLM verifies an invoice by calling the ERP tools. The
 * captured trace is returned (and streamed via `onCall`); the verdict is computed in
 * code. Every turn goes through the C6 audit wrapper, so each produces a profiler row,
 * and generation is capped (Hard Rule 8). `embed` is optional — with RAG off, the tools
 * still run; `match_purchase_order` just returns no near-miss candidates.
 */
export async function runVerificationAgent(
  db: Database.Database,
  extraction: InvoiceExtraction,
  embed?: EmbedFn,
  maxTurns = 5,
  onCall?: OnToolCall,
): Promise<ToolCallRecord[]> {
  const { tools, execute, calls } = buildErpTools(db, embed, onCall);
  setAuditNode("orchestrator");
  const modelId = await auditLoadModel(
    { modelSrc: QWEN3_1_7B_INST_Q4, modelConfig: { ctx_size: 4096, predict: TOOL_MAX_TOKENS, tools: true } },
    { model: TOOL_MODEL },
  );
  try {
    const history: Array<{ role: string; content: string }> = [
      {
        role: "system",
        content:
          "You are an accounts-payable verification agent. You have NO authority to approve payment — you ONLY gather facts by calling tools. " +
          "Steps: call lookup_vendor with the vendor name; if it exists, call match_purchase_order and verify_wallet using the returned vendorId. " +
          "Call every applicable tool before answering. Then state one sentence summarizing what the tools returned.",
      },
      {
        role: "user",
        content:
          `Verify this invoice:\nvendor: ${extraction.vendorName}\namount: ${extraction.invoiceAmount}\n` +
          `currency: ${extraction.currency}\nprovided_wallet: ${extraction.providedWallet}\ndescription: ${descriptionFor(extraction)}`,
      },
    ];

    for (let turn = 0; turn < maxTurns; turn++) {
      const res = await auditCompletion({ modelId, history, stream: true, tools }, { model: TOOL_MODEL, event: `tool-turn-${turn}` });
      history.push({ role: "assistant", content: res.contentText });
      if (res.toolCalls.length === 0) break;
      for (const call of res.toolCalls) {
        const result = await execute(call.name, call.arguments);
        history.push({ role: "tool", content: JSON.stringify(result) });
      }
    }
  } finally {
    await auditUnloadModel({ modelId }, { model: TOOL_MODEL });
  }
  return calls;
}
