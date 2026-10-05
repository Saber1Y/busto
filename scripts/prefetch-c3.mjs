// Busto · C3 prefetch — embeddings (RAG) + a tool-calling model. Throwaway ESM.
import { downloadAsset, close, GTE_LARGE_FP16, QWEN3_1_7B_INST_Q4 } from "@qvac/sdk";

const assets = [
  ["GTE_LARGE_FP16", GTE_LARGE_FP16],
  ["QWEN3_1_7B_INST_Q4", QWEN3_1_7B_INST_Q4],
];
for (const [name, src] of assets) {
  process.stdout.write(`\n→ ${name} ... `);
  try {
    let last = -1;
    await downloadAsset({
      assetSrc: src,
      onProgress: (p) => {
        const pct = Math.floor(p.percentage);
        if (pct !== last && pct % 10 === 0) { process.stdout.write(`${pct}% `); last = pct; }
      },
    });
    process.stdout.write("done");
  } catch (e) {
    process.stdout.write(`FAILED: ${String(e?.message ?? e).split("\n")[0]}`);
  }
}
console.log("\nC3 prefetch complete");
await close();
process.exit(0);
