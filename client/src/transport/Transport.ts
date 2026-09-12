import type { WireMessage, ConnectionState } from "../types";

export type TransportListener = (msg: unknown) => void;
export type StateListener = (state: ConnectionState) => void;

/**
 * Anything that can move WireMessages between peers implements this.
 * The room store only ever talks to this interface — it has no idea
 * whether messages are travelling over BroadcastChannel, a WebSocket,
 * or (in tests) an in-memory fake. That's the whole point: swapping
 * transports later is a one-line change at the call site, not a rewrite.
 */
export interface Transport {
  send(msg: WireMessage): void;
  onMessage(listener: TransportListener): () => void;
  onStateChange(listener: StateListener): () => void;
  getState(): ConnectionState;
  close(): void;
}
