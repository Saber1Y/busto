import { createPublicClient, createWalletClient, defineChain, formatUnits, http, type Address, type Chain } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { loadEnvSafe } from "../../shared/src/index.ts";

// Busto Edge signer. Keys live ONLY on the Edge node (seed in gitignored .env via
// local self-custody). The Orchestrator has NO key API surface (threat #92).
//
// Settlement rail: BOT Chain Testnet (chain 968). The previous rail was Ethereum
// Sepolia; BOT is EVM-compatible but is NOT a chain the previous wallet stack
// could be pointed at, so signing is done with viem directly rather than forcing
// a wallet SDK onto an unknown chainId. The seed still never leaves this machine.
//
// bohr's RPC keeps no unlocked accounts, so eth_sendTransaction fails with
// "unknown account". Every write here is therefore signed locally and broadcast
// with eth_sendRawTransaction. Treat that as a hard requirement of this network,
// not an optimisation.

export const CHAIN = defineChain({
  id: 968,
  name: "BOT Chain Testnet",
  nativeCurrency: { name: "tBOT", symbol: "tBOT", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.bohr.life"] } },
  blockExplorers: { default: { name: "BOTScan", url: "https://scan.bohr.life" } },
  testnet: true
});

// Payment asset is network-specific configuration. Never reuse an Ethereum
// address here: BOT Chain Testnet USDT is a different deployment.
export const CHAIN_ID = Number(process.env.BUSTO_CHAIN_ID ?? 968);
export const USDT_ADDRESS = (process.env.BUSTO_USDT_ADDRESS ??
  "0x75edC9335175Fc0552D51D48439F229c10420fe3") as Address;
export const USDT_DECIMALS = Number(process.env.BUSTO_USDT_DECIMALS ?? 6);
export const EXPLORER_TX = (hash: string) => `https://scan.bohr.life/tx/${hash}`;
export const EXPLORER_ADDRESS = (a: string) => `https://scan.bohr.life/address/${a}`;

export interface EdgeWallet {
  address: Address;
  chain: Chain;
  // LocalAccount: signs locally. bohr holds no unlocked accounts, so nothing
  // may rely on the node holding a key for us.
  account: LocalAccount;
  publicClient: ReturnType<typeof createPublicClient>;
  walletClient: ReturnType<typeof createWalletClient>;
  rpc: string;
  dispose: () => void;
}

export async function openEdgeWallet(): Promise<EdgeWallet> {
  loadEnvSafe();
  const seed = process.env.BUSTO_WALLET_SEED;
  if (!seed) throw new Error("BUSTO_WALLET_SEED missing — Edge keys live in .env (gitignored)");

  const rpc = process.env.BOT_RPC_URL ?? CHAIN.rpcUrls.default.http[0];

  // The Edge signer is a plain 32-byte private key held in the gitignored .env.
  // HD mnemonic derivation was dropped together with the Sepolia wallet stack:
  // viem signs raw keypairs directly, so there is nothing left to derive.
  const key = seed.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "BUSTO_WALLET_SEED must be a 32-byte hex private key (0x + 64 hex chars). Keys live in .env on the Edge node only."
    );
  }
  const account = privateKeyToAccount(key as `0x${string}`);

  const publicClient = createPublicClient({ chain: CHAIN, transport: http(rpc), batch: { multicall: false } });
  const walletClient = createWalletClient({ chain: CHAIN, account, transport: http(rpc) });

  return {
    address: account.address,
    account,
    chain: CHAIN,
    publicClient,
    walletClient,
    rpc,
    dispose: () => {}
  };
}

/** Local signing + raw broadcast. bohr does not hold unlocked accounts. */
export async function signAndBroadcast(
  wallet: EdgeWallet,
  tx: { to: Address; data: `0x${string}`; gas: bigint; nonce: number; value?: bigint }
): Promise<`0x${string}`> {
  const gasPrice = await wallet.publicClient.getGasPrice();
  const signed = await wallet.account.signTransaction({
    chain: wallet.chain,
    to: tx.to,
    data: tx.data,
    gas: tx.gas,
    nonce: tx.nonce,
    value: tx.value ?? 0n,
    gasPrice,
    type: "legacy"
  });
  return wallet.publicClient.sendRawTransaction({ serializedTransaction: signed });
}

/** Fresh nonce per call. bohr shards can report a lagging pending count. */
export async function nextNonce(wallet: EdgeWallet): Promise<number> {
  return wallet.publicClient.getTransactionCount({ address: wallet.address, blockTag: "latest" });
}

export async function readTokenBalance(wallet: EdgeWallet, token: Address, holder: Address): Promise<bigint> {
  return wallet.publicClient.readContract({
    abi: [
      {
        type: "function",
        stateMutability: "view",
        name: "balanceOf",
        inputs: [{ name: "account", type: "address" }],
        outputs: [{ type: "uint256" }]
      }
    ],
    address: token,
    functionName: "balanceOf",
    args: [holder]
  });
}

export async function readAllowance(
  wallet: EdgeWallet,
  token: Address,
  owner: Address,
  spender: Address
): Promise<bigint> {
  return wallet.publicClient.readContract({
    abi: [
      {
        type: "function",
        stateMutability: "view",
        name: "allowance",
        inputs: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" }
        ],
        outputs: [{ type: "uint256" }]
      }
    ],
    address: token,
    functionName: "allowance",
    args: [owner, spender]
  });
}

export { formatUnits };