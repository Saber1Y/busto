// Busto · C2 sample generator — a REAL clean invoice as PNG (no external deps).
// Builds an SVG and rasterizes it with macOS QuickLook (`qlmanage`). Output:
// data/sample/acme_invoice.png  (+ the .svg source alongside it).
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = resolve(REPO, "data/sample");
const SVG_PATH = resolve(OUT_DIR, "acme_invoice.svg");
const PNG_PATH = resolve(OUT_DIR, "acme_invoice.png");

const WALLET = "0x8ba1f109551bD432803012645Ac136ddd64DBA72";
const rows = [
  { d: "Industrial servo motors (NEMA-34)", q: "10", u: "350.00", a: "3,500.00" },
  { d: "On-site installation & calibration", q: "1", u: "1,200.00", a: "1,200.00" },
  { d: "Extended warranty (12 months)", q: "1", u: "300.00", a: "300.00" },
];

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function rowSvg(y: number, r: (typeof rows)[number]): string {
  return (
    `<text x="60" y="${y}" font-family="Helvetica" font-size="24" fill="#111">${esc(r.d)}</text>` +
    `<text x="720" y="${y}" font-family="Helvetica" font-size="24" fill="#111" text-anchor="end">${esc(r.q)}</text>` +
    `<text x="900" y="${y}" font-family="Helvetica" font-size="24" fill="#111" text-anchor="end">${esc(r.u)}</text>` +
    `<text x="1100" y="${y}" font-family="Helvetica" font-size="24" fill="#111" text-anchor="end">${esc(r.a)}</text>`
  );
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1160" height="1500" viewBox="0 0 1160 1500">
<rect width="1160" height="1500" fill="#ffffff"/>
<text x="60" y="90" font-family="Helvetica" font-size="44" font-weight="bold" fill="#000">ACME ROBOTICS LTD</text>
<text x="60" y="128" font-family="Helvetica" font-size="22" fill="#444">123 Industrial Way · Lagos, NG · acme-robotics.example</text>
<text x="1100" y="90" font-family="Helvetica" font-size="40" fill="#000" text-anchor="end">INVOICE</text>
<text x="1100" y="128" font-family="Helvetica" font-size="22" fill="#444" text-anchor="end">No. INV-1042</text>
<line x1="60" y1="160" x2="1100" y2="160" stroke="#000" stroke-width="2"/>
<text x="60" y="210" font-family="Helvetica" font-size="22" fill="#111">Bill To: Busto Treasury Operations</text>
<text x="1100" y="200" font-family="Helvetica" font-size="22" fill="#111" text-anchor="end">Issue date: 2026-06-20</text>
<text x="1100" y="230" font-family="Helvetica" font-size="22" fill="#111" text-anchor="end">Due date: 2026-07-15</text>
<rect x="48" y="270" width="1064" height="44" fill="#f0f0f0"/>
<text x="60" y="300" font-family="Helvetica" font-size="22" font-weight="bold" fill="#000">Description</text>
<text x="720" y="300" font-family="Helvetica" font-size="22" font-weight="bold" fill="#000" text-anchor="end">Qty</text>
<text x="900" y="300" font-family="Helvetica" font-size="22" font-weight="bold" fill="#000" text-anchor="end">Unit</text>
<text x="1100" y="300" font-family="Helvetica" font-size="22" font-weight="bold" fill="#000" text-anchor="end">Amount</text>
${rowSvg(360, rows[0])}
${rowSvg(410, rows[1])}
${rowSvg(460, rows[2])}
<line x1="60" y1="500" x2="1100" y2="500" stroke="#bbb" stroke-width="1"/>
<text x="900" y="556" font-family="Helvetica" font-size="28" font-weight="bold" fill="#000" text-anchor="end">TOTAL</text>
<text x="1100" y="556" font-family="Helvetica" font-size="28" font-weight="bold" fill="#000" text-anchor="end">5,000.00 USDT</text>
<text x="60" y="640" font-family="Helvetica" font-size="22" fill="#111">Currency: USDT (USD₮)</text>
<text x="60" y="700" font-family="Helvetica" font-size="22" fill="#111">Pay to wallet (Ethereum):</text>
<text x="60" y="738" font-family="Courier,monospace" font-size="26" fill="#000">${WALLET}</text>
<text x="60" y="1460" font-family="Helvetica" font-size="18" fill="#777">Thank you for your business. Net 30. Reference INV-1042 on payment.</text>
</svg>`;

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(SVG_PATH, svg, "utf8");

const TMP = resolve(OUT_DIR, ".ql");
mkdirSync(TMP, { recursive: true });
execFileSync("qlmanage", ["-t", "-s", "1600", "-o", TMP, SVG_PATH], { stdio: "ignore" });
const produced = resolve(TMP, "acme_invoice.svg.png");
if (!existsSync(produced)) throw new Error(`qlmanage did not produce ${produced}`);
renameSync(produced, PNG_PATH);
rmSync(TMP, { recursive: true, force: true });

const { size } = await import("node:fs").then((fs) => fs.promises.stat(PNG_PATH));
console.log(`✅ wrote ${PNG_PATH} (${Math.round(size / 1024)} KB)`);
console.log(`   svg source: ${SVG_PATH}`);
