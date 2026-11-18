import { useEffect, useState } from "react";
import { backend, isLive, onPollChanged, type PollView } from "./backend";
import { t } from "./i18n";

/** A poll in the chat: answers with live results; click to vote. */
export function PollCard({ conversation, poll, question }: { conversation: string; poll: string; question: string }) {
  const [view, setView] = useState<PollView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const load = () => backend.poll(conversation, poll).then((v) => { setView(v); setPicked(v.mine); }).catch((e) => setError(String(e)));
  useEffect(() => {
    if (!isLive) return;
    void load();
    const off = onPollChanged((conv, id) => conv === conversation && id === poll && void load());
    return () => { off.then((f) => f()); };
  }, [conversation, poll]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!view) return <div className="poll-card"><b>📊 {question}</b>{error ? <p className="error">{error}</p> : <p className="muted">{t("common.loading")}</p>}</div>;
  const multi = view.maxSelections > 1;
  const voted = view.mine.length > 0;
  // Results show once you voted (if the poll allows) or when it has ended.
  const showResults = view.ended || (view.disclosed && voted);
  const top = Math.max(1, ...view.answers.map(([, , n]) => n));
  const send = (answers: string[]) => backend.vote(conversation, poll, answers).then(load).catch((e) => setError(String(e)));
  const choose = (id: string) => {
    if (view.ended) return;
    if (!multi) return void send([id]);
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < view.maxSelections ? [...p, id] : p));
  };

  return (
    <div className={`poll-card ${view.ended ? "ended" : ""}`}>
      <b>📊 {view.question}</b>
      {multi && !view.ended && <span className="muted small">{t("poll.pickUpTo", { count: view.maxSelections })}</span>}
      <div className="poll-answers">
        {view.answers.map(([id, text, votes]) => {
          const mine = (multi ? picked : view.mine).includes(id);
          const winner = view.ended && votes === top && votes > 0;
          return (
            <button key={id} className={`poll-answer ${mine ? "mine" : ""} ${winner ? "winner" : ""}`} disabled={view.ended} onClick={() => choose(id)}>
              {showResults && <span className="poll-bar" style={{ width: `${(votes / Math.max(1, view.voters)) * 100}%` }} />}
              <span className="poll-check">{mine ? "✓" : ""}</span>
              <span className="poll-text">{text}</span>
              {showResults && <span className="poll-count">{votes}</span>}
            </button>
          );
        })}
      </div>
      <div className="poll-foot">
        <span className="muted small">
          {view.ended ? t("poll.ended", { count: view.voters }) : !view.disclosed ? t("poll.hidden") : t("poll.votes", { count: view.voters })}
        </span>
        {multi && !view.ended && picked.join() !== view.mine.join() && <button className="btn primary small" onClick={() => void send(picked)}>{t("poll.vote")}</button>}
        {view.ours && !view.ended && <button className="btn small" onClick={() => confirm(t("poll.endConfirm")) && backend.endPoll(conversation, poll).then(load).catch((e) => setError(String(e)))}>{t("poll.end")}</button>}
      </div>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

/** /poll: question, 2–20 answers, single or multiple choice, results open or hidden until the end. */
export function PollDialog({ conversation, onClose, onError }: { conversation: string; onClose: () => void; onError: (e: string) => void }) {
  const [question, setQuestion] = useState("");
  const [answers, setAnswers] = useState(["", ""]);
  const [multi, setMulti] = useState(false);
  const [disclosed, setDisclosed] = useState(true);
  const filled = answers.map((a) => a.trim()).filter(Boolean);
  const create = () =>
    backend.createPoll(conversation, question.trim(), filled, multi ? filled.length : 1, disclosed).then(onClose).catch((e) => onError(String(e)));
  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card new-chat poll-dialog">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{t("poll.create")}</h1>
        <label>{t("poll.question")}<input autoFocus value={question} onChange={(e) => setQuestion(e.target.value)} /></label>
        {answers.map((a, i) => (
          <div key={i} className="poll-answer-edit">
            <input value={a} placeholder={t("poll.answerN", { n: i + 1 })} onChange={(e) => setAnswers(answers.map((x, n) => (n === i ? e.target.value : x)))} />
            {answers.length > 2 && <button className="icon-btn" title={t("common.remove")} onClick={() => setAnswers(answers.filter((_, n) => n !== i))}>✕</button>}
          </div>
        ))}
        {answers.length < 20 && <button className="link" onClick={() => setAnswers([...answers, ""])}>{t("poll.addAnswer")}</button>}
        <label className="toggle-row"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /><span>{t("poll.multi")}</span></label>
        <label className="toggle-row"><input type="checkbox" checked={!disclosed} onChange={(e) => setDisclosed(!e.target.checked)} /><span>{t("poll.hideResults")}</span></label>
        <button className="btn primary wide" disabled={!question.trim() || filled.length < 2} onClick={() => void create()}>{t("poll.create")}</button>
      </div>
    </div>
  );
}
