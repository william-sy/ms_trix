import { useEffect, useRef, useState, type ReactNode } from "react";
import { commandList, runCommand } from "./commands";
import { EmojiPicker } from "./EmojiPicker";
import { autoReplace } from "./emoticons";
import { applyFormat, insertTable as tableEdit, type Format } from "./format";
import { AttachIcon, EmojiIcon, FormatIcon, MicIcon, PlusIcon, SendIcon } from "./Icons";
import { sendLaterChoices } from "./scheduled";
import { formatDuration, useVoiceRecorder, type Voice } from "./voice";
import { backend, isLive, mediaUrl, type ImagePack, type PackImage } from "./backend";
import type { Attachment, Member, Message, Outgoing } from "./types";
import { locale, t, type Key } from "./i18n";
import { currentSettings, isMac } from "./settings";
import { useClickOutside } from "./hooks";
import { findDates, longDate } from "./dates";

// Markdown the format buttons insert; the adapter sends it as rich text.
// `label` is a symbol shown as-is; `labelKey` is translated.
export const formats: { label?: string; labelKey?: Key; className?: string; title: Key; format: Format }[] = [
  { label: "B", className: "fmt-B", title: "composer.bold", format: { kind: "wrap", before: "**", after: "**" } },
  { label: "I", className: "fmt-I", title: "composer.italic", format: { kind: "wrap", before: "_", after: "_" } },
  { label: "S", className: "fmt-S", title: "composer.strike", format: { kind: "wrap", before: "~~", after: "~~" } },
  { labelKey: "composer.label.bullets", title: "composer.bullets", format: { kind: "line", prefix: "- " } },
  { labelKey: "composer.label.numbered", title: "composer.numbered", format: { kind: "line", prefix: "", numbered: true } },
  { labelKey: "composer.label.quote", title: "composer.quote", format: { kind: "line", prefix: "> " } },
  { label: "</>", title: "composer.code", format: { kind: "wrap", before: "`", after: "`" } },
  { labelKey: "composer.label.codeBlock", title: "composer.codeBlock", format: { kind: "block" } },
];

// Remembered until there is a settings page for it.
const RICH_KEY = "Trixcomm.composer.rich";
const loadRich = () => { try { return localStorage.getItem(RICH_KEY) === "1"; } catch { return false; } };
const saveRich = (v: boolean) => { try { localStorage.setItem(RICH_KEY, v ? "1" : "0"); } catch { /* private mode */ } };

const escapeMarkdown = (s: string) => s.replace(/[[\]()\\]/g, "\\$&");
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const formatSize = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(0)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The text with picked mentions wrapped in pills, drawn behind the textarea. */
function mirror(text: string, names: string[]): ReactNode[] {
  if (!names.length) return [text];
  const re = new RegExp(`(${names.sort((a, b) => b.length - a.length).map((n) => escapeRegExp(`@${n}`)).join("|")})`, "g");
  return text.split(re).map((part, i) => (i % 2 ? <span key={i} className="mention-pill">{part}</span> : part));
}

interface Props {
  initial?: string;
  placeholder?: string;
  replyTo?: Message | null;
  onCancelReply?: () => void;
  onSend: (m: Outgoing) => void;
  /** Send later: the message is sent at `at` (ms) instead of now. */
  onSchedule?: (m: Outgoing, at: number) => void;
  /** Record and send voice messages (main chat only). */
  onVoice?: (v: Voice) => void;
  /** Custom emoji and sticker packs for this chat, and sending a sticker. */
  getPacks?: () => Promise<ImagePack[]>;
  onSticker?: (image: PackImage) => void;
  account?: string;
  onNotice: (message: string) => void;
  onTyping?: (typing: boolean) => void;
  onCommand?: (name: string, args: string) => void;
  getMembers?: () => Promise<Member[]>;
  /** What's typed, a moment after typing stops and when the box goes (another chat): the draft. */
  onDraft?: (text: string) => void;
  /** Staged files; omit to disable attachments (e.g. in threads). */
  attachments?: Attachment[];
  onPickFiles?: () => void;
  /** Attach from Nextcloud Files (shows a small menu on the attach button). */
  onPickCloud?: () => void;
  onAddFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
}

export function Composer(p: Props) {
  const { initial, placeholder = t("composer.placeholder"), replyTo, onCancelReply, onSend, onNotice, onTyping, onCommand, getMembers } = p;
  const attachments = p.attachments ?? [];
  const [text, setText] = useState(initial ?? "");
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    if (!p.onDraft) return;
    const timer = window.setTimeout(() => p.onDraft?.(text), 500);
    return () => window.clearTimeout(timer);
  }, [text]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => p.onDraft?.(textRef.current), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [cursor, setCursor] = useState(0);
  const [members, setMembers] = useState<Member[] | null>(null);
  // Display name typed as "@Name" -> user id; turned into a proper mention on send.
  const [mentioned, setMentioned] = useState<Record<string, string>>({});
  const [rich, setRichState] = useState(loadRich);
  const [emoji, setEmoji] = useState(false);
  const [stickers, setStickers] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  useEffect(() => {
    if (!attachMenu) return;
    const close = () => setAttachMenu(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [attachMenu]);
  const [packs, setPacks] = useState<ImagePack[]>([]);
  // Custom emoji typed as :shortcode: -> image URL, sent along so they show as images.
  const [emotes, setEmotes] = useState<Record<string, string>>({});
  useEffect(() => {
    if ((emoji || stickers) && p.getPacks) p.getPacks().then(setPacks).catch(() => setPacks([]));
  }, [emoji, stickers]); // eslint-disable-line react-hooks/exhaustive-deps
  const input = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const typingSince = useRef(0);

  const setRich = (v: boolean) => { setRichState(v); saveRich(v); };

  const mentionQuery = /(?:^|\s)@([^\s@]*)$/.exec(text.slice(0, cursor))?.[1];
  useEffect(() => {
    if (mentionQuery !== undefined && members === null && getMembers) getMembers().then(setMembers).catch(() => setMembers([]));
  }, [mentionQuery, members, getMembers]);
  const mentionHits = mentionQuery === undefined || !members ? [] : members
    .filter((m) => `${m.name} ${m.userId}`.toLowerCase().includes(mentionQuery.toLowerCase()))
    .slice(0, 8);
  // /help opens the full list; typing "/" filters it as you go.
  const [showHelp, setShowHelp] = useState(false);
  const suggestions = /^\/\S*$/.test(text) ? commandList.filter((c) => c.name.startsWith(text.slice(1).toLowerCase())) : showHelp && !text ? commandList : [];
  const canSend = !!text.trim() || attachments.length > 0;

  // Spelling (macOS): the system's correction for the word just typed, which Tab takes. (The
  // web view's own suggestions can't be accepted with Tab.) Esc hides it for that word.
  const [spell, setSpell] = useState<{ word: string; start: number; fix: string } | null>(null);
  const dismissedSpell = useRef<string | null>(null);
  useEffect(() => {
    setSpell(null);
    if (!isLive || !isMac || !currentSettings().spellCheck || mentionQuery !== undefined || text.startsWith("/")) return;
    // Only with the cursor right after a word, not in the middle of one.
    if (/[\p{L}']/u.test(text.charAt(cursor))) return;
    const before = text.slice(0, cursor);
    const word = /[\p{L}']{3,}$/u.exec(before);
    if (!word || dismissedSpell.current === `${word.index}:${word[0]}`) return;
    let live = true;
    const timer = window.setTimeout(() => {
      backend.spellSuggestion(before).then((fix) => { if (live && fix) setSpell({ word: word[0], start: word.index, fix }); }).catch(() => {});
    }, 250);
    return () => { live = false; window.clearTimeout(timer); };
  }, [text, cursor]); // eslint-disable-line react-hooks/exhaustive-deps
  const acceptSpell = () => {
    if (!spell) return;
    update(text.slice(0, spell.start) + spell.fix + text.slice(spell.start + spell.word.length), spell.start + spell.fix.length);
    setSpell(null);
  };
  const voice = useVoiceRecorder((v) => p.onVoice?.(v), (message) => onNotice(t("composer.micError", { error: message })), () => onNotice(t("composer.micSilent")));

  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);

  // Tell others we're typing at most every 4s; stop when the box empties or we send.
  const typing = (value: string) => {
    if (!onTyping) return;
    if (!value.trim()) {
      if (typingSince.current) onTyping(false);
      typingSince.current = 0;
    } else if (Date.now() - typingSince.current > 4000) {
      onTyping(true);
      typingSince.current = Date.now();
    }
  };
  useEffect(() => () => { if (typingSince.current) onTyping?.(false); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const update = (next: string, at: number) => {
    setText(next);
    setCursor(at);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(at, at); });
  };

  const pickMention = (m: Member) => {
    const start = cursor - (mentionQuery?.length ?? 0) - 1;
    const inserted = `@${m.name} `;
    setMentioned({ ...mentioned, [m.name]: m.userId });
    update(text.slice(0, start) + inserted + text.slice(cursor), start + inserted.length);
  };

  /** Backspace/Delete next to a mention removes the whole pill. */
  const deleteMention = (forward: boolean): boolean => {
    const el = input.current;
    if (!el || el.selectionStart !== el.selectionEnd) return false;
    const at = el.selectionStart;
    for (const name of Object.keys(mentioned)) {
      const token = `@${name}`;
      const start = forward ? at : at - token.length;
      if (start >= 0 && text.slice(start, start + token.length) === token) {
        const rest = { ...mentioned };
        delete rest[name];
        setMentioned(rest);
        update(text.slice(0, start) + text.slice(start + token.length), start);
        return true;
      }
    }
    return false;
  };

  const format = (f: Format) => {
    const el = input.current;
    const edit = applyFormat(text, el?.selectionStart ?? text.length, el?.selectionEnd ?? text.length, f);
    setText(edit.text);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(edit.start, edit.end); });
  };

  const insertAtCursor = (s: string) => {
    const el = input.current;
    const [a, b] = el ? [el.selectionStart, el.selectionEnd] : [text.length, text.length];
    update(text.slice(0, a) + s + text.slice(b), a + s.length);
  };

  /** An empty table at the cursor, its first header cell selected. */
  const insertTable = (columns: number, rows: number) => {
    const el = input.current;
    const [a, b] = el ? [el.selectionStart, el.selectionEnd] : [text.length, text.length];
    const edit = tableEdit(text, a, b, tableHeader(columns), rows);
    update(edit.text, edit.start);
    requestAnimationFrame(() => el?.setSelectionRange(edit.start, edit.end));
  };

  /** Sends now, or at `at` (send later). */
  const send = (at?: number) => {
    const raw = text.trim();
    if (!canSend) return;
    // With files staged, the text is their caption, never a command.
    const result = attachments.length ? { kind: "send" as const, text: raw, emote: false } : runCommand(raw);
    if (result.kind === "info") return onNotice(result.message);
    if (result.kind === "help") {
      setText("");
      return setShowHelp(true);
    }
    if (result.kind === "remote") {
      if (!onCommand) return onNotice(t("composer.notAvailable", { name: result.name }));
      onCommand(result.name, result.args);
      setText("");
      return;
    }
    if (!result.text && !attachments.length) return;
    // "@Name" -> markdown link to the user, which Matrix clients show as a pill.
    let out = result.text;
    const mentions: string[] = [];
    for (const [name, userId] of Object.entries(mentioned)) {
      if (!out.includes(`@${name}`)) continue;
      out = out.split(`@${name}`).join(`[${escapeMarkdown(name)}](https://matrix.to/#/${userId})`);
      mentions.push(userId);
    }
    const usedEmotes = Object.entries(emotes).filter(([code]) => out.includes(`:${code}:`));
    const message = { text: out, emotes: usedEmotes.length ? usedEmotes : undefined, emote: result.emote, html: "html" in result ? result.html : undefined, msgtype: "msgtype" in result ? result.msgtype : undefined, mentions, attachments: attachments.length ? attachments : undefined };
    if (at !== undefined && p.onSchedule) p.onSchedule(message, at);
    else onSend(message);
    setText("");
    p.onDraft?.("");
    setMentioned({});
    typing("");
  };

  return (
    <div className={`composer ${rich ? "rich" : ""}`}>
      {replyTo && (
        <div className="replying">
          <span>{t("composer.replyingTo", { name: replyTo.sender, text: replyTo.media ? replyTo.media.name : replyTo.body })}</span>
          <button className="icon-btn" title={t("composer.cancelReply")} onClick={onCancelReply}>✕</button>
        </div>
      )}
      {mentionHits.length > 0 && (
        <div className="menu suggestions">
          {mentionHits.map((m, i) => (
            <button key={m.userId} className={`menu-item ${i === 0 ? "first" : ""}`} onMouseDown={(e) => { e.preventDefault(); pickMention(m); }}>
              <b>{m.name}</b> <span>{m.userId}</span>
            </button>
          ))}
        </div>
      )}
      {spell && !mentionHits.length && !suggestions.length && (
        <div className="spell-suggestion" onMouseDown={(e) => e.preventDefault()}>
          <s>{spell.word}</s> → <button className="link" onClick={acceptSpell}>{spell.fix}</button> <kbd>Tab</kbd>
        </div>
      )}
      {suggestions.length > 0 && (
        <div className="menu suggestions" onMouseDown={(e) => e.preventDefault()}>
          {showHelp && !text && (
            <div className="menu-title suggestions-head">{t("composer.commands")}<button className="icon-btn" title={t("common.closeEsc")} onClick={() => setShowHelp(false)}>✕</button></div>
          )}
          {suggestions.map((c) => (
            <button key={c.name} className="menu-item" onClick={() => { setShowHelp(false); update(`/${c.name} `, c.name.length + 2); }}>
              <b>/{c.name}</b> <span>{c.usage ? `${c.usage} — ` : ""}{t(c.help)}</span>
            </button>
          ))}
        </div>
      )}
      {rich && (
        <div className="format-bar">
          {formats.map((f) => (
            <button key={f.title} className={`fmt ${f.className ?? ""}`} title={t(f.title)} onClick={() => format(f.format)}>
              {f.labelKey ? t(f.labelKey) : f.label}
            </button>
          ))}
          <span className="sep" />
          <TablePicker onPick={(columns, rows) => insertTable(columns, rows)} />
          {(() => {
            const hint = currentSettings().enterSends ? t("composer.markdownHintEnter") : t("composer.markdownHint", { key: isMac ? "⌘" : "Ctrl" });
            return <span className="soon-note" title={hint}>{hint}</span>;
          })()}
        </div>
      )}
      {(() => {
        // "donderdag 9 december" while that's a Wednesday: said before it goes out.
        const wrong = findDates(text, new Date()).find((f) => f.wrongWeekday);
        return wrong && <div className="date-warning">{t("dates.composerWrongWeekday", { date: longDate(wrong.date, locale()) })}</div>;
      })()}
      {attachments.length > 0 && (
        <div className="attachments">
          {attachments.map((a) => (
            <div key={a.id} className="attachment" title={a.name}>
              {a.preview ? <img src={a.preview} alt="" /> : <span className="file-icon">📄</span>}
              <span className="att-text">
                <span className="att-name">{a.name}</span>
                <span className="att-size">{formatSize(a.size)}</span>
              </span>
              <button className="icon-btn" title={t("common.remove")} onClick={() => p.onRemoveAttachment?.(a.id)}>✕</button>
            </div>
          ))}
        </div>
      )}
      {voice.recording && (
        <div className="composer-row recording">
          <span className="rec-dot" />
          <span className="rec-label">{t("composer.recording")}</span>
          <span className="rec-time">{formatDuration(voice.elapsed)}</span>
          {/* Live input level: if this stays flat, the microphone isn't reaching Trixcomm. */}
          <span className="vu" aria-hidden>
            {Array.from({ length: 12 }, (_, i) => <span key={i} className={voice.level * 12 > i ? "on" : ""} />)}
          </span>
          <span className="spacer" />
          <button className="btn small" onClick={() => voice.finish(false)}>{t("common.cancel")}</button>
          <button className="btn primary small" onClick={() => voice.finish(true)}>{t("composer.sendVoice")}</button>
        </div>
      )}
      <div className="composer-row" hidden={voice.recording}>
        <div className="input-wrap">
          <div className="input-mirror" ref={mirrorRef} aria-hidden>{mirror(text, Object.keys(mentioned))}{"​"}</div>
          <textarea
            ref={input}
            spellCheck={currentSettings().spellCheck}
            rows={rich ? 3 : 1}
            placeholder={attachments.length ? t("composer.captionPlaceholder") : placeholder}
            value={text}
            onScroll={(e) => { if (mirrorRef.current) mirrorRef.current.scrollTop = e.currentTarget.scrollTop; }}
            onSelect={(e) => setCursor(e.currentTarget.selectionStart)}
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length && p.onAddFiles) {
                e.preventDefault();
                p.onAddFiles(files);
              }
            }}
            onChange={(e) => {
              const el = e.target;
              setCursor(el.selectionStart);
              const replaced = autoReplace(el.value, el.selectionStart);
              setText(replaced ? replaced.text : el.value);
              if (replaced) requestAnimationFrame(() => el.setSelectionRange(replaced.cursor, replaced.cursor));
              typing(el.value);
            }}
            onKeyDown={(e) => {
              if ((e.key === "Tab" || e.key === "Enter") && mentionHits[0]) {
                e.preventDefault();
                return pickMention(mentionHits[0]);
              }
              if ((e.key === "Backspace" || e.key === "Delete") && deleteMention(e.key === "Delete")) {
                e.preventDefault();
                return;
              }
              // Settings → "Send messages with": Enter (Shift+Enter adds a line, also in format
              // mode) or ⌘/Ctrl+Enter (Enter adds a line). ⌘/Ctrl+Enter always sends.
              if (e.key === "Enter" && ((!e.shiftKey && currentSettings().enterSends) || e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
              if (e.key === "Tab" && suggestions[0]) {
                e.preventDefault();
                update(`/${suggestions[0].name} `, suggestions[0].name.length + 2);
              } else if (e.key === "Tab" && !e.shiftKey && spell) {
                e.preventDefault();
                acceptSpell();
              }
              if (e.key === "Escape" && spell) { dismissedSpell.current = `${spell.start}:${spell.word}`; setSpell(null); return; }
              if (e.key === "Escape" && showHelp) { setShowHelp(false); return; }
              if (e.key === "Escape" && replyTo) onCancelReply?.();
            }}
          />
        </div>
        {/* Beside the text, or on a row of their own under it when that leaves the text too little room (a thread). */}
        <div className="composer-tools">
          <button className={`icon-btn ${rich ? "on" : ""}`} title={t("composer.format")} onClick={() => setRich(!rich)}><FormatIcon /></button>
          <span className="emoji-anchor">
            <button className={`icon-btn ${emoji ? "on" : ""}`} title={t("composer.emoji")} onClick={() => setEmoji(!emoji)}><EmojiIcon /></button>
            {emoji && <EmojiPicker onPick={insertAtCursor} onClose={() => setEmoji(false)} packs={packs} account={p.account}
              onPickCustom={(img) => { setEmotes((m) => ({ ...m, [img.shortcode]: img.url })); insertAtCursor(`:${img.shortcode}:`); setEmoji(false); }} />}
          </span>
          <span className="emoji-anchor">
            <button className={`icon-btn ${attachMenu ? "on" : ""}`} title={t("composer.attach")} disabled={!p.onPickFiles} onMouseDown={(e) => e.stopPropagation()}
              onClick={() => (p.onPickCloud ? setAttachMenu(!attachMenu) : p.onPickFiles?.())}><AttachIcon /></button>
            {attachMenu && (
              <div className="menu attach-menu" onMouseDown={(e) => e.stopPropagation()}>
                <button className="menu-item" onClick={() => { setAttachMenu(false); p.onPickFiles?.(); }}>💻 {t("composer.attachComputer")}</button>
                <button className="menu-item" onClick={() => { setAttachMenu(false); p.onPickCloud?.(); }}>☁️ {t("composer.attachCloud")}</button>
              </div>
            )}
          </span>
          <span className="emoji-anchor">
            <button className={`icon-btn ${stickers ? "on" : ""}`} disabled={!p.onSticker} title={t("composer.stickers")} onClick={() => setStickers(!stickers)}><PlusIcon /></button>
            {stickers && (
              <div className="menu emoji-picker sticker-picker" onMouseDown={(e) => e.stopPropagation()}>
                {packs.filter((pk) => pk.images.some((i) => i.sticker)).length === 0 && <p className="empty">{t("composer.noStickers")}</p>}
                {packs.filter((pk) => pk.images.some((i) => i.sticker)).map((pk) => (
                  <div key={pk.name}>
                    <div className="menu-title">{pk.name}</div>
                    <div className="sticker-grid">
                      {pk.images.filter((i) => i.sticker).map((img) => (
                        <button key={img.shortcode + img.url} title={img.body ?? img.shortcode} onClick={() => { p.onSticker?.(img); setStickers(false); }}>
                          <img src={mediaUrl(p.account ?? "", img.url, 128)} alt={img.body ?? img.shortcode} />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </span>
          <span className="sep" />
          {/* Nothing typed: the send button becomes "record a voice message", like Teams. */}
          {!canSend && p.onVoice ? (
            <button className="icon-btn send" title={t("composer.recordVoice")} onClick={() => void voice.start()}><MicIcon /></button>
          ) : (
            <>
              {/* Files can't wait: they're sent from where they are now. */}
              {p.onSchedule && canSend && !attachments.length && <SendLater onPick={(at) => send(at)} />}
              <button className="icon-btn send" title={t("composer.send")} onClick={() => send()} disabled={!canSend}><SendIcon /></button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** "Send later": quick choices, or a day and time of your own. */
function SendLater({ onPick }: { onPick: (at: number) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState("");
  const ref = useRef<HTMLSpanElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  const pick = (at: number) => { setOpen(false); setCustom(""); onPick(at); };
  const customAt = custom ? new Date(custom).getTime() : NaN;
  return (
    <span className="bg-anchor" ref={ref}>
      <button type="button" className={`icon-btn send-later ${open ? "on" : ""}`} title={t("schedule.title")} onClick={() => setOpen(!open)}>🕓</button>
      {open && (
        <div className="menu send-later-menu">
          <div className="menu-title">{t("schedule.title")}</div>
          {sendLaterChoices().map((c) => <button key={c.at} className="menu-item" onClick={() => pick(c.at)}>{c.label}</button>)}
          <form className="send-later-custom" onSubmit={(e) => { e.preventDefault(); if (customAt > Date.now()) pick(customAt); }}>
            <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} />
            <button className="btn small" disabled={!(customAt > Date.now())}>{t("schedule.set")}</button>
          </form>
          <p className="hint small">{t("schedule.hint")}</p>
        </div>
      )}
    </span>
  );
}

/** Column names for a new table: "Column 1", "Column 2", … */
export const tableHeader = (columns: number) => Array.from({ length: columns }, (_, i) => t("composer.tableColumn", { n: i + 1 }));

/** The table button: pick a size on a grid (as in Word or Teams), up to 6 by 6. */
export function TablePicker({ onPick }: { onPick: (columns: number, rows: number) => void }) {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState({ columns: 2, rows: 2 });
  const ref = useRef<HTMLSpanElement>(null);
  useClickOutside(ref, open, () => setOpen(false));
  const max = 6;
  return (
    <span className="bg-anchor" ref={ref}>
      <button className={`fmt ${open ? "on" : ""}`} title={t("composer.tableHint")} onMouseDown={(e) => e.preventDefault()} onClick={() => setOpen(!open)}>{t("composer.table")}</button>
      {open && (
        <div className="menu table-picker">
          <div className="table-grid" onMouseLeave={() => setSize({ columns: 2, rows: 2 })}>
            {Array.from({ length: max * max }, (_, i) => {
              const columns = (i % max) + 1, rows = Math.floor(i / max) + 1;
              const on = columns <= size.columns && rows <= size.rows;
              return <button key={i} className={on ? "on" : ""} aria-label={`${columns} × ${rows}`} onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setSize({ columns, rows })} onClick={() => { setOpen(false); onPick(columns, rows); }} />;
            })}
          </div>
          <div className="table-size">{t("composer.tableSize", { columns: size.columns, rows: size.rows })}</div>
        </div>
      )}
    </span>
  );
}
