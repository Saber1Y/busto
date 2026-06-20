import type Database from "better-sqlite3";
import { toMinorUnits, type InvoiceExtraction } from "../../shared/src/index.ts";
import { lookupVendor, matchPurchaseOrder, verifyWallet, isDuplicateInvoice, type EmbedFn } from "./erp.ts";

// Deterministic PASS/REJECT (Gate 1: the LLM proposes; this code decides). A payment
// is impossible unless EVERY check clears. Threat-model C (36–54): vendor/PO/wallet
// from the DB, exact match, minor-units, EIP-55 — confidence never bypasses this.

export interface Verdict {
  decision: "PASS" | "REJECT";
  reasons: string[];
  matchedPO: string | null;
  knownWallet: string | null;
  checks: {
    gate0Clean: boolean;
    vendorExists: boolean;
    vendorActive: boolean;
    amountParsed: boolean;
    poMatched: boolean;
    walletMatch: boolean;
    notDuplicate: boolean;
  };
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
): Promise<Verdict> {
  const reasons: string[] = [];
  const checks: Verdict["checks"] = {
    gate0Clean: !gate0Flagged, vendorExists: false, vendorActive: false, amountParsed: false,
    poMatched: false, walletMatch: false, notDuplicate: false,
  };
  const ok = (r: string): void => void reasons.push(`ok: ${r}`);
  const reject = (r: string): void => void reasons.push(`REJECT: ${r}`);

  // 0. Gate-0 — obfuscated injection detected upstream → block (Threat-Model §2).
  if (gate0Flagged) reject("Gate-0 flagged an obfuscated/decoded imperative in the document text");
  else ok("Gate-0: no obfuscated imperative detected");

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
  if (vendor.exists && vendor.vendorId !== undefined && amountMinor !== null) {
    const po = await matchPurchaseOrder(db, vendor.vendorId, amountMinor, extraction.currency, descriptionForRag(extraction), embed);
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
    checks.gate0Clean && checks.vendorExists && checks.vendorActive && checks.amountParsed &&
    checks.poMatched && checks.walletMatch && checks.notDuplicate
      ? "PASS"
      : "REJECT";

  return { decision, reasons, matchedPO, knownWallet, checks };
}
