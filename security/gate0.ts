// Gate 0 — Input Normalization & Decode (the "encoding grade").
//
// Applied to ALL invoice text (typed, OCR'd, vision-read) BEFORE it reaches the
// extraction LLM. NFKC-normalizes, strips invisible/bidi/PUA/tag chars, then runs a
// DETECTION battery over the text and its decodings (Morse, base64/32, hex,
// Caesar/ROT13/Atbash, leetspeak, homoglyph/confusables; nested, depth-limited).
//
// A decoded IMPERATIVE is evidence of an attack: it is FLAGGED, logged, and the
// invoice is routed to REJECT — never executed. Decoding is for DETECTION, not
// obedience. Threat-Model §2 (Grades A–J) + vectors 1–22.

export interface Gate0Finding {
  grade: string; // A..J or "control-chars"
  encoding: string; // plaintext | homoglyph | leet | morse | base64 | base32 | hex | caesar | atbash | nested
  detail: string; // human-readable; includes a snippet of what was decoded
}

export interface Gate0Result {
  /** NFKC-normalized, invisible-stripped, confusable-folded text safe to show the LLM. */
  normalized: string;
  /** True iff an obfuscated/plaintext imperative or attack indicator was detected. */
  flagged: boolean;
  findings: Gate0Finding[];
}

const MAX_DEPTH = 3;

// ── invisible / bidi / PUA / tag code-point ranges (#9/#10/#21) ─────────────────
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff],
  [0xe000, 0xf8ff], // BMP Private Use Area
  [0xe0000, 0xe007f], // tag chars
];
const isInvisible = (cp: number): boolean =>
  INVISIBLE_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);

function stripInvisible(s: string): { out: string; stripped: boolean } {
  let stripped = false;
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined && isInvisible(cp)) { stripped = true; continue; }
    out += ch;
  }
  return { out, stripped };
}

// ── imperative / injection detectors ───────────────────────────────────────────
const norm = (t: string): string => t.toLowerCase().replace(/\s+/g, " ");

// Override/jailbreak language. Never appears on a legitimate invoice — so even in
// PLAINTEXT this is an attack (Grade A). "Pay to wallet 0x…" is NOT here on purpose.
const INJECTION_RE: RegExp[] = [
  /\bignore\b[^.\n]{0,20}\b(instruction|prompt|rule|direction|command)/,
  /ignore\s+(all\s+|the\s+|any\s+)?(previous|prior|above|earlier|preceding|former)\s+(instruction|prompt|message|rule|direction|command)/,
  /disregard\s+(all\s+|the\s+|previous\s+|prior\s+|your\s+|any\s+)?(instruction|rule|prompt|guideline|safety|direction)/,
  /forget\s+(everything|all|your|the\s+previous|previous|prior)/,
  /you\s+are\s+(now|a|an|no\s+longer|in)\b/,
  /\bact\s+as\b/,
  /developer\s+mode/,
  /jailbreak/,
  /system\s+prompt/,
  /\bnew\s+(instruction|rule|task|directive|system)s?\b/,
  /override\s+(your|the|all|previous|safety|the\s+system)/,
  /do\s+not\s+(verify|check|validate|confirm)/,
  /bypass\s+(the\s+)?(check|verification|gate|rule)/,
];

// Imperative-to-act. Used ONLY on DECODED content — encoding an instruction at all
// is the attack signal, so "pay attacker / send to 0x…" inside a decode is flagged.
const ACTION_RE: RegExp[] = [
  /\b(pay|send|transfer|wire|remit|release|route|forward|redirect)\b[^.\n]{0,40}\b(to|attacker|wallet|address|account|0x)/,
  /\b(pay|send|transfer)\b[^.\n]{0,20}0x[0-9a-f]{4,}/,
  /\bapprove\b[^.\n]{0,30}\b(payment|invoice|transfer|settlement)\b/,
  /\bchange\b[^.\n]{0,30}\b(wallet|address|recipient|account)\b/,
];

const looksLikeInjection = (t: string): boolean => { const s = norm(t); return INJECTION_RE.some((r) => r.test(s)); };
const looksLikeImperative = (t: string): boolean => { const s = norm(t); return looksLikeInjection(t) || ACTION_RE.some((r) => r.test(s)); };

// ── homoglyph / leet folding ────────────────────────────────────────────────────
const CONFUSABLES: Record<string, string> = {
  // Cyrillic
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j", "ѕ": "s",
  "А": "A", "Е": "E", "О": "O", "Р": "P", "С": "C", "У": "Y", "Х": "X", "І": "I", "К": "K", "М": "M", "Т": "T", "В": "B", "Н": "H",
  "к": "k", "м": "m", "т": "t", "в": "v", "н": "n", "г": "r", "д": "d",
  // Greek
  "α": "a", "ο": "o", "ν": "v", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ι": "i", "κ": "k", "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T", "Υ": "Y", "Χ": "X",
};
function foldConfusables(s: string): string {
  let out = "";
  for (const ch of s) out += CONFUSABLES[ch] ?? ch;
  return out;
}

const LEET: Record<string, string> = { "4": "a", "@": "a", "3": "e", "1": "i", "!": "i", "0": "o", "5": "s", "$": "s", "7": "t", "+": "t", "9": "g", "8": "b" };
function normalizeLeet(s: string): string {
  // Only fold leet inside word-ish runs so we don't mangle real numbers/addresses.
  return s.replace(/[A-Za-z0-9@!$+]{3,}/g, (w) =>
    /[a-zA-Z]/.test(w) ? w.replace(/[4@31!05$7+98]/g, (c) => LEET[c] ?? c) : w,
  );
}

// ── decoders (each returns plausible plaintext decodings) ───────────────────────
const printableRatio = (s: string): number => {
  if (!s) return 0;
  let p = 0;
  for (const ch of s) { const c = ch.charCodeAt(0); if (c === 9 || c === 10 || (c >= 32 && c <= 126)) p++; }
  return p / s.length;
};
const readable = (s: string): boolean => s.length >= 4 && printableRatio(s) >= 0.85 && /[a-zA-Z]{3,}/.test(s);
// Printable-but-maybe-not-English: lets us re-scan a decoded layer that is itself
// another encoding (e.g. base64-of-Morse → a Morse string with no letters).
const printableCandidate = (s: string): boolean => s.length >= 8 && printableRatio(s) >= 0.85;

const MORSE: Record<string, string> = {
  ".-": "a", "-...": "b", "-.-.": "c", "-..": "d", ".": "e", "..-.": "f", "--.": "g", "....": "h",
  "..": "i", ".---": "j", "-.-": "k", ".-..": "l", "--": "m", "-.": "n", "---": "o", ".--.": "p",
  "--.-": "q", ".-.": "r", "...": "s", "-": "t", "..-": "u", "...-": "v", ".--": "w", "-..-": "x",
  "-.--": "y", "--..": "z", "-----": "0", ".----": "1", "..---": "2", "...--": "3", "....-": "4",
  ".....": "5", "-....": "6", "--...": "7", "---..": "8", "----.": "9",
};
function decodeMorse(text: string): string[] {
  const runs = text.match(/[.\-]{1,7}(?:[ \t]+[.\-]{1,7}){2,}/g);
  if (!runs) return [];
  const out: string[] = [];
  for (const run of runs) {
    const words = run.trim().split(/(?:\s{2,}|\s*\/\s*|\s+\|\s+)/);
    let decoded = "";
    for (const word of words) {
      for (const letter of word.trim().split(/\s+/)) decoded += MORSE[letter] ?? "";
      decoded += " ";
    }
    decoded = decoded.trim();
    if (decoded.length >= 3) out.push(decoded);
  }
  return out;
}

function decodeBase64(text: string): string[] {
  const out: string[] = [];
  for (const tok of text.match(/[A-Za-z0-9+/]{12,}={0,2}/g) ?? []) {
    if (tok.length % 4 !== 0) continue;
    try { const d = Buffer.from(tok, "base64").toString("utf8"); if (printableCandidate(d)) out.push(d); } catch { /* skip */ }
  }
  return out;
}

function decodeBase32(text: string): string[] {
  const ALPH = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const out: string[] = [];
  for (const raw of text.match(/[A-Z2-7]{16,}={0,6}/g) ?? []) {
    const tok = raw.replace(/=+$/, "");
    let bits = "";
    let okTok = true;
    for (const ch of tok) { const v = ALPH.indexOf(ch); if (v < 0) { okTok = false; break; } bits += v.toString(2).padStart(5, "0"); }
    if (!okTok) continue;
    let d = "";
    for (let i = 0; i + 8 <= bits.length; i += 8) d += String.fromCharCode(parseInt(bits.slice(i, i + 8), 2));
    if (printableCandidate(d)) out.push(d);
  }
  return out;
}

function decodeHex(text: string): string[] {
  const out: string[] = [];
  for (const run of text.match(/(?:[0-9a-fA-F]{2}[\s:,]?){6,}/g) ?? []) {
    const hex = run.replace(/[^0-9a-fA-F]/g, "");
    if (hex.length < 12 || hex.length % 2 !== 0) continue;
    let d = "";
    for (let i = 0; i < hex.length; i += 2) d += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    if (readable(d)) out.push(d);
  }
  return out;
}

function caesarShift(s: string, k: number): string {
  return s.replace(/[a-z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 97 + k) % 26) + 97))
    .replace(/[A-Z]/g, (c) => String.fromCharCode(((c.charCodeAt(0) - 65 + k) % 26) + 65));
}
function atbash(s: string): string {
  return s.replace(/[a-z]/g, (c) => String.fromCharCode(122 - (c.charCodeAt(0) - 97)))
    .replace(/[A-Z]/g, (c) => String.fromCharCode(90 - (c.charCodeAt(0) - 65)));
}
// Returns the FIRST cipher decoding that yields an imperative (so we don't recurse on 25 noisy shifts).
function decodeCiphers(text: string): Array<{ encoding: string; decoded: string }> {
  const hits: Array<{ encoding: string; decoded: string }> = [];
  for (let k = 1; k < 26; k++) { const d = caesarShift(text, k); if (looksLikeImperative(d)) { hits.push({ encoding: k === 13 ? "rot13" : "caesar", decoded: d }); break; } }
  const a = atbash(text); if (looksLikeImperative(a)) hits.push({ encoding: "atbash", decoded: a });
  return hits;
}

// ── core recursive scan ─────────────────────────────────────────────────────────
function scan(text: string, depth: number, findings: Gate0Finding[], seen: Set<string>): void {
  if (depth > MAX_DEPTH || !text || seen.has(text)) return;
  seen.add(text);
  const snippet = (s: string): string => s.replace(/\s+/g, " ").trim().slice(0, 80);

  // plaintext + folded views: injection language only (so clean "pay to wallet" is safe)
  if (looksLikeInjection(text)) findings.push({ grade: depth === 0 ? "A" : "J", encoding: depth === 0 ? "plaintext" : "nested", detail: `injection language: "${snippet(text)}"` });
  const folded = foldConfusables(text);
  if (folded !== text && looksLikeInjection(folded)) findings.push({ grade: "G", encoding: "homoglyph", detail: `confusable-folds to: "${snippet(folded)}"` });
  const leet = normalizeLeet(text);
  if (leet !== text && looksLikeInjection(leet)) findings.push({ grade: "F", encoding: "leet", detail: `leet-folds to: "${snippet(leet)}"` });

  // decoders: any decode that yields an imperative is an attack; otherwise recurse (nested)
  const layers: Array<{ encoding: string; grade: string; decoded: string }> = [
    ...decodeMorse(text).map((d) => ({ encoding: "morse", grade: "B", decoded: d })),
    ...decodeBase64(text).map((d) => ({ encoding: "base64", grade: "C", decoded: d })),
    ...decodeBase32(text).map((d) => ({ encoding: "base32", grade: "C", decoded: d })),
    ...decodeHex(text).map((d) => ({ encoding: "hex", grade: "D", decoded: d })),
    ...decodeCiphers(text).map((c) => ({ encoding: c.encoding, grade: "E", decoded: c.decoded })),
  ];
  for (const { encoding, grade, decoded } of layers) {
    if (looksLikeImperative(decoded)) {
      findings.push({ grade: depth > 0 ? "J" : grade, encoding: depth > 0 ? `nested:${encoding}` : encoding, detail: `${encoding} decodes to: "${snippet(decoded)}"` });
    } else {
      scan(decoded, depth + 1, findings, seen); // maybe another layer (Grade J)
    }
  }
}

/**
 * Gate 0. Returns the safe normalized text plus whether an obfuscated/plaintext
 * imperative was detected. When `flagged`, the caller MUST route the invoice to
 * REJECT and log the findings — the decoded content is never acted upon.
 */
export function normalizeForLLM(raw: string): Gate0Result {
  const findings: Gate0Finding[] = [];
  const nfkc = (raw ?? "").normalize("NFKC");
  const { out: cleaned, stripped } = stripInvisible(nfkc);
  if (stripped) findings.push({ grade: "H", encoding: "control-chars", detail: "stripped zero-width/bidi/PUA/tag characters" });

  scan(cleaned, 0, findings, new Set<string>());

  // The text shown to the LLM is the confusable-folded, invisible-stripped form.
  const normalized = foldConfusables(cleaned);
  return { normalized, flagged: findings.some((f) => f.encoding !== "control-chars"), findings };
}
