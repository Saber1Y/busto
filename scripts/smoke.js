// Custos · C0 smoke harness
// Runs the SAME QVAC model on whichever Mac you run it on, and emits one
// JSONL metrics row (load_ms, ttft_ms, tok_per_sec). Run on BOTH nodes:
//   M1 Pro  (Metal)  -> CUSTOS_NODE=orchestrator npm run smoke
//   Intel   (CPU)    -> CUSTOS_NODE=edge        npm run smoke
// The delta between the two rows is our first honest, reproducible datapoint.

import { loadModel, LLAMA_3_2_1B_INST_Q4_0, completion, unloadModel } from "@qvac/sdk";
import os from "node:os";

const NODE_LABEL = process.env.CUSTOS_NODE || os.hostname();
const MODEL_NAME = "LLAMA_3_2_1B_INST_Q4_0";
const PROMPT =
  "List three reasons on-device AI is better than the cloud for handling " +
  "confidential financial documents. Be concise.";

const ms = () => Number(process.hrtime.bigint() / 1_000_000n);

async function main() {
  // ---- load ----
  const tLoad = ms();
  const modelId = await loadModel({
    modelSrc: LLAMA_3_2_1B_INST_Q4_0,
    modelType: "llm",
    // onProgress: (p) => process.stderr.write(`\rload ${p.percentage ?? ""}%`),
  });
  const load_ms = ms() - tLoad;

  // ---- generate (streamed, canonical events API) ----
  const run = completion({
    modelId,
    history: [{ role: "user", content: PROMPT }],
    stream: true,
  });

  let ttft_ms = null;
  let last_ms = null;
  let chars = 0;
  let out = "";
  const tGen = ms();

  for await (const event of run.events) {
    if (event.type === "contentDelta") {
      const t = ms();
      if (ttft_ms === null) ttft_ms = t - tGen;
      last_ms = t;
      out += event.text;
      chars += event.text.length;
    }
  }

  const final = await run.final;
  const stats = final?.stats ?? {};
  const gen_ms = (last_ms ?? ms()) - tGen;

  // Field names vary slightly by SDK version — try both, fall back to chars/4.
  const completion_tokens =
    stats.completionTokens ?? stats.completion_tokens ?? stats.tokens ?? null;
  const prompt_tokens = stats.promptTokens ?? stats.prompt_tokens ?? null;
  const tok_per_sec =
    completion_tokens && gen_ms > 0
      ? +(completion_tokens / (gen_ms / 1000)).toFixed(2)
      : +(chars / 4 / (gen_ms / 1000)).toFixed(2); // ~4 chars/token approximation

  await unloadModel({ modelId });

  const row = {
    ts: new Date().toISOString(),
    node: NODE_LABEL,
    op: "smoke",
    model: MODEL_NAME,
    delegated: false,
    load_ms,
    ttft_ms,
    gen_ms,
    prompt_tokens,
    completion_tokens,
    tok_per_sec,
    platform: `${os.platform()}/${os.arch()}`,
  };

  // The metrics row (this is what to paste back):
  console.log(JSON.stringify(row));
  // Human context:
  process.stderr.write("\n--- model output ---\n" + out + "\n");
  // Raw stats so we can lock exact field names for the real logger in C6:
  process.stderr.write("\n--- raw stats ---\n" + JSON.stringify(stats, null, 2) + "\n");
}

main().catch((err) => {
  console.error("❌ smoke failed:", err);
  process.exit(1);
});
