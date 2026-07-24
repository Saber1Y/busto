import type { loadModel } from "@qvac/sdk";
import { isHex64, isDelegated, setAuditNode, auditLoadModel } from "../../shared/src/index.ts";
import { normalizeForLLM } from "../../../security/gate0.ts";

// Reasoning delegation (Hugo #3). The Edge console can route its PURE-TEXT reasoning —
// explain, assist, and the tool-calling verification turns — to the Orchestrator/Vault
// provider over QVAC's encrypted P2P link, exactly as consumer.ts already does. Only
// completionStream has a delegatedHandler in @qvac/sdk@0.13.5 (verified: embed and ocr do
// NOT), so OCR, vision, and RAG embeds ALWAYS stay local. The verdict is never inference
// and never crosses the wire — judgment stays on the key-holder.

export interface DelegateConfig { providerPublicKey: string; timeout: number }

/**
 * Reasoning-delegation config from the environment, or `null` when delegation is off
 * (the default). Read fresh each call so the switch is honoured at runtime. Throws when
 * DELEGATE_REASONING=true but PROVIDER_PUBKEY is not a valid provider key — a loud
 * misconfiguration beats a silent fall back to local inference.
 */
export function reasoningDelegate(): DelegateConfig | null {
  if (process.env.DELEGATE_REASONING !== "true") return null;
  const providerPublicKey = process.env.PROVIDER_PUBKEY;
  if (!isHex64(providerPublicKey)) {
    throw new Error("DELEGATE_REASONING=true but PROVIDER_PUBKEY is not a 64-hex provider key — set it or unset DELEGATE_REASONING");
  }
  return { providerPublicKey, timeout: Number(process.env.DELEGATE_TIMEOUT_MS ?? 60_000) };
}

export interface ReasoningModel { modelId: string; delegated: boolean; providerPublicKey: string | null }

/**
 * Load a reasoning model, delegated to the provider when DELEGATE_REASONING is on. With
 * delegation, `fallbackToLocal: false` means an unreachable provider HARD-STOPS (the load
 * throws) — it never silently degrades to local inference (threat #82). `isDelegated`
 * confirms the outcome, so the audit rows carry the true `delegated` flag, never an
 * assumed one. Audit node is "edge" for delegated calls (the Edge initiated them, the
 * provider executed them), "orchestrator" for local — matching consumer.ts.
 */
export async function loadReasoningModel(loadOpts: Parameters<typeof loadModel>[0], modelName: string): Promise<ReasoningModel> {
  const del = reasoningDelegate();
  setAuditNode(del ? "edge" : "orchestrator");
  const opts = del
    ? { ...loadOpts, delegate: { providerPublicKey: del.providerPublicKey, timeout: del.timeout, fallbackToLocal: false } }
    : loadOpts;
  const modelId = await auditLoadModel(opts, { model: modelName, delegated: !!del, providerPublicKey: del?.providerPublicKey ?? null });
  // Authoritative: a delegated load that didn't throw ran on the provider, but confirm it
  // rather than assume, so `delegated:true` in the log is always the observed truth.
  const delegated = del ? await isDelegated(modelId) : false;
  return { modelId, delegated, providerPublicKey: del?.providerPublicKey ?? null };
}

/**
 * Edge-side re-validation of text that crossed the wire (threat: a compromised provider
 * injecting an imperative into the returned prose). Re-runs the pure-TS Gate 0 locally.
 * Gate 0's plaintext scan flags injection LANGUAGE only ("ignore previous instructions",
 * "act as", jailbreak, encoded imperatives) — not a legitimate explanation that mentions
 * paying or approving — so benign reasoning is never withheld. Only applied to delegated
 * text; local text never left this machine.
 */
export function screenDelegatedText(text: string): { text: string; withheld: boolean } {
  const g = normalizeForLLM(text);
  if (g.flagged) {
    return {
      text: "The reasoning came back from the orchestrator carrying an instruction-like pattern, so I withheld it. The verification and its verdict are unaffected — they run in plain code on this machine.",
      withheld: true,
    };
  }
  return { text, withheld: false };
}
