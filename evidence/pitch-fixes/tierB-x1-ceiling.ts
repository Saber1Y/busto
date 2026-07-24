// X1 ceiling probe: fire verifies back to back into ONE server process and report how
// many succeed before the context-window overflow. Cycles the 4 samples so the mix
// matches the demo. Stops at the first ERROR (or MAX). The number it prints is the
// restart rule. Run once with the server booted RAG-on and once RAG-off (CUSTOS_RAG=off)
// to attribute the ceiling to the embed/GTE residency vs the vision path.
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const MAX = Number(process.env.MAX ?? 8);
const CYCLE = ["ui-clean", "ui-fraud", "ui-injection", "ui-amount"];
const EXPECT: Record<string, string> = { "ui-clean": "VERIFIED", "ui-fraud": "BLOCKED", "ui-injection": "BLOCKED", "ui-amount": "BLOCKED" };

console.log(`X1 CEILING PROBE — one process, back to back, up to ${MAX} verifies`);
let survived = 0;
for (let i = 0; i < MAX; i++) {
  const id = CYCLE[i % CYCLE.length];
  const t0 = performance.now();
  let status = "?", reason = "";
  try {
    const res = await fetch(`${BASE}/api/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sample: id }) });
    const text = await res.text();
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as { t: string; data?: { status?: string; reason?: string } };
      if (e.t === "final") { status = String(e.data?.status); reason = String(e.data?.reason ?? ""); }
    }
  } catch (err) { status = "FETCH_ERROR"; reason = String(err); }
  const ms = Math.round(performance.now() - t0);
  const overflow = status === "ERROR" && /context window|exceeds/i.test(reason);
  const ok = status === EXPECT[id];
  console.log(`  call ${String(i + 1).padStart(2)} [${id.padEnd(12)}] ${ms.toString().padStart(6)}ms  ${status}${overflow ? "  <-- CONTEXT OVERFLOW" : ok ? "" : "  (unexpected)"}`);
  if (overflow) break;
  if (ok) survived++;
  else { console.log(`     reason: ${reason.slice(0, 120)}`); break; }
}
console.log(`\nSURVIVED ${survived} consecutive verifies before overflow/failure. RESTART RULE: restart serve every ${survived} verif${survived === 1 ? "y" : "ies"}.`);
process.exit(0);
