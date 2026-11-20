// Colours in code blocks (```yaml …```), by highlight.js. The languages people paste most are
// built in; all the others (about 190 in all) load the first time a message uses them, so the app
// doesn't carry them all. Matrix sends a block's language as <code class="language-yaml">;
// plain-text messages (Talk) get their fences read here.
import { useEffect, useState } from "react";
import hljs from "highlight.js/lib/core";
import type { LanguageFn } from "highlight.js";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import nginx from "highlight.js/lib/languages/nginx";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

// Each comes with its usual short names too (yml, sh, js, ts, py, rs, html, toml, …).
for (const [name, language] of Object.entries({ bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, nginx, php, powershell, python, ruby, rust, shell, sql, swift, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language);
}

// Every other language, each its own small file, loaded on first use.
const files = import.meta.glob<{ default: LanguageFn }>(["/node_modules/highlight.js/es/languages/*.js", "!/node_modules/highlight.js/es/languages/*.js.js"]);
const later = new Map(Object.entries(files).map(([path, load]) => [path.slice(path.lastIndexOf("/") + 1, -".js".length), load]));
/** Short names of languages that aren't loaded yet (loaded ones know their own). */
const SHORT: Record<string, string> = {
  hs: "haskell", pl: "perl", pm: "perl", ex: "elixir", exs: "elixir", erl: "erlang", clj: "clojure", fs: "fsharp", ml: "ocaml",
  jl: "julia", make: "makefile", mk: "makefile", proto: "protobuf", tex: "latex", gql: "graphql", objc: "objectivec", vb: "vbnet",
  lisp: "lisp", el: "lisp", scm: "scheme", ps: "powershell", tf: "ini", hcl: "ini", sass: "scss", styl: "stylus", pas: "delphi",
  asm: "x86asm", nim: "nim", zig: "zig", cr: "crystal", v: "verilog", sv: "verilog", vhd: "vhdl", m: "matlab",
};
const loading = new Map<string, Promise<boolean>>();
const loaded = new Set<() => void>();
let version = 0;

/** Loads a language that isn't built in; true once it can colour. */
export function ensureLanguage(language: string): Promise<boolean> {
  const name = language.trim().toLowerCase();
  const file = SHORT[name] ?? name;
  if (!name || hljs.getLanguage(name)) return Promise.resolve(!!name);
  const load = later.get(file);
  if (!load) return Promise.resolve(false);
  let pending = loading.get(file);
  if (!pending) {
    pending = load().then((m) => {
      hljs.registerLanguage(file, m.default);
      if (SHORT[name]) hljs.registerAliases(name, { languageName: file });
      version++;
      loaded.forEach((l) => l());
      return true;
    }, () => false);
    loading.set(file, pending);
  }
  return pending;
}

/** Changes when another language has loaded, so code shown before can get its colours. */
export function useHighlightVersion(): number {
  const [v, setV] = useState(version);
  useEffect(() => {
    const update = () => setV(version);
    loaded.add(update);
    return () => void loaded.delete(update);
  }, []);
  return v;
}

/**
 * `code` coloured as `language` (HTML: escaped text in spans), or null: a language we don't know,
 * or one still loading (it colours once loaded; see useHighlightVersion).
 */
export function highlightCode(code: string, language: string): string | null {
  const name = language.trim().toLowerCase();
  if (!name) return null;
  if (!hljs.getLanguage(name)) {
    void ensureLanguage(name);
    return null;
  }
  try {
    return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

/** Colours the code blocks with a language inside `root` (a sanitized message). */
export function highlightIn(root: Element) {
  for (const code of root.querySelectorAll("pre > code")) {
    const language = [...code.classList].find((c) => c.startsWith("language-"))?.slice("language-".length);
    const html = language && highlightCode(code.textContent ?? "", language);
    if (html) {
      code.innerHTML = html;
      code.classList.add("hljs");
    }
  }
}

/** A fenced block in plain text: ```lang, the code, ```. */
export const FENCE = /```([\w+#.-]*)[^\n]*\n([\s\S]*?)\n?```/g;
