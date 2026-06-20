# Custos — Claude Code Build Prompts

Phased prompts for building Custos with Claude Code. **`CLAUDE.md` is loaded automatically** — these prompts inherit its hard rules, the 5 gates, and the per-phase ritual (flow → smallest slice → prove for real → explain → commit → STOP).

## How to use
1. Put `CLAUDE.md`, `Custos-PRD.md`, `Custos-Threat-Model.md`, `README.md`, `package.json`, and `scripts/smoke.js` in the `custos/` root.
2. Open Claude Code in `custos/` **on the M1 Pro** (primary dev machine).
3. Paste **P0** first. When it reports all gates PASS, paste **C1**. Then one phase at a time — wait for green between each.
4. A few steps run on the **Intel** node too (the prompt says when).

---

## P0 — Ingest everything + prove the gates pass (NO feature code)

```text
This is the P0 bootstrap for Custos. Goal: fully ingest the project and PROVE every P0 gate passes on real hardware. Write NO feature code this phase — only verification, scaffolding, and a report.

1. INGEST. Read CLAUDE.md, Custos-PRD.md, Custos-Threat-Model.md, README.md, package.json, scripts/smoke.js. Then fetch and skim the QVAC SDK docs (docs.qvac.tether.io) and WDK docs (docs.wdk.tether.io). Report back, in your own words: the two-node architecture, the C0–C7 build order, the 5 gates, and the hard rules. This confirms you understand before building. Flag anything in the docs that contradicts the PRD.

2. ENVIRONMENT. Run and record: `node -v` (need >=22.17), `npm -v` (need >=10.9), `sw_vers` (this M1 should be macOS 26.5.1 / arm64), `uname -m`. If Node is too old, tell me the exact nvm command and stop.

3. QVAC SMOKE. `npm i @qvac/sdk`, then `CUSTOS_NODE=orchestrator npm run smoke`. Run it twice (first run downloads the GGUF). Capture the real load_ms (second run), ttft_ms, tok_per_sec, and the `--- raw stats ---` block. From the raw stats, document the EXACT field names the SDK uses for prompt/completion token counts — we need these for the C6 logger. Append the metrics row to evidence/inference-log.jsonl.

4. MODEL CATALOG. Enumerate the model constants actually exported by @qvac/sdk (inspect the installed package). Identify and document: (a) a multimodal/vision-capable LLM + its projection model for invoice reading, (b) an embeddings model for RAG, (c) confirm `@qvac/ocr-onnx` exists and how it's loaded. Record concrete IDs/paths. Do not guess — if a vision model isn't in the catalog, find the supported way to load a vision GGUF via the SDK and document it.

5. P2P SANITY (docs only this phase). From the QVAC docs, document the exact delegation API: how a provider starts and exposes a public key (startQVACProvider + QVAC_HYPERSWARM_SEED), and how a consumer delegates (loadModel delegate: { providerPublicKey, fallbackToLocal }) and checks health (heartbeat). Quote the real signatures. No bridge code yet — that's C1.

6. WDK SANITY. `npm i @tetherto/wdk @tetherto/wdk-wallet-evm @tetherto/wdk-secret-manager`. From the WDK docs, document the exact way to: create an EVM account on Sepolia with an RPC provider, read a balance, and send USD₮ (find the real ERC-20/USD₮ transfer method — do not assume the name). Create a throwaway test wallet, print its address, and tell me the Pimlico/Candide faucet URL to fund Sepolia test USD₮. Confirm a balance read works. NO real send this phase. Keep the seed in .env (gitignored) — never print or commit it.

7. SCAFFOLD. Initialize git. Create the package skeleton from CLAUDE.md (packages/edge, packages/orchestrator, packages/shared, security/, data/, evidence/, scripts/) with minimal package.json stubs. Keep .gitignore as-is.

8. REPORT. Write evidence/p0-report.md with: env table, smoke metrics, the locked stats field names, chosen model IDs, the documented P2P + WDK API signatures, the test wallet address + faucet status, and a PASS/FAIL line for each P0 gate (env, QVAC smoke, model catalog, P2P docs, WDK wallet). Commit "C0: P0 gates passing".

Then STOP. Show me the report and the smoke numbers. Also: I will run step 3 separately on the Intel node (CUSTOS_NODE=edge) to capture the CPU baseline — give me the exact commands for that.
```

---

## C1 — QVAC P2P bridge (the keystone)

```text
C1: prove real Intel→M1 delegated inference over QVAC P2P. PRD §6/§7; threat-model E (75–84) + #82.

Build a reusable delegation client in packages/shared (or orchestrator/edge as fits):
- Orchestrator (M1): a provider entrypoint — startQVACProvider with a stable identity seeded from QVAC_HYPERSWARM_SEED (.env), load the model, print the provider publicKey.
- Edge (Intel): a consumer entrypoint — heartbeat(providerPublicKey) then loadModel with delegate: { providerPublicKey, fallbackToLocal: true }, run a completion that executes ON the M1, and stream the result back.

Prove all three, with real runs and logged rows (delegated:true where applicable):
(a) delegated round-trip works (Edge prompt → M1 inference → Edge result);
(b) heartbeat detects the M1 offline;
(c) fallbackToLocal runs a degraded local 1B on the Edge when the M1 is down — and confirm Custos NEVER auto-settles in degraded mode (flag low-confidence).
Record the TTFT/tok-s of delegated vs Edge-local so we have the real offload delta.

I will run the M1 provider and the Intel consumer on the two machines and paste output. Give me the exact commands for each. Then STOP.
```

---

## C2 — Multimodal extraction (invoice → strict JSON)

```text
C2: turn a real invoice image into validated structured data on the M1. PRD §6 step 2; threat-model B (23–35).

On the Orchestrator: load the multimodal model + projection (IDs from p0-report.md) and @qvac/ocr-onnx. Pipeline:
- ocr-onnx → raw text;
- multimodal completion (image + raw text) constrained to a Zod schema → { vendorName, invoiceAmount (as written), currency, dueDate, providedWallet, lineItems[] };
- cross-check OCR text vs vision read; on disagreement mark fields "needs review" (threat #26).

Use a REAL sample invoice you generate into data/sample/ (a clean PNG/PDF). Leave a hook where Gate-0 normalization will run on extracted text (full impl is C-sec) but don't bypass it. Run on the sample, print the validated JSON, log the inference rows. Then STOP.
```

---

## C3 — ERP + verification tools (tool calling + RAG → verdict)

```text
C3: produce a deterministic PASS/REJECT verdict. PRD §6 step 3 + §11; threat-model C (36–54), #44/#45/#48/#39/#60.

- Seed a real SQLite ERP (better-sqlite3): vendors(id,name,known_wallet,status), purchase_orders(id,vendor_id,po_number,amount,currency,status,description), settlements(id,po_id,invoice_ref UNIQUE,tx_hash,amount,ts). Seed a vector store (sqlite-vec) of PO descriptions using QVAC embeddings.
- Implement QVAC tool-calling handlers (deterministic code, parameterized SQL): lookup_vendor(name), match_purchase_order(vendor_id,amount,description) [exact + RAG semantic], verify_wallet(vendor_id,provided_wallet) [EIP-55 checksum equality]. Amounts in canonical integer minor-units; currency must match exactly.
- The orchestrator LLM calls these tools and returns a structured verdict { decision, reasons[], matchedPO, knownWallet }.

Prove on the C2 output: clean invoice → PASS; and craft inputs that must REJECT — wrong vendor, amount≠PO, wallet mismatch. Show each. Log rows. Then STOP.
```

---

## C-sec — Gate-0 encoding-defense battery (harden before money)

```text
C-sec: build Gate 0 so obfuscated injection can't reach the LLM as instructions. Custos-Threat-Model.md §2 (Grades A–J) + vectors 1–22; this lands BEFORE C4.

In security/: an input normalizer applied to ALL invoice text (typed, OCR'd, vision-read) before extraction reasoning:
- NFKC normalize; strip zero-width/bidi/RTL-override/PUA/tag chars;
- decode Morse, base64/32, hex, ROT13/Caesar/Atbash, leetspeak, homoglyph/confusables; handle nested encodings (depth-limited);
- any decoded content containing an imperative → flag as attack, route to REJECT, log to evidence/inference-log.jsonl. Decoding is for DETECTION, not obedience.

Ship data/adversarial/ with one invoice per Grade A–J plus 4 bypass classics (homoglyph vendor, split-amount, duplicate-replay, wallet-lookalike). Write an automated test asserting every adversarial input is blocked + logged, and that a clean invoice still passes. Wire Gate 0 into the C2→C3 pipeline. Run the suite, show it green. Then STOP.
```

---

## C4 — WDK settlement (real test USD₮ on Sepolia, gated)

```text
C4: move REAL test USD₮ on Sepolia through WDK, behind every gate. PRD §10; threat-model D (55–74) + Gate 3/5; keys on EDGE only.

On the Edge node: using the WDK setup proven in P0 —
- define PaymentIntent { to, amount (minor-units), token, chainId, invoiceRef, memo } in packages/shared;
- on a PASS verdict, build the intent (recipient from the DB known_wallet, NOT the invoice);
- Gate 3: re-check intent.to === DB.known_wallet in plain code before signing;
- Gate 4: require explicit human approval;
- send via WDK's real USD₮ transfer method (verified in P0), pinned chainId + token address, exact amount, MEV-protected RPC, wait N confirmations;
- write the settlements row (UNIQUE invoice_ref — reject duplicates), record tx hash + explorer link.

Prove: a clean verified invoice → a real Sepolia tx hash you can open in the explorer; a poisoned invoice (from C-sec) → blocked, no send. Update remote_apis.json with the Sepolia RPC (+ WDK indexer if used) as non-AI. Then STOP.
```

---

## C5 — Edge UI (barebones, end-to-end)

```text
C5: a minimal local UI on the Edge node. PRD §6 step 5; keep it barebones — correctness over polish.

Flow: drop an invoice → live status stream (delegating… extracting… verifying…) → verified summary card ("Vendor verified · PO matched · wallet confirmed · stage N USD₮") → Approve button → receipt with tx hash + explorer link. On REJECT, show the reason and the gate that blocked it. No browser storage; in-memory + the SQLite/evidence files. Run the full happy path through the UI on a clean invoice and show it. Then STOP.
```

---

## C6 — Evidence + logging (survive the 3-stage review)

```text
C6: make the evidence bundle airtight. PRD §12; threat-model H (#99–100).

- A logging wrapper around EVERY QVAC call: append {ts, node, delegated, model, op, prompt_tokens, completion_tokens, ttft_ms, tok_per_sec, event} to evidence/inference-log.jsonl, mirrored to .csv. Use the profiler's real numbers (field names locked in P0) — never hand-write.
- Finalize remote_apis.json: enumerate all remote calls (only non-AI: Sepolia RPC, optional WDK indexer) + an explicit assertion that inference is 100% local QVAC.
- evidence/hardware/: add system-profiler screenshots for both Macs + specs.md (CPU/GPU/RAM/storage).
- Finalize README so a judge can run it out-of-the-box on the declared hardware; confirm LICENSE is Apache-2.0.

Do a full standard demo run end-to-end and show that the log is complete and internally consistent (loads/unloads, delegated rows, TTFT/tok-s). Then STOP.
```

---

## C7 — Ship gate (video + submit before early bird)

```text
C7: final dry run + submission. PRD §14 C7; target submit before the early-bird cutoff (June 16 EOD).

- Full end-to-end on both Macs: P2P handoff visible, an adversarial invoice rejected (show a Grade, e.g. Morse), and a real test USD₮ settlement with explorer link.
- Record the ≤5-min unlisted-YouTube demo with terminals visible so the P2P delegation and the audit log are on screen.
- Verify the evidence bundle is complete (log, remote_apis.json, hardware, README, LICENSE) and the repo is public + Apache-2.0.
- Walk me through the DoraHacks submission fields (name Custos, team Tim + Anu, track General Purpose + Build in Public, hashtag, repo + video links).

Then STOP and give me a final submission checklist.
```