import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, resolve, extname } from "node:path";
import { loadEnvSafe, logInference, buildPaymentIntent, toMinorUnits, type PaymentIntent } from "../../shared/src/index.ts";
import { openErp, ensureSchema, seedErp, lookupVendor } from "../../orchestrator/src/erp.ts";
import { extractInvoice } from "../../orchestrator/src/extract.ts";
import { computeVerdict, type Verdict } from "../../orchestrator/src/verdict.ts";
import { openEdgeWallet, CHAIN } from "./wallet.ts";
import { settleIntent } from "./settle.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const UI = resolve(HERE, "../ui");
const SAMPLES = resolve(REPO, "data/sample");
const PORT = Number(process.env.PORT ?? 4173);

loadEnvSafe();
const db = openErp(resolve(REPO, "data/erp.db"));
ensureSchema(db);
await seedErp(db); // exact-match verdict needs no models

interface Job { intent: PaymentIntent; vendorId: number; poId: number; verdict: Verdict; status: string }
const jobs = new Map<string, Job>();
let busy = false;

const SAMPLE_LIST = [
  { id: "ui-clean", label: "Clean invoice", note: "Acme · 1 USD₮ · valid wallet", expect: "settle" },
  { id: "ui-injection", label: "Prompt injection", note: "hidden “ignore instructions” payload", expect: "Gate 0" },
  { id: "ui-amount", label: "Amount mismatch", note: "4,242 USD₮ — matches no PO", expect: "Gate 2" },
];

const MIME: Record<string, string> = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const json = (res: import("node:http").ServerResponse, code: number, body: unknown): void => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const readBody = (req: import("node:http").IncomingMessage): Promise<Buffer> =>
  new Promise((ok) => { const c: Buffer[] = []; req.on("data", (d) => c.push(d)); req.on("end", () => ok(Buffer.concat(c))); });

function gatesFromVerdict(v: Verdict, gate0Flagged: boolean): Array<{ id: string; name: string; state: "cleared" | "blocked" | "pending"; detail: string }> {
  const g2 = v.checks.vendorExists && v.checks.vendorActive && v.checks.amountParsed && v.checks.poMatched;
  return [
    { id: "G0", name: "Input decode", state: gate0Flagged ? "blocked" : "cleared", detail: gate0Flagged ? "obfuscated imperative detected" : "no injection" },
    { id: "G1", name: "Role bounding", state: gate0Flagged ? "pending" : "cleared", detail: "model extracts only" },
    { id: "G2", name: "Deterministic truth", state: gate0Flagged ? "pending" : g2 ? "cleared" : "blocked", detail: g2 ? `vendor + PO ${v.matchedPO}` : "no vendor/PO match" },
    { id: "G3", name: "Recipient", state: gate0Flagged || !g2 ? "pending" : v.checks.walletMatch ? "cleared" : "blocked", detail: v.checks.walletMatch ? "matches DB wallet" : "wallet not corroborated" },
    { id: "G4", name: "Human approval", state: "pending", detail: "awaiting authorization" },
    { id: "G5", name: "On-chain settle", state: "pending", detail: "pinned chain + token" },
  ];
}

async function handleVerify(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  if (busy) { json(res, 429, { error: "a verification is already in progress" }); return; }
  busy = true;
  res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-cache" });
  const send = (e: unknown): void => { res.write(JSON.stringify(e) + "\n"); };
  try {
    const body = await readBody(req);
    const ctype = req.headers["content-type"] ?? "";
    let imagePath: string;
    let sourceLabel: string;
    if (ctype.includes("application/json")) {
      const { sample } = JSON.parse(body.toString() || "{}") as { sample?: string };
      imagePath = resolve(SAMPLES, `${sample}.png`);
      sourceLabel = SAMPLE_LIST.find((s) => s.id === sample)?.label ?? sample ?? "sample";
    } else {
      await mkdir(resolve(REPO, "data/uploads"), { recursive: true });
      imagePath = resolve(REPO, `data/uploads/${randomUUID()}.png`);
      await writeFile(imagePath, body);
      sourceLabel = "uploaded invoice";
    }
    const invoiceRef = `INV-UI-${Date.now().toString(36).toUpperCase()}`;

    send({ t: "step", id: "intake", state: "cleared", detail: sourceLabel });
    send({ t: "step", id: "G0", state: "active", detail: "normalizing + decoding" });
    send({ t: "step", id: "extract", state: "active", detail: "reading invoice (QVAC, on-device)" });

    const ex = await extractInvoice(imagePath);
    send({ t: "extraction", data: { ...ex.extraction, _ocrBlocks: ex.ocrBlockCount, _model: ex.visionModel } });
    send({ t: "step", id: "extract", state: "cleared", detail: `${ex.visionModel} · ${ex.ocrBlockCount} OCR blocks` });

    if (ex.gate0.flagged) {
      send({ t: "step", id: "G0", state: "blocked", detail: ex.gate0.findings.map((f) => `${f.grade}:${f.encoding}`).join(", ") });
      logInference({ node: "edge", op: "gate0-reject", model: "gate0", delegated: false, event: `ui ${ex.gate0.findings.map((f) => `${f.grade}:${f.encoding}`).join(",")}` });
      send({ t: "final", data: { status: "BLOCKED", blockedGate: "G0", reason: `Gate 0 — ${ex.gate0.findings.map((f) => f.detail).join("; ")}`, gates: gatesFromVerdict({ checks: { vendorExists: false, vendorActive: false, amountParsed: false, poMatched: false, walletMatch: false, notDuplicate: true, gate0Clean: false } } as Verdict, true) } });
      return;
    }
    send({ t: "step", id: "G0", state: "cleared", detail: "no injection" });

    send({ t: "step", id: "G2", state: "active", detail: "verifying against ERP" });
    const verdict = await computeVerdict(db, ex.extraction, invoiceRef, undefined, ex.gate0.flagged);
    logInference({ node: "edge", op: "verdict", model: "deterministic", delegated: false, event: `${verdict.decision} ${invoiceRef}` });
    const gates = gatesFromVerdict(verdict, false);
    send({ t: "verdict", data: verdict });
    for (const g of gates) if (g.id === "G2" || g.id === "G3") send({ t: "step", id: g.id, state: g.state, detail: g.detail });

    if (verdict.decision === "PASS" && verdict.knownWallet) {
      const vendor = lookupVendor(db, ex.extraction.vendorName);
      const poRow = db.prepare("SELECT id FROM purchase_orders WHERE po_number = ?").get(verdict.matchedPO) as { id: number };
      const intent = buildPaymentIntent({
        knownWallet: verdict.knownWallet,
        amountMinor: toMinorUnits(ex.extraction.invoiceAmount, CHAIN.usdtDecimals)!,
        token: CHAIN.usdt, chainId: CHAIN.id, invoiceRef, memo: `Custos · ${verdict.matchedPO}`,
      });
      const jobId = randomUUID();
      jobs.set(jobId, { intent, vendorId: vendor.vendorId!, poId: poRow.id, verdict, status: "awaiting-approval" });
      send({ t: "intent", data: intent });
      send({ t: "final", data: { status: "VERIFIED", jobId, gates, intent } });
    } else {
      const blocked = gates.find((g) => g.state === "blocked");
      send({ t: "final", data: { status: "BLOCKED", blockedGate: blocked?.id ?? "G2", reason: verdict.reasons.find((r) => r.startsWith("REJECT")) ?? "verification failed", gates } });
    }
  } catch (err) {
    send({ t: "final", data: { status: "ERROR", reason: String((err as Error)?.message ?? err) } });
  } finally {
    busy = false;
    res.end();
  }
}

async function handleApprove(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
  const { jobId } = JSON.parse((await readBody(req)).toString() || "{}") as { jobId?: string };
  const job = jobId ? jobs.get(jobId) : undefined;
  if (!job) { json(res, 404, { error: "unknown or expired job" }); return; }
  const r = await settleIntent(db, { intent: job.intent, vendorId: job.vendorId, poId: job.poId, approve: true, confirmations: 2 });
  job.status = r.status;
  json(res, 200, r);
}

async function serveStatic(url: string, res: import("node:http").ServerResponse): Promise<void> {
  const file = url === "/" ? "index.html" : url.slice(1);
  try {
    const data = await readFile(resolve(UI, file));
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404); res.end("not found");
  }
}

const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  try {
    if (req.method === "GET" && url === "/api/samples") return json(res, 200, SAMPLE_LIST);
    if (req.method === "GET" && url === "/api/wallet") {
      const w = await openEdgeWallet();
      const [eth, usdt] = [await w.account.getBalance(), await w.account.getTokenBalance(CHAIN.usdt)];
      w.dispose();
      return json(res, 200, { address: w.address, eth: eth.toString(), usdt: usdt.toString(), chain: "Ethereum Sepolia", token: CHAIN.usdt });
    }
    if (req.method === "POST" && url === "/api/verify") return void (await handleVerify(req, res));
    if (req.method === "POST" && url === "/api/approve") return void (await handleApprove(req, res));
    if (req.method === "GET") return void (await serveStatic(url, res));
    res.writeHead(405); res.end();
  } catch (e) {
    json(res, 500, { error: String((e as Error)?.message ?? e) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  CUSTOS · Edge console  →  http://localhost:${PORT}\n  (Ctrl+C to stop)\n`);
});
