// Tier A regression: UI samples end to end through the live verify path, printing the
// advisory retrieval trace that now rides on the stream. Verdict only — no approve, so
// no funds move. Pass sample ids as argv to run a subset (the X1 ceiling means the
// full four are run across two processes).
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
  let rag: { query: string; candidates: Array<{ poNumber: string; distance: number }> } | undefined;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { t: string; data?: Record<string, unknown> };
    if (e.t === "final") final = e.data;
    if (e.t === "rag") rag = e.data as unknown as typeof rag;
  }
  const ms = Math.round(performance.now() - t0);
  const status = String(final?.status);
  const ok = status === EXPECT[id];
  if (!ok) failures++;
  console.log(`\n[${id}] ${ok ? "PASS" : "*** FAIL ***"}  (${ms}ms)  expected ${EXPECT[id]}, got ${status}`);
  console.log(`   blockedGate : ${final?.blockedGate ?? "-"}`);
  console.log(`   reason      : ${final?.reason ?? "-"}`);
  if (rag) {
    console.log(`   RAG query   : ${rag.query}`);
    console.log(`   RAG returned: ${rag.candidates.map((c) => `${c.poNumber} d=${c.distance.toFixed(4)}`).join(", ") || "(none)"}`);
  } else {
    console.log("   RAG         : no retrieval event on the stream");
  }
}
console.log(`\n${failures === 0 ? `ALL ${ids.length} SAMPLE(S) PASS` : `${failures} SAMPLE(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
