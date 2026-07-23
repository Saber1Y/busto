// Final rehearsal against the live server: the exact demo path, end to end.
//   clean invoice -> gates -> approve -> REAL settle -> Etherscan
//   fraud invoice -> blocked at G3, nothing sent
// Two verifies + one settle in one process, which is inside the X1 context ceiling.
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";

const verify = async (sample: string): Promise<Record<string, unknown>> => {
  const res = await fetch(`${BASE}/api/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sample }),
  });
  const text = await res.text();
  let final: Record<string, unknown> | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { t: string; data?: Record<string, unknown> };
    if (e.t === "final") final = e.data;
  }
  if (!final) throw new Error(`${sample}: no final event`);
  return final;
};

console.log("REHEARSAL — the demo path, exactly as it will be driven\n");

console.log("[1] clean invoice");
const t1 = performance.now();
const clean = await verify("ui-clean");
console.log(`    ${Math.round(performance.now() - t1)}ms → ${String(clean.status)}`);
if (clean.status !== "VERIFIED") throw new Error("clean invoice did not verify");

console.log("\n[2] hold to authorize → REAL settlement");
const t2 = performance.now();
const r = (await (await fetch(`${BASE}/api/approve`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ jobId: clean.jobId }),
})).json()) as Record<string, unknown>;
console.log(`    ${Math.round(performance.now() - t2)}ms → ${String(r.status).toUpperCase()}`);
console.log(`    reason        : ${String(r.reason)}`);
console.log(`    txHash        : ${r.txHash ?? "(none)"}`);
console.log(`    confirmations : ${r.confirmations ?? "-"}`);
console.log(`    explorer      : ${r.explorerUrl ?? "(none)"}`);

console.log("\n[3] fraud invoice — must block at G3, nothing sent");
const t3 = performance.now();
const fraud = await verify("ui-fraud");
console.log(`    ${Math.round(performance.now() - t3)}ms → ${String(fraud.status)} at ${String(fraud.blockedGate)}`);
console.log(`    reason : ${String(fraud.reason)}`);

const ok = clean.status === "VERIFIED" && r.status === "settled" && fraud.status === "BLOCKED" && fraud.blockedGate === "G3";
console.log(`\n${ok ? "REHEARSAL PASS" : "*** REHEARSAL FAILED ***"}`);
process.exit(ok ? 0 : 1);
