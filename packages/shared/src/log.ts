import { appendFileSync } from "node:fs";
import { LOG_PATH } from "./paths.ts";
import type { CompletionStats } from "./qvac.ts";

/** One auditable row in evidence/inference-log.jsonl. */
export interface InferenceRow {
  ts: string;
  node: string;
  op: string;
  model: string;
  delegated: boolean;
  provider_public_key: string | null;
  load_ms: number | null;
  ttft_ms: number | null;
  gen_ms: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  tok_per_sec: number | null;
  cache_tokens: number | null;
  backend_device: string | null;
  event: string | null;
  platform: string;
  metrics_source: "profiler-raw" | "none";
}

export interface LogOpts {
  node: string;
  op: string;
  model: string;
  delegated: boolean;
  providerPublicKey?: string | null;
  load_ms?: number | null;
  stats?: CompletionStats;
  wallTtftMs?: number | null;
  wallTotalMs?: number | null;
  event?: string;
}

const round = (n: number, p = 3): number => Number(n.toFixed(p));

/**
 * Build an audit row from REAL profiler stats and append it to the inference log.
 * Prefers profiler values (`generatedTokens`, `timeToFirstToken`, `tokensPerSecond`)
 * over wall-clock — Hard Rule 6: metrics come from the profiler, never hand-written.
 */
export function logInference(o: LogOpts): InferenceRow {
  const s = o.stats;
  const ttft = s?.timeToFirstToken ?? o.wallTtftMs ?? null;
  const tps =
    s?.tokensPerSecond ??
    (s?.generatedTokens && o.wallTotalMs ? (s.generatedTokens / (o.wallTotalMs / 1000)) : null);

  const row: InferenceRow = {
    ts: new Date().toISOString(),
    node: o.node,
    op: o.op,
    model: o.model,
    delegated: o.delegated,
    provider_public_key: o.providerPublicKey ?? null,
    load_ms: o.load_ms != null ? Math.round(o.load_ms) : null,
    ttft_ms: ttft != null ? round(ttft) : null,
    gen_ms: o.wallTotalMs != null ? Math.round(o.wallTotalMs) : null,
    prompt_tokens: s?.promptTokens ?? null,
    completion_tokens: s?.generatedTokens ?? null,
    tok_per_sec: tps != null ? round(tps) : null,
    cache_tokens: s?.cacheTokens ?? null,
    backend_device: s?.backendDevice ?? null,
    event: o.event ?? null,
    platform: `${process.platform}/${process.arch}`,
    metrics_source: s ? "profiler-raw" : "none",
  };

  appendFileSync(LOG_PATH, JSON.stringify(row) + "\n");
  return row;
}
