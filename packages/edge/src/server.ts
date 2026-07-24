import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, extname, sep } from "node:path";
import { GTE_LARGE_FP16, heartbeat } from "@qvac/sdk";
import { loadEnvSafe, logInference, buildPaymentIntent, toMinorUnits, fromMinorUnits, setAuditNode, auditLoadModel, auditEmbed, isHex64, generateHyperswarmSeed, type PaymentIntent } from "../../shared/src/index.ts";
import { openErp, ensureSchema, seedErp, lookupVendor, type EmbedFn } from "../../orchestrator/src/erp.ts";
import { extractInvoice, type ExtractResult } from "../../orchestrator/src/extract.ts";
import { computeVerdict, type Verdict } from "../../orchestrator/src/verdict.ts";
import { explainInvoice, type ExplainContext } from "../../orchestrator/src/explain.ts";
import { assistChat, buildErpSnapshot } from "../../orchestrator/src/assistant.ts";
import { runVerificationAgent } from "../../orchestrator/src/tools.ts";
import { openEdgeWallet, CHAIN } from "./wallet.ts";
import { settleIntent } from "./settle.ts";

type Res = import("node:http").ServerResponse;
type Req = import("node:http").IncomingMessage;

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const UI = resolve(HERE, "../ui");
const SAMPLES = resolve(REPO, "data/sample");
const PORT = Number(process.env.PORT ?? 4173);
// Loopback only. POST /api/approve signs and broadcasts a real transfer with no auth,
// so binding 0.0.0.0 would put the key-holder's approve endpoint on the venue WiFi.
const HOST = process.env.HOST ?? "127.0.0.1";

loadEnvSafe();

// When delegating, the Edge consumer must NOT reuse the provider's hyperswarm identity —
// the .env QVAC_HYPERSWARM_SEED IS the provider's seed, and two peers sharing one identity
// never form a connection. Give the consumer a distinct identity (CONSUMER_SEED if set,
// else ephemeral) before any SDK/P2P call. Mirrors consumer.ts.
if (process.env.DELEGATE_REASONING === "true") {
  process.env.QVAC_HYPERSWARM_SEED = isHex64(process.env.CONSUMER_SEED) ? process.env.CONSUMER_SEED : generateHyperswarmSeed();
}

const db = openErp(resolve(REPO, "data/erp.db"));
ensureSchema(db);

// Retrieval runs in the served product, not only in the C3 demo script. GTE-large loads
// once at boot and stays resident — it seeds the PO vector store and embeds one query per
// verify, so there is no per-request load tax for a 0.62 GiB model. Retrieval is ADVISORY
// (verdict.ts): it reports what is *near*, it never widens what can pass.
const RAG_MODEL = "GTE_LARGE_FP16";
const RAG_ENABLED = process.env.CUSTOS_RAG !== "off"; // demo/measurement lever; verdict is identical either way
let ragEmbed: EmbedFn | undefined;
if (!RAG_ENABLED) {
  console.log("  RAG   disabled (CUSTOS_RAG=off) — exact-match verification only; retrieval panel absent");
  await seedErp(db);
} else try {
  setAuditNode("orchestrator");
  const gteId = await auditLoadModel({ modelSrc: GTE_LARGE_FP16, modelConfig: { gpuLayers: 99, device: "gpu" } }, { model: RAG_MODEL });
  const embedWith = (event: string): EmbedFn => async (text) => {
    setAuditNode("orchestrator");
    return auditEmbed({ modelId: gteId, text }, { model: RAG_MODEL, event });
  };
  await seedErp(db, embedWith("seed-po-embedding"));
  ragEmbed = embedWith("rag-query");
  console.log(`  RAG   ${RAG_MODEL} resident · purchase-order retrieval is live (advisory)`);
} catch (e) {
  // Never a boot failure: the verdict is exact-match arithmetic and needs no inference.
  // Say so out loud rather than serving a silently degraded product.
  const detail = String((e as Error)?.message ?? e);
  console.error(`  RAG   ${RAG_MODEL} did NOT load — ${detail}`);
  console.error("  RAG   falling back to exact-match verification only. Verdicts are unchanged; the retrieval panel will be absent.");
  logInference({ node: "orchestrator", op: "rag-unavailable", model: RAG_MODEL, delegated: false, event: `load failed: ${detail}` });
  await seedErp(db);
}

// Hugo #3 — reasoning delegation. OFF by default: the served product runs everything
// locally, exactly as before. ON (DELEGATE_REASONING=true + PROVIDER_PUBKEY) routes the
// PURE-TEXT reasoning — explain, assist, tool-calling turns — to the Vault provider over
// QVAC P2P. OCR, vision and RAG embeds ALWAYS stay local (SDK: only completionStream is
// delegatable). The verdict is never delegated — judgment stays on the key-holder. A boot
// heartbeat only reports reachability; the real hard-stop (threat #82, no local fallback)
// is enforced per-call by fallbackToLocal:false in loadReasoningModel.
const DELEGATE_REASONING = process.env.DELEGATE_REASONING === "true";
const PROVIDER_PUBKEY = process.env.PROVIDER_PUBKEY;
if (DELEGATE_REASONING) {
  if (!isHex64(PROVIDER_PUBKEY)) {
    console.error("  P2P   DELEGATE_REASONING=true but PROVIDER_PUBKEY is not a 64-hex key — reasoning calls will hard-stop until it is set.");
  } else {
    // Warm the swarm DHT at boot. Cold `dht.ready()` outlasts the SDK's 5s pre-connect
    // cap, so the first heartbeat lands on an empty routing table and fails; retries land
    // on a bootstrapped DHT and connect (~7s). Mirrors consumer.ts. This warms THIS
    // process's DHT cache so the per-call delegated loadModel connects immediately.
    const short = `${PROVIDER_PUBKEY.slice(0, 8)}…${PROVIDER_PUBKEY.slice(-6)}`;
    let reachable = false;
    for (let attempt = 1; attempt <= 3 && !reachable; attempt++) {
      try {
        await heartbeat({ delegate: { providerPublicKey: PROVIDER_PUBKEY, timeout: 45_000 } });
        reachable = true;
      } catch {
        if (attempt < 3) await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    if (reachable) console.log(`  P2P   reasoning delegated to Vault · provider ${short} reachable · OCR/vision/embed stay local`);
    else console.error(`  P2P   provider ${short} UNREACHABLE at boot — reasoning calls will hard-stop (threat #82); no local fallback. Verify/settle still run locally.`);
  }
} else {
  console.log("  P2P   reasoning local (DELEGATE_REASONING off) — set it + PROVIDER_PUBKEY to delegate explain/assist/tool-calling to Vault");
}

interface Job { explainContext: ExplainContext; status: string; intent?: PaymentIntent; vendorId?: number; poId?: number }
const jobs = new Map<string, Job>();
let busy = false; // one QVAC op (verify or explain) at a time
let settlingJobId: string | null = null; // one real on-chain transfer at a time (one wallet, one nonce)

const SAMPLE_LIST = [
  { id: "ui-clean", label: "Clean invoice", note: "Acme Robotics · 1 USD₮ · matches the PO", expect: "verified" },
  { id: "ui-fraud", label: "Swapped payment wallet", note: "Acme invoice, attacker's wallet printed", expect: "blocked · recipient" },
  { id: "ui-injection", label: "Hidden instruction", note: "“ignore previous instructions…” in the notes", expect: "blocked · Gate 0" },
  { id: "ui-amount", label: "Amount doesn't match a PO", note: "4,242 USD₮ — no matching order", expect: "blocked · ERP" },
];

// Profiler footer payload for an assistant answer — straight from `run.stats`
// (profiler-raw). When delegated, the stats are the PROVIDER's profiler numbers and the
// footer says so. `undefined` when no model ran (a canned early-return sentence).
function profOf(a: { stats?: import("../../shared/src/index.ts").CompletionStats; delegated?: boolean; providerPublicKey?: string | null }): Record<string, unknown> | undefined {
  if (!a.stats) return undefined;
  const s = a.stats;
  return { tokens: s.generatedTokens ?? null, tps: s.tokensPerSecond ?? null, ttft: s.timeToFirstToken ?? null, device: s.backendDevice ?? null, source: "profiler-raw", delegated: !!a.delegated, provider: a.providerPublicKey ?? null };
}

const MIME: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const json = (res: Res, code: number, body: unknown): void => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
const readBody = (req: Req): Promise<Buffer> => new Promise((ok) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });

function openPOsFor(vendorName: string): ExplainContext["vendorOpenPOs"] {
  const v = lookupVendor(db, vendorName);
  if (!v.vendorId) return [];
  const rows = db.prepare("SELECT po_number, amount_minor, currency FROM purchase_orders WHERE vendor_id = ? AND status = 'open'")
    .all(v.vendorId) as Array<{ po_number: string; amount_minor: string; currency: string }>;
  return rows.map((r) => ({ poNumber: r.po_number, amount: fromMinorUnits(BigInt(r.amount_minor), 6), currency: r.currency }));
}

function buildExplainContext(invoiceRef: string, ex: ExtractResult, verdict: Verdict): ExplainContext {
  return {
    invoiceRef,
    extraction: { vendorName: ex.extraction.vendorName, invoiceAmount: ex.extraction.invoiceAmount, currency: ex.extraction.currency, providedWallet: ex.extraction.providedWallet },
    verdict,
    vendorOpenPOs: openPOsFor(ex.extraction.vendorName),
    gate0Findings: ex.gate0.findings.map((f) => ({ grade: f.grade, encoding: f.encoding, detail: f.detail })),
  };
}

function gatesFromVerdict(v: Verdict, gate0Flagged: boolean): Array<{ id: string; name: string; state: "cleared" | "blocked" | "pending"; detail: string }> {
  // "Deterministic truth" (G2) also covers replay AND the OCR-vs-vision cross-check: a
  // duplicate invoice or two reads that disagree is not a clean record, so the ladder stays
  // consistent with the BLOCKED verdict instead of showing all gates cleared.
  const readsAgree = v.checks.crossCheckOk;
  const g2 = readsAgree && v.checks.vendorExists && v.checks.vendorActive && v.checks.amountParsed && v.checks.poMatched && v.checks.notDuplicate;
  const g2Detail = !readsAgree ? "the OCR and vision reads disagree — needs review" : g2 ? `${v.matchedPO} matches the amount` : !v.checks.notDuplicate ? "this invoice was already settled" : "no vendor/PO match in the ERP";
  return [
    { id: "G0", name: "Hidden-instruction check", state: gate0Flagged ? "blocked" : "cleared", detail: gate0Flagged ? "a hidden instruction was found in the document" : "no hidden instructions" },
    { id: "G1", name: "The reader can't pay", state: gate0Flagged ? "pending" : "cleared", detail: "the AI only extracts fields" },
    { id: "G2", name: "Vendor + purchase order", state: gate0Flagged ? "pending" : g2 ? "cleared" : "blocked", detail: g2Detail },
    { id: "G3", name: "Payment goes to the verified wallet", state: gate0Flagged || !g2 ? "pending" : v.checks.walletMatch ? "cleared" : "blocked", detail: v.checks.walletMatch ? "matches the wallet on file" : "the document's wallet doesn't match the ERP" },
    { id: "G4", name: "You approve", state: "pending", detail: "awaiting your authorization" },
    { id: "G5", name: "On-chain payment", state: "pending", detail: "pinned network + token, exact amount" },
  ];
}

async function handleVerify(req: Req, res: Res): Promise<void> {
  if (busy) { json(res, 429, { error: "a verification is already in progress" }); return; }
  busy = true;
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  const send = (e: unknown): void => { res.write(JSON.stringify(e) + "\n"); };
  try {
    const body = await readBody(req);
    const ctype = req.headers["content-type"] ?? "";
    let imagePath: string;
    let imageBytes: Buffer;
    let sourceLabel: string;
    if (ctype.includes("application/json")) {
      const { sample } = JSON.parse(body.toString() || "{}") as { sample?: string };
      imagePath = resolve(SAMPLES, `${sample}.png`);
      imageBytes = await readFile(imagePath);
      sourceLabel = SAMPLE_LIST.find((s) => s.id === sample)?.label ?? sample ?? "sample";
    } else {
      await mkdir(resolve(REPO, "data/uploads"), { recursive: true });
      imageBytes = body;
      imagePath = resolve(REPO, `data/uploads/${randomUUID()}.png`);
      await writeFile(imagePath, imageBytes);
      sourceLabel = "uploaded invoice";
    }
    // Deterministic invoice ref = hash of the document BYTES, so the SAME file always
    // produces the SAME ref and a re-upload is caught by the duplicate/replay guard. Hashing
    // the bytes only (not the vendor/amount) is deliberate: the vision read is
    // nondeterministic, so folding it in would break the "same document → same ref" property
    // the guard depends on. Canonical multi-field identity is the full fix, out of scope here.
    const invoiceRef = `INV-${createHash("sha256").update(imageBytes).digest("hex").slice(0, 12).toUpperCase()}`;

    send({ t: "step", id: "intake", state: "cleared", detail: sourceLabel });
    send({ t: "step", id: "G0", state: "active", detail: "checking for hidden instructions" });
    send({ t: "step", id: "extract", state: "active", detail: "reading the invoice on-device" });

    const readT0 = performance.now();
    const ex = await extractInvoice(imagePath);
    const readMs = Math.round(performance.now() - readT0);
    send({ t: "extraction", data: { ...ex.extraction, _ocrBlocks: ex.ocrBlockCount, _model: ex.visionModel, _readMs: readMs } });
    send({ t: "step", id: "extract", state: "cleared", detail: `read with ${ex.visionModel}` });

    const gate0Flagged = ex.gate0.flagged;
    if (gate0Flagged) {
      send({ t: "step", id: "G0", state: "blocked", detail: ex.gate0.findings.map((f) => f.detail).join("; ") });
      logInference({ node: "edge", op: "gate0-reject", model: "gate0", delegated: false, event: `ui ${ex.gate0.findings.map((f) => `${f.grade}:${f.encoding}`).join(",")}` });
    } else {
      send({ t: "step", id: "G0", state: "cleared", detail: "no hidden instructions" });
      send({ t: "step", id: "G2", state: "active", detail: "checking the ERP" });
    }

    // Hugo #1 — tool-calling visible in the product. On a document that cleared Gate 0,
    // the LLM gathers facts by calling the ERP tools (QWEN3-1.7B, native tool-calling).
    // It PROPOSES; it never decides — the deterministic verdict below does. Illustrative:
    // a failure here never blocks the verdict, and zero tool calls is a legitimate outcome.
    if (!gate0Flagged) {
      let toolCount = 0;
      try {
        await runVerificationAgent(db, ex.extraction, ragEmbed, {
          maxTurns: 5,
          onMeta: (m) => send({ t: "tools-begin", delegated: m.delegated, provider: m.providerPublicKey }),
          onCall: (rec) => { toolCount++; send({ t: "tool", name: rec.name, arguments: rec.arguments, result: rec.result }); },
        });
        send({ t: "tools-end", count: toolCount });
      } catch (err) {
        // Delegated + provider gone → the load threw (fallbackToLocal:false). We do NOT
        // run tool-calling locally (threat #82); we skip it. The verdict is deterministic
        // and local, so the verification still completes correctly without the trace.
        const offline = DELEGATE_REASONING;
        logInference({ node: offline ? "edge" : "orchestrator", op: "tool-calling", model: "QWEN3_1_7B_INST_Q4", delegated: false, event: `error ${String((err as Error)?.message ?? err).slice(0, 80)}` });
        if (toolCount === 0) send({ t: "tools-begin", delegated: DELEGATE_REASONING, provider: null });
        send({ t: "tools-end", count: toolCount, error: true, offline });
      }
    }

    const verdict = await computeVerdict(db, ex.extraction, invoiceRef, ragEmbed, gate0Flagged, ex.review);
    logInference({ node: "edge", op: "verdict", model: "deterministic", delegated: false, event: `${verdict.decision} ${invoiceRef}` });
    const gates = gatesFromVerdict(verdict, gate0Flagged);

    // Conversational reasoning stream (Workspace): real per-check results, derived
    // from the deterministic verdict — no fabricated timing. Stop at the first failing
    // check, mirroring the gate ladder ("a payment is impossible unless every gate clears").
    const c = verdict.checks;
    const r = (step: string, ok: boolean, detail: string): { step: string; ok: boolean; detail: string } => ({ step, ok, detail });
    const reasonStream = gate0Flagged
      ? [r("gate0", false, `a hidden instruction was found in the document and ignored — ${ex.gate0.findings[0]?.detail ?? ""}`)]
      : [
          r("gate0", true, "no hidden instructions in the document"),
          r("crosscheck", c.crossCheckOk, c.crossCheckOk ? "the OCR read and the vision read agree on the amount and vendor" : "the OCR read and the vision read disagree — needs review, not settling"),
          r("vendor", c.vendorExists && c.vendorActive, c.vendorExists ? (c.vendorActive ? `${ex.extraction.vendorName} is on file and active` : `${ex.extraction.vendorName} is on file but not active`) : `“${ex.extraction.vendorName}” is not in your books`),
          r("po", c.poMatched, c.poMatched ? `${verdict.matchedPO} matches ${ex.extraction.invoiceAmount} ${ex.extraction.currency}` : `no open purchase order matches ${ex.extraction.invoiceAmount} ${ex.extraction.currency}`),
          r("wallet", c.walletMatch, c.walletMatch ? "the payout wallet matches the verified wallet on file" : "the payout wallet does not match the wallet on file"),
          r("duplicate", c.notDuplicate, c.notDuplicate ? "not seen before — no duplicate" : "this invoice was already settled"),
        ];
    // The retrieval trace rides alongside the PO line — that is the check it informs.
    // It is emitted whether the PO matched or not: on a miss, "nearest by description"
    // is the most useful thing on the screen.
    for (const rs of reasonStream) {
      send({ t: "reason", ...rs });
      if (rs.step === "po" && verdict.rag) send({ t: "rag", data: verdict.rag });
      if (!rs.ok) break;
    }

    send({ t: "verdict", data: verdict });
    if (!gate0Flagged) for (const g of gates) if (g.id === "G2" || g.id === "G3") send({ t: "step", id: g.id, state: g.state, detail: g.detail });

    const job: Job = { explainContext: buildExplainContext(invoiceRef, ex, verdict), status: verdict.decision };
    if (verdict.decision === "PASS" && verdict.knownWallet) {
      const vendor = lookupVendor(db, ex.extraction.vendorName);
      const poRow = db.prepare("SELECT id FROM purchase_orders WHERE po_number = ?").get(verdict.matchedPO) as { id: number };
      job.intent = buildPaymentIntent({ knownWallet: verdict.knownWallet, amountMinor: toMinorUnits(ex.extraction.invoiceAmount, CHAIN.usdtDecimals)!, token: CHAIN.usdt, chainId: CHAIN.id, invoiceRef, memo: `Custos · ${verdict.matchedPO}` });
      job.vendorId = vendor.vendorId!;
      job.poId = poRow.id;
    }
    const jobId = randomUUID();
    jobs.set(jobId, job);

    if (verdict.decision === "PASS" && job.intent) {
      send({ t: "intent", data: job.intent });
      send({ t: "final", data: { status: "VERIFIED", jobId, gates, intent: job.intent, invoiceRef } });
    } else {
      const blockedGate = gate0Flagged ? "G0" : gates.find((g) => g.state === "blocked")?.id ?? "G2";
      // A replay is its own failure mode, not a vendor/PO miss — surface it distinctly so a
      // re-upload reads as "already settled", with the prior transaction, not a generic block.
      const isDuplicate = !gate0Flagged && !verdict.checks.notDuplicate && verdict.checks.vendorExists && verdict.checks.poMatched;
      const prior = isDuplicate ? (db.prepare("SELECT tx_hash, ts FROM settlements WHERE invoice_ref = ?").get(invoiceRef) as { tx_hash: string | null; ts: string } | undefined) : undefined;
      const reason = gate0Flagged
        ? `A hidden instruction was found in the document and ignored — ${ex.gate0.findings[0]?.detail ?? ""}`
        : isDuplicate
          ? `This invoice was already settled (${invoiceRef}). Custos will not pay the same document twice.`
          : verdict.reasons.find((r) => r.startsWith("REJECT"))?.replace(/^REJECT:\s*/, "") ?? "verification failed";
      send({ t: "final", data: { status: "BLOCKED", jobId, blockedGate, reason, gates, duplicate: isDuplicate, invoiceRef, priorTx: prior?.tx_hash ?? null } });
    }
  } catch (err) {
    send({ t: "final", data: { status: "ERROR", reason: String((err as Error)?.message ?? err) } });
  } finally {
    busy = false;
    res.end();
  }
}

async function handleAssist(req: Req, res: Res): Promise<void> {
  const { question } = JSON.parse((await readBody(req)).toString() || "{}") as { question?: string };
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  const send = (e: unknown): void => { res.write(JSON.stringify(e) + "\n"); };
  if (busy) { send({ t: "token", text: "One moment — finishing the current task." }); send({ t: "done" }); res.end(); return; }
  busy = true;
  try {
    const r = await assistChat(question ?? "", buildErpSnapshot(db), (tok) => send({ t: "token", text: tok }));
    send({ t: "done", full: r.text, prof: profOf(r) });
  } catch (e) {
    // In delegate mode a failure here means the provider is unreachable. Per threat #82 we
    // never fall back to local inference — we hard-stop and say so.
    const reason = DELEGATE_REASONING ? "Orchestrator (Vault) offline — reasoning cannot proceed. No local fallback (threat #82)." : String((e as Error)?.message ?? e);
    send({ t: "error", reason });
  } finally {
    busy = false;
    res.end();
  }
}

async function handleExplain(req: Req, res: Res): Promise<void> {
  const { jobId, question } = JSON.parse((await readBody(req)).toString() || "{}") as { jobId?: string; question?: string };
  const job = jobId ? jobs.get(jobId) : undefined;
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  const send = (e: unknown): void => { res.write(JSON.stringify(e) + "\n"); };
  if (!job) { send({ t: "token", text: "Load an invoice first — I can only explain a verification that has already run." }); send({ t: "done" }); res.end(); return; }
  if (busy) { send({ t: "token", text: "One moment — finishing the current verification." }); send({ t: "done" }); res.end(); return; }
  busy = true;
  try {
    const r = await explainInvoice(question ?? "", job.explainContext, (tok) => send({ t: "token", text: tok }));
    send({ t: "done", full: r.text, prof: profOf(r) });
  } catch (e) {
    // In delegate mode a failure here means the provider is unreachable. Per threat #82 we
    // never fall back to local inference — we hard-stop and say so.
    const reason = DELEGATE_REASONING ? "Orchestrator (Vault) offline — reasoning cannot proceed. No local fallback (threat #82)." : String((e as Error)?.message ?? e);
    send({ t: "error", reason });
  } finally {
    busy = false;
    res.end();
  }
}

async function handleApprove(req: Req, res: Res): Promise<void> {
  if (!process.env.CUSTOS_WALLET_SEED) { json(res, 200, { status: "blocked", reason: "Demo mode — set CUSTOS_WALLET_SEED in .env to a funded Sepolia wallet to settle for real." }); return; }
  const { jobId } = JSON.parse((await readBody(req)).toString() || "{}") as { jobId?: string };
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job || !jobId) { json(res, 404, { status: "blocked", error: "unknown or expired job", reason: "This invoice is no longer awaiting approval — it was already settled, or the console restarted. Re-run the verification." }); return; }
  if (!job.intent || job.vendorId == null || job.poId == null) { json(res, 200, { status: "blocked", reason: "This invoice was not verified for payment." }); return; }
  // Gate 4 is a single-shot authorization, but the hold gesture is client-side and the
  // settle window is ~24s. Without this guard a double-click, a second tab, or a replayed
  // request broadcasts a second REAL transfer. One wallet, one nonce, one send at a time.
  if (settlingJobId === jobId) { json(res, 409, { status: "blocked", reason: "This invoice is already being settled — one moment." }); return; }
  if (settlingJobId !== null) { json(res, 409, { status: "blocked", reason: "Another settlement is in progress. Wait for it to finish before authorizing this one." }); return; }
  settlingJobId = jobId;
  try {
    const r = await settleIntent(db, { intent: job.intent, vendorId: job.vendorId, poId: job.poId, approve: true, confirmations: 2 });
    job.status = r.status;
    // Anti-replay: a job whose funds are committed can't be re-submitted. "pending" counts —
    // the transfer is broadcast and recorded, so re-approving it must be impossible too.
    if (r.status === "settled" || r.status === "pending") jobs.delete(jobId);
    json(res, 200, r);
  } finally {
    settlingJobId = null;
  }
}

async function serveStatic(url: string, res: Res): Promise<void> {
  // The conversational dashboard is the product surface; the editorial page is kept at /landing.
  const file = url === "/" || url === "/app" ? "dash.html" : url === "/landing" ? "index.html" : url.slice(1);
  const full = resolve(UI, file);
  if (full !== UI && !full.startsWith(UI + sep)) { res.writeHead(404); res.end("not found"); return; } // contain to UI (no path traversal)
  try {
    const data = await readFile(full);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch { res.writeHead(404); res.end("not found"); }
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (req.method === "GET" && url === "/api/samples") return json(res, 200, SAMPLE_LIST);
    // The air-gapped ERP, read-only, for the Vendors + History screens. Same live snapshot
    // the assistant grounds on — real vendors/POs and the real on-chain settlement record.
    if (req.method === "GET" && url === "/api/erp") return json(res, 200, { ...buildErpSnapshot(db), chain: "Ethereum Sepolia", explorer: "https://sepolia.etherscan.io/tx/" });
    if (req.method === "GET" && url === "/api/wallet") {
      if (!process.env.CUSTOS_WALLET_SEED) return json(res, 200, { configured: false });
      const w = await openEdgeWallet();
      const [eth, usdt] = [await w.account.getBalance(), await w.account.getTokenBalance(CHAIN.usdt)];
      w.dispose();
      return json(res, 200, { configured: true, address: w.address, eth: eth.toString(), usdt: usdt.toString(), chain: "Ethereum Sepolia", token: CHAIN.usdt });
    }
    if (req.method === "POST" && url === "/api/verify") return void (await handleVerify(req, res));
    if (req.method === "POST" && url === "/api/explain") return void (await handleExplain(req, res));
    if (req.method === "POST" && url === "/api/assist") return void (await handleAssist(req, res));
    if (req.method === "POST" && url === "/api/approve") return void (await handleApprove(req, res));
    if (req.method === "GET") return void (await serveStatic(url, res));
    res.writeHead(405); res.end();
  } catch (e) {
    // Full detail to the terminal; a readable sentence to the screen. This text can land
    // on a projector, and it must not overclaim about funds — an approve that threw here
    // may or may not have broadcast, so it says to check rather than "nothing was sent".
    console.error(`[custos] unhandled error on ${req.method} ${url}:`, e);
    json(res, 500, { status: "blocked", error: String((e as Error)?.message ?? e), reason: "Something went wrong inside the console — the detail is in the terminal. If you were settling an invoice, check the explorer before authorizing it again." });
  }
});

server.listen(PORT, HOST, () => {
  const scope = HOST === "127.0.0.1" || HOST === "localhost" ? "loopback only — the approve endpoint holds the wallet" : "⚠ REACHABLE FROM THE NETWORK — /api/approve signs real transfers";
  console.log(`\n  CUSTOS · Edge console  →  http://localhost:${PORT}\n  bound to ${HOST} (${scope})\n  (Ctrl+C to stop)\n`);
});
