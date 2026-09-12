import type { Transport, TransportListener, StateListener } from "./Transport";
import type { WireMessage, ConnectionState } from "../types";

/**
 * Local-only transport. BroadcastChannel only delivers messages between
 * browsing contexts (tabs/windows/workers) on the SAME origin and the SAME
 * physical browser — there is no network hop, no server, and no way for a
 * second device to ever see these messages. It is a development/demo
 * transport, not a substitute for a real backend.
 */
export class BroadcastChannelTransport implements Transport {
  private channel: BroadcastChannel;
  private listeners = new Set<TransportListener>();
  private stateListeners = new Set<StateListener>();
  // BroadcastChannel has no connection handshake — it's "open" the instant
  // it's constructed, and browsers don't emit a close/error event for it.
  private state: ConnectionState = "open";

  constructor(room: string) {
    this.channel = new BroadcastChannel(`cursor-room:${room}`);
    this.channel.onmessage = (e: MessageEvent) => {
      this.listeners.forEach((l) => l(e.data));
    };
  }

  send(msg: WireMessage): void {
    this.channel.postMessage(msg);
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

  close(): void {
    this.channel.close();
    this.listeners.clear();
    this.stateListeners.clear();
  }
}
