# Custos — C-sec Report · Gate-0 Encoding-Defense Battery

**Phase:** C-sec (lands **before** C4) · Threat-Model §2 (Grades A–J) + vectors 1–22.

## What shipped

| File | Role |
|---|---|
| [security/gate0.ts](../security/gate0.ts) | full Gate-0 normalizer: NFKC → strip invisibles/bidi/PUA/tag → detection battery (Morse, base64/32, hex, Caesar/ROT13/Atbash, leet, homoglyph; nested, depth-limited) → flag + findings. |
| [scripts/gen-adversarial.ts](../scripts/gen-adversarial.ts) | generates the corpus with **real, standard** encodings (independent of the decoders). |
| [data/adversarial/](../data/adversarial/) | one sample per Grade A–J + 4 bypass classics + clean control + README. |
| [scripts/csec-test.ts](../scripts/csec-test.ts) | the automated suite. |

Wiring: `extract.ts` (C2) routes all OCR text through `normalizeForLLM` and **logs `gate0-reject`** on a hit; `computeVerdict` (C3) takes `gate0Flagged` and makes it an automatic REJECT. Gate 0 is never bypassed.

## Suite result (`npm run csec:test`) — **17 passed, 0 failed**

**Gate-0 blocks every encoding** (each logged to `inference-log.jsonl`):

| Grade | Encoding | Detected as |
|---|---|---|
| A | plaintext injection | `A:plaintext` |
| B | Morse | `B:morse` |
| C | Base64 / Base32 | `C:base64` / `C:base32` |
| D | Hex | `D:hex` |
| E | ROT13/Caesar/Atbash | `E:rot13` |
| F | Leetspeak | `F:leet` |
| G | Homoglyph (Cyrillic) | `G:homoglyph` |
| H | Zero-width/bidi | `H:control-chars` → reveals `A:plaintext` |
| I | Image/OCR-embedded text | `A:plaintext` (vision/OCR text also passes Gate 0) |
| J | **Nested** (Base64-of-Morse) | `J:nested:morse` (iterative decode) |

**No false positive:** a real invoice with "Pay to wallet (Ethereum): 0x8ba1…" is **not** flagged.

**Bypass classics — verdict REJECTs all, clean PASSes:**

| Case | Verdict | Why |
|---|---|---|
| clean control | ✅ PASS | — |
| homoglyph vendor ("аcmе") | 🛑 REJECT | canonical name ≠ DB (#36) |
| split amount (2,500 of 5,000) | 🛑 REJECT | no exact PO (#42) |
| duplicate replay (INV-1042) | 🛑 REJECT | `settlements.invoice_ref` UNIQUE (#41) |
| wallet lookalike (same prefix/suffix) | 🛑 REJECT | EIP-55 equality fails (#45) |

## Design notes
- **Decoding is for detection, not obedience.** A decoded imperative is logged and routed to REJECT; the decoded text is never executed.
- **Plaintext vs decoded thresholds differ — this is what avoids false positives.** Plaintext only flags *override/injection* language ("ignore … instructions", "you are now", "system prompt"); a real invoice's "pay to wallet" is data. Inside a *decode* (Morse/base64/…), **any** imperative ("pay attacker", "send to 0x…") flags — because encoding an instruction is itself the attack.
- **Nested handling:** a decoded layer that isn't yet an imperative but is still printable is re-scanned (depth ≤ 3), catching Base64-of-Morse (Grade J).
- **Genuine test:** the corpus uses standard encoders; Gate-0 is an independent decoder of the same standards — not a self-referential check.
- **Defense in depth:** even if Gate 0 ever missed, Gates 2–4 (DB truth, EIP-55 recipient re-check, human approval) still make funds unreachable.

C4 can now wire real money on a hardened pipeline.
