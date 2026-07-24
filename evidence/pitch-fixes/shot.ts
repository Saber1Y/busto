// Screenshot the live dashboard mid-verification, driving headless Chrome over CDP with
// Node's built-in WebSocket. Used to prove UI changes render for real rather than
// asserting "should work". Usage: node shot.ts <sample-index> <out.png> [waitMs]
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9333;
const [sampleIdx = "0", out = "shot.png", waitMs = "40000"] = process.argv.slice(2);

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,1400",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "custos-shot-"))}`,
  "http://127.0.0.1:4173/",
], { stdio: "ignore" });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function target(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      const page = list.find((t) => t.type === "page" && t.url.includes("4173"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error("no CDP target");
}

const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));

let id = 0;
const pending = new Map<number, (v: Record<string, unknown>) => void>();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown> };
  if (m.id != null && pending.has(m.id)) { pending.get(m.id)!(m.result ?? {}); pending.delete(m.id); }
});
const cdp = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  new Promise((res) => { const n = ++id; pending.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });

await sleep(2500); // let the samples list fetch and render
const clicked = await cdp("Runtime.evaluate", {
  expression: `(() => { const b = document.querySelectorAll(".sample")[${sampleIdx}]; if (!b) return "no sample button"; b.click(); return "clicked: " + b.textContent.slice(0, 40); })()`,
  returnByValue: true,
});
console.log(String((clicked.result as { value?: unknown })?.value));

await sleep(Number(waitMs));
const h = await cdp("Runtime.evaluate", { expression: "document.documentElement.scrollHeight", returnByValue: true });
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: Math.min(3000, Number((h.result as { value?: number })?.value ?? 1400)), deviceScaleFactor: 2, mobile: false });
const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(out, Buffer.from(String((shot as { data?: string }).data), "base64"));
console.log(`wrote ${out}`);

ws.close();
chrome.kill();
process.exit(0);
