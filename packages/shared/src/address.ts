import { keccak_256 } from "@noble/hashes/sha3.js";

// EVM address safety (Gate 3 recipient re-check + Gate 5 on-chain). Threat-model
// #45 (lookalike), #48 (checksum bypass), #49 (unicode/whitespace in address).

const HEX40 = /^0x[0-9a-fA-F]{40}$/;

/** Strict 0x + 40-hex validation (no unicode/whitespace tolerance beyond trim). */
export function isValidAddress(a: string): boolean {
  return typeof a === "string" && HEX40.test(a.trim());
}

/** EIP-55 mixed-case checksum form of a valid address. */
export function toChecksumAddress(a: string): string {
  if (!isValidAddress(a)) throw new Error(`invalid address: ${a}`);
  const hex = a.trim().toLowerCase().replace(/^0x/, "");
  const hash = Buffer.from(keccak_256(new TextEncoder().encode(hex))).toString("hex");
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? hex[i].toUpperCase() : hex[i];
  return out;
}

/** If the address is mixed-case it MUST be a valid EIP-55 checksum (typo guard, #48). */
export function isChecksumValid(a: string): boolean {
  if (!isValidAddress(a)) return false;
  const s = a.trim();
  if (s === s.toLowerCase() || s === s.toUpperCase()) return true; // no checksum claimed
  return s === toChecksumAddress(s);
}

/** True iff both are valid addresses and equal after EIP-55 normalization. */
export function addressEquals(a: string, b: string): boolean {
  if (!isValidAddress(a) || !isValidAddress(b)) return false;
  return toChecksumAddress(a) === toChecksumAddress(b);
}

// OCR/vision confusables that are NOT valid hex (so always a read error in an address).
const OCR_HEX_FOLD: Record<string, string> = { O: "0", o: "0", I: "1", l: "1", "|": "1", S: "5", s: "5", Z: "2", z: "2", G: "6" };
const foldOcrHex = (a: string): string => a.split("").map((c) => OCR_HEX_FOLD[c] ?? c).join("");

/**
 * Tolerant recipient corroboration for OCR/vision-read wallets. A legitimate wallet
 * read with OCR noise lands within a tiny drift of the DB address after folding
 * confusables; an attacker/lookalike address (threat #45) differs in many genuine hex
 * positions and is rejected. Forging a private key within ~2 chars of a fixed target
 * is computationally infeasible, so the small tolerance is safe. Payout always uses the
 * DB address regardless — this only decides corroboration.
 */
export function addressMatchTolerant(provided: string, known: string, maxDrift = 2): { match: boolean; exact: boolean; drift: number } {
  if (!isValidAddress(known)) return { match: false, exact: false, drift: 40 };
  if (isValidAddress(provided) && addressEquals(provided, known)) return { match: true, exact: true, drift: 0 };
  const folded = foldOcrHex((provided ?? "").trim());
  if (isValidAddress(folded) && addressEquals(folded, known)) return { match: true, exact: false, drift: 0 };
  const p = folded.replace(/^0x/i, "").toLowerCase();
  const k = known.replace(/^0x/i, "").toLowerCase();
  if (p.length !== 40 || k.length !== 40) return { match: false, exact: false, drift: 40 };
  let drift = 0;
  for (let i = 0; i < 40; i++) if (p[i] !== k[i]) drift++;
  return { match: drift <= maxDrift, exact: false, drift };
}
