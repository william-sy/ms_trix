// The updater's manifest (latest.json) for a release: one entry per installer with a signature
// (.sig) next to it, keyed as the Tauri updater looks them up: first {os}-{arch}-{bundle} (it
// knows how it was installed), then {os}-{arch} (the first kind listed below for that system).
//   node scripts/update-manifest.mjs <dir> <version> <notes.md> <download base URL> > latest.json
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [dir, version, notesFile, base] = process.argv.slice(2);
if (!base) {
  console.error("usage: update-manifest.mjs <dir> <version> <notes.md> <download base URL>");
  process.exit(2);
}

const kinds = [
  [".app.tar.gz", "darwin", "app"],
  ["-setup.exe", "windows", "nsis"],
  [".msi", "windows", "msi"],
  [".AppImage", "linux", "appimage"],
  [".deb", "linux", "deb"],
  [".rpm", "linux", "rpm"],
];
const files = readdirSync(dir);
const platforms = {};
for (const [ending, os, bundle] of kinds) {
  for (const sig of files.filter((f) => f.endsWith(`${ending}.sig`))) {
    const name = sig.slice(0, -".sig".length);
    if (!files.includes(name)) continue;
    const arch = /aarch64|arm64/.test(name) ? "aarch64" : "x86_64";
    const entry = { signature: readFileSync(join(dir, sig), "utf8").trim(), url: `${base}/${encodeURIComponent(name)}` };
    platforms[`${os}-${arch}-${bundle}`] = entry;
    platforms[`${os}-${arch}`] ??= entry;
  }
}
if (!Object.keys(platforms).length) {
  console.error("No signed installers (.sig) found: is the TAURI_SIGNING_PRIVATE_KEY secret set?");
  process.exit(1);
}
const notes = readFileSync(notesFile, "utf8").trim();
process.stdout.write(`${JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2)}\n`);
