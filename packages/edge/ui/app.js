"use strict";

const $ = (id) => document.getElementById(id);
const body = document.body;
const GATE_NAMES = {
  G0: "Input decode", G1: "Role bounding", G2: "Deterministic truth",
  G3: "Recipient", G4: "Human approval", G5: "On-chain settle",
};
let currentJob = null;

const short = (a) => (a && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a || "");
const fmtUnits = (v, d) => {
  const s = BigInt(v).toString().padStart(d + 1, "0");
  const i = s.slice(0, s.length - d), f = s.slice(s.length - d).replace(/0+$/, "");
  return i + (f ? "." + f : "");
};

/* ── hero state ─────────────────────────────────────────────────────── */
function setState(name, word, sub) {
  body.dataset.state = name;
  const el = $("stateWord");
  el.innerHTML = word;
  el.style.animation = "none";
  void el.offsetWidth; // reflow to replay the clip reveal
  el.style.animation = "";
  if (sub !== undefined) $("heroSub").textContent = sub;
}
const scrollToEl = (el) => el && el.scrollIntoView({ behavior: "smooth", block: "start" });

/* ── header (wallet) ────────────────────────────────────────────────── */
async function loadHeader() {
  try {
    const w = await (await fetch("/api/wallet")).json();
    $("wallet").textContent = short(w.address);
    $("wallet").href = `https://sepolia.etherscan.io/address/${w.address}`;
    $("balance").textContent = `${fmtUnits(w.usdt, 6)} USD₮`;
  } catch { $("balance").textContent = "wallet offline"; }
}

async function loadSamples() {
  const list = await (await fetch("/api/samples")).json();
  $("samples").innerHTML = list.map((s) => `
    <button class="sample" data-id="${s.id}" type="button">
      <span class="sample-label">${s.label}</span>
      <span class="sample-note">${s.note}</span>
      <span class="sample-expect">expects → ${s.expect}</span>
    </button>`).join("");
  $("samples").querySelectorAll(".sample").forEach((b) =>
    b.addEventListener("click", () => verify({ json: { sample: b.dataset.id } })));
}

/* ── gates ──────────────────────────────────────────────────────────── */
function renderGates() {
  $("gates").innerHTML = Object.keys(GATE_NAMES).map((id) => `
    <li class="gate" id="gate-${id}" data-state="pending">
      <span class="gate-no">${id}</span>
      <span class="gate-body"><span class="gate-name">${GATE_NAMES[id]}</span>
        <span class="gate-detail" id="detail-${id}"></span></span>
      <span class="gate-tag">pending</span>
    </li>`).join("");
}
function setGate(id, state, detail) {
  const g = $(`gate-${id}`); if (!g) return;
  g.dataset.state = state;
  g.querySelector(".gate-tag").textContent =
    state === "cleared" ? "cleared" : state === "blocked" ? "blocked" : state === "active" ? "checking" : "pending";
  if (detail) $(`detail-${id}`).textContent = detail;
}

/* ── readout ────────────────────────────────────────────────────────── */
function renderReadout(x) {
  $("readout").innerHTML = `
    <div class="field"><div class="field-label">Vendor</div><div class="field-value">${x.vendorName || "—"}</div></div>
    <div class="field"><div class="field-label">Invoice total</div><div class="field-value huge">${x.invoiceAmount || "—"} <span style="font-size:.4em">${x.currency || ""}</span></div></div>
    <div class="field"><div class="field-label">Due</div><div class="field-value">${x.dueDate || "—"}</div></div>
    <div class="field"><div class="field-label">Wallet on document</div><div class="field-value mono">${x.providedWallet || "—"}</div></div>
    <div class="field-meta">read on-device · ${x._model || ""} · ${x._ocrBlocks || 0} OCR blocks</div>`;
}

/* ── verify (stream) ────────────────────────────────────────────────── */
async function verify(payload) {
  ["bandBlocked", "bandSettle", "bandReceipt"].forEach((b) => ($(b).hidden = true));
  $("bandPipeline").hidden = false;
  renderGates();
  $("readout").innerHTML = `<p class="readout-empty">Reading invoice on-device…</p>`;
  setState("reading", "READING<br>INVOICE", "Local OCR + multimodal read on this machine. Nothing leaves the building.");
  scrollToEl($("bandPipeline"));

  const init = payload.json
    ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload.json) }
    : { method: "POST", headers: { "content-type": "image/png" }, body: payload.bytes };
  const res = await fetch("/api/verify", init);
  if (res.status === 429) { setState("idle", "BUSY", "A verification is already running."); return; }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) handleEvent(JSON.parse(line));
    }
  }
}

function handleEvent(e) {
  if (e.t === "step") {
    if (e.id === "G0") { setGate("G0", e.state, e.detail); if (e.state === "cleared") { setGate("G1", "cleared", "model extracts only"); setState("verifying", "VERIFYING", "Checking the document against the air-gapped ERP — vendor, PO, recipient."); } }
    else if (e.id === "extract") { if (e.state === "active") $("readout").innerHTML = `<p class="readout-empty">${e.detail}…</p>`; }
    else if (["G2", "G3"].includes(e.id)) setGate(e.id, e.state, e.detail);
  } else if (e.t === "extraction") { renderReadout(e.data); }
  else if (e.t === "verdict") { /* gates already streamed */ }
  else if (e.t === "intent") { currentJob = currentJob || {}; currentJob.intent = e.data; }
  else if (e.t === "final") { finalize(e.data); }
}

function finalize(d) {
  if (d.status === "VERIFIED") {
    currentJob = { jobId: d.jobId, intent: d.intent };
    setGate("G4", "active", "awaiting your authorization");
    setState("verified", "VERIFIED", "Every automated gate cleared. One deliberate human signature remains.");
    renderSummary(d.intent);
    $("bandSettle").hidden = false;
    setTimeout(() => scrollToEl($("bandSettle")), 350);
  } else if (d.status === "BLOCKED") {
    (d.gates || []).forEach((g) => setGate(g.id, g.state, g.detail));
    $("blockGate").textContent = (GATE_NAMES[d.blockedGate] ? `GATE ${d.blockedGate.slice(1)} — ${GATE_NAMES[d.blockedGate]}` : "BLOCKED");
    $("blockReason").textContent = d.reason;
    setState("blocked", "BLOCKED", "A payment is impossible unless every gate clears. No funds moved.");
    $("bandBlocked").hidden = false;
    setTimeout(() => scrollToEl($("bandBlocked")), 350);
  } else {
    setState("idle", "ERROR", d.reason || "Something went wrong.");
  }
}

function renderSummary(intent) {
  $("summary").innerHTML = `
    <div class="row"><dt>Recipient (DB-verified)</dt><dd class="mono">${intent.to}</dd></div>
    <div class="row"><dt>Amount</dt><dd class="amount">${fmtUnits(intent.amount, 6)} USD₮</dd></div>
    <div class="row"><dt>Token</dt><dd class="mono">${short(intent.token)}</dd></div>
    <div class="row"><dt>Network</dt><dd>Ethereum Sepolia · ${intent.chainId}</dd></div>
    <div class="row"><dt>Invoice ref</dt><dd>${intent.invoiceRef}</dd></div>`;
}

/* ── hold-to-authorize (Gate 4) ─────────────────────────────────────── */
function wireAuthorize() {
  const btn = $("authorize"), fill = $("holdFill");
  const HOLD = 1100; let raf = null, start = 0, fired = false;
  const tick = (t) => {
    if (!start) start = t;
    const p = Math.min(1, (t - start) / HOLD);
    fill.style.width = (p * 100) + "%";
    if (p >= 1) { if (!fired) { fired = true; authorize(); } return; }
    raf = requestAnimationFrame(tick);
  };
  const down = (ev) => { ev.preventDefault(); fired = false; start = 0; raf = requestAnimationFrame(tick); };
  const up = () => { if (raf) cancelAnimationFrame(raf); raf = null; if (!fired) fill.style.width = "0%"; };
  btn.addEventListener("pointerdown", down);
  ["pointerup", "pointerleave", "pointercancel"].forEach((e) => btn.addEventListener(e, up));
}

async function authorize() {
  if (!currentJob || !currentJob.jobId) return;
  $("authorize").classList.add("signing");
  setGate("G4", "cleared", "authorized by operator");
  setGate("G5", "active", "broadcasting + confirming");
  setState("signing", "SIGNING<br>&amp; SENDING", "Signing locally and broadcasting the exact-amount transfer. Waiting for confirmations.");
  try {
    const r = await (await fetch("/api/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: currentJob.jobId }) })).json();
    if (r.status === "settled") {
      setGate("G5", "cleared", `${r.confirmations} confirmations`);
      setState("settled", "SETTLED", "Real test USD₮ moved on Ethereum Sepolia, behind every gate.");
      renderReceipt(r);
      $("bandSettle").hidden = true;
      $("bandReceipt").hidden = false;
      setTimeout(() => scrollToEl($("bandReceipt")), 350);
    } else {
      setGate("G5", "blocked", r.reason);
      $("blockGate").textContent = "SETTLEMENT BLOCKED";
      $("blockReason").textContent = r.reason;
      setState("blocked", "BLOCKED", "The on-chain gate refused the send. No funds moved.");
      $("bandSettle").hidden = true; $("bandBlocked").hidden = false;
      setTimeout(() => scrollToEl($("bandBlocked")), 350);
    }
  } catch (err) {
    setState("idle", "ERROR", String(err));
  } finally {
    $("authorize").classList.remove("signing");
    $("holdFill").style.width = "0%";
  }
}

function renderReceipt(r) {
  const a = currentJob.intent;
  $("receipt").innerHTML = `
    <div class="seal">SETTLED</div>
    <div class="rrow"><span class="rk">Amount</span><span class="rv">${fmtUnits(a.amount, 6)} USD₮</span></div>
    <div class="rrow"><span class="rk">Recipient</span><span class="rv mono">${a.to}</span></div>
    <div class="rrow"><span class="rk">Confirmations</span><span class="rv">${r.confirmations} · Ethereum Sepolia</span></div>
    <div class="rrow"><span class="rk">Transaction</span><a class="tx" href="${r.explorerUrl}" target="_blank" rel="noreferrer">${r.txHash}</a></div>`;
  loadHeader();
}

/* ── intake wiring ──────────────────────────────────────────────────── */
function wireIntake() {
  const dz = $("dropzone"), file = $("file");
  dz.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => { if (file.files[0]) verify({ bytes: await file.files[0].arrayBuffer() }); });
  ["dragover", "dragenter"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((e) => dz.addEventListener(e, () => dz.classList.remove("drag")));
  dz.addEventListener("drop", async (ev) => { ev.preventDefault(); const f = ev.dataTransfer.files[0]; if (f) verify({ bytes: await f.arrayBuffer() }); });
}
function reset() {
  ["bandPipeline", "bandBlocked", "bandSettle", "bandReceipt"].forEach((b) => ($(b).hidden = true));
  currentJob = null;
  setState("idle", "AWAITING<br>INVOICE", "Read locally. Verified against the air-gapped ERP. Settled on-chain only after every gate clears.");
  scrollToEl($("hero"));
}

loadHeader(); loadSamples(); wireIntake(); wireAuthorize();
$("resetBlocked").addEventListener("click", reset);
$("resetReceipt").addEventListener("click", reset);

/* ── preview hook (visual QA only): /?preview=verified|blocked|receipt ── */
(function preview() {
  const p = new URLSearchParams(location.search).get("preview");
  if (!p) return;
  document.querySelector(".hero").style.minHeight = "440px"; // QA: see lower bands in one capture
  $("bandIntake").hidden = true;
  const intent = { to: "0x8ba1f109551bD432803012645Ac136ddd64DBA72", amount: "1000000", token: "0xd077a400968890eacc75cdc901f0356c943e4fdb", chainId: 11155111, invoiceRef: "INV-UI-DEMO" };
  $("bandPipeline").hidden = false; renderGates();
  renderReadout({ vendorName: "Acme Robotics Ltd", invoiceAmount: "1.00", currency: "USDT", dueDate: "2026-07-15", providedWallet: intent.to, _model: "QWEN3VL_2B_MULTIMODAL_Q4_K", _ocrBlocks: 18 });
  ["G0", "G1", "G2", "G3"].forEach((g) => setGate(g, "cleared", { G0: "no injection", G1: "model extracts only", G2: "vendor + PO PO-TEST", G3: "matches DB wallet" }[g]));
  if (p === "verified" || p === "receipt") { setGate("G4", p === "receipt" ? "cleared" : "active", p === "receipt" ? "authorized" : "awaiting your authorization"); renderSummary(intent); $("bandSettle").hidden = p === "receipt"; setState("verified", "VERIFIED", "Every automated gate cleared. One deliberate human signature remains."); }
  if (p === "receipt") { setGate("G5", "cleared", "2 confirmations"); currentJob = { intent }; renderReceipt({ status: "settled", confirmations: 2, txHash: "0xa3ed0f33fcfa685287185284079884c0ea0c3a260149443bfd945f083f79cd30", explorerUrl: "https://sepolia.etherscan.io/tx/0xa3ed0f33fcfa685287185284079884c0ea0c3a260149443bfd945f083f79cd30" }); $("bandReceipt").hidden = false; setState("settled", "SETTLED", "Real test USD₮ moved on Ethereum Sepolia, behind every gate."); }
  if (p === "blocked") { setGate("G2", "blocked", "no vendor/PO match"); setGate("G3", "pending", ""); $("blockGate").textContent = "GATE 2 — Deterministic truth"; $("blockReason").textContent = 'no open PO matches 4,242.00 USDT for "Acme Robotics Ltd" — the amount does not exist in the air-gapped ERP.'; $("bandBlocked").hidden = false; setState("blocked", "BLOCKED", "A payment is impossible unless every gate clears. No funds moved."); }
})();
