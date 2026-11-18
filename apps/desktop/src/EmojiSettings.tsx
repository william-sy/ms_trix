import { useEffect, useState } from "react";
import { backend, isLive, mediaUrl, type ImagePack, type PackImage } from "./backend";
import { t } from "./i18n";
import { useOrgs } from "./store";

const SHORTCODE = /^[a-zA-Z0-9_+-]{2,32}$/;

/** Shrinks a picked picture to at most 256 px (PNG keeps transparency). */
async function shrink(dataUrl: string): Promise<{ mime: string; data: string }> {
  const img = new Image();
  await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
  const scale = Math.min(1, 256 / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
  return { mime: "image/png", data: canvas.toDataURL("image/png").split(",")[1]! };
}

/** Settings → Emoji & stickers: the user's own pack (Matrix image pack, also used by Element). */
export function EmojiSettings() {
  const orgs = useOrgs().filter((o) => o.protocol === "matrix");
  const [account, setAccount] = useState(orgs[0]?.id ?? "");
  const [pack, setPack] = useState<ImagePack | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isLive || !account) return;
    setPack(null);
    setDirty(false);
    backend.ownPack(account).then(setPack).catch((e) => setError(String(e)));
  }, [account]);

  const change = (images: PackImage[], name = pack?.name ?? "") => { setPack({ name, images }); setDirty(true); };
  const update = (i: number, patch: Partial<PackImage>) => change(pack!.images.map((img, n) => (n === i ? { ...img, ...patch } : img)));

  const add = async () => {
    try {
      const picked = await backend.pickImageFile();
      if (!picked) return;
      setBusy(true);
      const { mime, data } = await shrink(picked);
      const url = await backend.uploadImage(account, mime, data);
      // A free placeholder name; the user renames it in the list.
      const taken = new Set(pack?.images.map((i) => i.shortcode));
      let n = (pack?.images.length ?? 0) + 1;
      while (taken.has(`emoji${n}`)) n++;
      change([...(pack?.images ?? []), { shortcode: `emoji${n}`, url, body: null, emoticon: true, sticker: true }]);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const invalid = pack?.images.find((i) => !SHORTCODE.test(i.shortcode));
  const duplicate = pack?.images.find((i, n) => pack.images.findIndex((j) => j.shortcode === i.shortcode) !== n);
  const save = () => {
    if (!pack || invalid || duplicate) return;
    setBusy(true);
    backend.saveOwnPack(account, pack).then(() => { setDirty(false); setError(null); }).catch((e) => setError(String(e))).finally(() => setBusy(false));
  };

  if (!orgs.length) return <p className="hint">{t("emojiSettings.matrixOnly")}</p>;
  return (
    <>
      <section>
        <h2>{t("emojiSettings.title")}</h2>
        <p className="hint">{t("emojiSettings.hint")}</p>
        {orgs.length > 1 && (
          <select value={account} onChange={(e) => setAccount(e.target.value)}>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.userId}</option>)}
          </select>
        )}
      </section>
      {!pack && !error && <p className="muted">{t("common.loading")}</p>}
      {pack && (
        <section>
          <label className="field-row">
            <span>{t("emojiSettings.packName")}</span>
            <input value={pack.name} placeholder={t("emojiSettings.packNamePlaceholder")} onChange={(e) => change(pack.images, e.target.value)} />
          </label>
          <div className="emoji-admin">
            {pack.images.length === 0 && <p className="hint">{t("emojiSettings.empty")}</p>}
            {pack.images.map((img, i) => (
              <div key={img.url + i} className={`emoji-admin-row ${!SHORTCODE.test(img.shortcode) ? "bad" : ""}`}>
                <img src={mediaUrl(account, img.url, 64)} alt="" />
                <span className="colon">:</span>
                <input value={img.shortcode} onChange={(e) => update(i, { shortcode: e.target.value.trim() })} aria-label={t("emojiSettings.shortcode")} />
                <span className="colon">:</span>
                <label className="toggle-row"><input type="checkbox" checked={img.emoticon} onChange={(e) => update(i, { emoticon: e.target.checked })} /><span>{t("emojiSettings.asEmoji")}</span></label>
                <label className="toggle-row"><input type="checkbox" checked={img.sticker} onChange={(e) => update(i, { sticker: e.target.checked })} /><span>{t("emojiSettings.asSticker")}</span></label>
                <button className="icon-btn" title={t("common.remove")} onClick={() => change(pack.images.filter((_, n) => n !== i))}>✕</button>
              </div>
            ))}
          </div>
          <div className="emoji-admin-actions">
            <button className="btn small" disabled={busy} onClick={() => void add()}>{busy ? t("common.loading") : t("emojiSettings.add")}</button>
            <span className="spacer" />
            {invalid && <span className="error">{t("emojiSettings.badName", { name: invalid.shortcode })}</span>}
            {duplicate && <span className="error">{t("emojiSettings.duplicate", { name: duplicate.shortcode })}</span>}
            <button className="btn primary small" disabled={!dirty || busy || !!invalid || !!duplicate} onClick={save}>{t("common.save")}</button>
          </div>
        </section>
      )}
      {error && <p className="error">{error}</p>}
    </>
  );
}
