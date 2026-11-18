import { useEffect, useRef, useState, type ReactNode } from "react";
import { commandList, runCommand } from "./commands";
import { EmojiPicker } from "./EmojiPicker";
import { autoReplace } from "./emoticons";
import { applyFormat, type Format } from "./format";
import { AttachIcon, EmojiIcon, FormatIcon, MicIcon, PlusIcon, SendIcon } from "./Icons";
import { formatDuration, useVoiceRecorder, type Voice } from "./voice";
import { mediaUrl, type ImagePack, type PackImage } from "./backend";
import type { Attachment, Member, Message, Outgoing } from "./types";
import { t, type Key } from "./i18n";
import { currentSettings } from "./settings";

// Markdown the format buttons insert; the adapter sends it as rich text.
// `label` is a symbol shown as-is; `labelKey` is translated.
const formats: { label?: string; labelKey?: Key; className?: string; title: Key; format: Format }[] = [
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
const RICH_KEY = "ms_trix.composer.rich";
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

  const send = () => {
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
    onSend({ text: out, emotes: usedEmotes.length ? usedEmotes : undefined, emote: result.emote, html: "html" in result ? result.html : undefined, msgtype: "msgtype" in result ? result.msgtype : undefined, mentions, attachments: attachments.length ? attachments : undefined });
    setText("");
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
          <button className="fmt" disabled title={t("composer.tableSoon")}>{t("composer.table")}</button>
          <span className="soon-note">{t("composer.markdownHint")}</span>
        </div>
      )}
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
          {/* Live input level: if this stays flat, the microphone isn't reaching ms_trix. */}
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
              // In format mode (or with "Enter sends" off) Enter adds a line; ⌘/Ctrl+Enter always sends.
              if (e.key === "Enter" && ((!e.shiftKey && !rich && currentSettings().enterSends) || e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                send();
              }
              if (e.key === "Tab" && suggestions[0]) {
                e.preventDefault();
                update(`/${suggestions[0].name} `, suggestions[0].name.length + 2);
              }
              if (e.key === "Escape" && showHelp) { setShowHelp(false); return; }
              if (e.key === "Escape" && replyTo) onCancelReply?.();
            }}
          />
        </div>
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
          <button className="icon-btn send" title={t("composer.send")} onClick={send} disabled={!canSend}><SendIcon /></button>
        )}
      </div>
    </div>
  );
}
