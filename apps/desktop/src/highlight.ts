// Colours in code blocks (```yaml …```), by highlight.js: its core and the languages people
// paste most, not all 190 (that would weigh more than the rest of the app). Matrix sends a block's
// language as <code class="language-yaml">; plain-text messages (Talk) get their fences read here.
import hljs from "highlight.js/lib/core";
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

/** `code` coloured as `language` (HTML: escaped text in spans), or null for a language we don't know. */
export function highlightCode(code: string, language: string): string | null {
  const name = language.trim().toLowerCase();
  if (!name || !hljs.getLanguage(name)) return null;
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
