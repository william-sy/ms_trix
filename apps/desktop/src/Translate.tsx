import { createContext, useContext, useState } from "react";
import { backend } from "./backend";
import { locale, t } from "./i18n";
import { RichText } from "./RichText";

// Messages translated by a Nextcloud with a translation provider: through the chat's own account
// when it can, otherwise through any account that can (so Matrix messages too). Into the app's
// language; the server detects the message's.

/** The accounts whose Nextcloud translates. */
export const TranslatorsContext = createContext<string[]>([]);

type Translation = { busy: true } | { text: string; from: string | null } | { error: string };

/** One message's translation; `translate` only when some account can. */
export function useTranslation(account: string) {
  const translators = useContext(TranslatorsContext);
  const via = translators.includes(account) ? account : translators[0];
  const [translation, setTranslation] = useState<Translation | null>(null);
  const translate = via ? (text: string) => {
    setTranslation({ busy: true });
    backend.translate(via, text, locale()).then(setTranslation, (e) => setTranslation({ error: String(e) }));
  } : undefined;
  return { translate, translation, hide: () => setTranslation(null) };
}

const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames([locale()], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** Under the message: what it says in your language, and where it came from. */
export function TranslationLine({ translation, account, onHide }: { translation: Translation; account: string; onHide: () => void }) {
  const head = "busy" in translation ? t("translate.busy")
    : "error" in translation ? t("translate.failed")
    : translation.from ? t("translate.from", { language: languageName(translation.from) }) : t("translate.done");
  return (
    <div className="msg-translation">
      <span className="msg-translation-head">
        🌐 {head}
        {!("busy" in translation) && <> · <button className="link" onClick={onHide}>{t("translate.hide")}</button></>}
      </span>
      {"error" in translation && <span className="error">{translation.error}</span>}
      {"text" in translation && <RichText body={translation.text} account={account} />}
    </div>
  );
}
