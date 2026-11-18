import { useEffect, useRef, useState } from "react";
import { backend, type Verification, type VerificationAction } from "./backend";
import { t } from "./i18n";
import { sasName } from "./sasNames";
import { useOrgs } from "./store";

/** Fired on window when a verification finishes, so lists showing "verified" can reload. */
export const VERIFIED_EVENT = "ms_trix:verified";

interface Props {
  verification: Verification;
  onClose: () => void;
}

/** Emoji (SAS) verification, for someone else or one of our own sessions. */
export function VerificationDialog({ verification: v, onClose }: Props) {
  const orgs = useOrgs();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const self = orgs.some((o) => o.id === v.account && o.userId === v.userId);
  const device = v.deviceName || v.deviceId;
  const who = self ? (device ? t("verify.ownSession", { device }) : t("verify.anotherSession")) : v.userId;
  const ended = v.state.kind === "done" || v.state.kind === "cancelled";

  useEffect(() => setBusy(false), [v.state.kind]);
  useEffect(() => {
    if (v.state.kind === "done") window.dispatchEvent(new Event(VERIFIED_EVENT));
  }, [v.state.kind]);

  const act = (action: VerificationAction) => {
    setBusy(true);
    setError(null);
    backend.verificationAction(v, action).catch((e) => { setError(String(e)); setBusy(false); });
    if (action === "cancel") onClose();
  };
  const close = () => (ended ? onClose() : act("cancel"));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const s = v.state;
  return (
    <div className="login-backdrop">
      <div className="login-card verify">
        <button className="icon-btn close" onClick={close} title={t("common.closeEsc")}>✕</button>
        <h1>{self ? t("verify.titleSession") : t("verify.titleUser")}</h1>
        {s.kind === "requested" && <p>{self ? t("verify.requestedSelf", { who }) : t("verify.requested", { who })}</p>}
        {s.kind === "ready" && (scanning ? (
          <>
            <p>{t("verify.scanTheirs", { who })}</p>
            <QrScanner onCode={(data) => {
              setScanning(false);
              setBusy(true);
              backend.scanVerificationQr(v, data).catch((e) => { setError(String(e)); setBusy(false); });
            }} onError={(e) => { setScanning(false); setError(e); }} />
          </>
        ) : (
          <>
            {s.qr ? <p>{t("verify.scanQr", { who })}</p> : <p>{t("verify.chooseMethod", { who })}</p>}
            {/* SVG made by our own Rust code from the verification data. */}
            {s.qr && <div className="verify-qr" dangerouslySetInnerHTML={{ __html: s.qr }} />}
          </>
        ))}
        {s.kind === "qrScanned" && <p>{t("verify.qrScanned", { who })}</p>}
        {s.kind === "waiting" && <p className="muted">{v.weStarted ? t("verify.waitingAccept", { who }) : t("verify.waitingStart", { who })}</p>}
        {s.kind === "emojis" && (
          <>
            <p>{t("verify.compare", { who })}</p>
            {s.emojis.length ? (
              <div className="sas-emojis">
                {s.emojis.map(([symbol, name], i) => (
                  <div key={i} className="sas-emoji"><span>{symbol}</span><small>{sasName(name)}</small></div>
                ))}
              </div>
            ) : (
              <p className="sas-decimals">{s.decimals.join(" ")}</p>
            )}
          </>
        )}
        {s.kind === "confirmed" && <p className="muted">{t("verify.waitingConfirm", { who })}</p>}
        {s.kind === "done" && <p className="verify-done">✓ {t("verify.done", { who })}</p>}
        {s.kind === "cancelled" && <p className="error">{s.byUs ? t("verify.cancelledByUs") : t("verify.cancelled", { reason: s.reason })}</p>}
        {error && <p className="error">{error}</p>}
        <div className="edit-actions">
          {s.kind === "requested" && (
            <>
              <button className="btn small" onClick={() => act("cancel")}>{t("common.decline")}</button>
              <button className="btn primary small" disabled={busy} onClick={() => act("accept")}>{t("common.accept")}</button>
            </>
          )}
          {s.kind === "ready" && (
            <>
              <button className="btn small" onClick={() => act("cancel")}>{t("common.cancel")}</button>
              {s.scan && <button className="btn small" disabled={busy} onClick={() => setScanning(!scanning)}>{scanning ? t("verify.stopScan") : t("verify.scanButton")}</button>}
              <button className="btn small" disabled={busy} onClick={() => act("startSas")}>{t("verify.useEmoji")}</button>
            </>
          )}
          {s.kind === "qrScanned" && (
            <>
              <button className="btn small" disabled={busy} onClick={() => act("mismatch")}>{t("verify.qrNo")}</button>
              <button className="btn primary small" disabled={busy} onClick={() => act("confirm")}>{t("verify.qrYes")}</button>
            </>
          )}
          {s.kind === "emojis" && (
            <>
              <button className="btn small" disabled={busy} onClick={() => act("mismatch")}>{t("verify.noMatch")}</button>
              <button className="btn primary small" disabled={busy} onClick={() => act("confirm")}>{t("verify.match")}</button>
            </>
          )}
          {(s.kind === "waiting" || s.kind === "confirmed") && <button className="btn small" onClick={() => act("cancel")}>{t("common.cancel")}</button>}
          {ended && <button className="btn primary small" onClick={onClose}>{t("common.close")}</button>}
        </div>
      </div>
    </div>
  );
}

/** Camera view that reads a QR code (Matrix verification codes are binary). */
function QrScanner({ onCode, onError }: { onCode: (data: number[]) => void; onError: (message: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    let timer = 0;
    let done = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
    (async () => {
      const { default: jsQR } = await import("jsqr");
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      if (done) return stream.getTracks().forEach((tr) => tr.stop());
      const el = video.current!;
      el.srcObject = stream;
      await el.play().catch(() => {});
      timer = window.setInterval(() => {
        if (!el.videoWidth) return;
        canvas.width = el.videoWidth;
        canvas.height = el.videoHeight;
        ctx.drawImage(el, 0, 0);
        const code = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "dontInvert" });
        if (code?.binaryData.length && !done) {
          done = true;
          onCode(code.binaryData);
        }
      }, 200);
    })().catch(() => onError(t("verify.noCamera")));
    return () => {
      done = true;
      window.clearInterval(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return <video ref={video} className="qr-scanner" autoPlay muted playsInline />;
}
