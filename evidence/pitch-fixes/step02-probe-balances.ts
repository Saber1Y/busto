// Probe: what do the real and the throwaway wallets actually hold on Sepolia?
// Used to pick a seed that genuinely reaches the ETH-gas-empty branch of settleIntent.
import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import { loadEnvSafe } from "../../packages/shared/src/index.ts";
import { CHAIN } from "../../packages/edge/src/wallet.ts";

loadEnvSafe();
const RPCS = ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"];
const SEEDS: Array<[string, string | undefined]> = [
  ["funded (.env CUSTOS_WALLET_SEED)", process.env.CUSTOS_WALLET_SEED],
  ["throwaway (hardhat test junk)", "test test test test test test test test test test test junk"],
];

for (const [label, seed] of SEEDS) {
  if (!seed) { console.log(`${label}: NOT SET`); continue; }
  const m = new WalletManagerEvm(seed, { provider: RPCS, chainId: CHAIN.id });
  const a = await m.getAccount(0);
  const [eth, usdt] = [await a.getBalance(), await a.getTokenBalance(CHAIN.usdt)];
  console.log(`${label}\n  address ${a.address}\n  ETH  ${eth} wei (${(Number(eth) / 1e18).toFixed(6)})\n  USD₮ ${usdt} minor (${(Number(usdt) / 1e6).toFixed(2)})`);
  if (typeof a.dispose === "function") a.dispose();
  if (typeof m.dispose === "function") m.dispose();
}
process.exit(0);
