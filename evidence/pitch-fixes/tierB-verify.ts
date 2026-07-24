// Tier B regression: UI samples end to end, capturing the tool-calling trace, the
// deterministic-verdict event, and per-verify wall time. Verdict only — no approve.
// Pass sample ids as argv; default all four (run across processes for the X1 ceiling).
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const EXPECT: Record<string, string> = {
  "ui-clean": "VERIFIED", "ui-fraud": "BLOCKED", "ui-injection": "BLOCKED", "ui-amount": "BLOCKED",
};
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(EXPECT);

let failures = 0;
for (const id of ids) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/api/verify`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sample: id }),
  });
  const text = await res.text();
  let final: Record<string, unknown> | undefined;
  let verdict: { decision?: string } | undefined;
  const tools: string[] = [];
  let toolsBegan = false, toolsEnd: { count?: number; error?: boolean } | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { t: string; data?: Record<string, unknown>; name?: string; count?: number; error?: boolean };
    if (e.t === "final") final = e.data;
    if (e.t === "verdict") verdict = e.data as { decision?: string };
    if (e.t === "tools-begin") toolsBegan = true;
    if (e.t === "tool") tools.push(String(e.name));
    if (e.t === "tools-end") toolsEnd = { count: e.count, error: e.error };
  }
  const ms = Math.round(performance.now() - t0);
  const status = String(final?.status);
  const ok = status === EXPECT[id];
  const under90 = ms < 90_000;
  if (!ok || !under90) failures++;
  console.log(`\n[${id}] ${ok ? "PASS" : "*** FAIL ***"}  (${ms}ms${under90 ? "" : " *** OVER 90s ***"})  expected ${EXPECT[id]}, got ${status}`);
  console.log(`   verdict event : ${verdict?.decision ?? "(none)"}`);
  console.log(`   tools         : began=${toolsBegan} calls=[${tools.join(", ") || "none"}] end=${JSON.stringify(toolsEnd) ?? "-"}`);
  console.log(`   blockedGate   : ${final?.blockedGate ?? "-"}   reason: ${String(final?.reason ?? "-").slice(0, 90)}`);
}
console.log(`\n${failures === 0 ? `ALL ${ids.length} SAMPLE(S) PASS (<90s each)` : `${failures} SAMPLE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
