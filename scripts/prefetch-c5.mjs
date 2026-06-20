import { downloadAsset, close, QWEN3VL_2B_MULTIMODAL_Q4_K, MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K } from "@qvac/sdk";
for (const [n,s] of [["QWEN3VL_2B_MULTIMODAL_Q4_K",QWEN3VL_2B_MULTIMODAL_Q4_K],["MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K",MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K]]) {
  process.stdout.write(`\n-> ${n} `); let last=-1;
  try { await downloadAsset({ assetSrc:s, onProgress:p=>{const pc=Math.floor(p.percentage); if(pc!==last&&pc%10===0){process.stdout.write(pc+"% ");last=pc;}} }); process.stdout.write("done"); }
  catch(e){ process.stdout.write("FAIL "+String(e?.message??e).split("\n")[0]); }
}
console.log("\nC5 prefetch complete"); await close(); process.exit(0);
