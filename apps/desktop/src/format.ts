// Markdown formatting for the composer's format bar. Pure, so it is easy to test.

export type Format =
  | { kind: "wrap"; before: string; after: string }
  /** Prefixes every selected line (or the current line); toggles off if all have it. */
  | { kind: "line"; prefix: string; numbered?: boolean }
  | { kind: "block" };

export interface Edit {
  text: string;
  /** Selection to restore after the edit. */
  start: number;
  end: number;
}

export function applyFormat(text: string, start: number, end: number, format: Format): Edit {
  const selected = text.slice(start, end);

  if (format.kind === "wrap") {
    const inserted = format.before + selected + format.after;
    const next = text.slice(0, start) + inserted + text.slice(end);
    // Nothing selected: put the cursor between the markers so you can type.
    return selected ? { text: next, start, end: start + inserted.length } : { text: next, start: start + format.before.length, end: start + format.before.length };
  }

  if (format.kind === "block") {
    const before = start > 0 && text[start - 1] !== "\n" ? "\n" : "";
    const after = end < text.length && text[end] !== "\n" ? "\n" : "";
    const open = `${before}\`\`\`\n`;
    const inserted = `${open}${selected}\n\`\`\`${after}`;
    const cursor = start + open.length;
    return { text: text.slice(0, start) + inserted + text.slice(end), start: cursor, end: cursor + selected.length };
  }

  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = text.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  const lines = text.slice(lineStart, lineEnd).split("\n");
  const marker = (i: number) => (format.numbered ? `${i + 1}. ` : format.prefix);
  const has = (line: string, i: number) => (format.numbered ? /^\d+\. /.test(line) : line.startsWith(marker(i)));
  const removing = lines.every(has);
  const changed = lines.map((line, i) => (removing ? line.replace(format.numbered ? /^\d+\. / : marker(i), "") : marker(i) + line)).join("\n");
  return { text: text.slice(0, lineStart) + changed + text.slice(lineEnd), start: lineStart + changed.length, end: lineStart + changed.length };
}
