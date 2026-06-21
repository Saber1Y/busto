"use strict";

/* Custos · Edge Console (C9-1) — conversational AP workspace.
   The conversation is the INTERFACE only. Deterministic gates still authorize; the
   only money-mover is the deliberate human hold → /api/approve. The explainer is
   read-only. Model- and document-derived text is rendered via textContent, never
   innerHTML, so a hostile invoice cannot inject UI. */

const $ = (id) => document.getElementById(id);

/* DOM refs */
const thread = $("thread");
const composerInput = $("composerInput"), send = $("send"), attach = $("attach"), file = $("file");
const signer = $("signer"), signerAddr = $("signerAddr"), balance = $("balance"), inboxCount = $("inboxCount");
const nav = $("nav"), viewTitle = $("viewTitle"), viewDesc = $("viewDesc");

let currentJob = null, walletConfigured = true, busy = false, pickerEl = null;

/* trusted icon constants (no user data) */
const CHECK_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5l3 3 6-7"/></svg>';
const CROSS_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
const DOC_SVG = '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h5l3 3v9H4zM9 2v3h3M6 8.5h4M6 11h3"/></svg>';

const REASON_LABEL = {
  gate0: "Checked for hidden instructions",
  vendor: "Looked up the vendor in your books",
  po: "Matched a purchase order",
  wallet: "Verified the payout wallet",
  duplicate: "Checked for duplicate invoices",
};

const DEMO_GATES_VERIFIED = [
  { id: "G0", name: "Hidden-instruction check", state: "cleared", detail: "no hidden instructions" },
  { id: "G1", name: "The reader can't pay", state: "cleared", detail: "the AI only extracts fields" },
  { id: "G2", name: "Vendor + purchase order", state: "cleared", detail: "PO-TEST matches the amount" },
  { id: "G3", name: "Payment goes to the verified wallet", state: "cleared", detail: "matches the wallet on file" },
  { id: "G4", name: "You approve", state: "active", detail: "awaiting your authorization" },
  { id: "G5", name: "On-chain payment", state: "pending", detail: "pinned network + token, exact amount" },
];
const DEMO_GATES_BLOCKED = [
  { id: "G0", name: "Hidden-instruction check", state: "cleared", detail: "no hidden instructions" },
  { id: "G1", name: "The reader can't pay", state: "cleared", detail: "the AI only extracts fields" },
  { id: "G2", name: "Vendor + purchase order", state: "cleared", detail: "PO-TEST matches the amount" },
  { id: "G3", name: "Payment goes to the verified wallet", state: "blocked", detail: "the document's wallet doesn't match the ERP" },
  { id: "G4", name: "You approve", state: "pending", detail: "awaiting your authorization" },
  { id: "G5", name: "On-chain payment", state: "pending", detail: "pinned network + token, exact amount" },
];

/* helpers */
const short = (a) => (a && a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a || "");
const fmtUnits = (v, d) => {
  const s = BigInt(v).toString().padStart(d + 1, "0");
  const i = s.slice(0, s.length - d), f = s.slice(s.length - d).replace(/0+$/, "");
  return i + (f ? "." + f : "");
};
const stripThinking = (s) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").replace(/\*\*(.*?)\*\*/g, "$1").replace(/\*\*/g, "").replace(/^\s{0,3}#{1,6}\s+/gm, "").trim();
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
const scrollThread = () => { thread.scrollTop = thread.scrollHeight; };

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else if (k === "html") n.innerHTML = v; // trusted icon constants only
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) { if (kid == null || kid === false) continue; n.append(kid.nodeType ? kid : document.createTextNode(String(kid))); }
  return n;
}

/* message scaffolding */
function appendUser(text, srcLabel) {
  const msg = el("div", { class: "msg user" }, el("div", { class: "avatar", text: "AP" }));
  const bubble = el("div", { class: "bubble" }, el("div", { class: "who", text: "You" }));
  const pr = el("div", { class: "prose", text });
  if (srcLabel) pr.append(el("span", { class: "src-chip", html: DOC_SVG }), srcLabel);
  bubble.append(pr);
  msg.append(bubble); thread.append(msg); scrollThread();
}
function appendAgent() {
  const bubble = el("div", { class: "bubble" }, el("div", { class: "who", text: "Custos" }));
  const msg = el("div", { class: "msg agent" }, el("div", { class: "avatar", text: "C" }), bubble);
  thread.append(msg); scrollThread();
  return { msg, bubble };
}
function addProse(bubble, text = "") { const p = el("div", { class: "prose", text }); bubble.append(p); scrollThread(); return p; }
function addChips(bubble, items, onPick) {
  const wrap = el("div", { class: "chips" });
  for (const q of items) wrap.append(el("button", { class: "chip", type: "button", onclick: () => onPick(q) }, q));
  bubble.append(wrap); scrollThread();
}

/* reasoning stream */
function mkGlyph(state) {
  if (state === "run") return el("div", { class: "rl-run" });
  if (state === "check") return el("span", { class: "rl-check", html: CHECK_SVG });
  if (state === "cross") return el("span", { class: "rl-cross", html: CROSS_SVG });
  return el("div", { class: "rl-info" });
}
function addReasoning(bubble) {
  const box = el("div", { class: "reasoning" }, el("div", { class: "reasoning-head" }, "Reasoning"));
  bubble.append(box); scrollThread(); return box;
}
function addReasonLine(box, text, state, detailNode) {
  const g = el("span", { class: "rl-glyph" }, mkGlyph(state));
  const body = el("div", { class: "rl-body" }, el("div", { class: "rl-text", text }));
  if (detailNode) body.append(detailNode);
  const line = el("div", { class: "rl", "data-done": state === "run" ? "pending" : "done" }, g, body);
  box.append(line); scrollThread(); return line;
}
function setReasonLine(line, state, opts = {}) {
  line.dataset.done = state === "run" ? "pending" : "done";
  const g = line.querySelector(".rl-glyph"); g.textContent = ""; g.append(mkGlyph(state));
  if (opts.text != null) line.querySelector(".rl-text").textContent = opts.text;
  if (opts.detailNode) { const old = line.querySelector(".rl-detail"); if (old) old.remove(); line.querySelector(".rl-body").append(opts.detailNode); }
}
function readDetail(model, blocks, ms) {
  const d = el("div", { class: "rl-detail" }, el("span", { class: "mono", text: model }));
  d.append(` · ${blocks} OCR blocks · ${(ms / 1000).toFixed(1)}s`);
  return d;
}
const reasonDetail = (text) => el("div", { class: "rl-detail", text });

/* structured cards */
function kvRow(k, v) {
  return el("div", { class: "kv-row" },
    el("span", { class: "kv-k", text: k }),
    typeof v === "string" ? el("span", { class: "kv-v", text: v }) : el("span", { class: "kv-v" }, v));
}
function gateRow(g) {
  const tag = { cleared: "cleared", blocked: "blocked", active: "awaiting", pending: "pending" }[g.state] || g.state;
  const main = el("div", { class: "gate-main" }, el("div", { class: "gate-name", text: g.name }));
  if (g.detail) main.append(el("div", { class: "gate-detail", text: g.detail }));
  return el("li", { class: "gaterow", "data-state": g.state },
    el("span", { class: "gate-no", text: g.id }), main, el("span", { class: "gate-tag", text: tag }));
}
function renderVerdictCard(bubble, fin, ctx) {
  const ok = fin.status === "VERIFIED";
  const pill = el("span", { class: "verdict-pill " + (ok ? "ok" : "bad") }, el("i"), ok ? "VERIFIED" : "BLOCKED");
  const left = el("div", {}, pill, el("div", { class: "card-sub", style: "margin-top:7px", text: ctx.sourceLabel || "invoice" }));
  const right = el("div", { style: "text-align:right" });
  if (ctx.extraction) {
    right.append(el("div", { class: "amount-big", text: `${ctx.extraction.invoiceAmount || "—"} ${ctx.extraction.currency || ""}` }));
    right.append(el("div", { class: "card-sub", text: ctx.extraction.vendorName || "" }));
  }
  const ol = el("ol", { class: "gates" });
  for (const g of fin.gates) ol.append(gateRow(g));
  bubble.append(el("div", { class: "card" }, el("div", { class: "card-head" }, left, right), ol));
  scrollThread();
}
function renderAuthorizeCard(bubble, demo) {
  const intent = currentJob.intent;
  const kv = el("div", { class: "kv" },
    kvRow("Recipient (verified)", el("span", { class: "mono", text: intent.to })),
    kvRow("Amount", `${fmtUnits(intent.amount, 6)} USD₮`),
    kvRow("Network", `Ethereum Sepolia · ${intent.chainId}`));
  const fill = el("span", { class: "hold-fill" });
  const btn = el("button", { class: "hold", type: "button" }, fill, el("span", { class: "hold-label", text: "HOLD TO AUTHORIZE PAYMENT" }));
  const auth = el("div", { class: "authorize" }, btn,
    el("p", { class: "auth-note", html: "The recipient is the <strong>verified wallet on file</strong>, never the document. Keys never leave this machine." }));
  bubble.append(el("div", { class: "card" },
    el("div", { class: "card-head" }, el("span", { class: "card-title", text: "Authorize payment" }), el("span", { class: "card-sub", text: "Gate 4 · human approval" })),
    kv, auth));
  scrollThread();
  wireHold(btn, fill, demo ? () => {} : () => doAuthorize(btn)); // demo replay never touches the real settle path
}
function renderDemoNote(bubble) {
  bubble.append(el("div", { class: "card" },
    el("div", { class: "card-head" }, el("span", { class: "card-title", text: "Authorize payment" }), el("span", { class: "card-sub", text: "Gate 4 · demo mode" })),
    el("div", { class: "authorize" },
      el("p", { class: "auth-note", html: "Demo mode — no wallet configured. Set <strong>CUSTOS_WALLET_SEED</strong> in <strong>.env</strong> to a funded Sepolia wallet and restart to settle for real. The verification above is fully live." }))));
  scrollThread();
}
function renderReceiptCard(bubble, r) {
  const intent = currentJob.intent;
  const kv = el("div", { class: "kv" },
    kvRow("Amount", `${fmtUnits(intent.amount, 6)} USD₮`),
    kvRow("Recipient", el("span", { class: "mono", text: intent.to })),
    kvRow("Transaction", el("a", { class: "tx-link", href: r.explorerUrl, target: "_blank", rel: "noreferrer", text: r.txHash })));
  bubble.append(el("div", { class: "card settled" },
    el("div", { class: "card-head" }, el("span", { class: "verdict-pill ok" }, el("i"), "SETTLED"), el("span", { class: "card-sub", text: `${r.confirmations} confirmations · Ethereum Sepolia` })),
    kv));
  scrollThread();
}

/* hold-to-authorize (Gate 4) */
function wireHold(btn, fill, onComplete) {
  const HOLD = 1100; let raf = null, start = 0, fired = false;
  const tick = (t) => {
    if (!start) start = t;
    const p = Math.min(1, (t - start) / HOLD);
    fill.style.width = (p * 100) + "%";
    if (p >= 1) { if (!fired) { fired = true; onComplete(); } return; }
    raf = requestAnimationFrame(tick);
  };
  const down = (ev) => { if (btn.classList.contains("demo") || btn.classList.contains("signing")) return; ev.preventDefault(); fired = false; start = 0; raf = requestAnimationFrame(tick); };
  const up = () => { if (raf) cancelAnimationFrame(raf); raf = null; if (!fired) fill.style.width = "0%"; };
  btn.addEventListener("pointerdown", down);
  ["pointerup", "pointerleave", "pointercancel"].forEach((e) => btn.addEventListener(e, up));
}

/* ── verify flow ──────────────────────────────────────────────────── */
async function startVerify(payload) {
  if (busy) { addProse(appendAgent().bubble, "One verification at a time — let me finish the current invoice first."); return; }
  busy = true; setComposerEnabled(false); hidePicker();
  appendUser("Verify this invoice", payload.label);
  const { bubble } = appendAgent();
  const box = addReasoning(bubble);
  const ctx = { bubble, box, sourceLabel: payload.label, extraction: null, intent: null,
                readLine: addReasonLine(box, "Reading the invoice on-device…", "run") };
  try {
    const res = await fetch("/api/verify", payload.json
      ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload.json) }
      : { method: "POST", headers: { "content-type": "image/png" }, body: payload.bytes });
    if (res.status === 429) { setReasonLine(ctx.readLine, "cross", { text: "Another verification is already running." }); return; }
    if (!res.ok || !res.body) { setReasonLine(ctx.readLine, "cross", { text: "The verifier is unavailable right now." }); return; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        handleVerifyEvent(ev, ctx);
      }
    }
  } catch {
    setReasonLine(ctx.readLine, "cross", { text: "Couldn't complete the verification." });
  } finally {
    busy = false; setComposerEnabled(true);
  }
}
function handleVerifyEvent(e, ctx) {
  if (e.t === "extraction") {
    ctx.extraction = e.data;
    setReasonLine(ctx.readLine, "check", { text: "Read the invoice on-device", detailNode: readDetail(e.data._model || "on-device", e.data._ocrBlocks || 0, e.data._readMs || 0) });
    addReasonLine(ctx.box, `Extracted ${e.data.vendorName || "—"} · ${e.data.invoiceAmount || "—"} ${e.data.currency || ""} · due ${e.data.dueDate || "—"}`, "info");
  } else if (e.t === "reason") {
    addReasonLine(ctx.box, REASON_LABEL[e.step] || e.step, e.ok ? "check" : "cross", reasonDetail(e.detail));
  } else if (e.t === "intent") {
    ctx.intent = e.data;
  } else if (e.t === "final") {
    finalizeVerify(e.data, ctx);
  }
}
function finalizeVerify(fin, ctx) {
  if (fin.status === "ERROR") { addReasonLine(ctx.box, fin.reason || "Something went wrong.", "cross"); return; }
  currentJob = { jobId: fin.jobId, intent: fin.intent || null, status: fin.status };
  renderVerdictCard(ctx.bubble, fin, ctx);
  if (fin.status === "VERIFIED") {
    const amt = ctx.extraction ? `${ctx.extraction.invoiceAmount} ${ctx.extraction.currency}` : "the amount";
    const vendor = ctx.extraction?.vendorName || "the vendor";
    addProse(ctx.bubble, `Every gate cleared. I've prepared a payment of ${amt} to ${vendor}'s verified wallet — the recipient comes from your books, not the document. Review it below and hold to authorize; I can't move the money myself.`);
    addChips(ctx.bubble, ["What happens if I approve?", "Is this vendor known?", "What does Custos check?"], askInThread);
    if (walletConfigured) renderAuthorizeCard(ctx.bubble); else renderDemoNote(ctx.bubble);
  } else {
    const gname = (fin.gates.find((g) => g.id === fin.blockedGate) || {}).name || "a gate";
    addProse(ctx.bubble, `I stopped at “${gname}”. ${cap(fin.reason)} No money can move — nothing was sent.`);
    addChips(ctx.bubble, ["Why was this blocked?", "Is this vendor known?", "What would make this pass?"], askInThread);
  }
}

/* ── streamed answers (read-only) ─────────────────────────────────── */
async function streamAnswer(pr, url, body) {
  pr.classList.add("streaming");
  let acc = "";
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1); if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.t === "token") { acc += ev.text; pr.textContent = stripThinking(acc); scrollThread(); }
        else if (ev.t === "done") { if (ev.full) pr.textContent = ev.full; }
        else if (ev.t === "error") { pr.textContent = "Sorry — " + ev.reason; }
      }
    }
  } catch (err) {
    pr.textContent = "The assistant is unavailable: " + String(err);
  }
  pr.classList.remove("streaming");
}

// Route any free-text message: a loaded invoice -> explain it; otherwise the general
// ERP-grounded assistant. (A dropped invoice goes through startVerify, not here.)
function handleMessage(q) {
  if (busy || !q) return;
  if (currentJob && currentJob.jobId) askInThread(q);
  else askAssistant(q);
}

// In-invoice questions (C8a explainInvoice).
async function askInThread(q) {
  if (busy || !currentJob || !currentJob.jobId) return;
  busy = true; setComposerEnabled(false);
  appendUser(q);
  const { bubble } = appendAgent();
  await streamAnswer(addProse(bubble, ""), "/api/explain", { jobId: currentJob.jobId, question: q });
  const chips = currentJob.status === "BLOCKED" ? ["What would make this pass?", "Is this vendor known?"] : ["What happens if I approve?", "Is this vendor known?"];
  addChips(bubble, chips, askInThread);
  busy = false; setComposerEnabled(true);
}

// General, ERP-grounded, read-only assistant (no invoice loaded).
async function askAssistant(q) {
  if (busy) return;
  busy = true; setComposerEnabled(false);
  appendUser(q);
  const { bubble } = appendAgent();
  await streamAnswer(addProse(bubble, ""), "/api/assist", { question: q });
  busy = false; setComposerEnabled(true);
}

/* ── settle (real C4 path; only on a deliberate human hold) ───────── */
async function doAuthorize(btn) {
  if (!currentJob || !currentJob.jobId) return;
  btn.classList.add("signing");
  const { bubble } = appendAgent();
  const pr = addProse(bubble, "Signing locally and broadcasting the exact-amount transfer…"); pr.classList.add("streaming");
  try {
    const r = await (await fetch("/api/approve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: currentJob.jobId }) })).json();
    pr.classList.remove("streaming");
    if (r.status === "settled") {
      pr.textContent = `Settled. ${fmtUnits(currentJob.intent.amount, 6)} USD₮ moved on Ethereum Sepolia with ${r.confirmations} confirmations.`;
      renderReceiptCard(bubble, r);
      loadHeader();
    } else {
      pr.textContent = r.reason || "The settlement gate refused the send. No funds moved.";
      btn.classList.remove("signing"); // recoverable refusal — allow another deliberate hold
    }
  } catch (err) {
    pr.classList.remove("streaming");
    pr.textContent = "Settlement error: " + String(err);
    btn.classList.remove("signing"); // transient error — allow retry
  }
}

/* ── composer / intake ────────────────────────────────────────────── */
function setComposerEnabled(on) {
  composerInput.disabled = !on;
  send.disabled = !on || !composerInput.value.trim();
  attach.style.pointerEvents = on ? "" : "none";
}
function submitComposer() {
  const v = composerInput.value.trim();
  if (!v || busy) return;
  composerInput.value = ""; send.disabled = true;
  handleMessage(v);
}
function wireComposer() {
  send.disabled = true;
  composerInput.addEventListener("input", () => { send.disabled = !composerInput.value.trim() || busy; });
  composerInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitComposer(); } });
  send.addEventListener("click", submitComposer);
  attach.addEventListener("click", () => file.click());
  file.addEventListener("change", async () => { if (file.files[0]) startVerify({ bytes: await file.files[0].arrayBuffer(), label: file.files[0].name }); });
  ["dragover", "dragenter"].forEach((e) => thread.addEventListener(e, (ev) => ev.preventDefault()));
  thread.addEventListener("drop", async (ev) => { ev.preventDefault(); const f = ev.dataTransfer.files[0]; if (f) startVerify({ bytes: await f.arrayBuffer(), label: f.name }); });
}

/* ── intro + inbox picker ─────────────────────────────────────────── */
function renderIntro() {
  const { bubble } = appendAgent();
  addProse(bubble, "I'm Custos — your air-gapped accounts-payable agent. Drop a vendor invoice and I'll verify it against your books and settle it on-chain after you approve — or ask me about a vendor, a past payment, or how the gates work.");
  addChips(bubble, ["What can you do?", "How do the gates work?", "Is Acme a known vendor?"], handleMessage);
  pickerEl = renderPicker(bubble);
}
function renderPicker(bubble) {
  const dz = el("button", { class: "dropzone", type: "button" },
    el("div", { class: "dz-lead", text: "Drop an invoice to verify" }),
    el("div", { class: "dz-sub", text: "PNG or PDF — read on this machine, never uploaded" }));
  dz.addEventListener("click", () => file.click());
  ["dragover", "dragenter"].forEach((e) => dz.addEventListener(e, (ev) => { ev.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((e) => dz.addEventListener(e, () => dz.classList.remove("drag")));
  dz.addEventListener("drop", async (ev) => { ev.preventDefault(); const f = ev.dataTransfer.files[0]; if (f) startVerify({ bytes: await f.arrayBuffer(), label: f.name }); });
  const list = el("div", { class: "samples" });
  const wrap = el("div", { style: "margin-top:12px" }, dz, el("div", { class: "samples-lead", text: "Or pick from your inbox" }), list);
  bubble.append(wrap);
  loadSamples(list);
  return wrap;
}
function hidePicker() { if (pickerEl) { pickerEl.style.display = "none"; pickerEl = null; } }
async function loadSamples(list) {
  try {
    const items = await (await fetch("/api/samples")).json();
    inboxCount.textContent = String(items.length);
    for (const s of items) {
      const main = el("div", { class: "sample-main" }, el("div", { class: "sample-label", text: s.label }), el("div", { class: "sample-note", text: s.note }));
      const b = el("button", { class: "sample", type: "button" },
        el("div", { class: "sample-ico", html: DOC_SVG }), main, el("div", { class: "sample-expect", text: s.expect }));
      b.addEventListener("click", () => startVerify({ json: { sample: s.id }, label: s.label }));
      list.append(b);
    }
  } catch { /* samples optional */ }
}

/* ── header (wallet) ──────────────────────────────────────────────── */
async function loadHeader() {
  try {
    const w = await (await fetch("/api/wallet")).json();
    walletConfigured = w.configured !== false;
    if (!walletConfigured) { signerAddr.textContent = "demo mode"; signer.removeAttribute("href"); balance.textContent = "no wallet · read-only"; return; }
    signerAddr.textContent = short(w.address);
    signer.href = `https://sepolia.etherscan.io/address/${w.address}`;
    balance.textContent = `${fmtUnits(w.usdt, 6)} USD₮`;
  } catch { balance.textContent = "wallet offline"; }
}

/* ── nav (Workspace real; rest are stubs until C9-2) ──────────────── */
const VIEWS = {
  workspace: { title: "Workspace", desc: "Verify and settle vendor invoices in conversation — grounded in on-device inference." },
  inbox: { title: "Inbox", desc: "Invoices waiting to be verified.", stub: "Your inbox of incoming vendor invoices will live here — pick one and the agent verifies it in the Workspace." },
  history: { title: "History", desc: "Every verification and settlement.", stub: "A searchable record of every verification and on-chain settlement, each with its profiler-backed audit trail." },
  vendors: { title: "Vendors", desc: "Your books: vendors, wallets, open POs.", stub: "Your air-gapped ERP: known vendors, their verified payout wallets, and open purchase orders." },
  settings: { title: "Settings", desc: "Signer, network, and models.", stub: "Configure the Edge signer, the Sepolia network, and the on-device QVAC models." },
};
function renderStub(name, meta) {
  const v = $(`view-${name}`); v.textContent = "";
  v.append(el("div", { class: "stub-card" },
    el("svg", { class: "ico-lg", viewBox: "0 0 16 16", html: '<path d="M2 3.5h12v9H2zM2 6.5h12" fill="none" stroke="currentColor" stroke-width="1.2"/>' }),
    el("h2", { text: meta.title }),
    el("p", { text: meta.stub }),
    el("span", { class: "stub-soon", text: "Available in C9-3" })));
}
function switchView(name) {
  for (const b of nav.querySelectorAll(".nav-item")) b.classList.toggle("is-active", b.dataset.view === name);
  for (const v of document.querySelectorAll(".view")) v.hidden = v.id !== `view-${name}`;
  const meta = VIEWS[name]; viewTitle.textContent = meta.title; viewDesc.textContent = meta.desc;
  if (name !== "workspace") renderStub(name, meta);
}
function wireNav() { nav.addEventListener("click", (e) => { const b = e.target.closest(".nav-item"); if (b) switchView(b.dataset.view); }); }

/* ── demo replay (visual QA only): /?demo=verified|blocked|settled ── */
function runDemoVerified(EX, settled) {
  appendUser("Verify this invoice", "ui-clean.png");
  const { bubble } = appendAgent();
  const box = addReasoning(bubble);
  setReasonLine(addReasonLine(box, "Reading the invoice on-device…", "run"), "check", { text: "Read the invoice on-device", detailNode: readDetail(EX._model, EX._ocrBlocks, EX._readMs) });
  addReasonLine(box, `Extracted ${EX.vendorName} · ${EX.invoiceAmount} ${EX.currency} · due ${EX.dueDate}`, "info");
  addReasonLine(box, REASON_LABEL.gate0, "check", reasonDetail("no hidden instructions in the document"));
  addReasonLine(box, REASON_LABEL.vendor, "check", reasonDetail("ACME ROBOTICS LTD is on file and active"));
  addReasonLine(box, REASON_LABEL.po, "check", reasonDetail("PO-TEST matches 1.00 USDT"));
  addReasonLine(box, REASON_LABEL.wallet, "check", reasonDetail("the payout wallet matches the verified wallet on file"));
  addReasonLine(box, REASON_LABEL.duplicate, "check", reasonDetail("not seen before — no duplicate"));
  const intent = { to: "0x8ba1f109551bD432803012645Ac136ddd64DBA72", amount: "1000000", token: "0xd077a400968890eacc75cdc901f0356c943e4fdb", chainId: 11155111, invoiceRef: "INV-UI-01", memo: "Custos · PO-TEST" };
  currentJob = { jobId: "demo", intent, status: "VERIFIED" };
  renderVerdictCard(bubble, { status: "VERIFIED", gates: DEMO_GATES_VERIFIED }, { sourceLabel: "ui-clean.png", extraction: EX });
  addProse(bubble, `Every gate cleared. I've prepared a payment of ${EX.invoiceAmount} ${EX.currency} to ${EX.vendorName}'s verified wallet — the recipient comes from your books, not the document. Review it below and hold to authorize; I can't move the money myself.`);
  addChips(bubble, ["What happens if I approve?", "Is this vendor known?", "What does Custos check?"], () => {});
  if (!settled) renderAuthorizeCard(bubble, true);
  appendUser("What happens if I approve?");
  addProse(appendAgent().bubble, "If you approve, the invoice will be processed and the specified amount (1 USDT) will be transferred to the vendor's wallet. The transaction will be verified against the database and confirmed as unique. The payout wallet matches the one recorded in the system.");
  if (settled) {
    appendUser("Authorize payment");
    const s = appendAgent();
    addProse(s.bubble, "Settled. 1.00 USD₮ moved on Ethereum Sepolia with 2 confirmations.");
    renderReceiptCard(s.bubble, { status: "settled", confirmations: 2, txHash: "0xa3ed0f33fcfa685287185284079884c0ea0c3a260149443bfd945f083f79cd30", explorerUrl: "https://sepolia.etherscan.io/tx/0xa3ed0f33fcfa685287185284079884c0ea0c3a260149443bfd945f083f79cd30" });
  }
}
function runDemoBlocked(EX) {
  const EXF = Object.assign({}, EX, { providedWallet: "0x6B175474E89094C44Da98b954EedeAC495271d0F" });
  appendUser("Verify this invoice", "ui-fraud.png");
  const { bubble } = appendAgent();
  const box = addReasoning(bubble);
  setReasonLine(addReasonLine(box, "Reading the invoice on-device…", "run"), "check", { text: "Read the invoice on-device", detailNode: readDetail(EX._model, 17, 2510) });
  addReasonLine(box, `Extracted ${EXF.vendorName} · ${EXF.invoiceAmount} ${EXF.currency} · due ${EXF.dueDate}`, "info");
  addReasonLine(box, REASON_LABEL.gate0, "check", reasonDetail("no hidden instructions in the document"));
  addReasonLine(box, REASON_LABEL.vendor, "check", reasonDetail("ACME ROBOTICS LTD is on file and active"));
  addReasonLine(box, REASON_LABEL.po, "check", reasonDetail("PO-TEST matches 1.00 USDT"));
  addReasonLine(box, REASON_LABEL.wallet, "cross", reasonDetail("the payout wallet does not match the wallet on file"));
  currentJob = { jobId: "demo", intent: null, status: "BLOCKED" };
  renderVerdictCard(bubble, { status: "BLOCKED", blockedGate: "G3", gates: DEMO_GATES_BLOCKED }, { sourceLabel: "ui-fraud.png", extraction: EXF });
  addProse(bubble, "I stopped at “Payment goes to the verified wallet”. The payout wallet does not match the wallet on file (drift 38). No money can move — nothing was sent.");
  addChips(bubble, ["Why was this blocked?", "Is this vendor known?", "What would make this pass?"], () => {});
  appendUser("Why was this blocked?");
  addProse(appendAgent().bubble, "The invoice was blocked because the wallet provided did not match the known wallet for the vendor, resulting in a drift of 38. Despite other checks passing, the wallet verification failed, leading to the rejection.");
}
// Representative free-text conversation (real captured answers) for screenshots.
function runDemoChat() {
  const { bubble } = appendAgent();
  addProse(bubble, "I'm Custos — your air-gapped accounts-payable agent. Drop a vendor invoice and I'll verify it against your books and settle it on-chain after you approve — or ask me about a vendor, a past payment, or how the gates work.");
  addChips(bubble, ["What can you do?", "How do the gates work?", "Is Acme a known vendor?"], () => {});
  const exchange = (q, a) => { appendUser(q); addProse(appendAgent().bubble, a); };
  exchange("hi", "Hello, I am Custos, your accounts-payable system. I can help verify invoices, check them against the ERP, and ensure every gate passes before any payment is made. Let me know if you need assistance with an invoice or your vendors.");
  exchange("what can you do?", "I can read vendor invoices on-device, verify them against my internal ERP, run them through six security gates, settle them as USD₮ on Ethereum Sepolia after human approval, and answer questions about vendors, purchase orders, and past settlements.");
  exchange("is Acme a known vendor?", "Yes, Acme Robotics Ltd is a known vendor.");
  exchange("have we paid Acme before?", "Acme Robotics Ltd is not in the settlement history, which means Custos has made no payment to this vendor yet. They do have open purchase orders (PO-1042 and PO-1043) that have not been paid.");
}
function runDemo(kind) {
  document.body.classList.add("demo-full");
  walletConfigured = true;
  signerAddr.textContent = "0x90F8bf…DA62A8"; signer.href = "#"; balance.textContent = "3.50 USD₮"; inboxCount.textContent = "4";
  if (kind === "chat") return runDemoChat();
  const EX = { vendorName: "ACME ROBOTICS LTD", invoiceAmount: "1.00", currency: "USDT", dueDate: "2026-07-15", providedWallet: "0x8ba1f109551bD432803012645Ac136ddd64DBA72", _model: "QWEN3VL_2B_MULTIMODAL_Q4_K", _ocrBlocks: 16, _readMs: 2380 };
  if (kind === "blocked") runDemoBlocked(EX); else runDemoVerified(EX, kind === "settled");
}

/* ── shell: collapse (persisted) + mobile drawer ──────────────────── */
function applySidebar(state) { document.documentElement.dataset.sidebar = state; }
function wireShell() {
  const override = new URLSearchParams(location.search).get("sidebar");
  let saved = null; try { saved = localStorage.getItem("custos.sidebar"); } catch { /* storage optional */ }
  applySidebar(override || saved || "expanded");
  const toggle = $("sideToggle");
  if (toggle) toggle.addEventListener("click", () => {
    const next = document.documentElement.dataset.sidebar === "collapsed" ? "expanded" : "collapsed";
    applySidebar(next);
    try { localStorage.setItem("custos.sidebar", next); } catch { /* storage optional */ }
  });
  const menuBtn = $("menuBtn"), scrim = $("scrim");
  const setDrawer = (open) => { document.body.dataset.drawer = open ? "open" : ""; };
  if (menuBtn) menuBtn.addEventListener("click", () => setDrawer(document.body.dataset.drawer !== "open"));
  if (scrim) scrim.addEventListener("click", () => setDrawer(false));
  nav.addEventListener("click", (e) => { if (e.target.closest(".nav-item")) setDrawer(false); });
}

/* ── init ─────────────────────────────────────────────────────────── */
loadHeader(); wireComposer(); wireNav(); wireShell();
const demoKind = new URLSearchParams(location.search).get("demo");
if (demoKind) runDemo(demoKind); else renderIntro();

