import { useEffect, useRef, useState } from "react";
import { backend, formatTime } from "./backend";
import { formats } from "./Composer";
import { applyFormat, type Format } from "./format";
import { t, type Key } from "./i18n";
import { RichText } from "./RichText";
import type { Note, Org } from "./types";

// Nextcloud Notes: the notes of every Nextcloud account in view that has the Notes app, and an
// editor that saves as you type (a second after you stop, and when you leave the note).

/** A note's title: its first line, without Markdown heading or list marks. */
function titleOf(text: string): string {
  const line = text.split("\n").map((l) => l.replace(/^[#>*\-+\s]+/, "").trim()).find(Boolean) ?? "";
  // The title is also its file name in Notes.
  return line.replace(/[/\\]/g, "-").slice(0, 100) || t("notes.untitled");
}

type Listed = Note & { account: string };

/** The composer's format buttons, plus what notes often need: a heading, a checklist, a link. */
const noteFormats: { label?: string; labelKey?: Key; className?: string; title: Key; format: Format }[] = [
  { label: "H", className: "fmt-B", title: "notes.heading", format: { kind: "line", prefix: "## " } },
  ...formats,
  { label: "☑", title: "notes.checklist", format: { kind: "line", prefix: "- [ ] " } },
  { label: "🔗", title: "notes.link", format: { kind: "wrap", before: "[", after: "](https://)" } },
];

/** Category filter values besides a category's own name. */
const ALL = "\u0000all";

export function NotesPane({ orgs }: { orgs: Org[] }) {
  const [notes, setNotes] = useState<Record<string, Note[]>>({});
  const [selected, setSelected] = useState<{ account: string; id: number } | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState(ALL);
  // Naming a new category, or renaming the one in view.
  const [naming, setNaming] = useState<"new" | "rename" | null>(null);
  const [name, setName] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [target, setTarget] = useState(orgs[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const ids = orgs.map((o) => o.id).join("|");

  const load = () => {
    for (const o of orgs) backend.notes(o.id).then((list) => { setNotes((n) => ({ ...n, [o.id]: list })); setLoaded(true); }, (e) => { setError(String(e)); setLoaded(true); });
  };
  useEffect(load, [ids]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (!orgs.some((o) => o.id === target)) setTarget(orgs[0]?.id ?? ""); }, [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  const put = (account: string, note: Note) => setNotes((n) => ({ ...n, [account]: [note, ...(n[account] ?? []).filter((x) => x.id !== note.id)] }));
  const create = async () => {
    if (!target) return;
    try {
      // In the category being looked at.
      const note = await backend.saveNote(target, null, null, { title: t("notes.untitled"), content: "", category: filter === ALL ? "" : filter, favorite: false });
      put(target, note);
      setSelected({ account: target, id: note.id });
    } catch (e) {
      setError(String(e));
    }
  };

  /** Moves the notes of category `from` (and its subfolders) to `to`; "" takes the category away. */
  const moveCategory = async (from: string, to: string) => {
    const moving = every.filter((x) => x.category === from || x.category.startsWith(`${from}/`));
    // An open note would save its old category back; it closes first.
    if (moving.some((n) => selected?.account === n.account && selected.id === n.id)) setSelected(null);
    for (const n of moving) {
      const rest = n.category.slice(from.length).replace(/^\//, "");
      const category = [to, rest].filter(Boolean).join("/");
      try {
        put(n.account, await backend.saveNote(n.account, n.id, n.etag, { category }));
      } catch (e) {
        setError(String(e));
      }
    }
  };
  const tidyName = (raw: string) => raw.split("/").map((p) => p.trim()).filter(Boolean).join("/");
  const finishNaming = async () => {
    const value = tidyName(name);
    const kind = naming;
    setNaming(null);
    setName("");
    if (!value || !target) return;
    if (kind === "rename" && filter !== ALL && filter && value !== filter) {
      await moveCategory(filter, value);
      setFilter(value);
    } else if (kind === "new") {
      // A category exists through its notes: it starts with a first one.
      try {
        const note = await backend.saveNote(target, null, null, { title: t("notes.untitled"), content: "", category: value, favorite: false });
        put(target, note);
        setFilter(value);
        setSelected({ account: target, id: note.id });
      } catch (e) {
        setError(String(e));
      }
    }
  };

  const q = query.trim().toLowerCase();
  const every: Listed[] = orgs.flatMap((o) => (notes[o.id] ?? []).map((n) => ({ ...n, account: o.id })));
  const categories = [...new Set(every.map((n) => n.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const count = (c: string) => every.filter((n) => n.category === c).length;
  const all = every.filter((n) => (filter === ALL || n.category === filter) && (!q || n.title.toLowerCase().includes(q) || n.category.toLowerCase().includes(q)));
  // By category (none first), favourites on top, then the latest changed.
  const groups = new Map<string, Listed[]>();
  for (const n of all) {
    const key = `${orgs.length > 1 ? `${orgs.find((o) => o.id === n.account)?.name} · ` : ""}${n.category}`;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="notes-pane">
      <div className="notes-list">
        <div className="notes-head">
          <input value={query} placeholder={t("notes.search")} onChange={(e) => setQuery(e.target.value)} />
          <button className="icon-btn" title={t("notes.reload")} onClick={load}>↻</button>
          <button className="btn primary small" disabled={!target} onClick={() => void create()}>{t("notes.new")}</button>
        </div>
        <select className="notes-filter" value={filter} onChange={(e) => setFilter(e.target.value)} title={t("notes.category")}>
          <option value={ALL}>{t("notes.allNotes", { count: every.length })}</option>
          {count("") > 0 && <option value="">{t("notes.noCategory")} ({count("")})</option>}
          {categories.map((c) => <option key={c} value={c}>{c} ({count(c)})</option>)}
        </select>
        {naming ? (
          <form className="notes-naming" onSubmit={(e) => { e.preventDefault(); void finishNaming(); }}>
            <input autoFocus value={name} placeholder={t("notes.categoryName")} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setNaming(null)} />
            <button className="btn small primary" disabled={!tidyName(name)}>{t("common.save")}</button>
            <button type="button" className="btn small" onClick={() => setNaming(null)}>{t("common.cancel")}</button>
          </form>
        ) : (
          <div className="notes-category-tools">
            <button className="link" disabled={!target} onClick={() => { setName(""); setNaming("new"); }}>{t("notes.newCategory")}</button>
            {filter !== ALL && filter && <>
              <button className="link" onClick={() => { setName(filter); setNaming("rename"); }}>{t("notes.renameCategory")}</button>
              <button className="link" onClick={() => {
                if (confirm(t("notes.removeCategoryConfirm", { name: filter, count: count(filter) }))) void moveCategory(filter, "").then(() => setFilter(ALL));
              }}>{t("notes.removeCategory")}</button>
            </>}
          </div>
        )}
        {orgs.length > 1 && (
          <select className="notes-account" value={target} onChange={(e) => setTarget(e.target.value)} title={t("notes.newIn")}>
            {orgs.map((o) => <option key={o.id} value={o.id}>{t("notes.newInAccount", { account: o.name })}</option>)}
          </select>
        )}
        {error && <p className="error small">{error}</p>}
        {all.length === 0 && <p className="empty small">{!loaded ? t("common.loading") : q || filter !== ALL ? t("notes.noneFound") : t("notes.none")}</p>}
        {sorted.map(([key, list]) => (
          <div key={key}>
            <div className="notes-group">{key.endsWith(" · ") || !key ? `${key}${t("notes.noCategory")}` : key}</div>
            {[...list].sort((a, b) => Number(b.favorite) - Number(a.favorite) || b.modified - a.modified).map((n) => (
              <button key={`${n.account}/${n.id}`} className={`note-row ${selected?.account === n.account && selected.id === n.id ? "selected" : ""}`}
                onClick={() => setSelected({ account: n.account, id: n.id })}>
                <span className="note-title">{n.favorite && "★ "}{n.title || t("notes.untitled")}</span>
                <span className="note-time">{formatTime(n.modified * 1000)}</span>
              </button>
            ))}
          </div>
        ))}
      </div>
      {selected ? (
        <NoteEditor key={`${selected.account}/${selected.id}`} account={selected.account} id={selected.id} categories={categories}
          onSaved={(note) => put(selected.account, note)}
          onDeleted={() => { setNotes((n) => ({ ...n, [selected.account]: (n[selected.account] ?? []).filter((x) => x.id !== selected.id) })); setSelected(null); }} />
      ) : (
        <div className="notes-empty">{t("notes.pick")}</div>
      )}
    </div>
  );
}

type SaveState = "saved" | "unsaved" | "saving" | "conflict" | "error";

function NoteEditor({ account, id, categories, onSaved, onDeleted }: {
  account: string; id: number; categories: string[]; onSaved: (note: Note) => void; onDeleted: () => void;
}) {
  const [note, setNote] = useState<Note | null>(null);
  const [text, setText] = useState("");
  const [category, setCategory] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [preview, setPreview] = useState(false);
  const [html, setHtml] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>("saved");
  const [error, setError] = useState<string | null>(null);
  // Saving reads these, so a save started from an old render still sends the newest text.
  const etag = useRef("");
  const dirty = useRef(false);
  const latest = useRef({ text, category, favorite });
  latest.current = { text, category, favorite };

  const open = () => backend.note(account, id).then((n) => {
    setNote(n);
    setText(n.content ?? "");
    setCategory(n.category);
    setFavorite(n.favorite);
    etag.current = n.etag;
    dirty.current = false;
    setState("saved");
  }, (e) => setError(String(e)));
  useEffect(() => void open(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (overwrite = false) => {
    if (!dirty.current || note?.readonly) return;
    dirty.current = false;
    setState("saving");
    const now = latest.current;
    try {
      const saved = await backend.saveNote(account, id, overwrite ? null : etag.current, { title: titleOf(now.text), content: now.text, category: now.category, favorite: now.favorite });
      etag.current = saved.etag;
      onSaved(saved);
      setState(dirty.current ? "unsaved" : "saved");
    } catch (e) {
      dirty.current = true;
      setState(String(e).includes("changed elsewhere") ? "conflict" : "error");
      setError(String(e));
    }
  };
  const change = (apply: () => void) => { dirty.current = true; apply(); };
  const area = useRef<HTMLTextAreaElement>(null);
  const format = (f: Format) => {
    const el = area.current;
    if (!el || note?.readonly) return;
    const edit = applyFormat(text, el.selectionStart, el.selectionEnd, f);
    change(() => setText(edit.text));
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(edit.start, edit.end); });
  };
  // A second after the last change; and whatever is left when the note is closed.
  useEffect(() => {
    if (!dirty.current || state === "conflict") return;
    setState("unsaved");
    const timer = window.setTimeout(() => void save(), 1000);
    return () => window.clearTimeout(timer);
  }, [text, category, favorite]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => void save(), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (preview) void backend.renderMarkdown(text).then(setHtml).catch(() => setHtml(null));
  }, [preview, text]);

  if (!note) return <div className="notes-empty">{error ?? t("common.loading")}</div>;
  return (
    <div className="note-editor">
      <div className="note-toolbar">
        <button className={`icon-btn ${favorite ? "on" : ""}`} title={t("notes.favorite")} disabled={note.readonly} onClick={() => change(() => setFavorite(!favorite))}>{favorite ? "★" : "☆"}</button>
        <label className="note-category">{t("notes.category")}
          <input list="note-categories" value={category} placeholder={t("notes.noCategory")} disabled={note.readonly} title={t("notes.categoryHint")}
            onChange={(e) => change(() => setCategory(e.target.value))} /></label>
        <datalist id="note-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        <span className="spacer" />
        <span className={`note-state ${state}`}>{note.readonly ? t("notes.readonly") : t(`notes.state.${state}`)}</span>
        <div className="segmented">
          <button className={preview ? "" : "on"} onClick={() => setPreview(false)}>{t("notes.edit")}</button>
          <button className={preview ? "on" : ""} onClick={() => setPreview(true)}>{t("notes.preview")}</button>
        </div>
        {!note.readonly && (
          <button className="icon-btn" title={t("notes.delete")}
            onClick={() => { if (confirm(t("notes.deleteConfirm", { title: titleOf(text) }))) backend.deleteNote(account, id).then(onDeleted, (e) => setError(String(e))); }}>🗑</button>
        )}
      </div>
      {state === "conflict" && (
        <div className="notice" role="alert">
          {t("notes.conflict")} <button className="link" onClick={() => void save(true)}>{t("notes.keepMine")}</button> · <button className="link" onClick={() => void open()}>{t("notes.loadTheirs")}</button>
        </div>
      )}
      {state === "error" && error && <div className="notice" role="alert">{error} <button className="link" onClick={() => void save()}>{t("notes.retry")}</button></div>}
      {!preview && !note.readonly && (
        <div className="format-bar note-format">
          {noteFormats.map((f) => (
            <button key={f.title} className={`fmt ${f.className ?? ""}`} title={t(f.title)} onMouseDown={(e) => e.preventDefault()} onClick={() => format(f.format)}>
              {f.labelKey ? t(f.labelKey) : f.label}
            </button>
          ))}
        </div>
      )}
      {preview ? (
        <div className="note-preview"><RichText body={text} html={html ?? undefined} account={account} /></div>
      ) : (
        <textarea ref={area} className="note-text" autoFocus={!text} value={text} readOnly={note.readonly} placeholder={t("notes.placeholder")}
          onChange={(e) => change(() => setText(e.target.value))}
          onKeyDown={(e) => {
            // ⌘B / ⌘I (Ctrl elsewhere), as in the composer's format bar.
            if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
            const key = e.key.toLowerCase();
            if (key === "b" || key === "i") {
              e.preventDefault();
              format(key === "b" ? { kind: "wrap", before: "**", after: "**" } : { kind: "wrap", before: "_", after: "_" });
            }
          }} />
      )}
    </div>
  );
}
