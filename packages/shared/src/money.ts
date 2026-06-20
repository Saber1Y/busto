// Canonical minor-unit money parsing (Gate 5). Threat-model #39 (amount unit
// confusion), #60 (decimals mismatch). Amounts are compared as integer minor
// units — never as floats — and over-precise inputs are rejected, not rounded.

/**
 * Parse a human amount string to integer minor units for `decimals` (USD₮ = 6).
 * Strips currency words/symbols and thousands separators; rejects ambiguous or
 * over-precise inputs (returns null). e.g. "5,000.00 USD" @6 -> 5000000000n.
 */
export function toMinorUnits(amount: string, decimals = 6): bigint | null {
  if (typeof amount !== "string") return null;
  const cleaned = amount.replace(/[^\d.,-]/g, "").trim();
  if (!cleaned) return null;
  const normalized = cleaned.replace(/,/g, ""); // assume comma = thousands separator
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  const negative = normalized.startsWith("-");
  const [intPart, fracPart = ""] = normalized.replace(/^-/, "").split(".");
  if (fracPart.length > decimals) return null; // over-precise -> reject (#39)
  const minor = BigInt(intPart + fracPart.padEnd(decimals, "0"));
  return negative ? -minor : minor;
}

/** Format integer minor units back to a decimal string (for display/logs). */
export function fromMinorUnits(minor: bigint, decimals = 6): string {
  const neg = minor < 0n;
  const s = (neg ? -minor : minor).toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + intPart + (fracPart ? "." + fracPart : "");
}
