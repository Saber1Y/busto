# NOTICE

**Busto** is a derivative work of **Custos**
(https://github.com/winsznx/custos), licensed under the Apache License 2.0.

The original Custos project and its authorship remain with the Custos
contributors. This fork preserves that license and credits the upstream work.

## What changed in Busto

Busto keeps Custos' security architecture intact:

> AI proposes. Deterministic code verifies. Human approves. Edge signs. Blockchain settles.

The changes are:

1. **Settlement rail migrated from Ethereum Sepolia to BOT Chain Testnet**
   (chain ID 968, RPC `https://rpc.bohr.life`, explorer
   `https://scan.bohr.life`, native gas token BOT). The pinned payment asset is
   the official BOT Chain Testnet USDT at
   `0x75edC9335175Fc0552D51D48439F229c10420fe3` (6 decimals).

2. **New on-chain settlement contract `BustoSettlement.sol`** so that settlement
   is mediated by a contract rather than a bare ERC-20 transfer. The contract
   holds no custody of funds between payments: it pulls an exact, per-invoice
   allowance and forwards it to the vendor in the same transaction.

3. **A contract-mediated approval flow** - exact-amount `approve`, then
   `settleInvoice`, then the allowance is consumed. No unbounded approval is
   ever created.

4. **On-chain metrics are derived from contract state and events**, not from
   in-memory counters or SQLite alone.

All Custos gates (0-5), the six-gate security ladder, the two-node
Orchestrator/Edge split, and the rule that the private seed exists only on the
Edge machine are preserved unchanged.

## Files still naming "Custos"

The `evidence/` directory contains dated test and research reports produced by
the upstream project. They are retained verbatim as a historical record and
intentionally still refer to the original project name. `LICENSE` is the
unmodified Apache 2.0 license from upstream.