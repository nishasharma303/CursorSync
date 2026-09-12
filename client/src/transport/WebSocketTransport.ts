import type { Transport, TransportListener, StateListener } from "./Transport";
import type { WireMessage, ConnectionState } from "../types";

const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 10_000;
const OUTBOX_LIMIT = 20;

/**
 * NOT WIRED UP BY DEFAULT. This is scaffolding for the production path —
 * it compiles and is structurally complete, but there is no WebSocket
 * server behind it in this project. Swapping it in is exactly one line
 * in App.tsx (see README "Engineering Decisions"); everything else
 * (RoomStore, protocol, components) is transport-agnostic and needs no
 * changes.
 *
 * Handles the two things BroadcastChannel gets for free but a real network
 * connection does not: reconnection with backoff, and re-announcing
 * presence after a reconnect so peers rebuild state instead of staying
 * stale.
 */
export class WebSocketTransport implements Transport {
  private socket: WebSocket | null = null;
  private listeners = new Set<TransportListener>();
  private stateListeners = new Set<StateListener>();
  private state: ConnectionState = "connecting";
  private retryCount = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private outbox: WireMessage[] = [];
  private closedByCaller = false;

  constructor(private url: string, private room: string) {
    this.connect();
  }

  private connect(): void {
    this.setState(this.retryCount === 0 ? "connecting" : "reconnecting");

    const socket = new WebSocket(`${this.url}?room=${encodeURIComponent(this.room)}`);
    this.socket = socket;

    socket.onopen = () => {
      this.retryCount = 0;
      this.setState("open");
      // Flush whatever queued up while we were disconnected/reconnecting.
      const queued = this.outbox;
      this.outbox = [];
      queued.forEach((m) => socket.send(JSON.stringify(m)));
    };

    socket.onmessage = (e: MessageEvent) => {
      try {
        const parsed: unknown = JSON.parse(e.data);
        this.listeners.forEach((l) => l(parsed));
      } catch {
        // Malformed frame — drop it. Structural validation happens one
        // layer up in protocol.ts regardless of transport.
      }
    };

    socket.onclose = () => {
      if (this.closedByCaller) return;
      this.setState("reconnecting");
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      socket.close();
    };
  }

  private scheduleReconnect(): void {
    // Exponential backoff with jitter, capped, so a server restart doesn't
    // get hammered by every client reconnecting on the same beat.
    const exp = BASE_BACKOFF_MS * 2 ** this.retryCount;
    const delay = Math.min(MAX_BACKOFF_MS, exp) * (0.75 + Math.random() * 0.5);
    this.retryCount++;
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  send(msg: WireMessage): void {
    if (this.socket && this.state === "open") {
      this.socket.send(JSON.stringify(msg));
      return;
    }
    // Queue important messages (join/hello/leave) across a reconnect window.
    // Move messages are cheap to lose — the next one is <100ms away — but we
    // don't special-case that here; the bounded outbox keeps memory flat
    // either way.
    this.outbox.push(msg);
    if (this.outbox.length > OUTBOX_LIMIT) this.outbox.shift();
  }

  onMessage(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStateChange(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    listener(this.state);
    return () => this.stateListeners.delete(listener);
  }

  getState(): ConnectionState {
    return this.state;
  }

  private setState(s: ConnectionState): void {
    this.state = s;
    this.stateListeners.forEach((l) => l(s));
  }

  close(): void {
    this.closedByCaller = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.socket?.close();
    this.listeners.clear();
    this.stateListeners.clear();
  }
}
