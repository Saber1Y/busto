// E1+E2 probe: verify ui-clean, then ask the explainer the two questions that drifted —
// "what happens if I approve?" (must state the EXACT 1.00 amount, never 0.01) and "is this
// vendor known?" (must credit the ERP, never the invoice/document). Prints each answer and a
// pass/fail heuristic.
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";

async function ndjson(path: string, body: unknown): Promise<Record<string, unknown>[]> {
  const res = await fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return (await res.text()).split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const vev = await ndjson("/api/verify", { sample: "ui-clean" });
const fin = vev.find((e) => e.t === "final")?.data as { status?: string; jobId?: string } | undefined;
console.log(`verify: ${fin?.status}  jobId=${fin?.jobId?.slice(0, 8)}…`);
if (fin?.status !== "VERIFIED" || !fin.jobId) { console.log("*** could not set up (verify not VERIFIED) — machine may be throttled; retry"); process.exit(1); }

async function ask(q: string): Promise<string> {
  const ev = await ndjson("/api/explain", { jobId: fin!.jobId, question: q });
  const done = ev.find((e) => e.t === "done") as { full?: string } | undefined;
  return done?.full ?? "(no answer)";
}

let fails = 0;
const a1 = await ask("What happens if I approve?");
const badAmount = /\b0\.01\b|\b0\.10\b|\b10\.0|\b100\b/.test(a1); // common drift values
const goodAmount = /\b1(\.0{1,2})?\s*USD/i.test(a1) || /\b1\.00\b/.test(a1);
console.log(`\nQ: What happens if I approve?\nA: ${a1}`);
console.log(`   amount check: ${goodAmount && !badAmount ? "PASS (states 1.00, no drift value)" : "*** REVIEW *** goodAmount=" + goodAmount + " badAmount=" + badAmount}`);
if (badAmount || !goodAmount) fails++;

const a2 = await ask("Is this vendor known?");
const creditsInvoice = /based on the (invoice|document)|from the (invoice|document)|the invoice (shows|says|confirms)/i.test(a2);
console.log(`\nQ: Is this vendor known?\nA: ${a2}`);
console.log(`   source check: ${!creditsInvoice ? "PASS (does not credit the invoice/document)" : "*** REVIEW *** credits the invoice as a source"}`);
if (creditsInvoice) fails++;

console.log(`\n${fails === 0 ? "EXPLAIN GROUNDING OK" : fails + " ANSWER(S) NEED REVIEW"}`);
process.exit(0);
