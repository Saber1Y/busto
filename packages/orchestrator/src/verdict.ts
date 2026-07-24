import type Database from "better-sqlite3";
import { toMinorUnits, type InvoiceExtraction, type ExtractionReview } from "../../shared/src/index.ts";
import { lookupVendor, matchPurchaseOrder, verifyWallet, isDuplicateInvoice, type EmbedFn } from "./erp.ts";

// Deterministic PASS/REJECT (Gate 1: the LLM proposes; this code decides). A payment
// is impossible unless EVERY check clears. Threat-model C (36–54): vendor/PO/wallet
// from the DB, exact match, minor-units, EIP-55 — confidence never bypasses this.

/** What the vector search was asked and what it returned. Advisory evidence for the
 *  operator — it is NOT part of the decision. */
export interface RagTrace {
  query: string;
  candidates: Array<{ poNumber: string; distance: number }>;
}

export interface Verdict {
  decision: "PASS" | "REJECT";
  reasons: string[];
  matchedPO: string | null;
  knownWallet: string | null;
  /** null when no embedder was supplied, or when the vendor/amount preconditions meant
   *  no search ran. A populated trace never widens what can pass — `decision` below is
   *  computed from `checks` alone. */
  rag: RagTrace | null;
  checks: {
    gate0Clean: boolean;
    crossCheckOk: boolean;
    vendorExists: boolean;
    vendorActive: boolean;
    amountParsed: boolean;
    poMatched: boolean;
    walletMatch: boolean;
    notDuplicate: boolean;
  };
  /** OCR-vs-vision corroboration sub-results (threat #26), for the UI. null when no OCR
   *  review was supplied (e.g. a synthetic extraction with no document to cross-read). */
  crossCheck: ExtractionReview["checks"] | null;
}

function descriptionForRag(x: InvoiceExtraction): string {
  const items = x.lineItems.map((li) => li.description).filter(Boolean).join("; ");
  return items || x.vendorName;
}

export async function computeVerdict(
  db: Database.Database,
  extraction: InvoiceExtraction,
  invoiceRef: string,
  embed?: EmbedFn,
  gate0Flagged = false,
  review?: ExtractionReview,
): Promise<Verdict> {
  const reasons: string[] = [];
  const checks: Verdict["checks"] = {
    gate0Clean: !gate0Flagged, crossCheckOk: true, vendorExists: false, vendorActive: false, amountParsed: false,
    poMatched: false, walletMatch: false, notDuplicate: false,
  };
  const ok = (r: string): void => void reasons.push(`ok: ${r}`);
  const reject = (r: string): void => void reasons.push(`REJECT: ${r}`);

  // 0. Gate-0 — obfuscated injection detected upstream → block (Threat-Model §2).
  if (gate0Flagged) reject("Gate-0 flagged an obfuscated/decoded imperative in the document text");
  else ok("Gate-0: no obfuscated imperative detected");

  // 0b. OCR-vs-vision cross-check (threat #26). The two independent reads must AGREE on the
  //     material fields before the deterministic checks trust the extraction — a 5000→50000
  //     perturbation between the paths must NOT settle silently. Scoped to AMOUNT (the #26
  //     target) and VENDOR, both soundly detectable in the OCR text. The WALLET is excluded
  //     on purpose: OCR mangles long hex (O→0, l→1), so raw-substring corroboration
  //     false-positives on a CORRECT address, and the wallet already has a dedicated,
  //     OCR-tolerant gate (Gate 3 / walletMatch vs the DB). Including it would block clean
  //     invoices on OCR noise, not on real disagreement.
  const cc = review?.checks ?? null;
  checks.crossCheckOk = !cc || (cc.amountInOcr && cc.vendorInOcr);
  if (cc) {
    if (checks.crossCheckOk) ok("OCR and vision reads corroborate the amount and vendor");
    else reject(`OCR and vision disagree on the ${!cc.amountInOcr ? "amount" : "vendor"} — the two independent reads don't match (threat #26); needs review, not settling`);
  }

  // 1. Vendor existence + status (Gate 2).
  const vendor = lookupVendor(db, extraction.vendorName);
  checks.vendorExists = vendor.exists;
  if (!vendor.exists) {
    reject(`unknown vendor "${extraction.vendorName}" (not in ERP)`);
  } else {
    checks.vendorActive = vendor.status === "active";
    if (checks.vendorActive) ok(`vendor "${vendor.name}" exists and is active`);
    else reject(`vendor "${vendor.name}" is ${vendor.status}, not active`);
  }

  // 2. Amount -> canonical minor units (threat #39).
  const amountMinor = toMinorUnits(extraction.invoiceAmount, 6);
  checks.amountParsed = amountMinor !== null;
  if (amountMinor === null) reject(`invoiceAmount "${extraction.invoiceAmount}" is not parseable to canonical minor units`);

  // 3. PO match — exact vendor+amount+currency, RAG only suggests (threat #37/#38/#40).
  let matchedPO: string | null = null;
  let rag: RagTrace | null = null;
  if (vendor.exists && vendor.vendorId !== undefined && amountMinor !== null) {
    const ragQuery = descriptionForRag(extraction);
    const po = await matchPurchaseOrder(db, vendor.vendorId, amountMinor, extraction.currency, ragQuery, embed);
    if (embed) rag = { query: ragQuery, candidates: po.ragCandidates.map((c) => ({ poNumber: c.poNumber, distance: c.distance })) };
    checks.poMatched = po.matched;
    if (po.matched) {
      matchedPO = po.poNumber ?? null;
      ok(`PO ${matchedPO} matches ${extraction.invoiceAmount} ${extraction.currency} for "${vendor.name}"`);
    } else {
      const near = po.ragCandidates.map((c) => `${c.poNumber}(d=${c.distance.toFixed(3)})`).join(", ");
      reject(`no open PO matches ${extraction.invoiceAmount} ${extraction.currency} for "${vendor.name}"${near ? ` — nearest by description: ${near}` : ""}`);
    }
  }

  // 4. Wallet — Gate 3 hard recipient check (threat #45/#48/#49).
  let knownWallet: string | null = vendor.knownWallet ?? null;
  if (vendor.exists && vendor.vendorId !== undefined) {
    const w = verifyWallet(db, vendor.vendorId, extraction.providedWallet);
    knownWallet = w.knownWallet;
    checks.walletMatch = w.match;
    if (w.match) ok(`provided wallet matches DB known_wallet (${w.reason})`);
    else reject(`wallet check failed — ${w.reason}`);
  }

  // 5. Duplicate / replay (threat #41).
  checks.notDuplicate = !isDuplicateInvoice(db, invoiceRef);
  if (checks.notDuplicate) ok(`invoice_ref "${invoiceRef}" not previously settled`);
  else reject(`invoice_ref "${invoiceRef}" already settled (duplicate/replay)`);

  const decision: Verdict["decision"] =
    checks.gate0Clean && checks.crossCheckOk && checks.vendorExists && checks.vendorActive &&
    checks.amountParsed && checks.poMatched && checks.walletMatch && checks.notDuplicate
      ? "PASS"
      : "REJECT";

  return { decision, reasons, matchedPO, knownWallet, rag, checks, crossCheck: cc };
}
