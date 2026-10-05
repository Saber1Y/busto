import WalletManagerEvm from "@tetherto/wdk-wallet-evm";
import type { WalletAccountEvm } from "@tetherto/wdk-wallet-evm";
import { loadEnvSafe } from "../../shared/src/index.ts";

// Busto Edge signer. Keys live ONLY on the Edge node (seed in gitignored .env via
// WDK self-custody). The Orchestrator has NO key API surface (threat #92).

export const CHAIN = {
  id: 11155111, // Ethereum Sepolia (pinned)
  usdt: "0xd077a400968890eacc75cdc901f0356c943e4fdb", // test USD₮, 6 decimals (pinned)
  usdtDecimals: 6,
} as const;

// Reliable public Sepolia RPCs for the testnet send (guaranteed inclusion). Production
// pins an MEV-protected endpoint (Flashbots Protect) — see remote_apis.json. A plain
// ERC-20 transfer carries no extractable MEV (threat #55), and Sepolia private-mempool
// inclusion is unreliable, so the demo broadcasts via the public mempool.
const FALLBACK_RPCS = ["https://ethereum-sepolia-rpc.publicnode.com", "https://sepolia.drpc.org"];

export interface EdgeWallet {
  account: WalletAccountEvm;
  address: string;
  rpcs: string[];
  dispose: () => void;
}

export async function openEdgeWallet(): Promise<EdgeWallet> {
  loadEnvSafe();
  const seed = process.env.BUSTO_WALLET_SEED;
  if (!seed) throw new Error("BUSTO_WALLET_SEED missing — Edge keys live in .env (gitignored)");
  const envRpc = process.env.SEPOLIA_RPC_URL;
  const rpcs = envRpc ? [envRpc, ...FALLBACK_RPCS.filter((r) => r !== envRpc)] : [...FALLBACK_RPCS];
  const manager = new WalletManagerEvm(seed, { provider: rpcs, chainId: CHAIN.id });
  const account = await manager.getAccount(0);
  return {
    account,
    address: account.address,
    rpcs,
    dispose: () => {
      if (typeof account.dispose === "function") account.dispose();
      if (typeof manager.dispose === "function") manager.dispose();
    },
  };
}
