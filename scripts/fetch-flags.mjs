// Square national flags (flag-icons, MIT) -> web/public/flags/<code>.svg, served from our own hosting.
// Only missing files are fetched; the list is web/src/data/flags.js. Run: node scripts/fetch-flags.mjs
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FLAGS } from "../web/src/data/flags.js";

const OUT = "web/public/flags", BASE = "https://cdn.jsdelivr.net/npm/flag-icons@7.2.3/flags/1x1/";
mkdirSync(OUT, { recursive: true });
let got = 0, failed = 0;
for (const code of new Set(Object.values(FLAGS))) {
  const file = join(OUT, `${code}.svg`); if (existsSync(file)) continue;
  try {
    const r = await fetch(BASE + code + ".svg");
    const text = await r.text();
    if (!r.ok || !text.trimStart().startsWith("<svg")) throw new Error(`HTTP ${r.status}`);
    writeFileSync(file, text); got++;
  } catch (e) { failed++; console.warn(`${code}: ${e.message}`); }
}
console.log(`${got} new, ${failed} failed`);
if (failed) process.exit(1);
