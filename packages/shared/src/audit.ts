import { loadModel, unloadModel, completion, embed, ocr, profiler, type ToolCallWithCall } from "@qvac/sdk";
import { logInference } from "./log.ts";
import type { CompletionStats } from "./qvac.ts";

// Audit wrapper around EVERY QVAC call (C6 · threat #99). Each call appends one
// profiler-backed row to evidence/inference-log.{jsonl,csv}. Completion token /
// TTFT / throughput come straight from the SDK's profiler (CompletionStats) — never
// hand-written. Load/OCR timing is wall-clock around the call.

let auditNode = "orchestrator";
export function setAuditNode(node: string): void { auditNode = node; }

/** Turn on QVAC's profiler so timing is captured at the source. */
export function enableQvacAudit(): void {
  try { profiler.enable({ mode: "verbose", includeServerBreakdown: true }); } catch { /* profiler optional */ }
}
export function exportProfilerSummary(): string {
  try { return profiler.exportTable(); } catch { return "(profiler unavailable)"; }
}

interface ModelMeta { model: string; delegated?: boolean; providerPublicKey?: string | null }

export async function auditLoadModel(opts: Parameters<typeof loadModel>[0], meta: ModelMeta): Promise<string> {
  const t0 = performance.now();
  const id = await loadModel(opts);
  logInference({ node: auditNode, op: "loadModel", model: meta.model, delegated: meta.delegated ?? false, providerPublicKey: meta.providerPublicKey ?? null, load_ms: performance.now() - t0, event: "model loaded" });
  return id;
}

export async function auditUnloadModel(params: Parameters<typeof unloadModel>[0], meta: ModelMeta): Promise<void> {
  await unloadModel(params);
  logInference({ node: auditNode, op: "unloadModel", model: meta.model, delegated: meta.delegated ?? false, event: "model unloaded" });
}

export interface AuditCompletion { contentText: string; stats?: CompletionStats; toolCalls: ToolCallWithCall[]; wallTtftMs: number | null; wallTotalMs: number }
export async function auditCompletion(params: Parameters<typeof completion>[0], meta: ModelMeta & { event: string; onToken?: (t: string) => void }): Promise<AuditCompletion> {
  const t0 = performance.now();
  const run = completion(params);
  let wallTtftMs: number | null = null;
  for await (const ev of run.events) {
    if (ev.type === "contentDelta") {
      if (wallTtftMs === null) wallTtftMs = performance.now() - t0;
      meta.onToken?.(ev.text);
    }
  }
  const final = await run.final;
  const wallTotalMs = performance.now() - t0;
  const stats = final.stats as CompletionStats | undefined;
  logInference({ node: auditNode, op: "completion", model: meta.model, delegated: meta.delegated ?? false, providerPublicKey: meta.providerPublicKey ?? null, stats, wallTtftMs, wallTotalMs, event: meta.event });
  return { contentText: final.contentText, stats, toolCalls: final.toolCalls ?? [], wallTtftMs, wallTotalMs };
}

export async function auditEmbed(params: { modelId: string; text: string }, meta: ModelMeta & { event: string }): Promise<number[]> {
  const t0 = performance.now();
  const r = await embed(params);
  logInference({ node: auditNode, op: "embed", model: meta.model, delegated: false, wallTotalMs: performance.now() - t0, event: meta.event });
  return (r as { embedding: number[] }).embedding;
}

export async function auditOcr(params: Parameters<typeof ocr>[0], meta: ModelMeta & { event?: string }): Promise<{ blocks: Array<{ text: string }>; totalTime?: number }> {
  const t0 = performance.now();
  const { blocks, stats } = ocr(params);
  const b = (await blocks) as Array<{ text: string }>;
  const s = (await stats) as { totalTime?: number } | undefined;
  // Wall-clock only. The SDK's ocr `stats.totalTime` is in SECONDS, not ms, so logging it
  // as `wallTotalMs` underreported OCR by ~1000x (a ~5s read showed as gen_ms=5). Timing
  // load/OCR by wall-clock around the call is what this module documents at the top.
  logInference({ node: auditNode, op: "ocr", model: meta.model, delegated: false, wallTotalMs: performance.now() - t0, event: meta.event ?? `blocks=${b.length}` });
  return { blocks: b, totalTime: s?.totalTime };
}
