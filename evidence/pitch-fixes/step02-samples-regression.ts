// Regression: every UI sample end to end through the live verify path.
// Verdict only — no approve, so no funds move.
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";

const SAMPLES = [
  { id: "ui-clean", expect: "VERIFIED" },
  { id: "ui-fraud", expect: "BLOCKED" },
  { id: "ui-injection", expect: "BLOCKED" },
  { id: "ui-amount", expect: "BLOCKED" },
];

let failures = 0;
for (const s of SAMPLES) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/verify`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ sample: s.id }),
  });
  const text = await res.text();
  let final: Record<string, unknown> | undefined;
  const steps: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { t: string; id?: string; state?: string; data?: Record<string, unknown> };
    if (e.t === "final") final = e.data;
    if (e.t === "step" && e.state === "blocked") steps.push(String(e.id));
  }
  const ms = Math.round(performance.now() - t0);
  const status = String(final?.status);
  const ok = status === s.expect;
  if (!ok) failures++;
  console.log(`\n[${s.id}] ${ok ? "PASS" : "*** FAIL ***"}  (${ms}ms)`);
  console.log(`   expected ${s.expect}, got ${status}`);
  console.log(`   blockedGate : ${final?.blockedGate ?? "-"}   (blocked steps: ${steps.join(",") || "none"})`);
  console.log(`   reason      : ${final?.reason ?? "-"}`);
}
console.log(`\n${failures === 0 ? "ALL 4 SAMPLES PASS" : `${failures} SAMPLE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
