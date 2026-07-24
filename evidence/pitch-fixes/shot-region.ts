// Verify a sample, then screenshot the VIEWPORT scrolled so a target line is in view —
// used to capture the tool-calling header + first tool calls, which sit high in a tall page.
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 9335;
const [sampleIdx = "0", out = "shot.png", needle = "Model gathered facts"] = process.argv.slice(2);

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  `--remote-debugging-port=${PORT}`, "--window-size=1440,1100",
  `--user-data-dir=${mkdtempSync(join(tmpdir(), "custos-shotregion-"))}`,
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
const evalJs = async (expr: string): Promise<unknown> => (await cdp("Runtime.evaluate", { expression: expr, returnByValue: true }) as { result?: { value?: unknown } }).result?.value;

await sleep(2500);
console.log("click:", await evalJs(`(()=>{const b=document.querySelectorAll(".sample")[${sampleIdx}];b&&b.click();return b?b.textContent.slice(0,24):"none";})()`));
await sleep(52000);
console.log("scrolled:", await evalJs(`(()=>{const n=[...document.querySelectorAll(".rl-text")].find(e=>e.textContent.includes(${JSON.stringify(needle)}));if(!n)return"needle not found";n.scrollIntoView({block:"start"});window.scrollBy(0,-90);return"ok";})()`));
await sleep(600);
const shot = await cdp("Page.captureScreenshot", { format: "png" });
writeFileSync(out, Buffer.from(String((shot as { data?: string }).data), "base64"));
console.log(`wrote ${out}`);
ws.close(); chrome.kill(); process.exit(0);
