import { startQVACProvider } from "@qvac/sdk";
import { pathToFileURL } from "node:url";
import { loadEnvSafe, generateHyperswarmSeed, isHex64 } from "../../shared/src/index.ts";

export interface ProviderHandle {
  publicKey: string;
  /** True when no stable QVAC_HYPERSWARM_SEED was supplied (identity is ephemeral). */
  ephemeral: boolean;
}

/**
 * Start the Orchestrator (M1) as a QVAC delegated-inference provider.
 * A stable QVAC_HYPERSWARM_SEED yields a pinnable public key (threat #75/#83).
 * An optional allow-listed consumer key arms the firewall (threat #81).
 */
export async function startProvider(
  opts: { seed?: string; allowedConsumer?: string } = {},
): Promise<ProviderHandle> {
  let seed = opts.seed ?? process.env.QVAC_HYPERSWARM_SEED;
  let ephemeral = false;
  if (!isHex64(seed)) {
    seed = generateHyperswarmSeed();
    ephemeral = true;
  }
  process.env.QVAC_HYPERSWARM_SEED = seed;

  const allowedConsumer = opts.allowedConsumer ?? process.env.ALLOWED_CONSUMER_PUBKEY;
  const res = await startQVACProvider({
    firewall: isHex64(allowedConsumer) ? { mode: "allow", publicKeys: [allowedConsumer] } : undefined,
  });
  if (!res.success || !res.publicKey) {
    throw new Error(`startQVACProvider failed: ${res.error ?? "unknown error"}`);
  }
  return { publicKey: res.publicKey, ephemeral };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  loadEnvSafe();
  const { publicKey, ephemeral } = await startProvider({
    seed: process.argv[2],
    allowedConsumer: process.argv[3],
  });
  console.log("✅ Busto provider up (Orchestrator · M1 · QVAC Metal)");
  if (ephemeral) {
    console.warn("⚠️  Ephemeral identity — set QVAC_HYPERSWARM_SEED in .env for a stable, pinnable key.");
  }
  // Exact line the consumer/demo parse for the key — keep this format stable.
  console.log(`Provider Public Key: ${publicKey}`);
  console.log("📡 Provider running — Ctrl+C to stop.");
  process.on("SIGINT", () => {
    console.log("\n🛑 Provider stopped");
    process.exit(0);
  });
  process.stdin.resume();
}
