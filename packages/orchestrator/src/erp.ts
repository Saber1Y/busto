import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { addressMatchTolerant, toChecksumAddress } from "../../shared/src/index.ts";
import { toMinorUnits } from "../../shared/src/index.ts";

// Air-gapped SQLite ERP — the deterministic source of truth (Gate 2). Vendor / PO /
// wallet come from here, NEVER the document. Parameterized SQL only (threat #44).

export const EMBED_DIM = 1024; // GTE-large

export type EmbedFn = (text: string) => Promise<number[]>;

export interface VendorRow { id: number; name: string; known_wallet: string; status: string }
export interface PoRow { id: number; vendor_id: number; po_number: string; amount_minor: string; currency: string; status: string; description: string }

export interface VendorLookup {
  exists: boolean;
  vendorId?: number;
  name?: string;
  knownWallet?: string;
  status?: string;
}
export interface PoMatch {
  matched: boolean;
  poId?: number;
  poNumber?: string;
  ragCandidates: Array<{ poId: number; poNumber: string; distance: number }>;
}
export interface WalletCheck { match: boolean; knownWallet: string | null; reason: string }

const SEED_VENDORS = [
  { name: "Acme Robotics Ltd", wallet: "0x8ba1f109551bD432803012645Ac136ddd64DBA72", status: "active" },
  { name: "Globex Corporation", wallet: "0x6B175474E89094C44Da98b954EedeAC495271d0F", status: "active" },
  { name: "Initech LLC", wallet: "0xdAC17F958D2ee523a2206206994597C13D831ec7", status: "inactive" },
];

const SEED_POS = [
  { vendor: "Acme Robotics Ltd", po: "PO-1042", amount: "5000", currency: "USDT", status: "open",
    description: "Industrial servo motors NEMA-34 with on-site installation, calibration and extended warranty" },
  { vendor: "Acme Robotics Ltd", po: "PO-1043", amount: "2000", currency: "USDT", status: "open",
    description: "Replacement gripper assemblies and pneumatic spare parts" },
  { vendor: "Acme Robotics Ltd", po: "PO-TEST", amount: "1", currency: "USDT", status: "open",
    description: "C4 live-settlement test order — single unit, on-chain proof" },
  { vendor: "Globex Corporation", po: "PO-2001", amount: "12000", currency: "USDT", status: "open",
    description: "Annual SCADA software license and premium support" },
];

/** NFKC + lowercase + alnum-collapse. Exact match vs this canonical form rejects
 *  homoglyph/whitespace spoofs (threat #36) — a spoof simply won't equal it. */
export function canonicalizeName(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function openErp(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  sqliteVec.load(db);
  return db;
}

export function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_canonical TEXT NOT NULL UNIQUE,
      known_wallet TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY, vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      po_number TEXT NOT NULL, amount_minor TEXT NOT NULL, currency TEXT NOT NULL,
      status TEXT NOT NULL, description TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settlements (
      id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL REFERENCES purchase_orders(id),
      invoice_ref TEXT NOT NULL UNIQUE, tx_hash TEXT, amount_minor TEXT NOT NULL, ts TEXT NOT NULL
    );
  `);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS po_vectors USING vec0(embedding float[${EMBED_DIM}]);`);
}

/** Full wipe INCLUDING settlement history — the explicit `npm run demo:reset` path only.
 *  Boot-time seeding never calls this, so a settled invoice survives a server restart. */
export function resetErp(db: Database.Database): void {
  db.exec("DELETE FROM settlements; DELETE FROM purchase_orders; DELETE FROM vendors; DELETE FROM po_vectors;");
}

/** Seed the ERP deterministically, but ONLY when it is empty — so vendors/POs/vectors AND
 *  the settlement history persist across restarts (the replay guard depends on that). A
 *  populated ERP is left untouched; `resetErp` (demo:reset) is the explicit way to clear it.
 *  With `embed`, also populates the PO vector store (RAG); without it, exact-match works. */
export async function seedErp(db: Database.Database, embed?: EmbedFn): Promise<void> {
  const alreadySeeded = (db.prepare("SELECT COUNT(*) AS n FROM vendors").get() as { n: number }).n > 0;
  if (alreadySeeded) return; // preserve the ERP + settlements across boots; demo:reset clears

  // Fresh ERP (brand new, or just after resetErp): tables are empty. Defensive clean of the
  // ERP tables — NEVER settlements — in case a prior seed half-completed.
  db.exec("DELETE FROM purchase_orders; DELETE FROM vendors; DELETE FROM po_vectors;");

  const insV = db.prepare("INSERT INTO vendors(name, name_canonical, known_wallet, status) VALUES (?,?,?,?)");
  const vendorId = new Map<string, number>();
  for (const v of SEED_VENDORS) {
    const info = insV.run(v.name, canonicalizeName(v.name), toChecksumAddress(v.wallet), v.status);
    vendorId.set(v.name, Number(info.lastInsertRowid));
  }

  const insPo = db.prepare("INSERT INTO purchase_orders(vendor_id, po_number, amount_minor, currency, status, description) VALUES (?,?,?,?,?,?)");
  const insVec = db.prepare("INSERT INTO po_vectors(rowid, embedding) VALUES (?, ?)");
  for (const p of SEED_POS) {
    const minor = toMinorUnits(p.amount, 6);
    if (minor === null) throw new Error(`seed: bad amount ${p.amount}`);
    const info = insPo.run(vendorId.get(p.vendor), p.po, minor.toString(), p.currency, p.status, p.description);
    if (embed) {
      const vec = await embed(p.description);
      if (vec.length !== EMBED_DIM) throw new Error(`seed: embed dim ${vec.length} != ${EMBED_DIM}`);
      insVec.run(BigInt(Number(info.lastInsertRowid)), Buffer.from(new Float32Array(vec).buffer));
    }
  }
}

/** Record an on-chain settlement (Gate 5 / C4). UNIQUE invoice_ref blocks replays (#41). */
export function recordSettlement(db: Database.Database, poId: number, invoiceRef: string, amountMinor: bigint, txHash: string | null, ts: string): void {
  db.prepare("INSERT INTO settlements(po_id, invoice_ref, tx_hash, amount_minor, ts) VALUES (?,?,?,?,?)")
    .run(poId, invoiceRef, txHash, amountMinor.toString(), ts);
}

/** Gate 2 — vendor existence by exact canonical name. */
export function lookupVendor(db: Database.Database, name: string): VendorLookup {
  const row = db.prepare("SELECT id, name, known_wallet, status FROM vendors WHERE name_canonical = ?")
    .get(canonicalizeName(name)) as VendorRow | undefined;
  if (!row) return { exists: false };
  return { exists: true, vendorId: row.id, name: row.name, knownWallet: row.known_wallet, status: row.status };
}

/** Gate 2 — PO match: EXACT (vendor+amount+currency+open) authorizes; RAG only suggests
 *  (threat #37/#38). */
export async function matchPurchaseOrder(
  db: Database.Database,
  vendorId: number,
  amountMinor: bigint,
  currency: string,
  description: string,
  embed?: EmbedFn,
): Promise<PoMatch> {
  const exact = db.prepare(
    "SELECT id, po_number FROM purchase_orders WHERE vendor_id = ? AND amount_minor = ? AND currency = ? AND status = 'open'",
  ).get(vendorId, amountMinor.toString(), currency) as { id: number; po_number: string } | undefined;

  const ragCandidates: PoMatch["ragCandidates"] = [];
  if (embed) {
    const vec = await embed(description);
    const knn = db.prepare(
      "SELECT rowid AS po_id, distance FROM po_vectors WHERE embedding MATCH ? ORDER BY distance LIMIT ?",
    ).all(Buffer.from(new Float32Array(vec).buffer), 3) as Array<{ po_id: number; distance: number }>;
    for (const k of knn) {
      const po = db.prepare("SELECT po_number, vendor_id FROM purchase_orders WHERE id = ?")
        .get(k.po_id) as { po_number: string; vendor_id: number } | undefined;
      if (po && po.vendor_id === vendorId) ragCandidates.push({ poId: k.po_id, poNumber: po.po_number, distance: k.distance });
    }
  }

  return exact
    ? { matched: true, poId: exact.id, poNumber: exact.po_number, ragCandidates }
    : { matched: false, ragCandidates };
}

/**
 * Document-wallet corroboration vs DB known_wallet (threat #45/#48). OCR/vision-noise
 * tolerant: a legit read lands within ≤2 chars after confusable folding; an attacker /
 * lookalike differs in many positions and is rejected. The PAYOUT always uses the DB
 * address (Gate 3, strict, at sign time) — this only decides corroboration.
 */
export function verifyWallet(db: Database.Database, vendorId: number, providedWallet: string): WalletCheck {
  const row = db.prepare("SELECT known_wallet FROM vendors WHERE id = ?").get(vendorId) as { known_wallet: string } | undefined;
  if (!row) return { match: false, knownWallet: null, reason: "vendor not found" };
  const m = addressMatchTolerant(providedWallet, row.known_wallet, 2);
  if (m.match) {
    return { match: true, knownWallet: row.known_wallet, reason: m.exact ? "matches DB known_wallet (exact)" : `corroborates DB known_wallet (${m.drift} OCR correction${m.drift === 1 ? "" : "s"})` };
  }
  return { match: false, knownWallet: row.known_wallet, reason: `provided wallet does not corroborate DB known_wallet (drift ${m.drift})` };
}

/** Threat #41 — duplicate/replay invoice guard (settlements.invoice_ref UNIQUE). */
export function isDuplicateInvoice(db: Database.Database, invoiceRef: string): boolean {
  const row = db.prepare("SELECT 1 FROM settlements WHERE invoice_ref = ?").get(invoiceRef);
  return row !== undefined;
}
