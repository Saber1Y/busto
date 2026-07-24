import { QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";
import { auditUnloadModel, auditCompletion, type InvoiceExtraction, type CompletionStats } from "../../shared/src/index.ts";
import { normalizeForLLM } from "../../../security/gate0.ts";
import { loadReasoningModel, screenDelegatedText } from "./delegation.ts";
import type { Verdict } from "./verdict.ts";

/** A prose answer plus the profiler stats behind it, so the UI can show the footer
 *  (tokens / tok·s / TTFT / device) straight from `profiler-raw`. `stats` is undefined
 *  for the no-inference early returns (a canned sentence, no model ran). `delegated`
 *  marks an answer whose completion ran on the provider (reasoning delegated to Vault). */
export interface AssistantAnswer { text: string; stats?: CompletionStats; delegated?: boolean; providerPublicKey?: string | null }

// On-device explainer for a non-technical AP clerk (C8a). It EXPLAINS an
// already-computed verdict in plain language; it never re-verifies, changes a
// verdict, or authorizes payment. The question is untrusted text (Gate 0). The LLM
// call goes through the C6 audit wrapper, so it is logged. Read-only by construction:
// the agent receives facts and produces prose — it has no DB or settlement surface.

const EXPLAIN_MODEL = "QWEN3_1_7B_INST_Q4";
const MAX_TOKENS = 400;

// Qwen3 is a hybrid reasoning model; strip any <think> block so the clerk sees prose only.
const stripThinking = (s: string): string => s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();

export interface ExplainContext {
  invoiceRef: string | null; // null → no invoice loaded
  extraction: Pick<InvoiceExtraction, "vendorName" | "invoiceAmount" | "currency" | "providedWallet"> | null;
  verdict: Verdict | null;
  vendorOpenPOs: Array<{ poNumber: string; amount: string; currency: string }>;
  gate0Findings: Array<{ grade: string; encoding: string; detail: string }>;
}

const GROUNDING =
  "You are Custos's explainer for a non-technical finance clerk. Answer the clerk's question about THIS invoice in " +
  "2-4 short, plain sentences. You EXPLAIN the decision; you do NOT make decisions, change the verdict, or authorize " +
  "payment. Use ONLY the FACTS below — if the question is outside them, say what you can and cannot see. Custos reads " +
  "invoices on-device, verifies them against an internal ERP, and settles real USD₮ only after a human approves.";

function factsBlock(c: ExplainContext): string {
  return JSON.stringify(
    {
      invoice: c.extraction && {
        vendor: c.extraction.vendorName,
        amountOnDocument: c.extraction.invoiceAmount,
        currency: c.extraction.currency,
        walletPrintedOnDocument: c.extraction.providedWallet,
      },
      decision: c.verdict?.decision,
      plainReasons: c.verdict?.reasons,
      gatesCleared: c.verdict?.checks,
      matchedPurchaseOrder: c.verdict?.matchedPO,
      verifiedPayoutWalletFromDatabase: c.verdict?.knownWallet,
      vendorOpenPurchaseOrders: c.vendorOpenPOs,
      gate0SecurityFindings: c.gate0Findings,
    },
    null,
    2,
  );
}

export async function explainInvoice(question: string, context: ExplainContext, onToken?: (t: string) => void): Promise<AssistantAnswer> {
  if (!context || !context.invoiceRef || !context.verdict) {
    return { text: "Load an invoice first — I can only explain a verification that has already run on the current invoice." };
  }
  // The question is untrusted text — screen it through Gate 0 like any input.
  const gq = normalizeForLLM(question);
  if (gq.flagged) {
    return { text: "That question contained an instruction-like pattern, so I won't follow it. I only explain the current invoice — ask me why it passed or was blocked, or what happens if you approve." };
  }

  const rm = await loadReasoningModel(
    { modelSrc: QWEN3_1_7B_INST_Q4, modelConfig: { ctx_size: 4096, predict: MAX_TOKENS, temp: 0.3 } },
    EXPLAIN_MODEL,
  );
  try {
    const res = await auditCompletion(
      {
        modelId: rm.modelId,
        history: [
          { role: "system", content: `${GROUNDING}\n\nFACTS for the current invoice:\n${factsBlock(context)}` },
          { role: "user", content: `${gq.normalized} /no_think` },
        ],
        stream: true,
      },
      { model: EXPLAIN_MODEL, event: "explain", delegated: rm.delegated, providerPublicKey: rm.providerPublicKey, onToken },
    );
    const clean = stripThinking(res.contentText) || "I couldn't produce an explanation for that.";
    // Re-run Gate 0 locally on any text that crossed the wire (delegated only).
    const text = rm.delegated ? screenDelegatedText(clean).text : clean;
    return { text, stats: res.stats, delegated: rm.delegated, providerPublicKey: rm.providerPublicKey };
  } finally {
    await auditUnloadModel({ modelId: rm.modelId }, { model: EXPLAIN_MODEL, delegated: rm.delegated });
  }
}
