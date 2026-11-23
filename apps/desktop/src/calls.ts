// Matrix 1:1 calls (VoIP spec v1, like Element): signalling goes through room events
// (m.call.invite / answer / candidates / select_answer / negotiate / hangup / reject),
// sent and received via the host; media flows over WebRTC in this webview.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { backend, isLive, onCallSignal, type CallSignal } from "./backend";
import { currentSettings } from "./settings";
import { openMic } from "./voice";
import { processCamera, switchEffect, type CameraEffect } from "./cameraEffects";
import { pickScreen, screenStopped } from "./screenShare";

export type CallPhase = "ringing" | "connecting" | "connected" | "ended";

export interface CallState {
  id: string;
  conversation: string;
  account: string;
  peer: string;
  direction: "out" | "in";
  /** The call was offered with video. */
  video: boolean;
  phase: CallPhase;
  muted: boolean;
  cameraOn: boolean;
  sharing: boolean;
  /** Put on hold with /holdcall: no audio or video either way until resumed. */
  onHold: boolean;
  remote?: MediaStream;
  remoteScreen?: MediaStream;
  local?: MediaStream;
  remoteMuted: boolean;
  /** When it started ringing. */
  startedAt?: number;
  connectedAt?: number;
  endReason?: string;
  minimized: boolean;
}

/** Unique per app run, so our own events can be told apart from our other sessions'. */
const PARTY = Math.random().toString(36).slice(2, 10);
const VERSION = "1";
const LIFETIME = 60_000;
const METADATA = "org.matrix.msc3077.sdp_stream_metadata";

type Json = Record<string, unknown>;

class Call {
  pc?: RTCPeerConnection;
  state: CallState;
  opponent?: string;
  offer?: RTCSessionDescriptionInit;
  pending: RTCIceCandidateInit[] = [];
  outbox: RTCIceCandidateInit[] = [];
  canSendCandidates = false;
  /** The call was minimised for screen sharing and comes back when sharing stops. */
  restoreAfterShare = false;
  flushTimer = 0;
  inviteTimer = 0;
  screen?: MediaStream;
  remoteMeta: Record<string, { purpose?: string; audio_muted?: boolean; video_muted?: boolean }> = {};

  constructor(state: CallState, private update: (s: CallState) => void) {
    this.state = state;
  }

  set(patch: Partial<CallState>) {
    this.state = { ...this.state, ...patch };
    this.update(this.state);
  }

  send(type: string, content: Json) {
    return backend.sendCallEvent(this.state.conversation, `m.call.${type}`, JSON.stringify({ call_id: this.state.id, party_id: PARTY, version: VERSION, ...content }));
  }

  metadata(): Json {
    const out: Json = {};
    const local = this.state.local;
    if (local) out[local.id] = { purpose: "m.usermedia", audio_muted: this.state.muted, video_muted: !this.state.cameraOn };
    if (this.screen) out[this.screen.id] = { purpose: "m.screenshare" };
    return out;
  }

  async connect() {
    const turn = await backend.turnServers(this.state.account).catch(() => null);
    const pc = new RTCPeerConnection({ iceServers: turn ? [{ urls: turn.uris, username: turn.username, credential: turn.password }] : [] });
    this.pc = pc;
    pc.onicecandidate = (e) => {
      // Batched like Element; an empty candidate marks the end.
      this.outbox.push(e.candidate ? e.candidate.toJSON() : { candidate: "", sdpMid: "0", sdpMLineIndex: 0 });
      this.scheduleFlush();
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (!stream) return;
      if (this.remoteMeta[stream.id]?.purpose === "m.screenshare") this.set({ remoteScreen: stream });
      else this.set({ remote: stream });
      stream.onremovetrack = () => {
        if (stream.getTracks().length === 0 && this.state.remoteScreen?.id === stream.id) this.set({ remoteScreen: undefined });
      };
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected" && this.state.phase !== "connected") {
        window.clearTimeout(this.inviteTimer);
        this.set({ phase: "connected", connectedAt: Date.now() });
      }
      if (pc.connectionState === "failed") void this.hangup("ice_failed");
    };
    // Adding/removing video or screen sharing during the call.
    pc.onnegotiationneeded = async () => {
      if (this.state.phase !== "connected") return;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await this.send("negotiate", { description: { type: offer.type, sdp: offer.sdp }, lifetime: LIFETIME, [METADATA]: this.metadata() });
    };
    for (const track of this.state.local?.getTracks() ?? []) pc.addTrack(track, this.state.local!);
    return pc;
  }

  scheduleFlush() {
    if (this.flushTimer || !this.canSendCandidates) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = 0;
      const candidates = this.outbox.splice(0);
      if (candidates.length) void this.send("candidates", { candidates });
    }, 200);
  }

  async addCandidates(list: RTCIceCandidateInit[]) {
    if (!this.pc?.remoteDescription) return void this.pending.push(...list);
    for (const c of list) {
      if (!c.candidate) continue; // end of candidates
      await this.pc.addIceCandidate(c).catch(() => {});
    }
  }

  async flushPending() {
    const list = this.pending.splice(0);
    await this.addCandidates(list);
  }

  async start() {
    const pc = await this.connect();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const peer = this.state.peer;
    await this.send("invite", { lifetime: LIFETIME, offer: { type: offer.type, sdp: offer.sdp }, invitee: peer, [METADATA]: this.metadata() });
    this.canSendCandidates = true;
    this.scheduleFlush();
    this.inviteTimer = window.setTimeout(() => this.state.phase === "ringing" && void this.hangup("invite_timeout"), LIFETIME);
  }

  async accept(video: boolean) {
    this.set({ phase: "connecting" });
    const local = await openMedia(video && this.state.video);
    this.set({ local, cameraOn: local.getVideoTracks().length > 0 });
    const pc = await this.connect();
    await pc.setRemoteDescription(this.offer!);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await this.send("answer", { answer: { type: answer.type, sdp: answer.sdp }, [METADATA]: this.metadata() });
    this.canSendCandidates = true;
    this.scheduleFlush();
    await this.flushPending();
  }

  async onSignal(type: string, c: Json, fromMe: boolean) {
    const party = c.party_id as string | undefined;
    const meta = c[METADATA] as Call["remoteMeta"] | undefined;
    if (meta) {
      this.remoteMeta = { ...this.remoteMeta, ...meta };
      const usermedia = Object.values(meta).find((m) => m.purpose === "m.usermedia");
      if (usermedia) this.set({ remoteMuted: !!usermedia.audio_muted });
    }
    switch (type) {
      case "m.call.answer":
        if (fromMe) return this.end(this.state.direction === "in" ? "answered_elsewhere" : undefined); // our other session picked up
        if (this.state.direction !== "out" || this.opponent) return;
        this.opponent = party;
        await this.pc?.setRemoteDescription(c.answer as RTCSessionDescriptionInit);
        await this.send("select_answer", { selected_party_id: party });
        this.set({ phase: "connecting" });
        await this.flushPending();
        return;
      case "m.call.select_answer":
        if (c.selected_party_id !== PARTY) this.end("answered_elsewhere");
        return;
      case "m.call.candidates":
        if (fromMe || (this.opponent && party !== this.opponent)) return;
        return this.addCandidates((c.candidates as RTCIceCandidateInit[]) ?? []);
      case "m.call.negotiate": {
        if (fromMe || !this.pc) return;
        const desc = c.description as RTCSessionDescriptionInit;
        await this.pc.setRemoteDescription(desc);
        if (desc.type === "offer") {
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          await this.send("negotiate", { description: { type: answer.type, sdp: answer.sdp }, lifetime: LIFETIME, [METADATA]: this.metadata() });
        }
        return;
      }
      case "m.call.hangup":
      case "m.call.reject":
        if (fromMe && this.state.phase === "ringing" && this.state.direction === "in") return this.end("answered_elsewhere");
        if (!fromMe) this.end((c.reason as string) ?? (type === "m.call.reject" ? "rejected" : "hangup"));
        return;
    }
  }

  async hangup(reason = "user_hangup") {
    const declining = this.state.direction === "in" && this.state.phase === "ringing";
    await (declining ? this.send("reject", {}) : this.send("hangup", { reason })).catch(() => {});
    this.end(reason === "user_hangup" ? undefined : reason);
  }

  end(reason?: string) {
    window.clearTimeout(this.inviteTimer);
    window.clearTimeout(this.flushTimer);
    this.state.local?.getTracks().forEach((t) => t.stop());
    this.screen?.getTracks().forEach((t) => t.stop());
    screenStopped();
    this.pc?.close();
    this.set({ phase: "ended", endReason: reason, remote: undefined, remoteScreen: undefined });
  }

  /** Hold = every stream inactive; resuming renegotiates back to send/receive. */
  setHold(on: boolean) {
    if (!this.pc || this.state.phase !== "connected") return;
    for (const tr of this.pc.getTransceivers()) if (tr.currentDirection !== "stopped") tr.direction = on ? "inactive" : "sendrecv";
    this.set({ onHold: on });
  }

  setMuted(muted: boolean) {
    this.state.local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    this.set({ muted });
    void this.send("sdp_stream_metadata_changed", { [METADATA]: this.metadata() });
  }

  async setCamera(on: boolean) {
    const local = this.state.local;
    const track = local?.getVideoTracks()[0];
    if (track) {
      track.enabled = on;
    } else if (on && local && this.pc) {
      // A voice call turning video on: add a camera track (renegotiates).
      const cam = await navigator.mediaDevices.getUserMedia({ video: cameraConstraint() });
      const t = await processCamera(cam.getVideoTracks()[0]!);
      local.addTrack(t);
      this.pc.addTrack(t, local);
    }
    this.set({ cameraOn: on });
    void this.send("sdp_stream_metadata_changed", { [METADATA]: this.metadata() });
  }

  /** Blur or replace the camera background; the same stream keeps its id (stream metadata). */
  async setBackground(effect: CameraEffect) {
    await switchEffect(this.state.local, [this.pc], effect);
    this.set({ local: this.state.local });
  }

  async setSharing(on: boolean) {
    if (!this.pc) return;
    if (on) {
      const screen = await pickScreen(() => void this.setSharing(false));
      this.screen = screen;
      for (const t of screen.getTracks()) {
        this.pc.addTrack(t, screen);
        t.onended = () => void this.setSharing(false); // stopped from the system's own control
      }
      // Out of the way while sharing, or the shared screen shows the call showing the screen…
      this.restoreAfterShare = !this.state.minimized;
      this.set({ sharing: true, minimized: true });
    } else if (this.screen) {
      for (const sender of this.pc.getSenders()) if (sender.track && this.screen.getTracks().includes(sender.track)) this.pc.removeTrack(sender);
      this.screen.getTracks().forEach((t) => t.stop());
      this.screen = undefined;
      screenStopped();
      this.set({ sharing: false, ...(this.restoreAfterShare ? { minimized: false } : {}) });
      this.restoreAfterShare = false;
    }
  }
}

const cameraConstraint = (): MediaTrackConstraints | boolean => {
  const id = currentSettings().cameraId;
  return id ? { deviceId: { ideal: id } } : true;
};

/** Microphone (the one chosen in Settings) and, for video calls, the camera. */
async function openMedia(video: boolean): Promise<MediaStream> {
  const [mic, cam] = await Promise.all([
    openMic(),
    // No camera: carry on with audio.
    video ? navigator.mediaDevices.getUserMedia({ video: cameraConstraint() }).catch(() => null) : null,
  ]);
  for (const t of cam?.getVideoTracks() ?? []) mic.addTrack(await processCamera(t));
  return mic;
}

/** One finished call, kept on this device for the Calls view. */
export interface CallRecord {
  id: string;
  conversation: string;
  peer: string;
  direction: "out" | "in";
  video: boolean;
  at: number;
  /** Talk time in ms; 0 when it never connected. */
  duration: number;
  /** End reason (missed, rejected, invite_timeout, ...) or null for a normal hang-up. */
  outcome: string | null;
}

const HISTORY_KEY = "Trixcomm.calls.history";
const loadHistory = (): CallRecord[] => {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); } catch { return []; }
};

export interface Calls {
  call: CallState | null;
  history: CallRecord[];
  clearHistory: () => void;
  start: (conversation: string, account: string, peer: string, video: boolean) => void;
  accept: (video: boolean) => void;
  hangup: () => void;
  setMuted: (muted: boolean) => void;
  setCamera: (on: boolean) => void;
  setSharing: (on: boolean) => void;
  setBackground: (effect: CameraEffect) => void;
  setMinimized: (minimized: boolean) => void;
  setHold: (on: boolean) => void;
  dismiss: () => void;
}

export const CallsContext = createContext<Calls | null>(null);
export const useCalls = () => useContext(CallsContext);

/** One call at a time; incoming invites while busy are left to ring elsewhere. */
export function useMatrixCalls(onError: (message: string) => void, onRing: (conversation: string, peer: string, video: boolean) => void): Calls {
  const [call, setCall] = useState<CallState | null>(null);
  const current = useRef<Call | null>(null);
  const [history, setHistoryState] = useState<CallRecord[]>(loadHistory);
  const setHistory = (next: CallRecord[]) => {
    setHistoryState(next);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };
  const recorded = useRef(new Set<string>());
  // Every call that ends goes into the history once.
  useEffect(() => {
    if (!call || call.phase !== "ended" || recorded.current.has(call.id)) return;
    recorded.current.add(call.id);
    const entry: CallRecord = {
      id: call.id, conversation: call.conversation, peer: call.peer, direction: call.direction, video: call.video,
      at: call.startedAt ?? Date.now(), duration: call.connectedAt ? Date.now() - call.connectedAt : 0, outcome: call.endReason ?? null,
    };
    setHistory([entry, ...loadHistory().filter((r) => r.id !== entry.id)].slice(0, 200));
  }, [call?.phase]); // eslint-disable-line react-hooks/exhaustive-deps
  const handlers = useRef({ onError, onRing });
  handlers.current = { onError, onRing };

  useEffect(() => {
    if (!isLive) return;
    const off = onCallSignal((sig) => void onSignal(sig));
    return () => { off.then((f) => f()); };
  }, []);

  const make = (initial: CallState) => {
    const state = { ...initial, startedAt: Date.now() };
    const c = new Call(state, (s) => setCall({ ...s }));
    current.current = c;
    setCall(state);
    return c;
  };

  const onSignal = async (sig: CallSignal) => {
    let content: Json;
    try { content = JSON.parse(sig.content); } catch { return; }
    if (content.party_id === PARTY) return; // our own echo
    const c = current.current;
    if (sig.eventType === "m.call.invite") {
      const lifetime = Number(content.lifetime ?? LIFETIME);
      if (sig.fromMe || sig.ageMs > lifetime) return;
      // Both calling each other at once ("glare"): the lower call id wins on both sides,
      // so one call survives. If theirs wins, drop ours and pick theirs up straight away.
      const glare = c && c.state.phase === "ringing" && c.state.direction === "out" && c.state.conversation === sig.conversation;
      if (glare && String(content.call_id) > c.state.id) return; // ours wins; they'll answer it
      const autoAnswer = glare ? c.state.video : null;
      if (glare) {
        await c.send("hangup", { reason: "replaced" }).catch(() => {});
        recorded.current.add(c.state.id); // not a call of its own in the history
        c.end("replaced");
      } else if (c && c.state.phase !== "ended") {
        return; // busy: let it ring on other devices
      }
      const offer = content.offer as RTCSessionDescriptionInit;
      const call = make({
        id: content.call_id as string, conversation: sig.conversation, account: sig.conversation.split("|")[0]!, peer: sig.sender,
        direction: "in", video: /m=video/.test(offer?.sdp ?? ""), phase: "ringing", muted: false, cameraOn: false, sharing: false, onHold: false, remoteMuted: false, minimized: false,
      });
      call.opponent = content.party_id as string;
      call.offer = offer;
      if (content[METADATA]) call.remoteMeta = content[METADATA] as Call["remoteMeta"];
      call.inviteTimer = window.setTimeout(() => call.state.phase === "ringing" && call.end("missed"), lifetime - sig.ageMs);
      if (autoAnswer !== null) return guard(() => call.accept(autoAnswer));
      handlers.current.onRing(sig.conversation, sig.sender, call.state.video);
      return;
    }
    if (c && content.call_id === c.state.id && c.state.phase !== "ended") {
      try {
        await c.onSignal(sig.eventType, content, sig.fromMe);
      } catch (e) {
        handlers.current.onError(String(e));
      }
    }
  };

  const guard = (f: () => Promise<void> | void) => {
    Promise.resolve().then(f).catch((e) => {
      handlers.current.onError(String(e));
      current.current?.end("error");
    });
  };

  return {
    call,
    history,
    clearHistory: () => setHistory([]),
    start: (conversation, account, peer, video) =>
      guard(async () => {
        if (current.current && current.current.state.phase !== "ended") return;
        const local = await openMedia(video);
        const c = make({
          id: `c${Date.now()}${Math.random().toString(36).slice(2, 8)}`, conversation, account, peer, direction: "out", video,
          phase: "ringing", muted: false, cameraOn: local.getVideoTracks().length > 0, sharing: false, onHold: false, local, remoteMuted: false, minimized: false,
        });
        await c.start();
      }),
    accept: (video) => guard(() => current.current?.accept(video)),
    hangup: () => guard(() => current.current?.hangup()),
    setMuted: (muted) => current.current?.setMuted(muted),
    setCamera: (on) => guard(() => current.current?.setCamera(on)),
    setSharing: (on) => guard(() => current.current?.setSharing(on)),
    // A failed background change shouldn't end the call.
    setBackground: (effect) => void current.current?.setBackground(effect).catch((e) => handlers.current.onError(String(e))),
    setMinimized: (minimized) => current.current?.set({ minimized }),
    setHold: (on) => current.current?.setHold(on),
    dismiss: () => { current.current = null; setCall(null); },
  };
}
