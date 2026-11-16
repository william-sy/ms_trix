// Verifies every locale has exactly the keys of en.json and the same {placeholders}.
//   node scripts/check-locales.mjs
import { readdirSync, readFileSync } from "node:fs";

const dir = new URL("../src/locales/", import.meta.url);
const load = (f) => JSON.parse(readFileSync(new URL(f, dir), "utf8"));
const en = load("en.json");
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
let problems = 0;

for (const file of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "en.json")) {
  const other = load(file);
  for (const key of Object.keys(en)) {
    if (!(key in other)) { console.log(`${file}: missing ${key}`); problems++; }
    else if (vars(en[key]) !== vars(other[key])) { console.log(`${file}: placeholders differ in ${key}`); problems++; }
  }
  for (const key of Object.keys(other)) if (!(key in en)) { console.log(`${file}: unknown key ${key}`); problems++; }
}
console.log(problems ? `${problems} problem(s)` : `locales OK (${Object.keys(en).length} keys)`);
process.exit(problems ? 1 : 0);
