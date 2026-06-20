// Custos · C2 prefetch — warm the model cache for the extraction pipeline so the
// demo doesn't stall on cold downloads. Throwaway (plain ESM). Idempotent: cached
// assets are skipped by the registry client.
import {
  downloadAsset, close,
  SMOLVLM2_500M_MULTIMODAL_Q8_0, MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  OCR_LATIN_RECOGNIZER_1, OCR_CRAFT_DETECTOR,
} from "@qvac/sdk";

const assets = [
  ["SMOLVLM2_500M_MULTIMODAL_Q8_0", SMOLVLM2_500M_MULTIMODAL_Q8_0],
  ["MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0", MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0],
  ["OCR_CRAFT_DETECTOR", OCR_CRAFT_DETECTOR],
  ["OCR_LATIN_RECOGNIZER_1", OCR_LATIN_RECOGNIZER_1],
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
console.log("\nprefetch complete");
await close();
process.exit(0);
