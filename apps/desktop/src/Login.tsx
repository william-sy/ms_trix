import { useState, type FormEvent } from "react";
import { backend, type LoginMethods } from "./backend";
import { t } from "./i18n";

type Step = { kind: "server" } | { kind: "method"; methods: LoginMethods } | { kind: "sso"; methods: LoginMethods };

interface Props {
  /** Shown as a dialog over the app (adding a 2nd account) instead of full screen. */
  dialog?: boolean;
  onDone: () => void;
  onCancel?: () => void;
}

export function Login({ dialog, onDone, onCancel }: Props) {
  const [step, setStep] = useState<Step>({ kind: "server" });
  const [server, setServer] = useState("matrix.org");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (f: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const discover = (e: FormEvent) => {
    e.preventDefault();
    run(async () => setStep({ kind: "method", methods: await backend.loginMethods(server) }));
  };

  const loginPassword = (e: FormEvent, methods: LoginMethods) => {
    e.preventDefault();
    run(async () => {
      await backend.loginPassword(methods.homeserver, username, password);
      onDone();
    });
  };

  const loginSso = (methods: LoginMethods, idp: string | null) => {
    setStep({ kind: "sso", methods });
    run(async () => {
      try {
        await backend.loginSso(methods.homeserver, idp);
        onDone();
      } catch (e) {
        setStep({ kind: "method", methods });
        throw e;
      }
    });
  };

  const body = (() => {
    switch (step.kind) {
      case "server":
        return (
          <form onSubmit={discover}>
            <h1>{t("login.title")}</h1>
            <p className="muted">{t("login.intro")}</p>
            <label>
              {t("login.server")}
              <input autoFocus value={server} onChange={(e) => setServer(e.target.value)} placeholder={t("login.serverPlaceholder")} />
            </label>
            <button className="btn primary wide" disabled={busy || !server.trim()}>{busy ? t("login.checking") : t("login.continue")}</button>
          </form>
        );
      case "method": {
        const m = step.methods;
        const idps = m.identity_providers;
        return (
          <div>
            <h1>{t("login.signInTo", { server: new URL(m.homeserver).host })}</h1>
            {m.sso && (
              <div className="sso">
                {idps.length > 0 ? (
                  idps.map((p) => (
                    <button key={p.id} className="btn primary wide" disabled={busy} onClick={() => loginSso(m, p.id)}>{t("login.continueWith", { provider: p.name })}</button>
                  ))
                ) : (
                  <button className="btn primary wide" disabled={busy} onClick={() => loginSso(m, null)}>{t("login.sso")}</button>
                )}
              </div>
            )}
            {m.sso && m.password && <div className="or"><span>{t("login.or")}</span></div>}
            {m.password && (
              <form onSubmit={(e) => loginPassword(e, m)}>
                <label>
                  {t("login.username")}
                  <input autoFocus={!m.sso} value={username} onChange={(e) => setUsername(e.target.value)} placeholder={t("login.usernamePlaceholder")} autoComplete="username" />
                </label>
                <label>
                  {t("login.password")}
                  <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
                </label>
                <button className={`btn wide ${m.sso ? "" : "primary"}`} disabled={busy || !username || !password}>{busy ? t("login.signingIn") : t("login.signIn")}</button>
              </form>
            )}
            {!m.sso && !m.password && <p className="error">{t("login.unsupported")}</p>}
            <button className="link back" onClick={() => setStep({ kind: "server" })}>{t("login.otherServer")}</button>
          </div>
        );
      }
      case "sso":
        return (
          <div>
            <h1>{t("login.browserTitle")}</h1>
            <p className="muted">{t("login.browserText")}</p>
            <div className="spinner" aria-label={t("login.waiting")} />
          </div>
        );
    }
  })();

  return (
    <div className={dialog ? "login-backdrop" : "login-screen"}>
      <div className="login-card">
        {dialog && onCancel && <button className="icon-btn close" onClick={onCancel} title={t("common.close")}>✕</button>}
        {body}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
