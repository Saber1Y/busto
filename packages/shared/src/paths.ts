import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Repo root, resolved from packages/shared/src. */
export const REPO_ROOT = resolve(here, "../../..");

/** The single auditable inference log (Hard Rule 6). Overridable for tests. */
export const LOG_PATH = process.env.BUSTO_LOG_PATH ?? resolve(REPO_ROOT, "evidence/inference-log.jsonl");

/** Load the gitignored .env at the repo root, if present. No-op when absent. */
export function loadEnvSafe(): void {
  try {
    process.loadEnvFile(resolve(REPO_ROOT, ".env"));
  } catch {
    /* no .env yet — entrypoints fall back to process env / args */
  }
}
