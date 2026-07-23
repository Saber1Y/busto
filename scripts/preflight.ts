// Custos · pre-demo preflight. Fails loudly BEFORE a live pitch rather than mid-demo.
//
// Checks, in order: wallet seed loads · Sepolia RPC answers on the pinned chain ·
// USD₮ covers a settlement · ETH covers gas with headroom · the OCR and vision weights
// are already on this machine (so nothing downloads while a judge is watching).
//
// Model presence is proven twice: the weight files are listed off disk, and each model
// is warm-loaded and unloaded through the real audit wrappers. A cold download would
// take minutes, so a load measured in seconds is itself the proof it was local.
//
// This appends loadModel/unloadModel rows to evidence/inference-log.jsonl — that is
// required by Hard Rule 6 (every QVAC call is logged) and is append-only. Nothing here
// ever rewrites the log.
import { homedir } from "node:os";
import { resolve } from "node:path";
import { readdirSync, statSync, existsSync } from "node:fs";
import {
  OCR_LATIN_RECOGNIZER_1,
  QWEN3VL_2B_MULTIMODAL_Q4_K,
  MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K,
} from "@qvac/sdk";
import { loadEnvSafe, setAuditNode, enableQvacAudit, auditLoadModel, auditUnloadModel, fromMinorUnits } from "../packages/shared/src/index.ts";
import { openEdgeWallet, CHAIN } from "../packages/edge/src/wallet.ts";

const MODELS_DIR = process.env.QVAC_MODELS_DIR ?? resolve(homedir(), ".qvac/models");
const MIN_USDT_MINOR = 1_000_000n; // 1.00 USD₮ — one demo settlement
const ERC20_TRANSFER_GAS = 65_000n;
const GAS_RUNS = 3n; // want headroom for a rehearsal plus the live demo

// Substrings of the weight filenames the demo path needs. Names come from the cache
// listing (`<hash>_<name>`), so match on the human-readable half.
const REQUIRED_WEIGHTS = [
  "detector_craft.onnx",
  "recognizer_latin.onnx",
  "Qwen3VL-2B-Instruct-Q4_K_M.gguf",
  "mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf",
];

let failures = 0;
const pass = (label: string, detail: string): void => { console.log(`  PASS  ${label.padEnd(38)} ${detail}`); };
const fail = (label: string, detail: string): void => { failures++; console.log(`  FAIL  ${label.padEnd(38)} ${detail}`); };
const mib = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(0)} MiB`;

const rpc = async (url: string, method: string, params: unknown[] = []): Promise<string | null> => {
  try {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method, params, id: 1 }) });
    return ((await r.json()) as { result?: string }).result ?? null;
  } catch { return null; }
};

console.log("\nCUSTOS PREFLIGHT\n");

// ── 1. seed ──────────────────────────────────────────────────────────────────
console.log("[1] wallet seed");
loadEnvSafe();
if (!process.env.CUSTOS_WALLET_SEED) {
  fail("CUSTOS_WALLET_SEED", "not set — the console will run in demo mode and cannot settle");
} else {
  pass("CUSTOS_WALLET_SEED", "present in .env (value never printed)");
}

// ── 2. wallet + RPC + balances ───────────────────────────────────────────────
console.log("\n[2] chain + funds");
if (process.env.CUSTOS_WALLET_SEED) {
  try {
    const w = await openEdgeWallet();
    pass("signer address", w.address);

    const chainIdHex = await rpc(w.rpcs[0], "eth_chainId");
    const blockHex = await rpc(w.rpcs[0], "eth_blockNumber");
    if (!chainIdHex || !blockHex) {
      fail("Sepolia RPC", `${w.rpcs[0]} did not answer`);
    } else if (parseInt(chainIdHex, 16) !== CHAIN.id) {
      fail("chain id", `RPC reports ${parseInt(chainIdHex, 16)}, pinned is ${CHAIN.id}`);
    } else {
      pass("Sepolia RPC", `${w.rpcs[0]} · chainId ${CHAIN.id} · block ${parseInt(blockHex, 16)}`);
    }

    const usdt = await w.account.getTokenBalance(CHAIN.usdt);
    if (usdt < MIN_USDT_MINOR) {
      fail("USD₮ balance", `${fromMinorUnits(usdt, CHAIN.usdtDecimals)} — need at least ${fromMinorUnits(MIN_USDT_MINOR, CHAIN.usdtDecimals)}`);
    } else {
      pass("USD₮ balance", `${fromMinorUnits(usdt, CHAIN.usdtDecimals)} USD₮ (${usdt} minor units)`);
    }

    const gasPrice = await rpc(w.rpcs[0], "eth_gasPrice");
    const eth = await w.account.getBalance();
    if (!gasPrice) {
      fail("gas price", "eth_gasPrice unavailable — cannot size the ETH floor");
    } else {
      const perSend = BigInt(gasPrice) * ERC20_TRANSFER_GAS * 2n;
      const floor = perSend * GAS_RUNS;
      const detail = `${fromMinorUnits(eth, 18).slice(0, 10)} ETH · one send costs ~${fromMinorUnits(perSend, 18).slice(0, 10)} · floor ${fromMinorUnits(floor, 18).slice(0, 10)} (${GAS_RUNS} sends)`;
      if (eth < floor) fail("ETH for gas", detail); else pass("ETH for gas", detail);
    }
    w.dispose();
  } catch (e) {
    fail("wallet", String((e as Error)?.message ?? e));
  }
} else {
  fail("chain checks", "skipped — no seed");
}

// ── 3. model weights on disk ─────────────────────────────────────────────────
console.log("\n[3] model weights present locally");
if (!existsSync(MODELS_DIR)) {
  fail("cache dir", `${MODELS_DIR} does not exist — every model would download on first use`);
} else {
  const files = readdirSync(MODELS_DIR);
  pass("cache dir", MODELS_DIR);
  for (const want of REQUIRED_WEIGHTS) {
    const hit = files.find((f) => f.includes(want));
    if (!hit) fail(want, "MISSING — would download mid-demo");
    else pass(want, mib(statSync(resolve(MODELS_DIR, hit)).size));
  }
}

// ── 4. warm load/unload through the real audit wrappers ──────────────────────
console.log("\n[4] warm load + unload (real QVAC, logged to the audit trail)");
setAuditNode("orchestrator");
enableQvacAudit();

const warm = async (label: string, opts: Parameters<typeof auditLoadModel>[0], model: string): Promise<void> => {
  try {
    const t0 = performance.now();
    const id = await auditLoadModel(opts, { model });
    const loadMs = Math.round(performance.now() - t0);
    await auditUnloadModel({ modelId: id, clearStorage: false }, { model });
    // A cold download of these weights takes minutes; seconds means it came off disk.
    if (loadMs > 60_000) fail(label, `loaded in ${loadMs}ms — that is download-shaped, not cache-shaped`);
    else pass(label, `loaded + unloaded in ${loadMs}ms (local)`);
  } catch (e) {
    fail(label, String((e as Error)?.message ?? e));
  }
};

await warm("OCR (CRAFT + Latin)", {
  modelSrc: OCR_LATIN_RECOGNIZER_1,
  modelConfig: { langList: ["en"], useGPU: true, timeout: 30_000, magRatio: 1.5, defaultRotationAngles: [90, 180, 270], contrastRetry: false, lowConfidenceThreshold: 0.5, recognizerBatchSize: 1 },
}, "OCR_LATIN_RECOGNIZER_1");

await warm("Vision (Qwen3-VL-2B)", {
  modelSrc: QWEN3VL_2B_MULTIMODAL_Q4_K,
  modelConfig: { ctx_size: 8192, projectionModelSrc: MMPROJ_QWEN3VL_2B_MULTIMODAL_Q4_K },
}, "QWEN3VL_2B_MULTIMODAL_Q4_K");

// ── verdict ──────────────────────────────────────────────────────────────────
console.log(failures === 0
  ? "\nPREFLIGHT OK — safe to demo.\n\nReminder: restart `npm run serve` between demo segments.\nVision context accumulates ~2780 tokens per verify against an 8192 window,\nso the 3rd–4th verify in one process overflows (evidence/pitch-fixes/stepX1-*).\n"
  : `\nPREFLIGHT FAILED — ${failures} check(s) need attention before demoing.\n`);
process.exit(failures === 0 ? 0 : 1);
