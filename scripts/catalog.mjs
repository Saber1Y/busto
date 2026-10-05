// Busto · C0 catalog probe — introspect the INSTALLED @qvac/sdk (ground truth, not docs).
// Lists named exports, isolates model-id constants, and reports the package's
// declared version + entry points. Throwaway verification script (P0).
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function pkgMeta(name) {
  try {
    const p = require.resolve(`${name}/package.json`);
    const j = JSON.parse(readFileSync(p, "utf8"));
    return { resolved: p, version: j.version, main: j.main, module: j.module, exports: j.exports, type: j.type };
  } catch (e) {
    return { error: String(e?.message ?? e) };
  }
}

async function dumpExports(name) {
  try {
    const mod = await import(name);
    const keys = Object.keys(mod).sort();
    const constants = keys.filter((k) => /^[A-Z0-9_]+$/.test(k));
    const fns = keys.filter((k) => typeof mod[k] === "function" && !/^[A-Z0-9_]+$/.test(k));
    const constValues = {};
    for (const k of constants) {
      const v = mod[k];
      constValues[k] = typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v
        : typeof v === "object" && v !== null ? JSON.stringify(v).slice(0, 400)
        : typeof v;
    }
    return { ok: true, totalExports: keys.length, functions: fns, modelConstants: constValues, allKeys: keys };
  } catch (e) {
    return { ok: false, error: String(e?.stack ?? e) };
  }
}

const target = process.argv[2] || "@qvac/sdk";
console.log("=== package meta:", target, "===");
console.log(JSON.stringify(pkgMeta(target), null, 2));
console.log("\n=== exports:", target, "===");
console.log(JSON.stringify(await dumpExports(target), null, 2));
