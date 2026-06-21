import {
  loadModel,
  unloadModel,
  heartbeat,
  close,
  LLAMA_3_2_1B_INST_Q4_0,
} from "@qvac/sdk";
import { pathToFileURL } from "node:url";
import {
  loadEnvSafe,
  runCompletion,
  isDelegated,
  logInference,
  isHex64,
  type CompletionStats,
} from "../../shared/src/index.ts";

const MODEL = "LLAMA_3_2_1B_INST_Q4_0";
const DEFAULT_PROMPT = "In one sentence, why is on-device AI better for confidential invoices?";
const HEARTBEAT_TIMEOUT_MS = 45_000; // cold DHT bootstrap can take 15–45s on first contact
const DELEGATE_TIMEOUT_ONLINE_MS = 60_000;
const HEARTBEAT_ATTEMPTS = 3;
// Cold `dht.ready()` takes ~6s, but the SDK caps its pre-connect bootstrap wait
// at 5s (DHT_BOOTSTRAP_WAIT_CAP_MS) and then connects on an empty routing table,
// which fails instantly. The first heartbeat warms the SDK's cached swarm DHT;
// retries land on a bootstrapped DHT and connect (~7s incl. holepunch/relay).
const DHT_WARMUP_DELAY_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface ConsumerResult {
  providerOnline: boolean;
  delegated: boolean;
  /** Fell back to the local 1B because delegation was unavailable. */
  degradedMode: boolean;
  /** In degraded mode Custos NEVER auto-settles (threat #82). */
  autoSettleBlocked: boolean;
  load_ms: number;
  stats?: CompletionStats;
  text: string;
}

/**
 * Edge (Intel) consumer: heartbeat the provider, delegate inference to it
 * (falling back to a degraded local 1B if it's down), and emit one audit row.
 */
export async function runConsumer(opts: {
  providerPublicKey: string;
  prompt?: string;
  node?: string;
  heartbeatTimeoutMs?: number;
  delegateTimeoutMs?: number;
}): Promise<ConsumerResult> {
  const { providerPublicKey } = opts;
  if (!isHex64(providerPublicKey)) {
    throw new Error("providerPublicKey must be a 64-char hex string");
  }
  const prompt = opts.prompt ?? DEFAULT_PROMPT;
  const node = opts.node ?? "edge";

  let providerOnline = false;
  for (let attempt = 1; attempt <= HEARTBEAT_ATTEMPTS; attempt++) {
    try {
      await heartbeat({ delegate: { providerPublicKey, timeout: opts.heartbeatTimeoutMs ?? HEARTBEAT_TIMEOUT_MS } });
      providerOnline = true;
      break;
    } catch {
      if (attempt < HEARTBEAT_ATTEMPTS) {
        await sleep(DHT_WARMUP_DELAY_MS);
        continue;
      }
      logInference({ node, op: "heartbeat", model: MODEL, delegated: false, providerPublicKey, event: "provider-offline" });
    }
  }

  // The Edge holds the wallet keys but runs NO local inference (the x64 build
  // suppresses stop tokens). If the orchestrator is unreachable, hard-stop and
  // block settlement rather than degrade — threat #82. No fallbackToLocal.
  if (!providerOnline) {
    return {
      providerOnline: false,
      delegated: false,
      degradedMode: false,
      autoSettleBlocked: true,
      load_ms: 0,
      text: "Orchestrator offline — cannot proceed. Settlement blocked (threat #82).",
    };
  }

  const tLoad = performance.now();
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    delegate: {
      providerPublicKey,
      timeout: opts.delegateTimeoutMs ?? DELEGATE_TIMEOUT_ONLINE_MS,
      fallbackToLocal: false,
    },
  });
  const load_ms = performance.now() - tLoad;

  const delegated = await isDelegated(modelId);
  const degradedMode = !delegated;

  const res = await runCompletion(modelId, prompt);

  logInference({
    node,
    op: "completion",
    model: MODEL,
    delegated,
    providerPublicKey,
    load_ms,
    stats: res.stats,
    wallTtftMs: res.wallTtftMs,
    wallTotalMs: res.wallTotalMs,
    event: delegated ? "delegated-completion" : "degraded-local-fallback",
  });

  await unloadModel({ modelId });

  return {
    providerOnline,
    delegated,
    degradedMode,
    autoSettleBlocked: degradedMode,
    load_ms,
    stats: res.stats,
    text: res.text,
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadEnvSafe();
  if (process.env.CONSUMER_SEED) process.env.QVAC_HYPERSWARM_SEED = process.env.CONSUMER_SEED;
  const providerPublicKey = process.argv[2];
  if (!providerPublicKey) {
    console.error("Usage: node packages/edge/src/consumer.ts <providerPublicKey> [prompt]");
    process.exit(1);
  }
  const r = await runConsumer({ providerPublicKey, prompt: process.argv[3] });
  console.log("\n=== Edge consumer result ===");
  console.log(
    JSON.stringify(
      {
        providerOnline: r.providerOnline,
        delegated: r.delegated,
        degradedMode: r.degradedMode,
        autoSettleBlocked: r.autoSettleBlocked,
        load_ms: Math.round(r.load_ms),
        ttft_ms: r.stats?.timeToFirstToken ?? null,
        tok_per_sec: r.stats?.tokensPerSecond ?? null,
        backend_device: r.stats?.backendDevice ?? null,
      },
      null,
      2,
    ),
  );
  console.log(`\nResult text: ${r.text.trim()}`);
  if (!r.providerOnline) {
    console.warn("⛔ ORCHESTRATOR OFFLINE — hard-stop. The Edge runs no local inference; settlement BLOCKED (threat #82).");
  }
  await close();
  process.exit(0);
}
