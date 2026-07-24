// D1 probe: fire N assist turns back to back at the resident chat model. Reports each
// round-trip time and whether a loadModel row was written between turns (a cache HIT writes
// none). Also surfaces any context-window overflow on the CHAT path (the X1 mechanism was
// characterised on vision; this checks whether residency re-introduces it on chat).
import { readFileSync } from "node:fs";
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const LOG = process.env.LOG ?? "evidence/inference-log.jsonl";
const N = Number(process.env.N ?? 8);
const Q = ["Is Acme a known vendor?", "What can you do?", "How do the gates work?", "What is a purchase order?"];

const loadRows = (): number => readFileSync(LOG, "utf8").trimEnd().split("\n").filter((l) => {
  try { const r = JSON.parse(l); return r.op === "loadModel" && r.model === "QWEN3_1_7B_INST_Q4"; } catch { return false; }
}).length;

let overflow = 0;
for (let i = 0; i < N; i++) {
  const before = loadRows();
  const t0 = performance.now();
  let full = "", err = "";
  try {
    const res = await fetch(`${BASE}/api/assist`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ question: Q[i % Q.length] }) });
    for (const line of (await res.text()).split("\n")) {
      if (!line.trim()) continue;
      const e = JSON.parse(line) as { t: string; full?: string; reason?: string };
      if (e.t === "done" && e.full) full = e.full;
      if (e.t === "error") err = e.reason ?? "error";
    }
  } catch (e) { err = String(e); }
  const ms = Math.round(performance.now() - t0);
  const loadedNow = loadRows() - before; // 1 = loaded this turn (cold), 0 = cache hit
  const isOverflow = /context window|exceeds/i.test(err);
  if (isOverflow) overflow++;
  console.log(`  turn ${String(i + 1).padStart(2)}  ${ms.toString().padStart(6)}ms  qwenLoadRows+=${loadedNow}  ${isOverflow ? "*** CHAT OVERFLOW ***" : err ? "ERR: " + err.slice(0, 40) : "\"" + full.slice(0, 44) + "\""}`);
}
console.log(`\nchat overflows in ${N} turns: ${overflow}`);
process.exit(0);
