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

export interface ReasoningModel { modelId: string; delegated: boolean; providerPublicKey: string | null; cached: boolean }

// D1 (Hugo #2) — keep the local chat model resident so explain/assist don't pay the
// ~2.4s Qwen load on every turn. Module-level, safe under the server's single-flight busy
// lock. LOCAL instances only: a delegated model is tied to the provider connection (and its
// load tax is on the provider, not the Edge), so there is nothing local to cache. Chat is a
// minor local context consumer next to vision, and residency here does not touch the verify
// path's models — so it does not move the vision X1 ceiling (measured).
const residentLocal = new Map<string, string>(); // cacheKey -> modelId

/** Shared cache key for the local chat model. explain and assist load QWEN3-1.7B with an
 *  IDENTICAL modelConfig (ctx_size 4096, predict 400, temp 0.3), so they can share one
 *  resident instance. Tool-calling uses tools:true — a different config — so it is NOT
 *  cached (and its per-verify unload is part of what keeps the vision ceiling healthy). */
export const CHAT_CACHE_KEY = "chat-local";

/**
 * Load a reasoning model, delegated to the provider when DELEGATE_REASONING is on. With
 * delegation, `fallbackToLocal: false` means an unreachable provider HARD-STOPS (the load
 * throws) — it never silently degrades to local inference (threat #82). `isDelegated`
 * confirms the outcome, so the audit rows carry the true `delegated` flag, never an
 * assumed one. Audit node is "edge" for delegated calls (the Edge initiated them, the
 * provider executed them), "orchestrator" for local — matching consumer.ts.
 */
export async function loadReasoningModel(
  loadOpts: Parameters<typeof loadModel>[0],
  modelName: string,
  opts: { cacheKey?: string } = {},
): Promise<ReasoningModel> {
  const del = reasoningDelegate();
  setAuditNode(del ? "edge" : "orchestrator");
  // Cache only LOCAL instances. A delegated cache hit would return a modelId whose provider
  // connection may have dropped, and the load saving is on the provider anyway.
  if (!del && opts.cacheKey) {
    const hit = residentLocal.get(opts.cacheKey);
    if (hit) return { modelId: hit, delegated: false, providerPublicKey: null, cached: true };
  }
  const mergedOpts = del
    ? { ...loadOpts, delegate: { providerPublicKey: del.providerPublicKey, timeout: del.timeout, fallbackToLocal: false } }
    : loadOpts;
  const modelId = await auditLoadModel(mergedOpts, { model: modelName, delegated: !!del, providerPublicKey: del?.providerPublicKey ?? null });
  // Authoritative: a delegated load that didn't throw ran on the provider, but confirm it
  // rather than assume, so `delegated:true` in the log is always the observed truth.
  const delegated = del ? await isDelegated(modelId) : false;
  if (!del && opts.cacheKey) { residentLocal.set(opts.cacheKey, modelId); return { modelId, delegated: false, providerPublicKey: null, cached: true }; }
  return { modelId, delegated, providerPublicKey: del?.providerPublicKey ?? null, cached: false };
}

/** Unload a reasoning model unless it is resident (cached) — then keep it warm. */
export async function releaseReasoningModel(rm: ReasoningModel, unload: () => Promise<void>): Promise<void> {
  if (rm.cached) return;
  await unload();
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
