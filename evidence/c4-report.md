# Custos — C4 Report · Real USD₮ Settlement on Sepolia (gated)

**Phase:** C4 · **Node:** Edge "AP Clerk" (keys here only) · PRD §10 · Threat-model D (55–74) + Gate 3/5.

## The settlement (real, on-chain, independently verified)

| | |
|---|---|
| **tx hash** | `0xa3ed0f33fcfa685287185284079884c0ea0c3a260149443bfd945f083f79cd30` |
| **explorer** | https://sepolia.etherscan.io/tx/0xa3ed0f33fcfa685287185284079884c0ea0c3a260149443bfd945f083f79cd30 |
| receipt | `status 0x1` (success), block 11,103,356, 2 confirmations |
| from | `0x5C6C9e12D49e28670E00AD1C05f24243ad77Be13` (Edge signer) |
| to (recipient) | `0x8ba1f109551bD432803012645Ac136ddd64DBA72` (Acme's **DB** known_wallet) |
| token | `0xd077a400968890eacc75cdc901f0356c943e4fdb` (pinned Sepolia test USD₮, 6 dp) |
| amount | exactly **1 USD₮** (`0xf4240` = 1,000,000 base units) |
| balance | 2000 → **1999 USD₮**; gas paid in ETH |

Verified independently via `eth_getTransactionReceipt` + the ERC-20 Transfer log + a fresh balance read — not just WDK's return value.

## What shipped

| File | Role |
|---|---|
| [packages/shared/src/intent.ts](../packages/shared/src/intent.ts) | `PaymentIntent { to, amount, token, chainId, invoiceRef, memo }` + `buildPaymentIntent` (recipient = DB knownWallet). |
| [packages/edge/src/wallet.ts](../packages/edge/src/wallet.ts) | WDK signer — **keys only on Edge** (seed from gitignored `.env`); RPC failover. |
| [packages/edge/src/settle.ts](../packages/edge/src/settle.ts) | Gates 3/4/5 + WDK `transfer` + confirmations + `recordSettlement`. |
| [remote_apis.json](../remote_apis.json) | discloses the non-AI RPCs + pinned token (inference stays 100% local). |

## Proven (`CUSTOS_APPROVE=I-APPROVE npm run c4:demo`)

| Case | Outcome |
|---|---|
| **clean verified invoice** | ✅ **SETTLED** — real tx hash above |
| poisoned invoice (wallet-lookalike) | 🛑 verdict REJECT → **no send** |
| forged intent (recipient = attacker) | 🛑 **Gate 3** blocked (`intent.to !== DB known_wallet`) |
| duplicate replay (same invoice_ref) | 🛑 blocked (`settlements.invoice_ref` UNIQUE, #41) |
| dry run (no approval) | 🛑 **Gate 4** blocked (no funds moved) |

## Gates enforced (threat-model D)
- **Gate 3** (#61) — recipient re-checked against the **re-fetched** DB `known_wallet` in plain code before signing; a forged `intent.to` is blocked even if it reached settlement.
- **Gate 4** — explicit human approval (`CUSTOS_APPROVE`); the dry run proves no send without it. In C5 this is a literal Approve click on the Edge UI.
- **Gate 5** — pinned `chainId` (#58/#59) + pinned token address (#64), **exact-amount** `transfer` (no unbounded approve, #65), wait **2 confirmations** (#57). MEV-protected RPC (Flashbots Protect) pinned for production in `remote_apis.json`; the testnet send uses the public mempool (reliable inclusion; a plain transfer has no extractable MEV, #55).
- **Recipient is the DB wallet, never the document** — the invoice's `providedWallet` is only cross-checked; the money goes to `verdict.knownWallet`.

## Notes
- Live-send amount is 1 USD₮ against a `PO-TEST` order so the demo is cheap and re-runnable on the funded balance; the gates are identical at any amount.
- `wdk-secret-manager` is Bare-native (P0 finding) — for the Node demo the seed lives in gitignored `.env`; the encrypted secret store is the production hardening.
