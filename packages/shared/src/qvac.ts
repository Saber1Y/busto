import { completion, getLoadedModelInfo } from "@qvac/sdk";

/**
 * The CompletionStats fields Custos audits. Names are the exact ones the SDK
 * emits on `run.stats` (verified against @qvac/sdk@0.13.5 .d.ts + live smoke).
 * NOTE: output tokens are `generatedTokens` — NOT `completionTokens`.
 */
export interface CompletionStats {
  promptTokens?: number;
  generatedTokens?: number;
  timeToFirstToken?: number;
  tokensPerSecond?: number;
  cacheTokens?: number;
  backendDevice?: "cpu" | "gpu";
}

export interface RunResult {
  text: string;
  stats?: CompletionStats;
  /** Wall-clock time to first token (ms), measured client-side. */
  wallTtftMs: number | null;
  /** Wall-clock total generation time (ms), measured client-side. */
  wallTotalMs: number;
}

/** Stream a single-turn completion and capture text + profiler stats + wall timings. */
export async function runCompletion(modelId: string, prompt: string): Promise<RunResult> {
  const t0 = performance.now();
  const run = completion({ modelId, history: [{ role: "user", content: prompt }], stream: true });

  let wallTtftMs: number | null = null;
  let text = "";
  for await (const token of run.tokenStream) {
    if (wallTtftMs === null) wallTtftMs = performance.now() - t0;
    text += token;
  }
  const stats = (await run.stats) as CompletionStats | undefined;
  return { text, stats, wallTtftMs, wallTotalMs: performance.now() - t0 };
}

/**
 * Authoritative check of whether a loaded model is running on a remote provider
 * (delegated) or locally (fallback). Drives the `delegated` audit flag and the
 * degraded-mode settlement block.
 */
export async function isDelegated(modelId: string): Promise<boolean> {
  const info = (await getLoadedModelInfo({ modelId })) as { isDelegated?: boolean };
  return info.isDelegated === true;
}
