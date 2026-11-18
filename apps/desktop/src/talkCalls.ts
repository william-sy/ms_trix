// Talk group calls in ms_trix's own call screen.
//
// Membership (joining the conversation and the call) and the signalling settings go
// through Talk's REST API via the host (`backend.callApi`). Signalling then runs either
// over the high-performance backend (HPB: a WebSocket, with or without an MCU/video server)
// or over Talk's built-in signalling (HTTP polling). Media is WebRTC in this webview.
//
// Message shapes follow Talk's own web client: data { to, type, roomType, sid, payload }.
// Every step is logged (backend.logUi) so problems can be traced on the real server.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { backend, isLive } from "./backend";
import { currentSettings } from "./settings";
import { openMic } from "./voice";
import { currentEffect, processCamera, switchEffect, type CameraEffect } from "./cameraEffects";
import { pickScreen, screenStopped } from "./screenShare";

const API = "/ocs/v2.php/apps/spreed/api";
// Talk's in-call flags.
const IN_CALL = 1, WITH_AUDIO = 2, WITH_VIDEO = 4;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

export interface TalkPeerView {
  sid: string;
  name: string;
  stream?: MediaStream;
  screen?: MediaStream;
  audioOn: boolean;
  videoOn: boolean;
  speaking: boolean;
  /** When they raised their hand (lowered: undefined). */
  handRaised?: number;
}

/** A reaction floating over the call for a few seconds. */
export interface FloatingReaction {
  id: number;
  emoji: string;
  name: string;
}

export interface TalkCallState {
  conversation: string;
  account: string;
  /** "prejoin": preview and device check before actually joining (like Teams). */
  phase: "prejoin" | "joining" | "connected" | "ended";
  peers: TalkPeerView[];
  local?: MediaStream;
  screen?: MediaStream;
  muted: boolean;
  cameraOn: boolean;
  sharing: boolean;
  minimized: boolean;
  speakingSelf: boolean;
  handRaised: boolean;
  reactions: FloatingReaction[];
  /** The call is being recorded (Talk's recording server). */
  recording?: "starting" | "on";
  connectedAt?: number;
  error?: string;
}

interface Peer extends TalkPeerView {
  pcs: Partial<Record<"video" | "screen", RTCPeerConnection>>;
  pending: Partial<Record<"video" | "screen", RTCIceCandidateInit[]>>;
  inCall: number;
  offerTimer?: number;
  meter?: () => void;
}

const log = (msg: string) => { console.info("[talk-call]", msg); void backend.logUi(`talk call: ${msg}`).catch(() => {}); };

/** Speaking detection: calls `on(true/false)` as the level crosses a threshold. */
function speakingMeter(stream: MediaStream, on: (speaking: boolean) => void): () => void {
  if (!stream.getAudioTracks().length) return () => {};
  const ctx = new AudioContext();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const data = new Float32Array(analyser.fftSize);
  let speaking = false;
  const timer = window.setInterval(() => {
    analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    const now = Math.sqrt(sum / data.length) > 0.02;
    if (now !== speaking) { speaking = now; on(now); }
  }, 150);
  return () => { window.clearInterval(timer); void ctx.close(); };
}

interface Signaling {
  ownSid: string;
  mcu: boolean;
  send: (to: string, data: Any) => void;
  close: () => void;
}

export class TalkCall {
  state: TalkCallState;
  peers = new Map<string, Peer>();
  sig?: Signaling;
  token: string;
  names = new Map<string, string>(); // signalling session id -> display name
  nextcloudSid = "";
  /** Our display name; Talk names call tiles (and "raised their hand") after the nick in our offers. */
  nick = "";
  /** The call was minimised for screen sharing and comes back when sharing stops. */
  restoreAfterShare = false;
  /** The preview's camera background being applied (joining waits for it). */
  effectReady: Promise<void> = Promise.resolve();
  iceServers: RTCIceServer[] = [];
  publishers: Partial<Record<"video" | "screen", RTCPeerConnection>> = {};
  ownPending: Partial<Record<"video" | "screen", RTCIceCandidateInit[]>> = {};
  selfMeter?: () => void;
  closed = false;

  constructor(conversation: string, private update: (s: TalkCallState) => void) {
    const [account, token] = conversation.split("|") as [string, string];
    this.token = token;
    this.state = { conversation, account, phase: "prejoin", peers: [], muted: false, cameraOn: false, sharing: false, minimized: false, speakingSelf: false, handRaised: false, reactions: [] };
  }

  private set(patch: Partial<TalkCallState>) {
    this.state = { ...this.state, ...patch, peers: [...this.peers.values()].map(({ sid, name, stream, screen, audioOn, videoOn, speaking, handRaised }) => ({ sid, name, stream, screen, audioOn, videoOn, speaking, handRaised })) };
    this.update(this.state);
  }

  /** The Nextcloud address, for the signalling server's backend check. */
  server = "";

  private async api(method: string, path: string, form: Record<string, string> = {}, timeout = 30): Promise<Any> {
    const [json, server] = await backend.callApi(this.state.account, method, `${API}${path}`, Object.entries(form), timeout);
    this.server = server;
    return JSON.parse(json);
  }

  /** Pre-join: open microphone (and camera) for the preview. */
  async prepare(video: boolean, micId?: string | null, cameraId?: string | null) {
    try {
      this.selfMeter?.();
      this.state.local?.getTracks().forEach((t) => t.stop());
      // The preview shows the plain camera at once; the background follows when it's ready.
      const local = await openMedia(video, micId, cameraId, false);
      local.getAudioTracks().forEach((t) => (t.enabled = !this.state.muted));
      this.selfMeter = speakingMeter(local, (speakingSelf) => this.set({ speakingSelf }));
      this.set({ local, cameraOn: local.getVideoTracks().length > 0 });
      this.effectReady = switchEffect(local, [], currentEffect()).then((changed) => { if (changed) this.set({ local }); }, () => {});
    } catch (e) {
      this.set({ error: String(e) });
    }
  }

  /** Leaves the preview without joining. */
  cancel() {
    this.closed = true;
    this.selfMeter?.();
    this.state.local?.getTracks().forEach((t) => t.stop());
    this.set({ phase: "ended", local: undefined });
  }

  async start() {
    this.set({ phase: "joining" });
    try {
      const settings = await this.api("GET", `/v3/signaling/settings`, { token: this.token });
      log(`signaling mode ${settings.signalingMode}, server ${settings.server || "(built-in)"}`);
      this.iceServers = [...(settings.stunservers ?? []), ...(settings.turnservers ?? [])].map((s: Any) => ({ urls: s.urls, username: s.username, credential: s.credential }));

      const room = await this.api("POST", `/v4/room/${this.token}/participants/active`, { force: "true" });
      this.nextcloudSid = room.sessionId;
      log(`joined the conversation, Nextcloud session ${this.nextcloudSid.slice(0, 8)}…`);
      const names = this.loadNames().then(() => { this.nick = this.names.get(this.nextcloudSid) ?? ""; });

      const local = this.state.local ?? await openMedia(false);
      await this.effectReady;
      // A camera switched off in the preview joins switched off.
      local.getVideoTracks().forEach((t) => (t.enabled = this.state.cameraOn));

      this.sig = settings.signalingMode === "internal" || !settings.server
        ? this.internalSignaling()
        : await this.externalSignaling(settings);
      const flags = IN_CALL | WITH_AUDIO | (local.getVideoTracks().length && this.state.cameraOn ? WITH_VIDEO : 0);
      await this.api("POST", `/v4/call/${this.token}`, { flags: String(flags), silent: "false" });
      log(`in the call (flags ${flags}), ${this.sig.mcu ? "via the video server (MCU)" : "peer to peer"}`);
      await names;
      if (this.sig.mcu) await this.publish("video", local);
      this.set({ phase: "connected", connectedAt: Date.now() });
      void this.watchRecording();
    } catch (e) {
      log(`failed to start: ${String(e)}`);
      this.set({ error: String(e) });
      await this.leave();
    }
  }

  // ---- signalling: high-performance backend (WebSocket) ----

  private externalSignaling(settings: Any): Promise<Signaling> {
    return new Promise((resolve, reject) => {
      const base = String(settings.server).replace(/^http/, "ws").replace(/\/$/, "");
      const ws = new WebSocket(base.endsWith("/spreed") ? base : `${base}/spreed`);
      let id = 1;
      const out = (msg: Any) => ws.send(JSON.stringify({ id: String(id++), ...msg }));
      const sig: Signaling = {
        ownSid: "", mcu: false,
        send: (to, data) => out({ type: "message", message: { recipient: { type: "session", sessionid: to }, data } }),
        close: () => ws.close(),
      };
      ws.onopen = () => {
        const backendUrl = `${this.server}${API}/v3/signaling/backend`;
        const v2 = settings.helloAuthParams?.["2.0"];
        out(v2
          ? { type: "hello", hello: { version: "2.0", auth: { type: "client", url: backendUrl, params: v2 } } }
          : { type: "hello", hello: { version: "1.0", auth: { url: backendUrl, params: settings.helloAuthParams?.["1.0"] ?? { userid: settings.userId, ticket: settings.ticket } } } });
      };
      ws.onerror = () => reject(new Error("couldn't connect to the signalling server"));
      ws.onclose = () => { if (!this.closed) { log("signalling connection closed"); void this.leave(); } };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        switch (msg.type) {
          case "hello":
            sig.ownSid = msg.hello.sessionid;
            sig.mcu = (msg.hello.server?.features ?? []).includes("mcu");
            log(`signalling hello, session ${sig.ownSid.slice(0, 8)}…, features ${(msg.hello.server?.features ?? []).join(",")}`);
            out({ type: "room", room: { roomid: this.token, sessionid: this.nextcloudSid } });
            break;
          case "room":
            log("joined the signalling room");
            resolve(sig);
            break;
          case "error":
            log(`signalling error: ${msg.error?.code} ${msg.error?.message ?? ""}`);
            if (!sig.ownSid) reject(new Error(msg.error?.message ?? "signalling error"));
            break;
          case "message":
            void this.onData(msg.message.sender?.sessionid, msg.message.data);
            break;
          case "event":
            this.onEvent(msg.event);
            break;
        }
      };
    });
  }

  private onEvent(event: Any) {
    if (event.target === "room" && event.type === "join") {
      for (const j of event.join ?? []) if (j.user?.displayname) this.names.set(j.sessionid, j.user.displayname);
    }
    if (event.target === "room" && event.type === "leave") {
      for (const sid of event.leave ?? []) this.dropPeer(sid);
    }
    if (event.target === "participants" && event.type === "update") {
      const users = event.update?.users ?? [];
      void this.onUsers(users.map((u: Any) => ({ sid: u.sessionId, inCall: Number(u.inCall ?? 0), userId: u.userId, name: u.displayName })));
    }
  }

  // ---- signalling: Talk's built-in (HTTP polling, peer to peer only) ----

  private internalSignaling(): Signaling {
    const sig: Signaling = {
      ownSid: this.nextcloudSid, mcu: false,
      send: (to, data) => {
        const messages = JSON.stringify([{ ev: "message", fn: JSON.stringify({ ...data, to }), sessionId: this.nextcloudSid }]);
        void this.api("POST", `/v3/signaling/${this.token}`, { messages }).catch((e) => log(`send failed: ${String(e)}`));
      },
      close: () => {},
    };
    void (async () => {
      while (!this.closed) {
        try {
          const items: Any[] = await this.api("GET", `/v3/signaling/${this.token}`, {}, 40);
          for (const item of items ?? []) {
            if (item.type === "usersInRoom") {
              await this.onUsers((item.data ?? []).map((u: Any) => ({ sid: u.sessionId, inCall: Number(u.inCall ?? 0), userId: u.userId })));
            } else if (item.type === "message") {
              const data = typeof item.data === "string" ? JSON.parse(item.data) : item.data;
              await this.onData(data.from, data);
            }
          }
        } catch (e) {
          if (this.closed) break;
          log(`polling failed: ${String(e)}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    })();
    return sig;
  }

  // ---- participants ----

  private async onUsers(users: { sid: string; inCall: number; userId?: string; name?: string }[]) {
    const sig = this.sig;
    if (!sig) return;
    const inCall = users.filter((u) => u.sid && u.sid !== sig.ownSid && u.sid !== this.nextcloudSid && u.inCall & IN_CALL);
    if (inCall.some((u) => !this.names.has(u.sid) && !u.name)) await this.loadNames();
    for (const u of inCall) {
      if (u.name) this.names.set(u.sid, u.name);
      let peer = this.peers.get(u.sid);
      if (!peer) {
        peer = { sid: u.sid, name: this.names.get(u.sid) ?? u.userId ?? "…", pcs: {}, pending: {}, inCall: u.inCall, audioOn: !!(u.inCall & WITH_AUDIO), videoOn: !!(u.inCall & WITH_VIDEO), speaking: false };
        this.peers.set(u.sid, peer);
        log(`participant joined: ${peer.name} (flags ${u.inCall})`);
        this.connectPeer(peer);
        if (this.state.screen) this.sendScreenTo(peer);
      }
      peer.inCall = u.inCall;
    }
    // Who left the call (flags 0 or gone from the list).
    for (const sid of [...this.peers.keys()]) {
      const u = users.find((x) => x.sid === sid);
      if (u && !(u.inCall & IN_CALL)) this.dropPeer(sid);
    }
    this.set({});
  }

  private async loadNames() {
    try {
      const list: Any[] = await this.api("GET", `/v4/room/${this.token}/participants`, { includeStatus: "false" });
      for (const p of list ?? []) for (const sid of p.sessionIds ?? []) this.names.set(sid, p.displayName || p.actorId);
    } catch { /* names are a nicety */ }
  }

  private connectPeer(peer: Peer) {
    const sig = this.sig!;
    if (sig.mcu) {
      // The video server sends us an offer for each publisher we ask for. Someone who
      // just joined may not be publishing yet, so ask again a few times.
      let tries = 0;
      const ask = () => {
        if (this.closed || !this.peers.has(peer.sid) || peer.pcs.video || tries++ >= 6) return;
        if (peer.inCall & (WITH_AUDIO | WITH_VIDEO)) sig.send(peer.sid, { type: "requestoffer", roomType: "video" });
        peer.offerTimer = window.setTimeout(ask, 3000);
      };
      ask();
      return;
    }
    // Peer to peer: one side offers; the other waits (and offers itself if nothing comes).
    if (sig.ownSid > peer.sid) void this.offerTo(peer, "video");
    else peer.offerTimer = window.setTimeout(() => !peer.pcs.video && void this.offerTo(peer, "video"), 4000);
  }

  private dropPeer(sid: string) {
    const peer = this.peers.get(sid);
    if (!peer) return;
    window.clearTimeout(peer.offerTimer);
    peer.meter?.();
    Object.values(peer.pcs).forEach((pc) => pc?.close());
    this.peers.delete(sid);
    log(`participant left: ${peer.name}`);
    this.set({});
  }

  // ---- WebRTC ----

  private newPc(onCandidate: (c: RTCIceCandidate) => void): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    pc.onicecandidate = (e) => e.candidate && onCandidate(e.candidate);
    return pc;
  }

  private candidateData(to: string, roomType: string, c: RTCIceCandidate) {
    return { to, type: "candidate", roomType, sid: "", payload: { candidate: { candidate: c.candidate, sdpMid: c.sdpMid, sdpMLineIndex: c.sdpMLineIndex } } };
  }

  /** MCU: send our camera/mic (or screen) to the video server via our own session. */
  private async publish(roomType: "video" | "screen", stream: MediaStream) {
    const sig = this.sig!;
    const pc = this.newPc((c) => sig.send(sig.ownSid, this.candidateData(sig.ownSid, roomType, c)));
    for (const track of stream.getTracks()) pc.addTransceiver(track, { direction: "sendonly", streams: [stream] });
    this.publishers[roomType] = pc;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sig.send(sig.ownSid, { to: sig.ownSid, type: "offer", roomType, sid: String(Date.now()), payload: { type: "offer", sdp: offer.sdp, nick: this.nick } });
    log(`publishing ${roomType} to the video server`);
  }

  /** Peer to peer: offer our media to one participant. */
  private async offerTo(peer: Peer, roomType: "video" | "screen") {
    const sig = this.sig!;
    const pc = this.peerPc(peer, roomType);
    const stream = roomType === "screen" ? this.state.screen : this.state.local;
    for (const track of stream?.getTracks() ?? []) pc.addTrack(track, stream!);
    if (roomType === "video" && !this.state.local?.getVideoTracks().length) pc.addTransceiver("video", { direction: "recvonly" });
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sig.send(peer.sid, { to: peer.sid, type: "offer", roomType, sid: String(Date.now()), payload: { type: "offer", sdp: offer.sdp, nick: this.nick } });
  }

  private peerPc(peer: Peer, roomType: "video" | "screen"): RTCPeerConnection {
    const existing = peer.pcs[roomType];
    if (existing) return existing;
    const sig = this.sig!;
    const pc = this.newPc((c) => sig.send(peer.sid, this.candidateData(peer.sid, roomType, c)));
    pc.ontrack = (e) => {
      const stream = e.streams[0] ?? new MediaStream([e.track]);
      if (roomType === "screen") peer.screen = stream;
      else {
        peer.stream = stream;
        peer.meter?.();
        peer.meter = speakingMeter(stream, (speaking) => { peer.speaking = speaking; this.set({}); });
      }
      this.set({});
    };
    pc.onconnectionstatechange = () => {
      log(`${peer.name} ${roomType}: ${pc.connectionState}`);
      if (pc.connectionState === "failed" && roomType === "screen") { peer.screen = undefined; this.set({}); }
    };
    peer.pcs[roomType] = pc;
    return pc;
  }

  private async onData(from: string | undefined, data: Any) {
    if (!data || !this.sig) return;
    const roomType: "video" | "screen" = data.roomType === "screen" ? "screen" : "video";
    // The video server answering what we publish.
    if (from === this.sig.ownSid || (this.sig.mcu && data.from === this.sig.ownSid)) {
      const pc = this.publishers[roomType];
      if (data.type === "answer" && pc) await pc.setRemoteDescription(data.payload);
      if (data.type === "candidate" && pc && data.payload?.candidate?.candidate) await pc.addIceCandidate(data.payload.candidate).catch(() => {});
      return;
    }
    const sid = from ?? data.from;
    if (!sid) return;
    let peer = this.peers.get(sid);
    if (!peer && (data.type === "offer" || data.type === "candidate")) {
      // Media from someone the participant list didn't announce yet.
      peer = { sid, name: this.names.get(sid) ?? "…", pcs: {}, pending: {}, inCall: IN_CALL, audioOn: true, videoOn: true, speaking: false };
      this.peers.set(sid, peer);
    }
    if (!peer) return;
    switch (data.type) {
      case "offer": {
        window.clearTimeout(peer.offerTimer);
        const pc = this.peerPc(peer, roomType);
        await pc.setRemoteDescription(data.payload);
        // Peer to peer: send our own media back on the same connection.
        if (!this.sig.mcu && roomType === "video" && pc.getSenders().length === 0) {
          for (const track of this.state.local?.getTracks() ?? []) pc.addTrack(track, this.state.local!);
        }
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.sig.send(sid, { to: sid, type: "answer", roomType, sid: data.sid ?? "", payload: { type: "answer", sdp: answer.sdp, nick: this.nick } });
        for (const c of peer.pending[roomType] ?? []) await pc.addIceCandidate(c).catch(() => {});
        peer.pending[roomType] = [];
        break;
      }
      case "answer":
        await peer.pcs[roomType]?.setRemoteDescription(data.payload);
        break;
      case "candidate": {
        const c = data.payload?.candidate;
        if (!c?.candidate) break;
        const pc = peer.pcs[roomType];
        if (pc?.remoteDescription) await pc.addIceCandidate(c).catch(() => {});
        else (peer.pending[roomType] ??= []).push(c);
        break;
      }
      case "mute":
      case "unmute":
        if (data.payload?.name === "audio") peer.audioOn = data.type === "unmute";
        if (data.payload?.name === "video") peer.videoOn = data.type === "unmute";
        this.set({});
        break;
      case "shareScreen":
        if (this.sig.mcu) this.sig.send(sid, { type: "requestoffer", roomType: "screen" });
        break;
      case "unshareScreen":
        peer.pcs.screen?.close();
        delete peer.pcs.screen;
        peer.screen = undefined;
        this.set({});
        break;
      // Talk's raise hand and reactions travel as signalling messages too.
      case "raiseHand":
        peer.handRaised = data.payload?.state ? Number(data.payload.timestamp) || Date.now() : undefined;
        this.set({});
        break;
      case "reaction":
        if (typeof data.payload?.reaction === "string") this.float(data.payload.reaction, peer.name);
        break;
    }
  }

  /** Talk tells everyone when a call is recorded; check the conversation now and then. */
  private async watchRecording() {
    while (!this.closed) {
      try {
        // callRecording: 0 off, 1 video, 2 audio, 3/4 starting, 5 failed.
        const status = Number((await this.api("GET", `/v4/room/${this.token}`))?.callRecording ?? 0);
        const recording = status === 1 || status === 2 ? "on" : status === 3 || status === 4 ? "starting" : undefined;
        if (recording !== this.state.recording) this.set({ recording });
      } catch { /* try again next round */ }
      await new Promise((r) => window.setTimeout(r, 15_000));
    }
  }

  private reactionId = 0;

  /** Shows a reaction over the call for a few seconds. */
  private float(emoji: string, name: string) {
    const id = ++this.reactionId;
    this.set({ reactions: [...this.state.reactions, { id, emoji: emoji.slice(0, 8), name }].slice(-12) });
    window.setTimeout(() => this.set({ reactions: this.state.reactions.filter((r) => r.id !== id) }), 4000);
  }

  setHand(raised: boolean) {
    this.broadcast({ type: "raiseHand", payload: { state: raised, timestamp: Date.now() } });
    this.set({ handRaised: raised });
  }

  react(emoji: string) {
    this.broadcast({ type: "reaction", payload: { reaction: emoji } });
    this.float(emoji, "");
  }

  private broadcast(data: Any) {
    for (const sid of this.peers.keys()) this.sig?.send(sid, { to: sid, roomType: "video", ...data });
  }

  // ---- controls ----

  setMuted(muted: boolean) {
    this.state.local?.getAudioTracks().forEach((t) => (t.enabled = !muted));
    if (this.state.phase === "prejoin") return this.set({ muted });
    this.broadcast({ type: muted ? "mute" : "unmute", payload: { name: "audio" } });
    this.set({ muted });
  }

  setCamera(on: boolean) {
    const track = this.state.local?.getVideoTracks()[0];
    if (!track) return; // joined without a camera
    track.enabled = on;
    if (this.state.phase === "prejoin") return this.set({ cameraOn: on });
    this.broadcast({ type: on ? "unmute" : "mute", payload: { name: "video" } });
    this.set({ cameraOn: on });
  }

  /** Blur or replace the camera background (also in the pre-join preview). */
  async setBackground(effect: CameraEffect) {
    const connections = [this.publishers.video, ...[...this.peers.values()].map((p) => p.pcs.video)];
    await switchEffect(this.state.local, connections, effect);
    this.set({ local: this.state.local });
  }

  async setSharing(on: boolean) {
    if (!this.sig) return;
    if (on) {
      const screen = await pickScreen(() => void this.setSharing(false));
      screen.getVideoTracks()[0]!.onended = () => void this.setSharing(false);
      // Out of the way while sharing, or the shared screen shows the call showing the screen…
      this.restoreAfterShare = !this.state.minimized;
      this.set({ screen, sharing: true, minimized: true });
      if (this.sig.mcu) {
        await this.publish("screen", screen);
        // The server can only offer the screen to others once it receives it.
        await connected(this.publishers.screen, 10_000);
      }
      for (const peer of this.peers.values()) this.sendScreenTo(peer);
    } else {
      this.state.screen?.getTracks().forEach((t) => t.stop());
      screenStopped();
      this.publishers.screen?.close();
      delete this.publishers.screen;
      for (const peer of this.peers.values()) { peer.pcs.screen?.close(); delete peer.pcs.screen; }
      this.broadcast({ type: "unshareScreen", roomType: "screen" });
      this.set({ screen: undefined, sharing: false, ...(this.restoreAfterShare ? { minimized: false } : {}) });
      this.restoreAfterShare = false;
    }
  }

  /**
   * Shows our shared screen to one participant. With the video server it's the server that
   * offers our screen to them, asked for with "sendoffer" (as Talk's web app does).
   */
  private sendScreenTo(peer: Peer) {
    if (!this.sig) return;
    if (this.sig.mcu) this.sig.send(peer.sid, { type: "sendoffer", roomType: "screen" });
    else void this.offerTo(peer, "screen");
    log(`sharing the screen with ${peer.name}`);
  }

  async leave() {
    if (this.closed) return;
    this.closed = true;
    this.selfMeter?.();
    for (const sid of [...this.peers.keys()]) this.dropPeer(sid);
    Object.values(this.publishers).forEach((pc) => pc?.close());
    this.state.local?.getTracks().forEach((t) => t.stop());
    this.state.screen?.getTracks().forEach((t) => t.stop());
    screenStopped();
    this.sig?.close();
    await this.api("DELETE", `/v4/call/${this.token}`).catch(() => {});
    await this.api("DELETE", `/v4/room/${this.token}/participants/active`).catch(() => {});
    log("left the call");
    this.set({ phase: "ended", local: undefined, screen: undefined });
  }

  setMinimized(minimized: boolean) {
    this.set({ minimized });
  }
}

/** Microphone and camera, opened side by side; `effects`: with the camera background. */
async function openMedia(video: boolean, micId?: string | null, cameraId?: string | null, effects = true): Promise<MediaStream> {
  const id = cameraId ?? currentSettings().cameraId;
  const [mic, cam] = await Promise.all([
    micId ? navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: micId } } }) : openMic(),
    // No camera: audio only.
    video ? navigator.mediaDevices.getUserMedia({ video: id ? { deviceId: { ideal: id } } : true }).catch(() => null) : null,
  ]);
  for (const t of cam?.getVideoTracks() ?? []) mic.addTrack(effects ? await processCamera(t) : t);
  return mic;
}

/** Resolves when `pc` is connected, fails or `ms` have passed. */
function connected(pc: RTCPeerConnection | undefined, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (!pc || pc.connectionState === "connected") return resolve();
    const timer = window.setTimeout(done, ms);
    function done() { window.clearTimeout(timer); pc!.removeEventListener("connectionstatechange", check); resolve(); }
    function check() { if (pc!.connectionState !== "connecting" && pc!.connectionState !== "new") done(); }
    pc.addEventListener("connectionstatechange", check);
  });
}

export interface TalkCalls {
  call: TalkCallState | null;
  /** Opens the pre-join screen. */
  start: (conversation: string, video: boolean) => void;
  /** Joins straight away with these choices (a call moved between windows). */
  join: () => void;
  cancel: () => void;
  /** Pre-join: switch camera on/off or devices (reopens the preview). */
  reprepare: (video: boolean, micId?: string | null, cameraId?: string | null) => void;
  leave: () => void;
  setMuted: (muted: boolean) => void;
  setCamera: (on: boolean) => void;
  setSharing: (on: boolean) => void;
  setBackground: (effect: CameraEffect) => void;
  setHand: (raised: boolean) => void;
  react: (emoji: string) => void;
  setMinimized: (minimized: boolean) => void;
  dismiss: () => void;
}

export const TalkCallsContext = createContext<TalkCallHost | null>(null);

// ---- Calls in their own window ----

const OWN_WINDOW = "trix.callOwnWindow";
export const callsInOwnWindow = () => { try { return localStorage.getItem(OWN_WINDOW) === "1"; } catch { return false; } };
export const setCallsInOwnWindow = (on: boolean) => { try { localStorage.setItem(OWN_WINDOW, on ? "1" : "0"); } catch { /* not kept */ } };

/** What a call's webview gets to start with. */
export interface CallWindowParams {
  conversation: string;
  account: string;
  name: string;
  avatar?: string;
  video: boolean;
  /** Starts in the app, rather than in a window of its own. */
  docked: boolean;
}

/** What the rest of the app sees of a Talk call: the call itself runs in a webview of its own. */
export interface TalkCallHost {
  call: { conversation: string; phase: TalkCallState["phase"] } | null;
  start: (conversation: string, video: boolean) => void;
  /** Brings the call to the front (restored, when minimised). */
  show: () => void;
}

/**
 * Starts Talk calls in their own webview (OwnCallWindow): docked in the app, or in a window of
 * their own if that's where you last had one. Moving between the two keeps the call connected.
 */
export function useTalkCallHost(describe: (conversation: string) => { account: string; name: string; avatar?: string }, onError: (message: string) => void): TalkCallHost {
  const [inCall, setInCall] = useState<string | null>(null);
  useEffect(() => {
    if (!isLive) return;
    const off = listen<string | null>("trix://call-window", (e) => setInCall(e.payload));
    return () => void off.then((f) => f());
  }, []);
  return {
    call: inCall ? { conversation: inCall, phase: "connected" } : null,
    start: (conversation, video) => {
      if (inCall) return void backend.focusCallWindow();
      setInCall(conversation);
      const params: CallWindowParams = { conversation, ...describe(conversation), video, docked: !callsInOwnWindow() };
      void backend.openCallWindow(JSON.stringify(params), params.name, params.docked).catch((e) => { setInCall(null); onError(String(e)); });
    },
    show: () => void backend.focusCallWindow(),
  };
}

export const useTalkCalls = () => useContext(TalkCallsContext);

export function useTalkCallEngine(onError: (message: string) => void): TalkCalls {
  const [call, setCall] = useState<TalkCallState | null>(null);
  const current = useRef<TalkCall | null>(null);
  useEffect(() => () => void current.current?.leave(), []);
  useEffect(() => {
    if (call?.error) onError(call.error);
  }, [call?.error]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    call,
    start: (conversation, video) => {
      if (current.current && current.current.state.phase !== "ended") return;
      const c = new TalkCall(conversation, (s) => setCall({ ...s }));
      current.current = c;
      setCall(c.state);
      void c.prepare(video);
    },
    join: () => void current.current?.start(),
    cancel: () => current.current?.cancel(),
    reprepare: (video, micId, cameraId) => void current.current?.prepare(video, micId, cameraId),
    leave: () => void current.current?.leave(),
    setMuted: (m) => current.current?.setMuted(m),
    setCamera: (on) => current.current?.setCamera(on),
    setSharing: (on) => void current.current?.setSharing(on).catch((e) => onError(String(e))),
    setBackground: (effect) => void current.current?.setBackground(effect).catch((e) => onError(String(e))),
    setHand: (raised) => current.current?.setHand(raised),
    react: (emoji) => current.current?.react(emoji),
    setMinimized: (m) => current.current?.setMinimized(m),
    dismiss: () => { current.current = null; setCall(null); },
  };
}
