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
