// Screenshot a nav view by data-view name. Usage: node shot-nav.ts <view> <out.png>
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9336;
const [view = "vendors", out = "nav.png"] = process.argv.slice(2);

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,1000",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "custos-nav-"))}`,
  "http://127.0.0.1:4173/",
], { stdio: "ignore" });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function target(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      const p = list.find((t) => t.type === "page" && t.url.includes("4173"));
      if (p?.webSocketDebuggerUrl) return p.webSocketDebuggerUrl;
    } catch { /* wait */ }
    await sleep(500);
  }
  throw new Error("no CDP target");
}
const ws = new WebSocket(await target());
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0; const pend = new Map<number, (v: Record<string, unknown>) => void>();
ws.addEventListener("message", (ev) => { const m = JSON.parse(String(ev.data)) as { id?: number; result?: Record<string, unknown> }; if (m.id != null && pend.has(m.id)) { pend.get(m.id)!(m.result ?? {}); pend.delete(m.id); } });
const cdp = (method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> => new Promise((res) => { const n = ++id; pend.set(n, res); ws.send(JSON.stringify({ id: n, method, params })); });
const evalJs = async (e: string): Promise<unknown> => (await cdp("Runtime.evaluate", { expression: e, returnByValue: true }) as { result?: { value?: unknown } }).result?.value;

await sleep(2500);
console.log("clicked:", await evalJs(`(()=>{const b=document.querySelector('.nav-item[data-view="${view}"]');if(!b)return"no nav item";b.click();return "${view}";})()`));
await sleep(1800);
const h = await evalJs("document.documentElement.scrollHeight");
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: Math.min(2200, Number(h) || 1000), deviceScaleFactor: 2, mobile: false });
const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(out, Buffer.from(String((shot as { data?: string }).data), "base64"));
console.log(`wrote ${out}`);
ws.close(); chrome.kill(); process.exit(0);
