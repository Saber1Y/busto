# Custos P0 — Developer Reference

## 1. QVAC P2P Delegation

**Provider startup** — `startQVACProvider` (NOT `startProvider`). [high]
```ts
function startQVACProvider(params: ProvideParams): Promise<{ error?: string; publicKey?: string; success: boolean; type: "provide" }>;
```
```ts
import { startQVACProvider } from "@qvac/sdk";
const response = await startQVACProvider({
  firewall: allowedConsumerPublicKey
    ? { mode: "allow", publicKeys: [allowedConsumerPublicKey] }
    : undefined,
});
// response.publicKey = key consumers pin/connect to
```
- Source: `docs.qvac.tether.io/p2p-capabilities/delegated-inference/`, `/reference/api/`

**Deterministic provider identity** — seed before startup so the public key is stable and pinnable. [high]
```ts
process.env["QVAC_HYPERSWARM_SEED"] = seed; // 64-char hex
```

**Access control** — only documented primitive is the firewall allowlist `{ mode: "allow", publicKeys: [...] }`. No request nonce / replay protection exists at the SDK layer. [high]

**Consumer delegation** — pass `delegate` to `loadModel()`. [high]
```ts
const modelId = await loadModel({
  modelSrc: LLAMA_3_2_1B_INST_Q4_0,
  delegate: {
    providerPublicKey,        // required
    timeout: 60_000,          // ms
    fallbackToLocal: true,
    forceNewConnection: true,
  },
  onProgress: (p) => {},
});
```
```ts
function loadModel(options: LoadModelOptions, rpcOptions?: RPCOptions): Promise<string> & { requestId: string }
```
- Verified delegate keys: `providerPublicKey`, `timeout`, `fallbackToLocal`, `forceNewConnection`. No `topic` field. [high]

**Heartbeat** — optional delegate ping; no args = local worker. [high]
```ts
function heartbeat(params?: { delegate?: { healthCheckTimeout?: number; providerPublicKey: string; timeout?: number } }): Promise<HeartbeatResponse>;
```

**Stream resumption** — NONE. `resume()` is an app-lifecycle (foreground) call, not a stream-resume primitive. On suspend, a delegated stream RPC is **severed** (consumer iterator hangs silently) and is **not recovered** — it must be re-issued after `resume()`. [high]
```ts
function resume(): Promise<void>;
```
- Source: `docs.qvac.tether.io/runtime/lifecycle/`

**Request identity** — `requestId` is attached to the returned promise of long-running calls (`loadModel()`, `completion()`, `downloadAsset()`) and is used for targeted cancellation. No separate "session nonce" concept. [high]

---

## 2. QVAC Model Catalog

**Vision + projection (mmproj)** [high]
- LLM constant: `SMOLVLM2_500M_MULTIMODAL_Q8_0`
- Projection constant: `MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0`
- Config field: `projectionModelSrc` (inside `modelConfig`)
```ts
const modelId = await loadModel({
  modelSrc: SMOLVLM2_500M_MULTIMODAL_Q8_0,
  modelConfig: {
    ctx_size: 1024,
    projectionModelSrc: MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
  },
});
```
- Resolved GGUF (registry source): `SmolVLM2-500M-Video-Instruct-Q8_0.gguf` + `mmproj-SmolVLM2-500M-Video-Instruct-Q8_0.gguf` (HF SmolVLM2-500M-Video-Instruct). F16 variants also exist. [high]
- Image input via chat history: `attachments: [{ path: imageFilePath }]` on a user turn, then `completion({ modelId, history, stream: true })`. [high]
- `modelSrc` / `projectionModelSrc` accept a local path, remote URL, or Hyperdrive key. [high]
- Source: `docs.qvac.tether.io/ai-capabilities/multimodal/`, `/reference/api/`, registry `models.ts`

**Embeddings (RAG)** [high]
- Constant: `GTE_LARGE_FP16`
```ts
const modelId = await loadModel({
  modelSrc: GTE_LARGE_FP16,
  modelConfig: { gpuLayers: 99, device: "gpu" },
});
const { embedding } = await embed({ modelId, text: "Hello, world!" }); // string → 1 vector; string[] → array
```
- Source: `docs.qvac.tether.io/ai-capabilities/text-embeddings/`

**OCR (`@qvac/ocr-onnx` 0.6.0)** — real npm package, hard dep of `@qvac/sdk@0.13.5` (`"@qvac/ocr-onnx": "^0.6.0"`). [high]

High-level via `@qvac/sdk`:
```ts
import { loadModel, ocr, OCR_LATIN_RECOGNIZER_1 } from "@qvac/sdk";
const modelId = await loadModel({
  modelSrc: OCR_LATIN_RECOGNIZER_1,
  modelConfig: { langList: ["en"], useGPU: true, timeout: 30000, magRatio: 1.5,
    defaultRotationAngles: [90,180,270], contrastRetry: false,
    lowConfidenceThreshold: 0.5, recognizerBatchSize: 1 },
});
const { blocks } = ocr({ modelId, image: imagePath, options: { paragraph: false } });
const result = await blocks; // each block: .text, optional .bbox, .confidence
```
Low-level via `@qvac/ocr-onnx` (Bare runtime ≥ 1.19.3; EasyOCR [CRAFT+recognizers, default] or DocTR [DBNet+CRNN/PARSeq] pipelines):
```ts
const { ONNXOcr } = require('@qvac/ocr-onnx');
const model = new ONNXOcr({ params: { langList:['en'], pathDetector, pathRecognizer, useGPU, timeout }, opts: { stats:true } });
await model.load();
const response = await model.run({ path: imagePath, options: { paragraph: true, rotationAngles:[90,270], boxMarginMultiplier:1.0 } });
```
- Source: `registry.npmjs.org/@qvac/ocr-onnx`, `docs.qvac.tether.io/ai-capabilities/ocr/`

**Built-in model constants** (verbatim named exports of `@qvac/sdk`) [high]
```
LLAMA_3_2_1B_INST_Q4_0, LLAMA_2_7B_CHAT_GGUF, WHISPER_TINY, PARAKEET_TDT_0_6B_V3_Q8_0,
TTS_T3_TURBO_EN_CHATTERBOX_Q8_0, TTS_S3GEN_EN_CHATTERBOX, TTS_MULTILINGUAL_SUPERTONIC2_Q8_0,
REALESRGAN_X4PLUS_ANIME_6B, SMOLVLM2_500M_MULTIMODAL_Q8_0, MMPROJ_SMOLVLM2_500M_MULTIMODAL_Q8_0,
GTE_LARGE_FP16, OCR_LATIN_RECOGNIZER_1
```
Import (dynamic form): `const { loadModel, LLAMA_3_2_1B_INST_Q4_0, completion, unloadModel } = await import("@qvac/sdk");`
- `modelConfig` fields include: `ctx_size`, `projectionModelSrc`, `vadModelSrc`, `language`, `ttsEngine`, `s3genModelSrc`, `mode`, `upscaler`, `lora_apply_mode`. [high]
- Source: `docs.qvac.tether.io/reference/api/`, `/quickstart/`

> Note: `huggingface.co/qvac` does NOT back these constants. SDK constants resolve via the QVAC P2P (Hyperswarm) registry. The HF `qvac` org hosts only research/fine-tune repos (MedPsy, genesis, fabric) — do not wire Custos to it for SmolVLM2/GTE/Whisper weights. [high]

---

## 3. QVAC Completion / Profiler Stats Field Names

> All field names quoted verbatim from `@qvac/sdk@0.13.5` `.d.ts` (npm tarball `sdk-0.13.5.tgz`) — runtime-authoritative. The hosted reference page defers to these `.d.ts` files. [high]

**`completion()`** — returns `CompletionRun` synchronously (not a Promise). [high]
```ts
export declare function completion(params: CompletionParams): CompletionRun;
```
```ts
type CompletionParams = Omit<CompletionClientParams, "tools"> & {
  tools?: Tool[] | ToolInput[]; mcp?: McpClientInput[];
  rpcOptions?: RPCOptions; captureThinking?: boolean; emitRawDeltas?: boolean;
};
// stream defaults to true
```
- `history` message shape: `{ role: string; content: string; attachments?: { path: string }[] }` (role/content are plain strings). [high]

**Streamed events** — `run.events: AsyncIterable<CompletionEvent>`; every event has `type` + `seq: number`. [high]
```ts
contentDelta:    { type:"contentDelta";    seq:number; text:string }
rawDelta:        { type:"rawDelta";        seq:number; text:string }
thinkingDelta:   { type:"thinkingDelta";   seq:number; text:string }
toolCall:        { type:"toolCall";        seq:number; call:{ id:string; name:string; arguments:Record<string,unknown>; raw?:string } }
toolError:       { type:"toolError";       seq:number; error:{ code:"PARSE_ERROR"|"VALIDATION_ERROR"|"UNKNOWN_TOOL"; message:string; raw?:string } }
completionStats: { type:"completionStats"; seq:number; stats:CompletionStats }
completionDone:  { type:"completionDone";  seq:number; stopReason?:"cancelled"|"eos"|"length"|"stopSequence"; raw?:{ fullText:string } }
```

**Final aggregate** — read `(await run.final).stats`. [high]
```ts
type CompletionFinal = { contentText: string; thinkingText?: string; toolCalls: ToolCallWithCall[]; stats?: CompletionStats; stopReason?: StopReason; raw: { fullText: string }; cacheableAssistantContent?: string };
type CompletionRun = { requestId: string; events: AsyncIterable<CompletionEvent>; final: Promise<CompletionFinal>; tokenStream: AsyncGenerator<string>; toolCallStream: AsyncGenerator<ToolCallEvent>; text: Promise<string>; toolCalls: Promise<ToolCallWithCall[]>; stats: Promise<CompletionStats | undefined> };
// run.stats is a DEPRECATED mirror
```

**`CompletionStats` — LOCK FOR AUDIT LOGGER** (all optional) [high]
```ts
completionStatsSchema = z.object({
  timeToFirstToken: z.number().optional(),   // TTFT
  tokensPerSecond:  z.number().optional(),   // throughput
  cacheTokens:      z.number().optional(),   // KV-cache reuse
  promptTokens:     z.number().optional(),
  generatedTokens:  z.number().optional(),   // output tokens — NOT "completionTokens"
  backendDevice:    z.enum({ cpu:"cpu", gpu:"gpu" }).optional(),
});
```
- Critical naming: output tokens = `generatedTokens` (no `completionTokens`); prompt = `promptTokens`; TTFT = `timeToFirstToken`; throughput = `tokensPerSecond`; KV reuse = `cacheTokens`; device = `backendDevice`. No load/unload timing inside `CompletionStats`. [high]

**Profiler** — `import { profiler } from "@qvac/sdk"`. [high]
```ts
profiler.enable(options?: ProfilerRuntimeOptions): void;  // resets aggregates
profiler.disable(): void;
profiler.isEnabled(): boolean;
profiler.exportJSON(options?: { includeRecentEvents?: boolean }): ProfilerExport;
profiler.exportTable(): string;
profiler.exportSummary(): string;
profiler.onRecord(cb: (event: ProfilingEvent) => void): () => void;
profiler.getConfig(): ResolvedProfilerConfig;
profiler.getAggregates(): Record<string, AggregatedStats>;
profiler.clear(): void;
// ProfilerRuntimeOptions: { mode?: "summary"|"verbose"; includeServerBreakdown?: boolean; operationFilters?: string[] }
// usage: profiler.enable({ mode: "summary" }); ...; console.log(profiler.exportTable()); profiler.disable();
```

**Profiler event taxonomy** [high]
```ts
type ProfilingEventKind = "rpc" | "handler" | "download" | "load" | "delegation";
interface ProfilingEvent { ts:number; op:string; kind:ProfilingEventKind; profileId?:string; phase?:string; ms?:number; count?:number; bytes?:number; gauges?:Record<string,number>; tags?:Record<string,string> }
interface AggregatedStats { count:number; min:number; max:number; avg:number; sum:number; last:number }
interface ProfilerExport { config:{ enabled:boolean; mode:"summary"|"verbose"; includeServerBreakdown:boolean; operationFilters:string[]; maxRecentEvents:number }; aggregates:Record<string,AggregatedStats>; recentEvents?:ProfilingEvent[]; exportedAt:number }
```

**Load / download timing** (separate from `CompletionStats`) [high]
```ts
interface LoadTimingStats { modelInitializationTimeMs?:number; totalLoadTimeMs?:number }
interface DownloadStats { downloadTimeMs?:number; totalBytesDownloaded?:number; downloadSpeedBps?:number; checksumValidationTimeMs?:number; cacheHit?:boolean; sharedTransfer?:boolean }
// unloadModel(params): Promise<void>  — NO unload-timing struct in 0.13.5; derive via profiler/wall-clock
```

**P2P delegation timing** (unary-only injection; streaming records server-side but does not inject) [high]
```ts
delegationBreakdownSchema = z.object({ profileId, connectionMs, requestStringifyMs, serverWaitMs, responseJsonParseMs, totalDelegationMs }); // all .number().optional()
// profiler phases: delegation.connection / delegation.serverWait / delegation.totalDelegationTime
```

**Server-side timing** (when `includeServerBreakdown` enabled) [high]
```ts
serverBreakdownSchema = z.object({ requestJsonParseMs, requestZodValidationMs, handlerExecutionMs, responseZodValidationMs, responseStringifyMs, totalServerMs }); // all .number().optional()
```

---

## 4. WDK Account / Balance / Transfer

> `@tetherto/wdk-wallet-evm` (latest beta.13), `@tetherto/wdk` orchestrator (beta.12). Signatures from published `.d.ts` + `tetherto/wdk-examples`. NOT Vercel Workflow DevKit.

**Create EVM account (Sepolia)** [high]
```ts
import WalletManagerEvm from '@tetherto/wdk-wallet-evm';
const wallet = new WalletManagerEvm(seedPhrase, { provider: 'https://sepolia.drpc.org' });
const account = await wallet.getAccount(0);
const address = await account.getAddress();
wallet.dispose();
```
```ts
class WalletManagerEvm extends WalletManager {
  constructor(seed: string | Uint8Array, config?: EvmWalletConfig);
  getAccount(index?: number): Promise<WalletAccountEvm>;
  getAccountByPath(path: string): Promise<WalletAccountEvm>;
  getFeeRates(): Promise<FeeRates>;
}
type EvmWalletConfig = {
  provider?: string | Eip1193Provider | Array<string | Eip1193Provider>;
  retries?: number;        // default 3 (provider arrays only)
  chainId?: number;        // pass 11155111 for Sepolia to skip auto-detect
  transferMaxFee?: number | bigint;
  transactionMaxFee?: number | bigint;
};
```
Orchestrator path [high]:
```ts
import WDK from '@tetherto/wdk';
const wdk = new WDK(seedPhrase).registerWallet('ethereum', WalletManagerEvm, { provider: 'https://sepolia.drpc.org' });
const account = await wdk.getAccount('ethereum', 0);
// WDK: registerWallet<W>(blockchain, WalletManager: W, config: ConstructorParameters<W>[1]): WDK
// static getRandomSeedPhrase(wordCount?: 12|24): string; static isValidSeed(seed): boolean
```

**Read balances** [high]
```ts
const native = await account.getBalance();                     // ETH in wei (bigint)
const usdt   = await account.getTokenBalance(tokenAddress);    // base units (bigint), via balanceOf
const many   = await account.getTokenBalances([t1, t2]);       // Record<address, bigint>
```
> Token balances are raw base units — apply token decimals yourself.

**Transfer USD₮ / ERC-20** — the method is `transfer()`, NOT `sendTransaction()`. [high — independently confirmed across API ref, guide, and example file]
```ts
const result = await account.transfer({ token, recipient, amount }); // → { hash, fee }
const quote  = await account.quoteTransfer({ token, recipient, amount }); // → { fee }, no send
// type EvmTransferOptions = { token: string; recipient: string; amount: number | bigint; authorizationList?: AuthorizationLike[] }
```
- `sendTransaction(tx)` / `quoteSendTransaction(tx)` are for **native** txs only — do not use for ERC-20. [high]
- `approve({ token, spender, amount })` **throws** if approving USDT with a non-zero existing allowance (USDT reset-to-zero rule). [high]
- `account.dispose()` erases the private key from memory. [high]
- Caveat: the docs guide example uses the **mainnet** USDT address `0xdAC17F95...`; on Sepolia load the token address from config (see §5). [high]

**Seed handling — `@tetherto/wdk-secret-manager` (beta.3, shipped `.d.ts`/`.js`)** [high]
```ts
export const wdkSaltGenerator: { generate: (() => Buffer) };
export class WdkSecretManager {
  constructor(passKey: Buffer | ArrayBuffer | Uint8Array | string, salt?: Buffer);
  generateAndEncrypt(payload?: Buffer, derivedKey?: Buffer): { encryptedSeed: Buffer; encryptedEntropy: Buffer };
  decrypt(payload: Buffer, derivedKey?: Buffer): Buffer;
  generateRandomBuffer(): Buffer;
  entropyToMnemonic(entropy: Buffer): string;
  mnemonicToEntropy(seedPhrase: string): Buffer;
  dispose(): void; // zeroizes passkey/salt
}
```
- Crypto: libsodium `crypto_secretbox` (XSalsa20-Poly1305) + PBKDF2-SHA256 KDF. `generateAndEncrypt` makes entropy → BIP-39 mnemonic → seed and returns both encrypted. [high]
- ⚠️ The beta.3 README documents a richer API (static `generateSalt()`, 3-arg constructor with `{ iterations }`, standalone `encrypt()`) that the **shipped beta.3 binary does NOT expose**. Trust the shipped `.d.ts`/`.js`; pin and inspect your exact installed version before writing key-management code. [medium]

---

## 5. WDK Sepolia USD₮ Faucet + RPC + Token Address

> From `docs.wdk.tether.io/sdk/wallet-modules/wallet-evm-erc-4337/configuration` and the Node.js/Bare quickstart. The ERC-4337 (Safe smart account) setup is gasless via paymaster — fees are paid in the paymaster token (the same Sepolia mock USD₮), so USD₮ doubles as gas.

**Test USD₮ faucets** [high]
- Pimlico: `https://dashboard.pimlico.io/test-erc20-faucet`
- Candide: `https://dashboard.candide.dev/faucet`

**Sepolia USD₮ token address** (faucet-dispensed, used as `paymasterToken.address`) [high]
```
0xd077a400968890eacc75cdc901f0356c943e4fdb
```
- Etherscan: `https://sepolia.etherscan.io/address/0xd077a400968890eacc75cdc901f0356c943e4fdb`
- Decimals: **6** (`transferMaxFee: 100000 // 0.1 USDT (6 decimals)`). [medium — stated only via inline doc comment; `decimals()` not read on-chain]

**WDK-pinned RPC** (chainId 11155111) [high]
```
https://sepolia.drpc.org
```
- This is NOT advertised as MEV-protected on its public tier.

**MEV-protected alternative** (NOT WDK-pinned — sourced from Flashbots docs) [high]
```
https://rpc-sepolia.flashbots.net/
```
- Flashbots Protect routes through a private mempool (frontrunning/sandwich protection). Validate ERC-4337 bundler/paymaster compatibility before swapping away from WDK's pinned dRPC endpoint.

**Full Sepolia ERC-4337 config blocks** (verbatim) [high]
```ts
const sepoliaConfigPimlico = {
  chainId: 11155111,
  provider: 'https://sepolia.drpc.org',
  bundlerUrl: 'https://public.pimlico.io/v2/11155111/rpc',
  paymasterUrl: 'https://public.pimlico.io/v2/11155111/rpc',
  paymasterAddress: '0x777777777777AeC03fd955926DbF81597e66834C',
  safeModulesVersion: '0.3.0',
  paymasterToken: { address: '0xd077a400968890eacc75cdc901f0356c943e4fdb' }, // USDT Sepolia
  transferMaxFee: 100000, // 0.1 USDT (6 decimals)
};
const sepoliaConfigCandide = {
  chainId: 11155111,
  provider: 'https://sepolia.drpc.org',
  bundlerUrl: 'https://api.candide.dev/public/v3/11155111',
  paymasterUrl: 'https://api.candide.dev/public/v3/11155111',
  paymasterAddress: '0x8b1f6cb5d062aa2ce8d581942bbb960420d875ba',
  safeModulesVersion: '0.3.0',
  paymasterToken: { address: '0xd077a400968890eacc75cdc901f0356c943e4fdb' }, // USDT Sepolia
  transferMaxFee: 100000,
};
```
> WDK warning (verbatim): "Ethereum Sepolia is a testnet. The USD₮ tokens available at the links below are not real... they cannot be redeemed with Tether International... and are not Tether Tokens."

---

## UNVERIFIED / needs package introspection

Confirm these by reading the installed `node_modules/@qvac/sdk/dist`, `@qvac/ocr-onnx`, and WDK `.d.ts` / on-chain before relying on them.

**QVAC P2P delegation**
- Full body of `HeartbeatResponse` (referenced by name only in docs; no field-level type published).
- Full `ProvideParams` body and complete `firewall` type — only `mode: "allow"` + `publicKeys: string[]` shown by example; deny/block modes not documented.
- Complete `LoadModelOptions` / `delegate` TypeScript type with field optionality (only example fields confirmed; a `topic` field appeared in third-party summaries but is NOT in official pages).
- Version pinning: docs self-label v0.13.x (release notes cover 0.13.0–0.13.3); 0.13.5 signature stability is inferred, not explicitly enumerated. Live reference page header has read both v0.11.0 and v0.13.x across pages.
- Whether any session/replay-protection nonce exists for delegated inference — no such concept found anywhere in docs.

**QVAC model catalog**
- Exact backing GGUF id + SHA-256 for each SDK constant (`GTE_LARGE_FP16`, etc.) — baked into the P2P registry entry, not on public doc pages. (SmolVLM2 GGUF filenames were confirmed via the registry `models.ts` source; others not.)
- Whether Qwen2.5-Omni / Qwen3-VL ("Quen3-VL" is a doc typo) is an actual named SDK constant — only listed in prose as a recommended pair; only confirmed vision constants are the SmolVLM2 pair.
- The full/exhaustive list of every exported constant (SDK reportedly maps to ~hundreds of registry models; only 12 surfaced here).
- Exact return type of `embed()` (single → `number[]`, batch → `number[][]` stated by summarizer, not from a verbatim signature).
- Whether `OCR_LATIN_RECOGNIZER_1` resolves both a CRAFT detector and a latin recognizer ONNX from the single constant (low-level API needs `pathDetector` + `pathRecognizer`; detector constant name not surfaced).

**QVAC completion / profiler**
- Emission cadence of `completionStats` events (mid-stream vs end-only) — not pinned from `.d.ts`; confirm at runtime if dedup matters.
- Exact column headers / text produced by `profiler.exportTable()` and `exportSummary()` (generated at runtime in `exporters.js`).
- Exact profiler phase-string names for the `load` kind (delegation.* / server.* phase prefixes are confirmed; load.* not located in a declaration file).
- No dedicated `unloadTimeMs` / unload-timing struct exists in 0.13.5 — must be derived externally.

**WDK**
- Sepolia USD₮ `decimals()` not read on-chain (assumed 6 from doc comment, consistent with mainnet USDT).
- Whether Pimlico/Candide faucets currently dispense exactly `0xd077a4...e4fdb` vs a different mock token (taken from WDK docs' assertion; live dashboards are auth/JS-gated).
- wdk-secret-manager beta.3 README vs shipped-binary API discrepancy (see §4) — repo main branch is beta.1, npm latest is beta.3; they disagree. Verify against the exact installed version.
- wallet-evm `.d.ts` quoted from repo main branch, not pinned to the exact beta.13 tarball (README + examples + types were internally consistent).
- Whether the public `sepolia.drpc.org` tier applies any MEV protection (dRPC MEV protection is described elsewhere as a premium feature; not confirmed for the public endpoint).
- Version-pin confirmation on the specific docs pages read (no version selector verified; read as current/main).