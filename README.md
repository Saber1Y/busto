# Busto

### Air-gapped agentic settlement — accounts payable an AI can't be tricked into paying wrong.

> Busto reads a vendor invoice **on your own machine**, checks it against **your own books**,
> and pays it **on-chain** — and a payment is **impossible** unless it clears **six independent
> gates**. No invoice, no dollar figure, and no AI prompt ever leaves the building.
> **Zero cloud, zero data leakage.**

**Built for** QVAC Hackathon I (Tether · DoraHacks) · **Team** Tim (`@winsznx`) + Anu (`@svector`) · **Track** General Purpose (≤ 32 GB) + Build in Public · **License** Apache-2.0

**It's not a mock** — here is a real payment Busto settled on BOT Chain Testnet:
[`0x2ea60336…8a4c23`](https://scan.bohr.life/tx/0x2ea60336babd5e995c79b2575026635d91ab50f9d42a67fd3908dcbd3e8a4c23)
(1 USD₮, block 25,784,689). Every piece of AI ran on-device through the **QVAC SDK** — the
only outside calls are the blockchain RPC, listed in [`remote_apis.json`](./remote_apis.json).

---

### BOT Chain settlement

Settlement is **contract-mediated** on BOT Chain Testnet, not a bare transfer:

```
Edge wallet
    │  approve(BustoSettlement, exactAmount)   ← exact amount, consumed immediately
    ▼
BustoSettlement.settleInvoice(invoiceRef, vendor, amount)
    │  transferFrom(payer → vendor) + InvoiceSettled event
    ▼
BOT Chain Testnet · chain 968 · https://scan.bohr.life
```

| | |
|---|---|
| Settlement contract | `0xf08790ceffd2521538f4be5cabad059631bd2eb2` |
| USDT (test) | `0x75edC9335175Fc0552D51D48439F229c10420fe3` (6 decimals) |
| Real settlement | [`0x2ea60336…8a4c23`](https://scan.bohr.life/tx/0x2ea60336babd5e995c79b2575026635d91ab50f9d42a67fd3908dcbd3e8a4c23) — 1.000000 USDT, block 25,784,689 |
| Exact approval | [`0x31726011…f7854`](https://scan.bohr.life/tx/0x31726011a1479de447dcb774954b611d281b08dac9e93af89f90a8d2f3797854) |
| Contract deploy | [`0xadb6c73b…3721f`](https://scan.bohr.life/tx/0xadb6c73b63a329a87ae81bd49fca83df2c1717044398600330dbed04ed03721f) |

After that settlement, read straight from the chain: `settledInvoiceCount` 0 → 1,
`totalSettledAmount` 0 → 1.000000 USDT, vendor balance 0 → 1.000000 USDT, leftover
allowance 0. Re-settling the same invoice reverts with `AlreadySettled(bytes32)`.


## Quick Start (Local-first)

> Busto is designed to run entirely on your local machine. There is no public hosted instance.

### Prerequisites
- **Node.js ≥ 22.17** and **npm ≥ 10.9**
- **macOS ≥ 14** (Apple Silicon recommended for GPU acceleration via QVAC SDK)
- At least **~10–15 GB free disk space** on first run (local ML models are downloaded to `~/.qvac/models`)

### Run the local web console

```bash
npm install
npm run serve
```

Then open [http://localhost:4173](http://localhost:4173) in your browser.

> **Note:** On first startup, the server will download and load local ML models (CLIP/Qwen embeddings) via the QVAC SDK. This can take several minutes. Wait for model initialization to complete before uploading invoices.

### Verify everything is working

```bash
# Run preflight checks (vision/model load + basic sanity)
npm run preflight

# Run smoke tests
npm run smoke
```
