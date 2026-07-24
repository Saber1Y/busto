// Screenshot the live dashboard after a verify AND a follow-up question, so both the
// tool-calling trace and the profiler footer are captured. Drives headless Chrome over
// CDP. Usage: node shot-flow.ts <sampleIdx> <out.png> [askChip=1]
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9334;
const [sampleIdx = "0", out = "shot.png", ask = "1"] = process.argv.slice(2);

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,1800",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "custos-shotflow-"))}`,
  "http://127.0.0.1:4173/",
], { stdio: "ignore" });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
async function target(): Promise<string> {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json() as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
      const page = list.find((t) => t.type === "page" && t.url.includes("4173"));
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* not up */ }
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
const evalJs = async (expr: string): Promise<unknown> => {
  const r = await cdp("Runtime.evaluate", { expression: expr, returnByValue: true });
  return (r.result as { value?: unknown })?.value;
};

await sleep(2500);
console.log("click sample:", await evalJs(`(()=>{const b=document.querySelectorAll(".sample")[${sampleIdx}];if(!b)return"none";b.click();return b.textContent.slice(0,30);})()`));
await sleep(52000); // verify (tool-calling nearly doubles it) + settle-card render

if (ask === "1") {
  // Click the first suggestion chip to trigger the read-only explainer (profiler footer).
  console.log("click chip:", await evalJs(`(()=>{const c=[...document.querySelectorAll(".chip")].filter(x=>x.offsetParent);const b=c[c.length-1]||c[0];if(!b)return"none";b.click();return b.textContent.slice(0,40);})()`));
  await sleep(14000);
  await evalJs(`window.scrollTo(0, document.body.scrollHeight)`);
  await sleep(500);
}

const h = await evalJs("document.documentElement.scrollHeight");
await cdp("Emulation.setDeviceMetricsOverride", { width: 1440, height: Math.min(4000, Number(h) || 1800), deviceScaleFactor: 2, mobile: false });
const shot = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
writeFileSync(out, Buffer.from(String((shot as { data?: string }).data), "base64"));
console.log(`wrote ${out}`);
ws.close(); chrome.kill(); process.exit(0);
