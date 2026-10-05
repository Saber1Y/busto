# Busto on BOT Chain

Busto settles verified vendor invoices on **BOT Chain Testnet** through an
on-chain settlement contract. This document is the authoritative description of
the network configuration, the deployed contract and the real transaction that
proves the flow works.

> **This integration targets BOT Chain Testnet (chain 968).**
> **No BOT mainnet settlement is enabled.**

## Network

| | |
|---|---|
| Network | BOT Chain Testnet |
| Chain ID | `968` (`0x3c8`) |
| RPC | `https://rpc.bohr.life` |
| Explorer | `https://scan.bohr.life` |
| Native gas token | tBOT (18 decimals) |
| Faucet | `https://faucet.botchain.ai/en/basic` |

## Payment asset

| | |
|---|---|
| Token | USDT (Tether USD) |
| Address | `0x75edC9335175Fc0552D51D48439F229c10420fe3` |
| Decimals | 6 |

The token is network-specific configuration. An Ethereum USDT address is **not**
valid on BOT Chain.

## Settlement contract

| | |
|---|---|
| Contract | `0xf08790ceffd2521538f4be5cabad059631bd2eb2` |
| Source | `contracts/src/BustoSettlement.sol` |
| ABI | `contracts/out/BustoSettlement.sol/BustoSettlement.json` |
| Deploy tx | [`0xadb6c73b63a329a87ae81bd49fca83df2c1717044398600330dbed04ed03721f`](https://scan.bohr.life/tx/0xadb6c73b63a329a87ae81bd49fca83df2c1717044398600330dbed04ed03721f) |
| Deploy block | 25,783,704 |
| Authorized settlement caller | the Custos Edge wallet |

Read-only interface:

```solidity
function token() external view returns (IERC20);
function tokenDecimals() external view returns (uint8);
function settlementCaller() external view returns (address);
function settledInvoiceCount() external view returns (uint256);
function totalSettledAmount() external view returns (uint256);
function settlementExists(bytes32 invoiceRef) external view returns (bool);
function getSettlement(bytes32 invoiceRef) external view returns (Settlement memory);
```

Write interface:

```solidity
function settleInvoice(bytes32 invoiceRef, address recipient, uint256 amount) external returns (bool);
```

### Security properties

- **Single authorized caller.** Only the Edge wallet can settle. The AI /
  orchestrator never holds this role, so a compromised model cannot move funds.
- **Pinned token.** The token is immutable and set at construction; a wrong-token
  settlement is impossible.
- **Exact allowance.** Busto approves precisely the invoice amount and the
  contract consumes it in the same transaction. No unbounded approval is created
  and no allowance survives a payment.
- **On-chain replay guard.** `settlementExists[invoiceRef]` is durable. If the
  local SQLite ledger is lost or rolled back, an invoice still cannot be paid
  twice.
- **Checked transfer.** The token call's return value is checked, so a token that
  returns `false` cannot record a settlement that never moved value.
- **Checks-effects-interactions.** State is written before the token call.
- **No custody.** The contract holds no balance between payments.

## Payment flow

```
Edge wallet
    │  approve(BustoSettlement, exactAmount)
    ▼
BustoSettlement.settleInvoice(invoiceRef, vendor, amount)
    │
    ▼  transferFrom(payer → vendor, exactAmount)  +  InvoiceSettled event
BOT Chain Testnet
```

`invoiceRef` is the Custos invoice reference encoded as `bytes32`. It is derived
deterministically so the same invoice always maps to the same replay-guard key.

## Real transaction

A full end-to-end settlement was executed and independently verified by reading
chain state (not application logs).

**Step 1 — exact-amount approval**

| | |
|---|---|
| Tx | [`0x31726011a1479de447dcb774954b611d281b08dac9e93af89f90a8d2f3797854`](https://scan.bohr.life/tx/0x31726011a1479de447dcb774954b611d281b08dac9e93af89f90a8d2f3797854) |
| Call | `approve(0xf08790…eb2, 1000000)` |
| Gas | 46,961 |
| Result | allowance = 1.000000 USDT, exact |

**Step 2 — settlement**

| | |
|---|---|
| Tx | [`0x2ea60336babd5e995c79b2575026635d91ab50f9d42a67fd3908dcbd3e8a4c23`](https://scan.bohr.life/tx/0x2ea60336babd5e995c79b2575026635d91ab50f9d42a67fd3908dcbd3e8a4c23) |
| Call | `settleInvoice(0x78b6a003…, vendor, 1000000)` |
| Block | 25,784,689 |
| Gas | 241,393 |
| Result | status `success` |

**`InvoiceSettled` event** (topic `0xfb31c137…9192`):

```
invoiceRef    0x78b6a003ef614f7ced410a5006a09414c9c67933e383102306593e94b7a66300
payer         0x3f5b96a494061f7338da529e3047809ac6a7fb84
recipient     0xe35cc278497ee0d4fdf3312ef59976468b1a0499
amount        1.000000 USDT
timestamp     2026-10-05T11:00:00Z
settledCount  1
totalVolume   1.000000 USDT
```

**State read back from the chain after settlement:**

| Check | Result |
|---|---|
| `settledInvoiceCount` | 0 → 1 |
| `totalSettledAmount` | 0 → 1.000000 USDT |
| `settlementExists(INV-1042)` | `true` |
| `settlement.recipient` | matches the verified vendor wallet |
| Vendor USDT balance | 0 → 1.000000 USDT (exactly the invoice amount) |
| Leftover allowance | 0 (approval fully consumed) |

### Replay guard proven live

Re-settling `INV-1042` after re-approving the funds (so funding was definitively
not the blocker) reverted with selector `0xb196a44a` = `AlreadySettled(bytes32)`.
The counter stayed at 1 and the vendor was not paid twice.

## Commands

```bash
# contract tests
cd contracts && forge test -vv

# compile
cd contracts && forge build

# deploy (requires .env — never commit)
cd contracts && forge script script/Deploy.s.sol:Deploy \
  --rpc-url https://rpc.bohr.life --broadcast

# app preflight (wallet, RPC, chain id, USDT balance, gas)
npm run preflight

# live end-to-end settlement demo behind every gate
npm run c4:demo
```

## Wallet configuration

The Edge signer is a plain 32-byte private key in the gitignored `.env`. It never
leaves the Edge machine; the Orchestrator has no key API surface.

```
BUSTO_WALLET_SEED=<0x + 64 hex chars>      # Edge only — never commit
BOT_RPC_URL=https://rpc.bohr.life
BUSTO_SETTLEMENT_CONTRACT=0xf08790ceffd2521538f4be5cabad059631bd2eb2
```

### Two BOT Chain integration constraints

1. **bohr keeps no unlocked accounts.** `eth_sendTransaction` fails with
   `unknown account`. Every write must be signed locally and broadcast with
   `eth_sendRawTransaction`. See `signAndBroadcast` in
   `packages/edge/src/wallet.ts`.
2. **The previous wallet stack could not target this chain.** The Sepolia
   implementation pinned chain 11155111 through `@tetherto/wdk-wallet-evm`, which
   validates against known networks. Busto signs with `viem` directly instead.

## On-chain dashboard

`GET /api/onchain` reads live settlement metrics from contract state. The
dashboard's "BOT Chain" view renders them. Counters are never cached in memory
and never derived from SQLite alone — if the RPC is unreachable the panel says so
rather than showing zero.

## Security considerations

The six-gate model is unchanged:

| Gate | Guarantee |
|---|---|
| 0 | Hidden-instruction / prompt-injection detection |
| 1 | The AI cannot pay |
| 2 | Vendor and PO truth comes from the local ERP |
| 3 | Recipient re-checked against the ERP immediately before signing |
| 4 | Explicit human approval required |
| 5 | On-chain validation of network, token, amount, recipient, balance, gas and receipt |

The contract sits behind all of them. It cannot tell whether an invoice is
legitimate — that is proven off-chain before a settlement intent reaches the
Edge signer.

## Known limitations

- Testnet only. No mainnet settlement is enabled.
- Receipts are not implemented; settlement is the payment rail.
- The provider mock pools mean no real vendor wallet is registered on-chain yet.
- `settleInvoice` does not support fee-on-transfer tokens; the recorded amount
  would be wrong for those.
- An invoice settles exactly once per contract. A re-issued invoice needs a new
  reference.

## Attribution

Busto is a derivative of [Custos](https://github.com/winsznx/custos)
(Apache-2.0). See `NOTICE.md`.