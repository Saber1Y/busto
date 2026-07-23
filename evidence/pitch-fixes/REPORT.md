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
