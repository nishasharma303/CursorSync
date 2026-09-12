import { useEffect, useMemo, useRef, useState } from "react";
import "../styles/App.css";
import { BroadcastChannelTransport } from "../transport/BroadcastChannelTransport";
import { WebSocketTransport } from "../transport/WebSocketTransport";
import type { Transport } from "../transport/Transport";
import { RoomStore } from "../store/RoomStore";
import CursorLayer from "./CursorLayer";
import SharedCards from "./SharedCards";
import SharedCounter from "./SharedCounter";
import ThemeToggle from "./ThemeToggle";
import PresenceList from "./PresenceList";
import ReactionPicker from "./ReactionPicker";
import ReactionLayer from "./ReactionLayer";
import type { ReactionBurst } from "./ReactionLayer";
import { getInitialTheme, persistTheme, randomColor, randomId } from "../utils";
import type { ConnectionState, CursorPoint, PresenceEntry, ReactionEmoji, Theme, TransportKind } from "../types";

const SEND_INTERVAL_MS = 33; // ~30 messages/sec — see README "Cursor throttling"

// Vite exposes any VITE_-prefixed env var at build time via import.meta.env.
// Falls back to localhost so `npm run dev` + `npm start` (in server/) just works.
const WS_URL = (import.meta.env.VITE_WS_URL as string | undefined) ?? "ws://localhost:8080";

interface Toast {
  id: string;
  text: string;
}

const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting…",
  open: "Connected",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
};

const CONNECTION_COLOR: Record<ConnectionState, string> = {
  connecting: "#D4A017",
  open: "#2F8C82",
  reconnecting: "#D4A017",
  closed: "#C2467D",
};

export default function App() {
  const [joined, setJoined] = useState(false);
  const [name, setName] = useState("");
  const [room, setRoom] = useState("design-room");
  // WebSocket talks to the real server (server/index.js). BroadcastChannel
  // stays in the codebase as the transport-agnostic architecture's proof —
  // same RoomStore, same protocol, zero server, same-browser only.
  const [transportKind, setTransportKind] = useState<TransportKind>("websocket");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [peerCount, setPeerCount] = useState(0);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const [counterValue, setCounterValue] = useState(0);
  const [mySelection, setMySelectionState] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<ConnectionState>("connecting");
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [showPresenceList, setShowPresenceList] = useState(false);
  const [reactions, setReactions] = useState<ReactionBurst[]>([]);

  const selfId = useMemo(randomId, []);
  const selfColor = useMemo(randomColor, []);
  const containerRef = useRef<HTMLDivElement>(null);
  const selfPosRef = useRef<CursorPoint>({ x: -100, y: -100 });
  const lastSentRef = useRef(0);
  const storeRef = useRef<RoomStore | null>(null); // read inside handlers, avoids stale closures
  const [store, setStore] = useState<RoomStore | null>(null); // drives render, so CursorLayer mounts even solo

  // ---- theme: applied to <html data-theme> so every CSS var updates in one place ----
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    persistTheme(theme);
  }, [theme]);

  function handleThemeToggle() {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }

  // ---- store lifecycle: created on join, torn down on leave/unmount -----
  useEffect(() => {
    if (!joined) return;

    // This is the entire migration surface between the local demo and the
    // real backend: which concrete Transport gets constructed. RoomStore,
    // protocol.ts, CursorLayer, and every UI component below are identical
    // either way.
    const transport: Transport =
      transportKind === "websocket" ? new WebSocketTransport(WS_URL, room) : new BroadcastChannelTransport(room);

    const newStore = new RoomStore(transport, room, selfId, { name, color: selfColor });
    storeRef.current = newStore;
    setStore(newStore);
    setMySelectionState(null);

    const unsubToast = newStore.onToast((text) => {
      const id = randomId();
      setToasts((t) => [...t, { id, text }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 2600);
    });
    const unsubPresence = newStore.subscribePresence(() => {
      const snapshot = newStore.getPresenceSnapshot();
      setPeerCount(snapshot.length);
      setPresence(snapshot);
    });
    const unsubCounter = newStore.subscribeCounter(() => {
      setCounterValue(newStore.getCounterSnapshot());
    });
    const unsubConnection = newStore.onConnectionState(setConnectionState);
    const unsubReaction = newStore.onReaction((id, emoji) => {
      const burstId = randomId();
      const senderName = id === selfId ? name : newStore.getPresenceSnapshot().find((p) => p.id === id)?.name ?? "Someone";
      setReactions((r) => [...r, { id: burstId, emoji, name: senderName, left: 15 + Math.random() * 70 }]);
      setTimeout(() => setReactions((r) => r.filter((x) => x.id !== burstId)), 1600);
    });

    return () => {
      unsubToast();
      unsubPresence();
      unsubCounter();
      unsubConnection();
      unsubReaction();
      newStore.destroy(); // sends "leave", clears timers, closes transport, drops listeners
      storeRef.current = null;
      setStore(null);
    };
  }, [joined, room, selfId, selfColor, name, transportKind]);

  // ---- disconnect signals -------------------------------------------------
  // Explicit "leave" on unload is the primary signal for a clean exit; the
  // heartbeat + pruneStale loop in RoomStore (and ws ping/pong + close on
  // the server) is the fallback for crashes, killed tabs, or lost network
  // where beforeunload never fires.
  useEffect(() => {
    if (!joined) return;
    const handleUnload = () => storeRef.current?.destroy();
    window.addEventListener("beforeunload", handleUnload);
    window.addEventListener("pagehide", handleUnload); // fires reliably on mobile Safari, unlike beforeunload
    return () => {
      window.removeEventListener("beforeunload", handleUnload);
      window.removeEventListener("pagehide", handleUnload);
    };
  }, [joined]);

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pos = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // Update the ref immediately (every frame gets the true local position —
    // no throttling for the local render path).
    selfPosRef.current = pos;

    // Throttle only the network send — see README "Cursor throttling".
    const now = Date.now();
    if (now - lastSentRef.current < SEND_INTERVAL_MS) return;
    lastSentRef.current = now;
    storeRef.current?.sendMove(pos);
  }

  function handleSelect(cardId: string | null) {
    setMySelectionState(cardId);
    storeRef.current?.sendSelect(cardId);
  }

  function handleCounterDelta(delta: 1 | -1) {
    storeRef.current?.sendCounterDelta(delta);
  }

  function handleReaction(emoji: ReactionEmoji) {
    storeRef.current?.sendReaction(emoji);
  }

  function handleLeave() {
    setJoined(false);
    setShowPresenceList(false);
    setReactions([]);
  }

  if (!joined) {
    return (
      <div className="app-landing">
        <div className="landing-noise" aria-hidden="true" />
        <div className="landing-grid" aria-hidden="true" />
        <div className="landing-orb landing-orb-a" aria-hidden="true" />
        <div className="landing-orb landing-orb-b" aria-hidden="true" />
        <div className="landing-orb landing-orb-c" aria-hidden="true" />

        <div className="landing-shell">
          <div className="landing-hero">
            <div className="landing-badge">
              <span className="landing-badge-dot" />
              Live multiplayer &middot; zero lock-in transport
            </div>

            <h1 className="landing-heading">
              Watch every <span className="landing-heading-accent">cursor</span>
              <br />
              move, live, together.
            </h1>

            <p className="landing-sub">
              Cursor Sync mirrors pointers, selections, reactions, and a shared
              counter across every tab in the room &mdash; instantly, with no
              refresh.
            </p>

            <div className="landing-features">
              <div className="landing-feature">
                <span className="landing-feature-icon">◎</span>
                Live cursor tracking
              </div>
              <div className="landing-feature">
                <span className="landing-feature-icon">⬡</span>
                Presence &amp; selection
              </div>
              <div className="landing-feature">
                <span className="landing-feature-icon">✦</span>
                Real-time reactions
              </div>
            </div>

            <div className="landing-cursor-demo" aria-hidden="true">
              <div className="demo-surface">
                <span className="demo-cursor demo-cursor-1">
                  <svg viewBox="0 0 20 20" className="demo-cursor-glyph">
                    <path d="M2 1L18 8.5L10.5 10.5L8.5 18L2 1Z" />
                  </svg>
                  <em>Nisha</em>
                </span>
                <span className="demo-cursor demo-cursor-2">
                  <svg viewBox="0 0 20 20" className="demo-cursor-glyph">
                    <path d="M2 1L18 8.5L10.5 10.5L8.5 18L2 1Z" />
                  </svg>
                  <em>Arjun</em>
                </span>
                <span className="demo-cursor demo-cursor-3">
                  <svg viewBox="0 0 20 20" className="demo-cursor-glyph">
                    <path d="M2 1L18 8.5L10.5 10.5L8.5 18L2 1Z" />
                  </svg>
                  <em>Zoe</em>
                </span>
              </div>
            </div>
          </div>

          <div className="landing-panel">
            <div className="landing-panel-glow" aria-hidden="true" />
            <div className="app-landing-card-top">
              <div>
                <div className="landing-panel-kicker">Join a room</div>
                <div className="app-landing-title">Cursor&nbsp;Sync</div>
              </div>
              <ThemeToggle theme={theme} onToggle={handleThemeToggle} />
            </div>
            <div className="app-landing-subtitle">
              See everyone's cursor, selection, and counter in real time.
            </div>

            <label className="app-label">Your name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Nisha"
              className="app-input"
            />

            <label className="app-label">Room</label>
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="room name"
              className="app-input"
            />

            <label className="app-label">Transport</label>
            <select
              value={transportKind}
              onChange={(e) => setTransportKind(e.target.value as TransportKind)}
              className="app-select"
            >
              <option value="websocket">WebSocket server ({WS_URL})</option>
              <option value="broadcastchannel">BroadcastChannel demo (no server, same browser only)</option>
            </select>

            <button
              onClick={() => name.trim() && setJoined(true)}
              className={`app-join-btn${name.trim() ? " is-ready" : ""}`}
            >
              <span>Join room</span>
              <span className="app-join-btn-arrow">→</span>
            </button>
            <div className="app-landing-hint">
              {transportKind === "websocket"
                ? "Run `npm start` in /server first, then open this in two browsers or two tabs."
                : "Open this same page in another tab (same browser) to test sync."}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} onMouseMove={handleMouseMove} className="app-workspace">
      <div className="app-room-panel">
        <div className="app-room-header">
          <div className="app-room-name">#{room}</div>
          <div className="app-status" style={{ color: CONNECTION_COLOR[connectionState] }}>
            <span className="app-status-dot" style={{ background: CONNECTION_COLOR[connectionState] }} />
            {CONNECTION_LABEL[connectionState]}
          </div>
          <ThemeToggle theme={theme} onToggle={handleThemeToggle} />
        </div>
        <button
          className="app-presence-line app-presence-toggle"
          onClick={() => setShowPresenceList((v) => !v)}
          aria-expanded={showPresenceList}
        >
          <span className="app-self-dot" style={{ background: selfColor }} />
          {name} (you) &middot; {peerCount} other{peerCount === 1 ? "" : "s"} online
        </button>
        {showPresenceList && <PresenceList presence={presence} selfName={name} selfColor={selfColor} />}
        <button onClick={handleLeave} className="app-leave-btn">
          Leave room
        </button>
      </div>

      <div className="app-toasts">
        {toasts.map((t) => (
          <div key={t.id} className="app-toast">
            {t.text}
          </div>
        ))}
      </div>

      {store && <CursorLayer store={store} selfName={name} selfColor={selfColor} selfPosRef={selfPosRef} />}

      <SharedCards presence={presence} mySelection={mySelection} selfColor={selfColor} onSelect={handleSelect} />
      <SharedCounter value={counterValue} onDelta={handleCounterDelta} />
      <ReactionPicker onReact={handleReaction} />
      <ReactionLayer reactions={reactions} />

      {peerCount === 0 && (
        <div className="app-waiting">Waiting for others to join room "{room}"...</div>
      )}
    </div>
  );
}

