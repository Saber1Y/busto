// FIX 2 gate probe. Modes:
//   verify        — verify ui-clean once; print status + deterministic ref + duplicate flag
//   settle-dup    — verify ui-clean, SETTLE it, then verify the identical file again (expect
//                   the second to BLOCK as a duplicate). All within one server lifetime.
const BASE = process.env.BASE ?? "http://127.0.0.1:4173";
const mode = process.argv[2] ?? "verify";

async function verify(): Promise<{ status: string; ref: string; duplicate: boolean; blockedGate: string; jobId: string; reason: string }> {
  const res = await fetch(`${BASE}/api/verify`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sample: "ui-clean" }) });
  let f: Record<string, unknown> | undefined;
  for (const line of (await res.text()).split("\n")) { if (line.trim()) { const e = JSON.parse(line) as { t: string; data?: Record<string, unknown> }; if (e.t === "final") f = e.data; } }
  return { status: String(f?.status), ref: String(f?.invoiceRef ?? "?"), duplicate: Boolean(f?.duplicate), blockedGate: String(f?.blockedGate ?? "-"), jobId: String(f?.jobId ?? ""), reason: String(f?.reason ?? "") };
}
async function settle(jobId: string): Promise<Record<string, unknown>> {
  return (await (await fetch(`${BASE}/api/approve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId }) })).json()) as Record<string, unknown>;
}

if (mode === "verify") {
  const v = await verify();
  console.log(`VERIFY  status=${v.status} ref=${v.ref} duplicate=${v.duplicate} gate=${v.blockedGate}`);
  if (v.reason) console.log(`        reason: ${v.reason}`);
  process.exit(0);
}

if (mode === "settle-dup") {
  const v1 = await verify();
  console.log(`[1] first verify   : ${v1.status} ref=${v1.ref} (expect VERIFIED)`);
  if (v1.status !== "VERIFIED") { console.log("*** setup failed — clean did not verify (already settled? run demo:reset)"); process.exit(1); }
  const r = await settle(v1.jobId);
  console.log(`[2] settle         : ${String(r.status).toUpperCase()} tx=${r.txHash ?? "-"}`);
  if (r.status !== "settled") { console.log(`*** settle did not complete: ${r.reason}`); process.exit(1); }
  const v2 = await verify();
  console.log(`[3] re-verify same : ${v2.status} duplicate=${v2.duplicate} gate=${v2.blockedGate} ref=${v2.ref}`);
  console.log(`        reason: ${v2.reason}`);
  // Same file → same deterministic ref → blocked as a duplicate. v1.ref is now populated too.
  const ok = v2.status === "BLOCKED" && v2.duplicate === true && v2.ref === v1.ref;
  console.log(`        ref match: first=${v1.ref} second=${v2.ref} → ${v1.ref === v2.ref ? "SAME" : "DIFFERENT"}`);
  console.log(`\n${ok ? "DUP GUARD FIRES — same file → same ref → blocked as duplicate" : "*** DUP GUARD FAILED ***"}`);
  process.exit(ok ? 0 : 1);
}
console.log("unknown mode"); process.exit(1);
