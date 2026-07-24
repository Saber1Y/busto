// FIX 1 probe: run samples and print the verdict + the OCR-vs-vision cross-check sub-results
// (amountInOcr / vendorInOcr / walletInOcr) + the derived crossCheckOk. Confirms the clean
// sample clears on amount+vendor (not by loosening) and shows exactly what the wallet trips.
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const EXPECT: Record<string, string> = { "ui-clean": "VERIFIED", "ui-fraud": "BLOCKED", "ui-injection": "BLOCKED", "ui-amount": "BLOCKED" };
const ids = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(EXPECT);

let fails = 0;
for (const id of ids) {
  const res = await fetch(`${BASE}/api/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sample: id }) });
  let final: Record<string, unknown> | undefined;
  let verdict: { checks?: Record<string, boolean>; crossCheck?: Record<string, boolean> | null } | undefined;
  for (const line of (await res.text()).split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line) as { t: string; data?: Record<string, unknown> };
    if (e.t === "final") final = e.data;
    if (e.t === "verdict") verdict = e.data as typeof verdict;
  }
  const status = String(final?.status);
  const ok = status === EXPECT[id];
  if (!ok) fails++;
  const cc = verdict?.crossCheck;
  console.log(`\n[${id}] ${ok ? "PASS" : "*** FAIL ***"}  ${status}  gate=${final?.blockedGate ?? "-"}`);
  console.log(`   crossCheckOk : ${verdict?.checks?.crossCheckOk}`);
  console.log(`   sub-checks   : ${cc ? `amountInOcr=${cc.amountInOcr} vendorInOcr=${cc.vendorInOcr} walletInOcr=${cc.walletInOcr}` : "(none)"}`);
}
console.log(`\n${fails === 0 ? `ALL ${ids.length} CORRECT` : fails + " WRONG"}`);
process.exit(fails === 0 ? 0 : 1);
