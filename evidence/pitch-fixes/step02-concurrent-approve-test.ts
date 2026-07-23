// Step 2(b)+(c) proof — against a LIVE server with the funded wallet.
//  1. verify the clean sample → jobId
//  2. fire TWO approves concurrently
//  3. exactly one may broadcast; the other must be refused WITHOUT broadcasting
//  4. the winner must not report SETTLED below the required confirmations
// This moves 1 REAL test USD₮ on Sepolia.
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";

const verify = async (): Promise<Record<string, unknown>> => {
  const res = await fetch(`${BASE}/api/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sample: "ui-clean" }),
  });
  const text = await res.text();
  let final: Record<string, unknown> | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { t: string; data?: Record<string, unknown> };
    if (e.t === "final") final = e.data;
  }
  if (!final) throw new Error("no final event");
  return final;
};

const approve = async (jobId: string, tag: string): Promise<void> => {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/approve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId }),
  });
  const body = (await res.json()) as Record<string, unknown>;
  const ms = Math.round(performance.now() - t0);
  console.log(`\n  [${tag}] HTTP ${res.status} after ${ms}ms`);
  console.log(`     status        : ${String(body.status)}`);
  console.log(`     reason        : ${String(body.reason)}`);
  console.log(`     txHash        : ${body.txHash ?? "(none — nothing broadcast)"}`);
  console.log(`     confirmations : ${body.confirmations ?? "-"}`);
};

console.log("[1] verifying the clean sample …");
const final = await verify();
console.log(`    status ${String(final.status)}  jobId ${String(final.jobId)}`);
if (final.status !== "VERIFIED") throw new Error(`expected VERIFIED, got ${String(final.status)}`);
const jobId = String(final.jobId);

console.log("\n[2] firing TWO approves concurrently for the same jobId …");
await Promise.all([approve(jobId, "approve #1"), approve(jobId, "approve #2")]);

console.log("\n[3] a third approve AFTER settlement (job should be gone) …");
await approve(jobId, "approve #3");
process.exit(0);
