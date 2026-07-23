# Custos — pre-pitch fix pass

Working log for the audit remediation run of **2026-07-23**, the night before the
Tether finalist pitch (Fri 2026-07-24). One section per step. Raw command output for
each step lives beside this file as `stepNN-<name>.txt`.

Ground rules held throughout: no fabricated output, no edits or back-fills to
`evidence/inference-log.jsonl`, one step at a time, revert anything that breaks the
demo path.

---

## Step 1 — Close the LAN-exposed approve endpoint

**Status: DONE.** Verified by observed output.

### Why

`POST /api/approve` ([server.ts:204-214](../../packages/edge/src/server.ts#L204-L214)) takes a
`jobId`, and on a match calls `settleIntent(..., approve: true, ...)` — the `approve` flag is
hard-coded, there is no authentication, and the hold-to-authorize gesture that represents
Gate 4 is client-side only ([dash.js:192-200](../../packages/edge/ui/dash.js#L192-L200)).
The server bound every interface, so on venue WiFi with a funded seed loaded, anyone on the
same LAN who guessed a `jobId` could broadcast a real USD₮ transfer.

I confirmed the exposure was live rather than theoretical (see raw output below):
with the pre-fix binding, `POST http://192.168.0.133:4173/api/approve` from the LAN address
answered `{"error":"unknown or expired job"}` / HTTP 404. That is the *jobId-not-found*
branch — **not** the `Demo mode — set CUSTOS_WALLET_SEED…` branch that guards the top of the
handler. So the wallet seed was loaded and the only thing standing between a LAN attacker and
a real signed transfer was guessing a v4 UUID.

### What changed

`packages/edge/src/server.ts`, two hunks:

| Lines | Change |
|---|---|
| 22-25 | Added `const HOST = process.env.HOST ?? "127.0.0.1";` with a comment stating why |
| 253-256 | `server.listen(PORT, …)` → `server.listen(PORT, HOST, …)`; boot banner now prints the bind address, and prints a `⚠ REACHABLE FROM THE NETWORK` warning if `HOST` is overridden to anything non-loopback |

Before:

```js
server.listen(PORT, () => {
  console.log(`\n  CUSTOS · Edge console  →  http://localhost:${PORT}\n  (Ctrl+C to stop)\n`);
});
```

After:

```js
server.listen(PORT, HOST, () => {
  const scope = HOST === "127.0.0.1" || HOST === "localhost" ? "loopback only — the approve endpoint holds the wallet" : "⚠ REACHABLE FROM THE NETWORK — /api/approve signs real transfers";
  console.log(`\n  CUSTOS · Edge console  →  http://localhost:${PORT}\n  bound to ${HOST} (${scope})\n  (Ctrl+C to stop)\n`);
});
```

The `HOST` env escape hatch is kept deliberately: the two-machine mesh setup needs a
non-loopback bind, and it now announces the risk instead of doing it silently. The demo
default is loopback.

### Commands run

```
npm run typecheck
HOST=0.0.0.0 node packages/edge/src/server.ts   # reproduces the OLD behaviour exactly
node packages/edge/src/server.ts                # NEW default
lsof -nP -iTCP:4173 -sTCP:LISTEN
curl http://127.0.0.1:4173/api/samples
curl http://192.168.0.133:4173/api/samples
curl -X POST -d '{"jobId":"guessed"}' http://192.168.0.133:4173/api/approve
```

Full raw output: `step01-bind-loopback.txt`.

### Result

| Check | Before (`HOST=0.0.0.0`) | After (default) |
|---|---|---|
| `lsof` listen address | `TCP *:4173 (LISTEN)` | `TCP 127.0.0.1:4173 (LISTEN)` |
| `GET /api/samples` from `127.0.0.1` | 200 | 200 |
| `GET /` (dash UI) from `127.0.0.1` | 200 | 200 |
| `GET /api/samples` from `192.168.0.133` | **200 — full JSON body returned** | **curl exit 7, connection refused** |
| `POST /api/approve` from `192.168.0.133` | **404 `unknown or expired job` (reached the handler; seed was loaded)** | **curl exit 7, connection refused** |

`npm run typecheck` → exit 0.

**PASS.** The demo path is untouched — the UI and all APIs answer normally on loopback,
which is where the pitch is driven from.

### Not verified programmatically

- I proved refusal from this machine's own LAN address (`192.168.0.133`), which exercises the
  same kernel path a second host on the WiFi would hit, but I did not curl from a physically
  separate machine. If you want belt-and-braces, from the Intel Mac run
  `curl -m 5 http://192.168.0.133:4173/api/samples` while the M1 serves — expect
  `Connection refused`.
- No UI screenshot for this step; the change is transport-level and the `GET /` 200 above is
  the meaningful signal.

### MANUAL CHECK (30 seconds, worth doing before the pitch)

1. `npm run serve` on the M1.
2. Confirm the banner reads `bound to 127.0.0.1 (loopback only — …)`.
3. Open `http://localhost:4173/` — the dash should load exactly as before.

---

## Step 2 — Demo-safety trio (settlement correctness)

**Status: DONE.** All three sub-fixes verified against real money on Sepolia.
**Also surfaced a pre-existing demo-breaking bug the audit missed — see "Finding X1" below.**

### (a) ETH gas pre-flight

`settle.ts:49-53` checked USD₮ only. A wallet flush with USD₮ and empty of ETH would fail deep
inside the WDK signer mid-demo, landing in the generic 500 handler.

Changed `packages/edge/src/settle.ts:52-73`:
- Both balance reads (`getTokenBalance`, `getBalance`) are wrapped so an unreachable RPC gets
  its own named failure — *"Couldn't read the wallet balance — the Sepolia RPC didn't respond.
  Nothing was sent."* — instead of throwing into the 500 catch. This was your explicit condition 2.
- Gas requirement is computed live: `eth_gasPrice × 65_000 gas × 2` headroom, falling back to a
  0.0005 ETH floor only if `eth_gasPrice` is unreachable. Not a magic number.
- Added `eth()` wei→ETH formatter trimmed to 6 decimals; the raw 18 (`0.00013823047459`) are
  unreadable on a shared screen.

**Proof** — `evidence/pitch-fixes/step02-preflight-test.ts`, run against the REAL WDK wallet and
REAL Sepolia RPC (no mocks). The throwaway hardhat seed holds 0 ETH / 0 USD₮, confirmed by
`step02-probe-balances.ts`. Requesting 0 USD₮ passes the USD₮ check (`0 >= 0`) and so reaches the
gas branch — that is how the branch is entered through production code:

```
[A · 1 USD₮ requested, wallet has none]
  status : BLOCKED
  reason : Not enough USD₮ — the wallet holds 0 but this invoice needs 1. Nothing was sent.
  txHash : (none — nothing was broadcast)

[B · 0 USD₮ requested, so execution reaches the ETH-gas check]
  status : BLOCKED
  reason : Not enough ETH for gas — the wallet holds 0 ETH but needs about 0.00013 to send this
           transfer. Top up 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 from a Sepolia faucet.
           Nothing was sent.
  txHash : (none — nothing was broadcast)
```

### (b) False SETTLED — **I diverged from the literal instruction; please read**

You said *"bail before recording if confirmations < required."* I implemented the honesty
requirement in full — **`settled` is now unreachable below the required confirmations** — but I
moved `recordSettlement` *earlier* (to immediately after broadcast) rather than skipping it.

Reason: the **broadcast** is the irreversible act, not the confirmation. `settlements.invoice_ref`
is UNIQUE and is what `isDuplicateInvoice` reads, so it is the only thing preventing the same
invoice being paid twice. Bailing without recording would leave a ~4-minute window in which an
unconfirmed-but-broadcast invoice could be approved again and **paid a second time** — the exact
hazard (c) exists to close, just sequential instead of concurrent. Recording at broadcast states
something strictly true ("this invoice_ref was sent, here is the hash") and closes that window.

So `settle.ts:88-124` now:
- records at broadcast (comment explains why),
- returns a new `"pending"` status when `confirmations < need`, carrying the hash, the explorer
  URL, the real confirmation count and the real elapsed seconds,
- returns `"reverted"` on receipt status 0, leaving the row in place and saying so in the reason.

**On revert I deliberately did not write rollback logic.** A revert would mean the row blocks a
legitimate retry, so the reason text says to clear it manually. I can't force a revert on Sepolia
to test rollback code, and untested recovery code touching real money the night before a pitch is
worse than a documented manual step. Flagging it as a known gap.

`SettleResult.status` gained `"pending"`; `dash.js` renders it with a **BROADCAST · UNCONFIRMED**
pill (never the SETTLED pill) and does not re-arm the hold button, since funds are committed.

### (c) Double-pay window

`handleApprove` ignored the busy lock entirely. Added `settlingJobId` (`server.ts:32`) and a guard
at `server.ts:216-219`. There are **no `await`s between reading the body and setting the flag**, so
the check-and-set is atomic with respect to the event loop — no TOCTOU. One wallet, one nonce, one
send at a time. Jobs are now deleted on `pending` as well as `settled`, since both committed funds.

### (d) Failure reasons (your correction to the audit)

Fixed server-side as agreed, not client-side:
- `server.ts:208` unknown/expired job — now carries a readable `reason` alongside `error`.
- `server.ts:255-259` the 500 catch — now `console.error`s full detail (with method + URL) to the
  terminal and returns a readable sentence. It deliberately does **not** claim "nothing was sent":
  an approve that threw there may or may not have broadcast, so it says *"check the explorer before
  authorizing it again."* Overclaiming safety would be the same class of error as a false SETTLED.

### Commands run

```
npm run typecheck                                            # exit 0 (run 3x across edits)
node evidence/pitch-fixes/step02-probe-balances.ts           # real balances
node evidence/pitch-fixes/step02-preflight-test.ts           # (a) both branches
node evidence/pitch-fixes/step02-concurrent-approve-test.ts  # (b)+(c) live, real money
node evidence/pitch-fixes/step02-samples-regression.ts       # 4-sample regression
```

Raw output: `step02-settlement-safety.txt`.

### Live concurrent-approve result — the headline proof

Funded wallet `0x5C6C…Be13`, 0.042824 ETH / 4990.00 USD₮. Two approves fired concurrently on the
same jobId:

```
  [approve #2] HTTP 409 after 32ms
     status : blocked
     reason : This invoice is already being settled — one moment.
     txHash : (none — nothing broadcast)

  [approve #1] HTTP 200 after 32695ms
     status : settled
     reason : ok
     txHash : 0xeb7d8299183abf8e4fd0250ea6dfb7778bce7c2fabefa4ee00d5dd9d1d8b0adf
     confirmations : 2

  [approve #3, after settlement] HTTP 404 after 2ms
     reason : This invoice is no longer awaiting approval — it was already settled, or the
              console restarted. Re-run the verification.
```

**On-chain confirmation that only one transfer happened:** USD₮ balance went
`4990000000 → 4989000000`, i.e. exactly 1.00 USD₮. The second approve moved nothing.
Etherscan: https://sepolia.etherscan.io/tx/0xeb7d8299183abf8e4fd0250ea6dfb7778bce7c2fabefa4ee00d5dd9d1d8b0adf

Inference log gained exactly two rows for this tx (`settle-broadcast`, `settle-confirmed conf=2`).
`git diff --numstat` on the log: **11 added, 0 removed** — append-only intact, nothing rewritten.

### PASS/FAIL

| Sub-fix | Result |
|---|---|
| (a) USD₮ branch | PASS — observed |
| (a) ETH gas branch | PASS — observed, named itself, no 500 |
| (a) RPC-unreachable branch | **NOT FORCED** — see below |
| (b) never SETTLED below required confirmations | PASS — settled only at conf=2 |
| (b) `pending` path | **NOT FORCED** — see below |
| (c) concurrent double-pay | PASS — 409 in 32ms, zero second broadcast, on-chain verified |
| (d) readable reasons | PASS — observed on 404 path |
| typecheck | PASS — exit 0 |

### Not verified programmatically

1. **The RPC-unreachable branch was not forced.** `openEdgeWallet` puts `SEPOLIA_RPC_URL` first but
   keeps two public fallbacks, so WDK fails over and the branch is unreachable without editing
   production code. The code path is straightforward (`try` around two awaits) but I did not see it
   execute. Stated as unproven rather than claimed.
2. **The `pending` branch was not forced.** Sepolia confirmed in ~32s, well inside the 240s window.
   Forcing it would mean raising the confirmation requirement artificially. The logic is a plain
   `confirmations < need` comparison on the same counter that produced the verified `conf=2`, but I
   did not observe the branch fire. The **BROADCAST · UNCONFIRMED** pill is therefore also unrendered
   and unscreenshotted.
3. **No UI screenshots.** No headless browser is installed and I did not install one offline. See
   the manual checks below.
4. **The revert path** — cannot be triggered on demand; no rollback logic written (deliberate, above).

### MANUAL CHECK

1. `npm run serve`, load a clean invoice, hold to authorize → expect the gold **SETTLED** pill,
   2 confirmations, and a working Etherscan link.
2. During the ~30s settle, open a second tab on `http://localhost:4173/` — you cannot re-approve
   the same job from there because the job is per-jobId and the guard is server-side. (Proven by
   script above; listed here only if you want to see it by hand.)
3. After settling, the receipt card should be the only one; no duplicate card appears.

---

## Finding X1 — PRE-EXISTING: sequential verifies die on a context-window overflow

**This is the most serious thing I found tonight and the audit did not mention it. It will bite you
on stage.** It is not caused by Step 2 — I proved that by stashing.

Running the four UI samples back to back **in one server process**, the 3rd or 4th verify fails:

```
status  : ERROR
reason  : prompt exceeds the model's context window for model "70969eb22b374ebe".
          Reduce the prompt size or start a new conversation.
elapsed : ~110s  (vs ~25s for a healthy verify)
```

Evidence it is pre-existing, not mine — identical sequence, with my Step 2 changes stashed:

| Run | Code | ui-clean | ui-fraud | ui-injection | ui-amount |
|---|---|---|---|---|---|
| A | with Step 2 | PASS 27s | PASS 28s | PASS 25s | **ERROR 110s** |
| B | Step 2 stashed | PASS 23s | PASS 24s | **ERROR 113s** | PASS 24s |

The failure **moves between samples across runs**, so it is not sample-specific — it is cumulative
process state. `ui-amount` alone on a fresh server passes in 21.5s (`BLOCKED`, gate G2, correct).
Note in run B the call *after* the failure succeeded, so the overflow appears to self-clear.

Likely cause: `extract.ts:74-88` loads the vision model with `ctx_size: 8192` and unloads with
`clearStorage: false` on every verify. If the SDK is reusing a cached model instance whose KV
cache/conversation state survives the unload, the effective prompt grows every call until it
overflows, then resets. That is exactly the territory of **Step 11** (model cache + warm-up, and
the missing `try/finally` in `extract.ts`).

**Impact on tomorrow: you plan to show a clean invoice AND a fraud invoice — that is 2 verifies,
which is inside the safe window. A third (e.g. the injection sample during Q&A) is roughly where it
breaks.**

Zero-cost mitigation available right now: **restart `npm run serve` between demo segments**, or keep
a session to at most 2 verifies. I have not changed any behaviour here — flagging for your call on
whether to promote Step 11 ahead of Tier 1.

---

## Finding X1 — diagnosis (timeboxed, no production change kept)

**Status: root cause CONFIRMED. No fix applied. `extract.ts` reverted to the committed value;
`git diff` on it is empty and typecheck is clean.**

Raw evidence: `stepX1-context-overflow-diagnosis.txt`.

### The proposed test would have deleted the model weights — I did not run it

`clearStorage` is **not** a context reset. It is a disk cache-eviction flag
(`@qvac/sdk/dist/server/bare/ops/unload-model.js`):

```js
if (clearStorage && entry.local.path) {
    const target = getClearStorageTarget(modelPath);
    await fsPromises.rm(target.path, { recursive: target.kind === "directory", force: true });
    logger.info(`Model storage cleared (${target.kind}): ${target.path}`);
}
```

and `paths.d.ts:30` confirms it: *"Returns the deletion target for `clearStorage`. Scoped to the
SDK cache directory — companion set and legacy ONNX paths delete the parent directory."*

Flipping it would have `rm`'d Qwen3-VL-2B out of the local model cache and forced a re-download
the night before the pitch. This is the CLAUDE.md "never guess an API" rule earning its keep.

Note also that the same function calls `entry.local.model.unload()` and `unregisterModel(modelId)`
**unconditionally** — so the model genuinely is released each cycle. That kills the "unload isn't
really unloading" premise independently.

### Your reasoning about Step 11 was right, for a stronger reason than either of us had

You said a resident cache would preserve the very state that accumulates. It's worse than that:
the SDK-session KV cache **isn't involved at all** in our path. `completion` takes an undocumented
`kvCache?: boolean | string`; `extract.ts` never passes it, so the plugin takes the explicit
disabled branch (`completion-stream.js:292`):

```js
if (!kvCache) {
    // KV-cache disabled — straight passthrough, no session involvement.
    logCacheDisabled();
    logMessagesToAddon(transformedHistory, "NO_CACHE");
```

So Step 11 would have been built on a false model of the failure either way.

### What is actually happening — confirmed by prediction, not by guess

The existing inference log (untouched) shows healthy vision completions are **flat at ~2780 prompt
tokens** against `ctx_size: 8192` — 3× headroom, so one prompt cannot overflow on its own. Failing
verifies log a normal OCR row (`blocks=15`, `blocks=19`) and then no completion row.

That yields a falsifiable prediction: if context is consumed cumulatively at ~2780/call, the
overflow point must scale linearly with `ctx_size`.

| `ctx_size` | Predicted failure | Observed failure |
|---|---|---|
| 8192 | call 2.95 → 3–4 | call 4 (run A), call 3 (run B) |
| 16384 | call 5.89 → 6 | **call 6** |

Eight sequential verifies at 16384: calls 1–5 pass (21–24s each), call 6 ERRORs, call 7 passes
again. **Confirmed: context accumulates across verifies within one server process, ~2780 tokens per
verify, and the load/unload cycle does not release it. The overflow self-clears afterwards.**

### The trade-off you need to know before choosing a mitigation

Doubling the window buys headroom but makes the eventual failure **much worse**:

| `ctx_size` | Safe verifies per process | Failure mode |
|---|---|---|
| 8192 (current) | ~2–3 | ~110s hang |
| 16384 | ~5 | **~291s hang (nearly 5 minutes)** |

I therefore did **not** keep the 16384 change. A 5-minute dead screen mid-pitch is a worse outcome
than the thing it prevents, and the real protection is procedural.

### Recommendation

**Runbook, not code.** Restart `npm run serve` between demo segments. Your planned demo is 2
verifies (clean + fraud), comfortably inside the safe window at the current 8192. If a judge asks
for a third and fourth sample in Q&A, restart first — it takes seconds.

Step 11 should be reconsidered from scratch later, on the confirmed mechanism: the leak is inside
the llamacpp completion plugin's context handling across load/unload within a process, not in the
SDK session layer and not in anything a userland cache would fix.

---

## Step 3 — Preflight + reset tooling

**Status: DONE.** Both scripts written, run, and observed passing.

Raw output: `step03-preflight-reset.txt`.

### What was added

| File | Purpose |
|---|---|
| `scripts/preflight.ts` | Fail loudly *before* the pitch instead of mid-demo |
| `scripts/demo-reset.ts` | Clean slate between rehearsals |
| `package.json` | `npm run preflight`, `npm run demo:reset` |

### `npm run preflight` — exit 0

```
[1] wallet seed
  PASS  CUSTOS_WALLET_SEED                     present in .env (value never printed)
[2] chain + funds
  PASS  signer address                         0x5C6C9e12D49e28670E00AD1C05f24243ad77Be13
  PASS  Sepolia RPC                            https://ethereum-sepolia-rpc.publicnode.com · chainId 11155111 · block 11336507
  PASS  USD₮ balance                           4989 USD₮ (4989000000 minor units)
  PASS  ETH for gas                            0.04277549 ETH · one send costs ~0.00013280 · floor 0.00039841 (3 sends)
[3] model weights present locally
  PASS  cache dir                              /Users/mac/.qvac/models
  PASS  detector_craft.onnx                    79 MiB
  PASS  recognizer_latin.onnx                  15 MiB
  PASS  Qwen3VL-2B-Instruct-Q4_K_M.gguf        1056 MiB
  PASS  mmproj-Qwen3VL-2B-Instruct-Q8_0.gguf   424 MiB
[4] warm load + unload (real QVAC, logged to the audit trail)
  PASS  OCR (CRAFT + Latin)                    loaded + unloaded in 1433ms (local)
  PASS  Vision (Qwen3-VL-2B)                   loaded + unloaded in 2738ms (local)

PREFLIGHT OK — safe to demo.
```

Design notes:
- The **seed value is never printed** — only its presence. This output is safe to screen-share.
- The ETH floor is not a magic number: it is `eth_gasPrice × 65_000 × 2 × 3 sends`, sized off live
  gas so a rehearsal plus the live demo both fit. It reports what one send actually costs.
- The chain id is asserted against the pinned `CHAIN.id`, so a wrong RPC is caught rather than
  silently used.
- **Model presence is proven twice**: the weight files are listed off disk with sizes, *and* each
  model is warm-loaded and unloaded through the real audit wrappers. A cold download of a 1 GiB
  GGUF takes minutes, so a 2.7s load is itself the evidence it came off local disk. The check fails
  if a load takes >60s, i.e. if it looks download-shaped.
- The success banner carries the **X1 runbook reminder** (restart between segments), so the finding
  lives in the tool you actually run rather than only in a report.
- Warm-loading appends `loadModel`/`unloadModel` rows to the inference log. That is required by
  Hard Rule 6 and is append-only.

### `npm run demo:reset` — exit 0

```
  uploads   cleared 5 .png file(s) from data/uploads
  erp       re-seeded /Users/mac/custos/data/erp.db
            cleared 0 prior settlement row(s)
            now: 3 vendors · 4 purchase orders · 0 settlements
  evidence  untouched (the inference log is append-only ground truth)
```

("0 prior settlement rows" is honest — a server restart had already re-seeded since the Step 2
settle. The counter reports whatever it actually cleared.)

**Verified the log is untouched by reset:** row count before `473`, after `473`.
`data/uploads/` went from 5 files to 0. Sample invoices in `data/sample` are inputs, not state,
and are deliberately left alone.

### PASS/FAIL

| Check | Result |
|---|---|
| typecheck | PASS — exit 0 |
| `npm run preflight` | PASS — exit 0, all 13 checks pass |
| `npm run demo:reset` | PASS — exit 0 |
| reset leaves inference log untouched | PASS — 473 rows before and after |
| reset clears uploads | PASS — 5 → 0 |

### Not verified programmatically

- **No failure-path run of preflight.** Every check passed on the first try, so I did not observe a
  `FAIL` line or the non-zero exit in anger. The gas/USD₮ comparisons are the same arithmetic proven
  in Step 2(a) against the empty wallet, but the preflight-specific failure output is unexercised.
- **The >60s "download-shaped" guard is unexercised** — the weights are all present, and I was not
  going to delete one to test it.

---

## Step 4 — Honesty sweep (docs + UI)

**Status: DONE.** Every claim below was re-verified against the code or the log *before* the line
was touched. Falsification grep at the end shows zero hits for every removed phrase.

Raw output: `step04-honesty-sweep.txt`.

### Ground truth established first

| Fact | How verified | Result |
|---|---|---|
| Delegated rows in the log | `grep -c '"delegated":true'` | was **0**, now **1** (see below) |
| Intel/x64 rows in the log | `grep -c 'darwin/x64'` | **0** |
| Relay docs location | `ls relay/` | `relay/README.md` exists (audit was right, the c1-report pointer was wrong) |
| Hard-stop sentences | `consumer.ts:76-88` | confirmed verbatim — **kept unchanged everywhere** |
| RAG dead in app path | `server.ts:30` seeds without embed, `server.ts:122` passes `undefined`, `erp.ts:135` is `if (embed)` | confirmed inert |
| Vault status dot | `grep vaultStat packages/edge/ui/*.js` | **no JS references** — hard-coded green dot, genuinely fake |
| `npm run c1:demo` | ran it | **audit was wrong** — see below |

### The audit was wrong about `c1:demo`, and it mattered

The audit said c1:demo "currently FAILS". It exits `❌ C1 LOCAL INCOMPLETE`, but the scorecard is:

```
provider identity (stable, pinnable key) ... ✅
(b) heartbeat detects offline ............... ✅
(c) fallbackToLocal degraded + auto-block ... ❌
(a) TRUE delegated round-trip .............. ✅
```

**Check (a) — the delegated round-trip — passes.** Check (c) asserts `degradedMode=true`, an
expectation written *before* the consumer moved to `fallbackToLocal: false`. Under the current
hard-stop design `degradedMode` can never be true, so the observed
`delegated=false degradedMode=false autoSettleBlocked=true providerOnline=false` is the **correct
modern behaviour**. The scorecard is stale, not the code. I documented that rather than "fixing"
either one.

**This run also captured Step 5's deliverable as a side effect** — the log's first `delegated:true`
row, written through the normal audit wrapper, never hand-edited:

```json
{"ts":"2026-07-23T22:21:20.777Z","node":"edge","op":"completion","model":"LLAMA_3_2_1B_INST_Q4_0",
 "delegated":true,"provider_public_key":"d04ab232…8737","load_ms":1427,"ttft_ms":316.886,
 "tok_per_sec":53.311,"backend_device":"gpu","platform":"darwin/arm64","metrics_source":"profiler-raw"}
```

`platform: darwin/arm64` on both sides — **one host, two processes.** It proves the delegation
path, not cross-machine transport.

### Every claim changed — before → after

| File:line | Before | After |
|---|---|---|
| `README.md:76` | "two machines, one job" / table column **Machine** | "two node roles, one job" / column **Node role** |
| `README.md:85` | Edge "**sends every AI task** to the Orchestrator over the encrypted P2P link" | "**by design it delegates** AI work over the encrypted P2P link" |
| `README.md:87-90` | "the Intel machine **delegates every inference to the M1**" | removed; hard-stop sentence **kept verbatim**, now cites `consumer.ts` |
| `README.md:92-94` | "the two-machine split is the 'your nodes can be anywhere' story, **proven across networks via a self-hosted relay**" | new **"Where the mesh actually stands"** section: designed + coded, round-trip proven **single-host** and logged, **cross-machine over hostile NAT is the pending step**, demo runs consolidated on one Mac |
| `README.md:150-155` | "### 5) The real two-machine version … The Edge delegates every AI task to the M1 … (including the cross-network relay setup): evidence/c1-report.md" | "### 5) The delegated path (two node roles, currently one host)" … relay pointer corrected to **`relay/README.md`** |
| `README.md:164` | "the **constrained Intel machine offloads inference to the M1** over encrypted P2P" | "QVAC-native delegation over an encrypted P2P link, **proven single-host and logged as `delegated:true` (cross-machine transport pending)**" |
| `ARCHITECTURE.md:25-27` | "The C1 demo … **proves the delegated round-trip** and the offline hard-stop" | "proves the offline hard-stop, and proves the delegated round-trip **on a single host**… transport step still pending" |
| `evidence/hardware/specs.md:35-38` | "…not staged; **the inference log shows the CPU→Metal offload**" + "Llama-3.2-1B routing" in the role line | claim removed; added an explicit block: log has **no `darwin/x64` rows**, the one delegated row is `darwin/arm64` on both sides, **CPU→Metal offload remains unmeasured** |
| `Custos-PRD.md:6` | (no status marker) | **one dated banner** marking it the original design spec, with a 4-row table of PRD-says vs actually-today (mesh, Edge routing, RAG, "air-gapped") |
| `DEMO_SCRIPT.md:18-19` | "`npm run c1:demo` for the P2P delegation **across two machines**" | corrected: two processes on one host, (a) passes / (c) stale, "don't put it on camera without that explanation" |
| `SUBMISSION_CHECKLIST.md:18` | "**102 rows**" | "**480 rows as of 2026-07-23** … append-only, count grows every run, check the file rather than trusting this number" |
| `SUBMISSION_CHECKLIST.md:51` | "the **Intel Mac delegates Qwen3-VL to the M1** over an E2E link" | redrafted: hard-stop consumer delegates, `delegated:true` profiler-raw in the log, **"proven single-host; cross-machine transport is the next step"** |
| `THREAT-MODEL.md:17` | "local-only console" | "console binds **`127.0.0.1` only**… one settlement in flight at a time" (now true, post Step 1 + 2c) |
| `THREAT-MODEL.md:24` | "`fallbackToLocal` never auto-settles (#82)" | "consumer sets `fallbackToLocal: false` and **hard-stops**… no degraded path to mis-settle from" |
| `THREAT-MODEL.md:15` | "RAG suggests only" | "…and in the shipped server it is **inert**: the app seeds without embeddings, so the KNN branch never runs" |
| `THREAT-MODEL.md:36` | "P2P (75–84): `npm run c1:demo`" | same pointer + what actually passes/fails and why |
| `SECURITY.md:29` | "`sqlite-vec` RAG only *suggests*" | "…**inert in the shipped server**… exercised in `npm run c3:demo`" |
| `SECURITY.md` G4 row | "explicit hold-to-authorize. No `.env` → stops here" | + "binds **`127.0.0.1` only**… one settlement in flight at a time" |
| `Custos-Threat-Model.md:161` | "#82 … degraded mode NEVER auto-settles; flagged low-confidence \| MVP" | "**superseded, and stronger:** … hard-stops, so no degraded local path exists to downgrade *to*" \| **HARD** |
| `ui/index.html:184-185` | "**A two-node mesh** … The machine that thinks never holds a key; the machine that holds keys never runs the model." | "**Two node roles, separable by design**" … "proven with both roles on one host — running them on separate machines is the pending step. What you are running here is the consolidated single-Mac build." |
| `ui/index.html:93` | "only the Edge — **never the inference machine** — can sign" | "signing authority lives only in the **key-holding role** — never in the code that runs the model" |
| `ui/index.html` (6, 28, 36, 199) + `dash.html` (7, 13, 59, 80) | "Air-gapped" badges/titles | **"Zero cloud AI"** — the claim the log actually proves. Zero `air-gapped` strings remain in any served HTML. |
| `ui/index.html:51` | "on one machine" | **unchanged** — accurate, kept as instructed |
| `ui/dash.html:79` | `class="stat stat-ok stat-vault"` with `<i></i>` → hard-coded green dot no JS ever sets | `stat-ok` and `<i></i>` removed + comment: *"nothing polls the orchestrator, so a green 'live' indicator would be decoration, not state"* |
| `evidence/c1-report.md` | (not rewritten) | **dated addendum appended** capturing the `c7da4db` fix, the re-run, the new log row, and an explicit "what this does and does not prove" |
| `evidence/c6-report.md:30` | "**Log to date:** 102 rows" | "**Log at the time of C6 (2026-06-21):** 102 rows" + dated addendum pointing at the current count |

### Falsification grep — zero hits

```
  "proven across networks"                             0 hit(s)
  "sends every AI task"                                0 hit(s)
  "delegates every inference"                          0 hit(s)
  "constrained Intel machine offloads"                 0 hit(s)
  "the inference log shows the CPU→Metal offload"      0 hit(s)
  "Llama-3.2-1B routing, P2P"                          0 hit(s)
  "the Intel Mac delegates Qwen3-VL"                   0 hit(s)
  "102 rows"                                           0 hit(s)   (after dating it)
  "proves the delegated round-trip and the"            0 hit(s)
  "local-only console"                                 0 hit(s)
  "the machine that thinks never holds a key"          0 hit(s)

=== 'air-gapped' remaining in any .html ===  none
```

The hard-stop sentence is still present verbatim in `ARCHITECTURE.md:24`, `README.md:88`,
`Custos-PRD.md:185`, `Custos-Threat-Model.md:161` and `CLAUDE.md:35`, as instructed.

### Regression — nothing broke

```
GET /        http_code=200 bytes=6856
GET /landing http_code=200 bytes=14437
served dash vault chip: <span class="stat stat-vault" id="vaultStat"><span>Vault · on-device</span></span>
served chips: "Zero cloud AI", "Zero cloud AI · on-device"
air-gapped occurrences in served HTML: 0
[ui-clean] 22933ms status=VERIFIED   ← demo path intact
```

`npm run typecheck` → exit 0.

### Not verified programmatically

- **No UI screenshots** (no headless browser). The served-HTML greps above confirm the markup
  changed and renders as served, but I have not *seen* the pages.
- **Only `ui-clean` was re-run** post-edit rather than all four samples. Step 4 touched no verify
  code, and the X1 ceiling makes a 4-sample run in one process unreliable. The full 4-sample pass
  is in the final rehearsal.
- **Transport for the delegated row** (relay vs direct holepunch) could not be attributed from the
  output for a same-host connection. Stated as unknown in the c1-report addendum rather than guessed.

### ⚠ NEEDS YOUR ANSWER — the build-in-public post

`SUBMISSION_CHECKLIST.md:51` contained *"QVAC P2P bridge live: the Intel Mac delegates Qwen3-VL to
the M1 over an E2E link."* **That never happened** — the Intel has never produced a logged inference
row, and Qwen3-VL was never delegated (the delegated model is Llama-3.2-1B). The draft in the repo
is now redrafted, but **if that text was ever actually posted to X, the redraft is not the whole
fix.** Only you can check the timeline. If it went out, the clean move is a short follow-up
correcting it before the pitch — a public correction reads as rigour; being caught reads as the
opposite.

---

## Step 6 — Remove the replay-mode hazard

**Status: DONE.** Deleted, with more removed than the audit asked for.

Raw output: `step06-remove-replay-mode.txt`.

### What was deleted

| File | Removed |
|---|---|
| `dash.js` | `runDemoVerified` / `runDemoBlocked` / `runDemoChat` / `runDemo` (65 lines), the `DEMO_GATES_VERIFIED` + `DEMO_GATES_BLOCKED` fabricated ladders (16 lines), and the `?demo=` dispatch — replaced with a plain `renderIntro()` |
| `dash.css` | the 4 dead `.demo-full` rules |
| **`app.js`** | **the entire `?preview=` hook (42 lines)** — see below |

`dash.js` 541 → 459 lines. `app.js` 383 → 341 lines.

### The audit under-scoped this one

The audit pointed at `dash.js:445-508`. Grepping after that deletion surfaced a **second, equally
dangerous path** on the legacy landing page — `app.js:366` fabricated the *same* receipt with the
*same* real transaction hash:

```js
renderReceipt({ status: "settled", confirmations: 2,
  txHash: "0xa3ed0f33fcfa685287185284079884c0ea0c3a260149443bfd945f083f79cd30",
  explorerUrl: "https://sepolia.etherscan.io/tx/0xa3ed0f33…" });
```

That hash is a **genuine past settlement**, which makes it worse, not better: the replay presented
a real, verifiable, Etherscan-resolvable transaction as though the run in front of you had produced
it. A reviewer clicking through would have found a legitimate on-chain transfer confirming a run
that never happened. Both paths are gone.

Also removed with it: hard-coded `balance.textContent = "3.50 USD₮"`, a fake signer address
`0x90F8bf…DA62A8`, a fake inbox count, and pre-written "reasoning" lines with invented timings.

### Verification

```
residue across ALL of packages/edge/ui:  NONE
  (no `demo=`, no `preview=`, no `0xa3ed0f33`, no DEMO_GATES, no runDemo)

GET /         http_code=200
GET /landing  http_code=200
fabricated tx in ?demo=settled response:     0
fabricated tx in ?preview=receipt response:  0
```

The old URLs are now inert — they render the normal application. Clean-URL run after deletion:
`ui-clean → VERIFIED (22.5s)`, `ui-fraud → BLOCKED at G3 (25.4s)`. `typecheck` exit 0.

---

# FINAL PASS

Raw output: `final-pass.txt`.

## Full rehearsal — the demo path, driven exactly as it will be tomorrow

```
[1] clean invoice
    21964ms → VERIFIED
[2] hold to authorize → REAL settlement
    23054ms → SETTLED
    txHash        : 0x54e58aef71c9f0358938a2d83873d1e0f643637cd2c4f5d489e2665b3232b68b
    confirmations : 2
    explorer      : https://sepolia.etherscan.io/tx/0x54e58aef…b68b
[3] fraud invoice — must block at G3, nothing sent
    21638ms → BLOCKED at G3
    reason : wallet check failed — provided wallet does not corroborate DB known_wallet (drift 38)

REHEARSAL PASS
```

USD₮ `4989000000 → 4988000000` — exactly 1.00 moved, once. **The whole demo path takes ~67 seconds.**

## Everything else

| Check | Result |
|---|---|
| `npm run typecheck` | **exit 0** |
| `npm run demo:reset` | exit 0 |
| Rehearsal (clean → settle → Etherscan, fraud → G3) | **PASS** |
| `ui-clean` | VERIFIED (22.0s) |
| `ui-fraud` | BLOCKED · G3 (21.6s) |
| `ui-injection` | BLOCKED · G0 (22.9s) |
| `ui-amount` | BLOCKED · G2 (21.7s) |
| `npm run csec:test` | **17 passed, 0 failed** |
| `npm run preflight` | **PASS**, exit 0 |

The four samples were run as 2 + 2 across two server processes, deliberately, because of X1.

## Every step

| Step | Status | Note |
|---|---|---|
| 1 · Bind approve endpoint to loopback | **DONE** | Exposure reproduced pre-fix (LAN reached the handler past the seed guard), refused post-fix |
| 2a · ETH gas preflight | **DONE** | Both branches forced through production code on a real 0-balance wallet |
| 2b · False SETTLED | **DONE (diverged, approved)** | Records at broadcast, `pending` status added; `settled` unreachable below required confirmations |
| 2c · Double-pay guard | **DONE** | Two concurrent approves → one settled, other refused in 32ms; on-chain proof exactly 1.00 moved |
| 2d · Readable failure reasons | **DONE** | Server-side (your correction to the audit), not client-side |
| 3 · Preflight + demo:reset | **DONE** | 13/13 checks; reset verified not to touch the log |
| 4 · Honesty sweep | **DONE** | ~24 claims changed across 12 files; falsification grep zero hits |
| 5 · Delegated evidence row | **DONE (incidentally)** | Captured while verifying `c1:demo` in Step 4 — first `delegated:true` row in the log |
| 6 · Remove replay mode | **DONE** | Both `?demo=` and the audit-missed `?preview=` |
| X1 · Context-overflow diagnosis | **DIAGNOSED, no code change** | Root cause confirmed by prediction; `ctx_size` bump reverted |
| 7–10 · Tier 1 visibility | **SKIPPED** | Your call: land honesty work, rehearse, sleep |
| 11 · Model cache + warm-up | **CUT** | X1 disproved its premise — the leak is below where a userland `Map` reaches |
| 12 · Real RAG in the app | **SKIPPED** | Tier 2, gated, not reached |
| 13 · Tool-calling in the app | **SKIPPED** | Tier 2, gated, not reached |

## What I could NOT verify programmatically — test these yourself

1. **No UI screenshots anywhere.** No headless browser was available and I did not install one. I
   verified served markup by curl and grep, but I have never *seen* any of these pages. **Look at
   the dash before you pitch** — especially the top bar, where I removed the fake green dot.
2. **The `pending` settlement branch never fired.** Sepolia confirmed in ~23s, far inside the 240s
   window. The **BROADCAST · UNCONFIRMED** pill is unrendered and unverified. `confirmations: 2` is
   hard-coded at `server.ts:222` with no env knob, so exercising it is a code edit, not a config
   flip — which you ruled out.
3. **The RPC-unreachable branch never fired.** WDK fails over to two public fallbacks, so it is
   unreachable without editing production code.
4. **Preflight's FAIL paths and its >60s "download-shaped" guard are unexercised.**
5. **The revert path in `settle.ts`** cannot be triggered on demand; there is deliberately no
   rollback logic, and the reason text tells the operator to clear the row manually.
6. **Cross-machine anything.** No test ran on the Intel. Including your Step 1 check — please run
   `curl -m 5 http://192.168.0.133:4173/api/samples` from the Intel while the M1 serves and confirm
   `Connection refused`.

## P2P status — say it like this

> The two-node mesh is designed and coded: a provider on the orchestrator, a hard-stop consumer
> that sets `fallbackToLocal: false`, and a self-hosted blind relay deployed on Fly. The delegated
> round-trip is proven and now logged — there's a `delegated:true` row in the audit trail with
> profiler-raw metrics, 316ms to first token at 53 tokens/sec on GPU. That was captured with both
> roles running as separate processes on one machine, after I fixed a DHT cold-start bug where the
> SDK fired `connect()` on an empty routing table before bootstrap finished. What is *not* done is
> cross-machine transport: two peers behind one NAT can't hairpin, so proving it needs the two
> hosts on different NATs. That's a known Hyperswarm limitation and it's the documented pending
> step. What you're watching today runs consolidated on one Mac.

## What the audit missed

1. **X1 — sequential verifies die on a context overflow.** The most serious finding of the night.
   The 3rd–4th verify in one process fails with a ~110s hang. Root cause confirmed: context
   accumulates ~2780 tokens per verify against an 8192 window and the load/unload cycle does not
   release it. Mitigation is procedural — restart between segments, now printed in the preflight
   banner.
2. **`clearStorage: true` deletes model weights.** The proposed X1 test would have `rm`'d
   Qwen3-VL-2B and forced a re-download tonight.
3. **A second replay path in `app.js`.** The audit found `?demo=` in `dash.js` but missed
   `?preview=` in `app.js`, which fabricated the same receipt using a **real** past transaction
   hash.
4. **The audit was wrong about `c1:demo`.** It does not simply "FAIL" — check (a), the delegated
   round-trip, *passes*. Check (c) asserts a `degradedMode` expectation that the current hard-stop
   design makes unreachable. The scorecard is stale, not the code. Believing the audit here would
   have meant deleting a pointer to something that actually works.
5. **The audit was wrong about `dash.js:340`.** It already read `r.reason`; the real gap was
   server-side responses that omitted the field.
6. **Uncommitted evidence.** 35 append-only log rows were sitting in the working tree, so a judge
   cloning the repo would not have seen the log you demo from. Now committed as `5f5f2b9`.
7. **`evidence/c6-report.md` had a stale row count** ("102 rows") that the audit did not list —
   another one-grep falsification. Now dated.

## ⚠ Still needs your answer

`SUBMISSION_CHECKLIST.md:51` contained *"the Intel Mac delegates Qwen3-VL to the M1 over an E2E
link."* **That never happened** — the Intel has never produced a logged row and the delegated model
is Llama-3.2-1B, not Qwen3-VL. The repo draft is redrafted. **If that text was ever actually posted
to X, the redraft is not the whole fix** — check your timeline. A short public correction before the
pitch reads as rigour; being caught reads as the opposite.
