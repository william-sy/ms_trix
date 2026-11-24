import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { Avatar } from "./Avatar";
import { ImageCropper } from "./ImageCropper";
import { backend, isLive, type DeviceInfo } from "./backend";
import { languages, locale, t, t as tr } from "./i18n";
import { accents, customColors, isMac, macSounds, type FontSize, type NotifyLevel, type Settings, type Sounds, type ThemeChoice } from "./settings";
import { comboLabel, comboOf, defaults, keyLabel, shortcuts, type ShortcutId } from "./shortcuts";
import { VERIFIED_EVENT } from "./VerificationDialog";
import { useOrgs } from "./store";
import { OrgAvatar } from "./OrgSwitcher";
import { AudioVideoSettings } from "./AudioVideoSettings";
import { EmojiSettings } from "./EmojiSettings";
import { playRingtone, RINGTONES, type Ringtone } from "./ringtone";
import { checkForUpdate, installUpdate, updateText, useUpdates } from "./updates";
import type { Org } from "./types";
import { ReconnectButton } from "./Offline";

interface Props {
  initialTab?: SettingsTab;
  settings: Settings;
  onChange: (s: Settings) => void;
  onClose: () => void;
}

export type SettingsTab = "general" | "accounts" | "notifications" | "audio" | "emoji" | "privacy" | "shortcuts" | "about";
const tabs: SettingsTab[] = ["general", "accounts", "notifications", "audio", "emoji", "privacy", "shortcuts", "about"];

export function SettingsDialog({ initialTab = "general", settings, onChange, onClose }: Props) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  useEffect(() => setTab(initialTab), [initialTab]);
  useEffect(() => {
    // Escape inside a field cancels that field instead (see the editors below).
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !(e.target instanceof HTMLInputElement) && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const set = (patch: Partial<Settings>) => onChange({ ...settings, ...patch });

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card settings">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <nav className="settings-nav">
          <h1>{t("settings.title")}</h1>
          {tabs.map((id) => (
            <button key={id} className={`settings-tab ${tab === id ? "on" : ""}`} onClick={() => setTab(id)}>{t(`settings.tab.${id}`)}</button>
          ))}
        </nav>
        <div className="settings-body">
          {tab === "general" && <General settings={settings} set={set} />}
          {tab === "accounts" && <Accounts settings={settings} set={set} />}
          {tab === "notifications" && <Notifications settings={settings} set={set} />}
          {tab === "audio" && <AudioVideoSettings settings={settings} set={set} />}
          {tab === "emoji" && <EmojiSettings />}
          {tab === "privacy" && <Privacy settings={settings} set={set} />}
          {tab === "shortcuts" && <Shortcuts settings={settings} set={set} />}
          {tab === "about" && <About settings={settings} set={set} />}
        </div>
      </div>
    </div>
  );
}

type Section = { settings: Settings; set: (patch: Partial<Settings>) => void };

function Segmented<T extends string>({ value, options, label, onPick }: { value: T; options: readonly T[]; label: (v: T) => string; onPick: (v: T) => void }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button key={o} role="radio" aria-checked={value === o} className={value === o ? "on" : ""} onClick={() => onPick(o)}>{label(o)}</button>
      ))}
    </div>
  );
}

function General({ settings, set }: Section) {
  return (
    <>
      <section>
        <h2>{t("settings.theme")}</h2>
        <Segmented value={settings.theme} options={["system", "light", "dark"] as ThemeChoice[]} label={(v) => tr(`settings.theme.${v}`)} onPick={(theme) => set({ theme })} />
      </section>

      <section>
        <h2>{t("settings.accent")}</h2>
        <div className="swatches">
          <button className={`swatch default ${settings.accent === null ? "on" : ""}`} title={t("settings.accentDefault")} onClick={() => set({ accent: null })}>A</button>
          {accents.map((a) => (
            <button key={a.color} className={`swatch ${settings.accent === a.color ? "on" : ""}`} title={t(a.name)} style={{ background: a.color }} onClick={() => set({ accent: a.color })} />
          ))}
          <label className="swatch custom" title={t("settings.accentCustom")}>
            <input type="color" value={settings.accent ?? "#5b5fc7"} onChange={(e) => set({ accent: e.target.value })} />
          </label>
        </div>
      </section>

      <section>
        <h2>{t("settings.textSize")}</h2>
        <Segmented value={settings.fontSize} options={["small", "normal", "large"] as FontSize[]} label={(v) => t(`settings.size.${v}`)} onPick={(fontSize) => set({ fontSize })} />
      </section>

      <section>
        <h2>{t("settings.language")}</h2>
        <select className="language" value={settings.language} onChange={(e) => set({ language: e.target.value })}>
          <option value="system">{t("settings.languageSystem")}</option>
          {languages.map((l) => <option key={l.code} value={l.code}>{l.name}</option>)}
        </select>
      </section>

      <section>
        <h2>{t("settings.app")}</h2>
        <Autostart />
        <label className="toggle-row">
          <input type="checkbox" checked={settings.closeToTray} onChange={(e) => set({ closeToTray: e.target.checked })} />
          <span>{t("settings.app.closeToTray")}</span>
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={settings.spellCheck} onChange={(e) => set({ spellCheck: e.target.checked })} />
          <span>{t("settings.app.spellCheck")}</span>
        </label>
      </section>

      <section>
        <h2>{t("settings.messages")}</h2>
        <div className="field-row">
          <span>{t("settings.sendWith")}</span>
          <Segmented value={settings.enterSends ? "enter" : "mod"} options={["enter", "mod"] as const}
            label={(v) => (v === "enter" ? t("settings.sendWith.enter") : isMac ? "⌘ + Enter" : "Ctrl + Enter")} onPick={(v) => set({ enterSends: v === "enter" })} />
        </div>
        <p className="hint">{settings.enterSends ? t("settings.sendWith.enterHint") : t("settings.sendWith.modHint", { key: isMac ? "⌘" : "Ctrl" })}</p>
        <div className="field-row">
          <span>{t("settings.emojiSize")}</span>
          <Segmented value={settings.emojiSize} options={["small", "medium", "large"] as const} label={(v) => t(`settings.size.${v === "medium" ? "normal" : v}`)} onPick={(emojiSize) => set({ emojiSize })} />
        </div>
        <div className="field-row">
          <span>{t("settings.density")}</span>
          <Segmented value={settings.density} options={["comfortable", "compact"] as const} label={(v) => t(`settings.density.${v}`)} onPick={(density) => set({ density })} />
        </div>
      </section>

      <section>
        <h2>{t("settings.colors")}</h2>
        <div className="color-grid">
          {customColors.map((name) => (
            <label key={name} className="color-pick">
              <input type="color" value={settings.colors[name] ?? (getComputedStyle(document.documentElement).getPropertyValue(name).trim().slice(0, 7) || "#ffffff")}
                onChange={(e) => set({ colors: { ...settings.colors, [name]: e.target.value } })} />
              <span>{t(`settings.color.${name.slice(2)}` as Parameters<typeof t>[0])}</span>
            </label>
          ))}
        </div>
        {Object.keys(settings.colors).length > 0 && <button className="btn small" onClick={() => set({ colors: {} })}>{t("settings.colorsReset")}</button>}
      </section>

      <section>
        <h2>{t("settings.presence")}</h2>
        <label className="field-row">
          <span>{t("settings.presence.awayAfter")}</span>
          <select value={settings.awayAfter} onChange={(e) => set({ awayAfter: Number(e.target.value) })}>
            {[5, 10, 15, 30, 60].map((m) => <option key={m} value={m}>{t("settings.presence.minutes", { count: m })}</option>)}
            <option value={0}>{t("settings.presence.never")}</option>
          </select>
        </label>
        <label className="toggle-row">
          <input type="checkbox" checked={settings.meetingStatus} onChange={(e) => set({ meetingStatus: e.target.checked })} />
          <span>{t("settings.presence.meetings")}</span>
        </label>
      </section>

      <p className="hint">{t("settings.hint")}</p>
    </>
  );
}

/** Start-at-login lives in the OS, so it's read from and written to the host. */
function Autostart() {
  const [on, setOn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (isLive) backend.autostart().then(setOn).catch(() => setOn(false)); }, []);
  const toggle = (value: boolean) => backend.setAutostart(value).then(() => { setOn(value); setError(null); }).catch((e) => setError(String(e)));
  return (
    <>
      <label className="toggle-row">
        <input type="checkbox" disabled={on === null} checked={!!on} onChange={(e) => toggle(e.target.checked)} />
        <span>{t("settings.app.autostart")}</span>
      </label>
      {error && <p className="error">{error}</p>}
    </>
  );
}

// ---- Accounts ----

function Accounts({ settings, set }: Section) {
  const orgs = useOrgs();
  if (!orgs.length) return <p className="empty">{t("settings.accounts.none")}</p>;
  return <>{orgs.map((o) => <AccountCard key={o.id} org={o} settings={settings} set={set} />)}</>;
}

function AccountCard({ org, settings, set }: { org: Org } & Section) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(org.displayName);
  const [error, setError] = useState<string | null>(null);
  const [cropping, setCropping] = useState(false);
  const run = (p: Promise<unknown>) => p.then(() => setError(null)).catch((e) => setError(String(e)));

  const saveName = () => {
    setEditing(false);
    if (name.trim() && name.trim() !== org.displayName) run(backend.setDisplayName(org.id, name.trim()));
  };

  return (
    <section className="account-card">
      <div className="account-head">
        <button className="room-avatar editable" title={t("settings.accounts.changePicture")} disabled={!isLive} onClick={() => setCropping(true)}>
          <Avatar account={org.id} media={org.avatar} name={org.displayName} className="big" />
        </button>
        <div className="account-text">
          {editing ? (
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={saveName} onKeyDown={(e) => { if (e.key === "Enter") saveName(); if (e.key === "Escape") { setName(org.displayName); setEditing(false); } }} />
          ) : (
            <button className="field editable" title={t("room.clickToEdit")} onClick={() => { setName(org.displayName); setEditing(true); }}>{org.displayName}</button>
          )}
          <span className="muted">{org.userId}</span>
          <span className="muted">{org.name} · {t(`settings.protocol.${org.protocol}`)}</span>
          {org.offline && (
            <span className="offline-line">
              <span className="offline-dot" /> {t("offline.label")}: {org.offline} <ReconnectButton accounts={[org.id]} />
            </span>
          )}
        </div>
        {/* Colour of this account's tile in the org switcher and its badges. */}
        <label className="org-color" title={t("settings.accounts.color")}>
          <OrgAvatar org={org} size={28} />
          <input type="color" value={org.color} onChange={(e) => set({ orgColors: { ...settings.orgColors, [org.id]: e.target.value } })} />
        </label>
        {settings.orgColors[org.id] && (
          <button className="link small" onClick={() => { const { [org.id]: _, ...rest } = settings.orgColors; set({ orgColors: rest }); }}>{t("shortcuts.reset")}</button>
        )}
      </div>
      {error && <p className="error">{error}</p>}
      {cropping && <ImageCropper title={t("settings.accounts.changePicture")} onCrop={(png) => backend.setAvatar(org.id, png)} onClose={() => setCropping(false)} />}
      {org.protocol === "matrix" && <ContactInfos org={org} />}
      <Sessions org={org} />
    </section>
  );
}

function Sessions({ org }: { org: Org }) {
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [page, setPage] = useState<string | null>(null);
  const load = () =>
    backend.devices(org.id).then((d) => { setDevices(d); setError(null); }).catch((e) => {
      if (!String(e).includes("not supported")) return setError(String(e));
      setUnsupported(true);
      backend.securityPage(org.id).then(setPage, () => {});
    });
  useEffect(() => {
    if (!isLive) return;
    load();
    window.addEventListener(VERIFIED_EVENT, load);
    return () => window.removeEventListener(VERIFIED_EVENT, load);
  }, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (unsupported) return page ? (
    <div className="sessions">
      <h2>{t("settings.sessions.title")}</h2>
      <p className="hint">{t("settings.sessions.onServer")}</p>
      <button className="btn small" onClick={() => void backend.openUrl(page).catch(() => {})}>{t("settings.sessions.openServer")}</button>
    </div>
  ) : <p className="hint">{t("settings.sessions.unsupported")}</p>;
  return (
    <div className="sessions">
      <h2>{t("settings.sessions.title")}</h2>
      {error && <p className="error">{error}</p>}
      {!devices && !error && <p className="muted">{t("common.loading")}</p>}
      {devices?.map((d) => <Session key={d.id} org={org} device={d} onChanged={load} />)}
    </div>
  );
}

/** Email addresses and phone numbers linked to the account (used for password resets, finding you). */
function ContactInfos({ org }: { org: Org }) {
  const [items, setItems] = useState<{ medium: string; address: string }[] | null>(null);
  const [email, setEmail] = useState("");
  const [step, setStep] = useState<null | { token: string; stage: "mail" | "password" | "browser"; session?: string }>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = () => backend.contactInfos(org.id).then(setItems).catch((e) => setError(String(e)));
  useEffect(() => { if (isLive) load(); }, [org.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = () => backend.addEmailStart(org.id, email.trim()).then((token) => { setStep({ token, stage: "mail" }); setError(null); }).catch((e) => setError(String(e)));
  const finish = async (auth: Parameters<typeof backend.addEmailFinish>[2]) => {
    if (!step) return;
    try {
      const result = await backend.addEmailFinish(org.id, step.token, auth);
      if (result.kind === "done") { setStep(null); setEmail(""); setPassword(""); setError(null); return load(); }
      if (result.kind === "needsPassword") return setStep({ ...step, stage: "password" });
      backend.openUrl(result.url);
      setStep({ ...step, stage: "browser", session: result.session });
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="contact-infos">
      <h2>{t("settings.contacts.title")}</h2>
      {items?.length === 0 && <p className="hint">{t("settings.contacts.none")}</p>}
      {items?.map((c) => (
        <div key={`${c.medium}:${c.address}`} className="contact-row">
          <span>{c.medium === "email" ? "✉️" : "📱"} {c.address}</span>
          <button className="icon-btn" title={t("common.remove")} onClick={() => confirm(t("settings.contacts.removeConfirm", { address: c.address })) && backend.removeContactInfo(org.id, c.medium, c.address).then(load).catch((e) => setError(String(e)))}>✕</button>
        </div>
      ))}
      {!step && (
        <form className="contact-add" onSubmit={(e) => { e.preventDefault(); if (email.includes("@")) void start(); }}>
          <input type="email" value={email} placeholder={t("settings.contacts.addPlaceholder")} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn small" disabled={!email.includes("@")}>{t("settings.contacts.add")}</button>
        </form>
      )}
      {step?.stage === "mail" && (
        <div className="session-confirm">
          <span className="muted">{t("settings.contacts.checkMail", { email })}</span>
          <button className="btn primary small" onClick={() => void finish({ kind: "none" })}>{t("settings.contacts.confirmed")}</button>
          <button className="btn small" onClick={() => setStep(null)}>{t("common.cancel")}</button>
        </div>
      )}
      {step?.stage === "password" && (
        <form className="session-confirm" onSubmit={(e) => { e.preventDefault(); void finish({ kind: "password", password }); }}>
          <input type="password" autoFocus placeholder={t("settings.sessions.password")} value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn primary small" disabled={!password}>{t("settings.contacts.add")}</button>
          <button type="button" className="btn small" onClick={() => setStep(null)}>{t("common.cancel")}</button>
        </form>
      )}
      {step?.stage === "browser" && (
        <div className="session-confirm">
          <span className="muted">{t("settings.sessions.browserStep")}</span>
          <button className="btn primary small" onClick={() => void finish({ kind: "browser", session: step.session! })}>{t("settings.sessions.browserDone")}</button>
          <button className="btn small" onClick={() => setStep(null)}>{t("common.cancel")}</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function Session({ org, device, onChanged }: { org: Org; device: DeviceInfo; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(device.name ?? "");
  const [step, setStep] = useState<null | { kind: "password" } | { kind: "browser"; session: string }>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const rename = () => {
    setRenaming(false);
    if (name.trim() && name.trim() !== device.name) backend.renameDevice(org.id, device.id, name.trim()).then(onChanged).catch((e) => setError(String(e)));
  };

  const signOut = async (auth: Parameters<typeof backend.signOutDevice>[2]) => {
    try {
      const result = await backend.signOutDevice(org.id, device.id, auth);
      if (result.kind === "done") return onChanged();
      if (result.kind === "needsPassword") return setStep({ kind: "password" });
      backend.openUrl(result.url);
      setStep({ kind: "browser", session: result.session });
    } catch (e) {
      setError(String(e));
    }
  };

  const seen = device.lastSeenTs ? new Date(device.lastSeenTs).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" }) : null;
  return (
    <div className="session">
      <div className="session-main">
        {renaming ? (
          <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => { if (e.key === "Enter") rename(); if (e.key === "Escape") setRenaming(false); }} />
        ) : (
          <button className="field editable" title={t("settings.sessions.rename")} onClick={() => setRenaming(true)}>{device.name || device.id}</button>
        )}
        <span className="muted">
          {device.id}
          {seen && ` · ${t("settings.sessions.lastSeen", { when: seen })}`}
          {device.lastSeenIp && ` · ${device.lastSeenIp}`}
        </span>
      </div>
      <div className="session-badges">
        {device.current && <span className="tag accent">{t("settings.sessions.current")}</span>}
        {device.verified !== null && <span className={`tag ${device.verified ? "ok" : "warn"}`}>{device.verified ? t("settings.sessions.verified") : t("settings.sessions.unverified")}</span>}
        {device.verified === false && !step && (
          <button className="btn small" onClick={() => backend.startVerification(org.id, org.userId, device.current ? null : device.id).catch((e) => setError(String(e)))}>
            {device.current ? t("verify.thisSession") : t("verify.start")}
          </button>
        )}
        {!device.current && !step && <button className="btn small" onClick={() => signOut({ kind: "none" })}>{t("settings.sessions.signOut")}</button>}
      </div>
      {step?.kind === "password" && (
        <form className="session-confirm" onSubmit={(e) => { e.preventDefault(); signOut({ kind: "password", password }); setPassword(""); }}>
          <input type="password" autoFocus placeholder={t("settings.sessions.password")} value={password} onChange={(e) => setPassword(e.target.value)} />
          <button className="btn primary small" disabled={!password}>{t("settings.sessions.signOut")}</button>
          <button type="button" className="btn small" onClick={() => setStep(null)}>{t("common.cancel")}</button>
        </form>
      )}
      {step?.kind === "browser" && (
        <div className="session-confirm">
          <span className="muted">{t("settings.sessions.browserStep")}</span>
          <button className="btn primary small" onClick={() => signOut({ kind: "browser", session: step.session })}>{t("settings.sessions.browserDone")}</button>
          <button className="btn small" onClick={() => setStep(null)}>{t("common.cancel")}</button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}

// ---- Notifications ----

const levels: NotifyLevel[] = ["all", "mentions", "off"];

function Notifications({ settings, set }: Section) {
  const notify = settings.notify;
  const [keyword, setKeyword] = useState("");
  const setNotify = (patch: Partial<Settings["notify"]>) => set({ notify: { ...notify, ...patch } });
  const addKeyword = () => {
    const k = keyword.trim();
    if (k && !notify.keywords.some((x) => x.toLowerCase() === k.toLowerCase())) setNotify({ keywords: [...notify.keywords, k] });
    setKeyword("");
  };

  return (
    <>
      <section>
        <h2>{t("settings.notify.chats")}</h2>
        <Segmented value={notify.chats} options={levels} label={(v) => t(`settings.notify.level.${v}`)} onPick={(chats) => setNotify({ chats })} />
      </section>
      <section>
        <h2>{t("settings.notify.channels")}</h2>
        <Segmented value={notify.channels} options={levels} label={(v) => t(`settings.notify.level.${v}`)} onPick={(channels) => setNotify({ channels })} />
      </section>
      <section>
        <label className="toggle-row">
          <input type="checkbox" checked={notify.calls} onChange={(e) => setNotify({ calls: e.target.checked })} />
          <span>{t("settings.notify.calls")}</span>
        </label>
        {notify.calls && (
          <>
            <label className="toggle-row">
              <input type="checkbox" checked={notify.silentCalls} onChange={(e) => setNotify({ silentCalls: e.target.checked })} />
              <span>{t("settings.notify.silentCalls")}</span>
            </label>
            <p className="hint">{t("settings.notify.silentCallsHint")}</p>
          </>
        )}
      </section>
      <section>
        <h2>{t("settings.notify.meetings")}</h2>
        <div className="sound-row">
          <span>{t("settings.notify.meetingsWhen")}</span>
          <select value={settings.reminderMinutes} onChange={(e) => set({ reminderMinutes: Number(e.target.value) })}>
            {REMINDER_MINUTES.map((m) => <option key={m} value={m}>{m ? t("settings.notify.minutesBefore", { count: m }) : t("settings.notify.noReminder")}</option>)}
          </select>
        </div>
        {settings.reminderMinutes > 0 && <Segmented value={settings.meetingReminder} options={["window", "app"] as Settings["meetingReminder"][]} label={(v) => t(`settings.notify.meetings.${v}`)} onPick={(meetingReminder) => set({ meetingReminder })} />}
        {settings.reminderMinutes > 0 && <p className="hint">{t("settings.notify.meetingsHint")}</p>}
      </section>
      <section>
        <h2>{t("settings.notify.keywords")}</h2>
        <p className="hint">{t("settings.notify.keywordsHint")}</p>
        <div className="keywords">
          {notify.keywords.map((k) => (
            <span key={k} className="chip">{k}<button title={t("common.remove")} onClick={() => setNotify({ keywords: notify.keywords.filter((x) => x !== k) })}>✕</button></span>
          ))}
          <input value={keyword} placeholder={t("settings.notify.addKeyword")} onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addKeyword(); }} onBlur={addKeyword} />
        </div>
      </section>
      <section>
        <h2>{t("settings.sound.title")}</h2>
        {(["message", "mention", "call"] as (keyof Sounds)[]).map((kind) => (
          <SoundRow key={kind} kind={kind} value={settings.sounds[kind]} onPick={(v) => set({ sounds: { ...settings.sounds, [kind]: v } })} />
        ))}
        <RingtoneRow field="ringtone" settings={settings} set={set} />
        <RingtoneRow field="reminderSound" settings={settings} set={set} />
      </section>
      <NtfySection settings={settings} set={set} />
      <p className="hint">{t("settings.notify.perChat")}</p>
    </>
  );
}

/** A long random topic name: on ntfy.sh anyone who knows a topic can read it. */
const randomTopic = () => `trixcomm-${Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => (b % 36).toString(36)).join("")}`;

/** ntfy add-on: notifications also to an ntfy topic (the ntfy app on your phone), e.g. while you're away. */
function NtfySection({ settings, set }: Section) {
  const ntfy = settings.ntfy;
  const update = (patch: Partial<Settings["ntfy"]>) => set({ ntfy: { ...ntfy, ...patch } });
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => { if (isLive) void backend.hasNtfyToken().then(setHasToken).catch(() => {}); }, []);
  const saveToken = (value: string | null) => backend.setNtfyToken(value).then(() => { setToken(""); setHasToken(!!value); }, (e) => setStatus(String(e)));
  return (
    <section className="ntfy">
      <h2>{t("settings.ntfy.title")}</h2>
      <label className="toggle-row">
        <input type="checkbox" checked={ntfy.enabled} onChange={(e) => update({ enabled: e.target.checked, topic: ntfy.topic || randomTopic() })} />
        <span>{t("settings.ntfy.enable")}</span>
      </label>
      <p className="hint">{t("settings.ntfy.hint")}</p>
      {ntfy.enabled && (
        <>
          <label className="field-row"><span>{t("settings.ntfy.server")}</span>
            <input value={ntfy.server} placeholder="https://ntfy.sh" onChange={(e) => update({ server: e.target.value.trim() })} /></label>
          <label className="field-row"><span>{t("settings.ntfy.topic")}</span>
            <input value={ntfy.topic} onChange={(e) => update({ topic: e.target.value.replace(/[^A-Za-z0-9_-]/g, "") })} />
            <button type="button" className="btn small" onClick={() => update({ topic: randomTopic() })}>{t("settings.ntfy.newTopic")}</button></label>
          <p className="hint">{t("settings.ntfy.topicHint")}</p>
          <label className="field-row"><span>{t("settings.ntfy.token")}</span>
            <input type="password" value={token} placeholder={hasToken ? t("settings.ntfy.tokenSaved") : t("settings.ntfy.tokenNone")} onChange={(e) => setToken(e.target.value)} />
            <button type="button" className="btn small" disabled={!token.trim()} onClick={() => void saveToken(token)}>{t("common.save")}</button>
            {hasToken && <button type="button" className="btn small" onClick={() => void saveToken(null)}>{t("common.remove")}</button>}</label>
          <Segmented value={ntfy.when} options={["away", "always"] as const} label={(v) => t(`settings.ntfy.when.${v}`)} onPick={(when) => update({ when })} />
          <label className="toggle-row">
            <input type="checkbox" checked={ntfy.includeText} onChange={(e) => update({ includeText: e.target.checked })} />
            <span>{t("settings.ntfy.includeText")}</span>
          </label>
          <p className="hint">{t("settings.ntfy.includeTextHint")}</p>
          <div className="ntfy-test">
            <button type="button" className="btn small" disabled={!isLive || !ntfy.topic}
              onClick={() => { setStatus(null); backend.testNtfy().then(() => setStatus(t("settings.ntfy.testSent")), (e) => setStatus(String(e))); }}>{t("settings.ntfy.test")}</button>
            {status && <span className="muted">{status}</span>}
          </div>
        </>
      )}
    </section>
  );
}

const RINGTONE_MAX = 5 * 1024 * 1024;
const REMINDER_MINUTES = [1, 5, 10, 15, 30, 0];

/** The ringtone or the reminder sound: one of Trixcomm's tunes or your own sound file, with a preview. */
function RingtoneRow({ field, settings, set }: Section & { field: "ringtone" | "reminderSound" }) {
  const [stop, setStop] = useState<(() => void) | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => stop?.(), [stop]);
  const preview = (which: Ringtone = settings[field]) => {
    stop?.();
    const end = playRingtone(1, which);
    const done = () => { end(); setStop(null); };
    setStop(() => done);
    window.setTimeout(done, 8000);
  };
  // Previewed once the dropdown has closed.
  const pick = (which: Ringtone) => { set({ [field]: which }); window.setTimeout(() => preview(which), 150); };
  const upload = async (file: File) => {
    setError(null);
    if (file.size > RINGTONE_MAX) return setError(t("settings.ringtone.tooBig"));
    try {
      await backend.saveRingtone(new Uint8Array(await file.arrayBuffer()));
      set({ [field]: "custom", ringtoneName: file.name });
      preview("custom");
    } catch (e) { setError(String(e)); }
  };
  return (
    <>
      <div className="sound-row">
        <span>{t(field === "ringtone" ? "settings.ringtone" : "settings.reminderSound")}</span>
        <select value={settings[field]} onChange={(e) => pick(e.target.value as Ringtone)}>
          {RINGTONES.filter((r) => field === "reminderSound" || r !== "chime").map((r) => <option key={r} value={r}>{t(`settings.ringtone.${r}`)}</option>)}
          {settings.ringtoneName && <option value="custom">{t("settings.ringtone.custom", { name: settings.ringtoneName })}</option>}
        </select>
        <button className="btn small" onClick={() => (stop ? stop() : preview())}>{stop ? t("settings.ringtone.stop") : t("settings.ringtone.play")}</button>
        <label className={`btn small ${isLive ? "" : "disabled"}`}>
          {t("settings.ringtone.choose")}
          <input type="file" accept="audio/*" hidden disabled={!isLive} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) void upload(f); }} />
        </label>
      </div>
      {(error || field === "reminderSound") && <p className="hint">{error ?? t("settings.ringtone.hint")}</p>}
    </>
  );
}

function SoundRow({ kind, value, onPick }: { kind: keyof Sounds; value: string; onPick: (v: string) => void }) {
  return (
    <div className="sound-row">
      <span>{t(`settings.sound.${kind}`)}</span>
      <select value={value} onChange={(e) => onPick(e.target.value)}>
        <option value="default">{t("settings.sound.default")}</option>
        <option value="none">{t("settings.sound.none")}</option>
        {isMac && macSounds.map((s) => <option key={s} value={s}>{s}</option>)}
      </select>
      {/* The host reads the sound from its prefs, which the parent has just pushed. */}
      <button className="btn small" disabled={!isLive} onClick={() => backend.testNotification(kind, t("settings.sound.testTitle"), t(`settings.sound.${kind}`)).catch(() => {})}>{t("settings.sound.test")}</button>
    </div>
  );
}

// ---- Shortcuts ----

function Shortcuts({ settings, set }: Section) {
  // The shortcut being recorded; the next key press (with modifiers) becomes its combo.
  const [recording, setRecording] = useState<ShortcutId | null>(null);
  const combo = (id: ShortcutId) => settings.shortcuts[id] ?? defaults[id];
  const ids = Object.keys(defaults) as ShortcutId[];
  const clash = (id: ShortcutId) => ids.find((other) => other !== id && combo(other) === combo(id));
  const assign = (id: ShortcutId, value: string | null) => {
    const next = { ...settings.shortcuts };
    if (value === null || value === defaults[id]) delete next[id];
    else next[id] = value;
    set({ shortcuts: next });
  };
  const capture = (id: ShortcutId) => (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation(); // don't run the old shortcut while recording
    if (e.key === "Escape") return setRecording(null);
    const value = comboOf(e);
    if (!value) return; // just a modifier so far
    assign(id, value);
    setRecording(null);
  };
  return (
    <>
      {shortcuts.map((g) => (
        <section key={g.group}>
          <h2>{t(g.group)}</h2>
          <dl className="shortcut-list">
            {g.items.map((s) => (
              <div key={"id" in s ? s.id : s.keys}>
                <dt>{t(s.label)}</dt>
                <dd>
                  {"id" in s ? (
                    <>
                      {clash(s.id) && <span className="tag warn" title={t("shortcuts.clashHint")}>{t("shortcuts.clash")}</span>}
                      {settings.shortcuts[s.id] && <button className="link small" onClick={() => assign(s.id, null)}>{t("shortcuts.reset")}</button>}
                      <button className={`shortcut-capture ${recording === s.id ? "on" : ""}`} title={t("shortcuts.change")}
                        onClick={() => setRecording(recording === s.id ? null : s.id)} onKeyDown={recording === s.id ? capture(s.id) : undefined} onBlur={() => setRecording(null)}>
                        {recording === s.id ? t("shortcuts.pressKeys") : <kbd>{comboLabel(combo(s.id))}</kbd>}
                      </button>
                    </>
                  ) : (
                    <kbd className="fixed">{keyLabel(s.keys)}</kbd>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <div className="shortcut-footer">
        <p className="hint">{t("shortcuts.howTo")}</p>
        {Object.keys(settings.shortcuts).length > 0 && <button className="btn small" onClick={() => set({ shortcuts: {} })}>{t("shortcuts.resetAll")}</button>}
      </div>
    </>
  );
}

// ---- Privacy ----

const SPONSOR = "https://selectedwithtrust.com";

function About({ settings, set }: Section) {
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => { if (isLive) void getVersion().then(setVersion).catch(() => {}); }, []);
  const update = useUpdates();
  return (
    <>
      <section>
        <h2>Trixcomm</h2>
        <p>{t("about.version", { version: version ?? "—" })}</p>
        <div className="about-update">
          {update.available ? (
            <>
              <span>{updateText(update)}</span>
              <button className="btn primary small" disabled={update.blocked || update.installing !== undefined} title={update.blocked ? t("update.afterCall") : undefined} onClick={() => void installUpdate()}>{t("update.restart")}</button>
            </>
          ) : (
            <>
              <button className="btn small" disabled={!isLive || update.checking} onClick={() => void checkForUpdate()}>{update.checking ? t("update.checking") : t("update.checkNow")}</button>
              {update.upToDate && <span className="muted">{t("update.upToDate")}</span>}
            </>
          )}
        </div>
        {update.error && <p className="error">{update.error}</p>}
        <label className="toggle-row">
          <input type="checkbox" checked={settings.autoUpdate} onChange={(e) => set({ autoUpdate: e.target.checked })} />
          <span>{t("update.auto")}</span>
        </label>
        <p className="hint">{t("update.autoHint")}</p>
      </section>
      <section>
        <h2>{t("about.supported")}</h2>
        <ul className="about-list">
          <li>{t("about.matrix")}</li>
          <li>{t("about.talk")}</li>
        </ul>
      </section>
      <section>
        <h2>{t("about.credits")}</h2>
        <ul className="about-list">
          <li>{t("about.idea")}</li>
          <li>{t("about.sponsor")} <button className="link" onClick={() => void backend.openUrl(SPONSOR).catch(() => {})}>selectedwithtrust.com</button></li>
          <li>{t("about.claude")}</li>
        </ul>
      </section>
      <section>
        <h2>{t("about.licence")}</h2>
        <p>{t("about.licenceText")}</p>
      </section>
    </>
  );
}

function Privacy({ settings, set }: Section) {
  return (
    <>
      <section>
        <label className="toggle-row">
          <input type="checkbox" checked={settings.shareReceipts} onChange={(e) => set({ shareReceipts: e.target.checked })} />
          <span>{t("settings.privacy.receipts")}</span>
        </label>
        <p className="hint">{t("settings.privacy.receiptsHint")}</p>
      </section>
      <section>
        <label className="toggle-row">
          <input type="checkbox" checked={settings.shareTyping} onChange={(e) => set({ shareTyping: e.target.checked })} />
          <span>{t("settings.privacy.typing")}</span>
        </label>
        <p className="hint">{t("settings.privacy.typingHint")}</p>
      </section>
      <section>
        <label className="toggle-row">
          <input type="checkbox" checked={settings.linkPreviews} onChange={(e) => set({ linkPreviews: e.target.checked })} />
          <span>{t("settings.privacy.linkPreviews")}</span>
        </label>
        <p className="hint">{t("settings.privacy.linkPreviewsHint")}</p>
      </section>
    </>
  );
}
