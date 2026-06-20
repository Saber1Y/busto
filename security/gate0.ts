// Gate 0 — Input Normalization & Decode.
//
// HOOK for C2. The full encoding-defense battery (Morse, base64/32, hex,
// ROT13/Caesar/Atbash, leetspeak, homoglyph/confusables — nested, depth-limited;
// a decoded imperative -> flag + REJECT + log) lands in C-sec (Threat-Model §2,
// Grades A-J). This hook establishes the real interface and performs the
// always-safe normalization so that NO invoice text (OCR'd or vision-read)
// reaches the LLM without passing through Gate 0. Decoding is for DETECTION,
// not obedience.

export interface Gate0Result {
  /** NFKC-normalized text with zero-width / bidi / tag chars stripped. */
  normalized: string;
  /** True when a decoded imperative / attack indicator was found (C-sec). */
  flagged: boolean;
  /** Human-readable notes (what was stripped / decoded / flagged). */
  findings: string[];
}

// Zero-width, bidi-override, BOM, and Unicode tag chars (Threat-Model #9/#10/#21).
// Expressed as code-point ranges to avoid embedding invisible literals in source.
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f], // ZWSP, ZWNJ, ZWJ, LRM, RLM
  [0x202a, 0x202e], // bidi embeddings / overrides
  [0x2060, 0x206f], // word joiner, invisible operators, deprecated format chars
  [0xfeff, 0xfeff], // BOM / ZWNBSP
  [0xe0000, 0xe007f], // Unicode tag chars
];

function isInvisible(cp: number): boolean {
  for (const [lo, hi] of INVISIBLE_RANGES) if (cp >= lo && cp <= hi) return true;
  return false;
}

/**
 * Always-safe input normalization (C2). C-sec extends this with the full
 * decode battery; the interface here is stable so callers never change.
 */
export function normalizeForLLM(raw: string): Gate0Result {
  const findings: string[] = [];
  const nfkc = raw.normalize("NFKC");

  let stripped = false;
  let normalized = "";
  for (const ch of nfkc) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isInvisible(cp)) {
      stripped = true;
      continue;
    }
    normalized += ch;
  }
  if (stripped) findings.push("stripped zero-width/bidi/tag control characters");

  // C-sec TODO: iterative decode (Morse/base64/hex/ROT13/leet/homoglyph, nested,
  // depth-limited). Any decoded IMPERATIVE -> set flagged=true, route to REJECT, log.
  return { normalized, flagged: false, findings };
}
