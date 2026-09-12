export type UserId = string;

export interface UserInfo {
  name: string;
  color: string;
}

export interface CursorPoint {
  x: number;
  y: number;
}

export type Theme = "light" | "dark";

/** Small, fixed allowlist — kept tight so the wire payload and the validator agree exactly. */
export const REACTION_EMOJIS = ["👍", "🎉", "❤️", "😂", "👀", "🔥"] as const;
export type ReactionEmoji = (typeof REACTION_EMOJIS)[number];

export const PROTOCOL_VERSION = 1 as const;

/**
 * Every message carries room + seq + ts even though BroadcastChannel already
 * scopes delivery to one room. That redundancy is deliberate: a production
 * WebSocket server fans one socket connection across many rooms, so `room`
 * has to travel in the payload for the server (and for defense-in-depth on
 * the client) to know where a message belongs. `seq` is a per-sender
 * monotonic counter used to drop out-of-order delivery.
 */
export type WireMessage =
  | { v: 1; type: "join"; id: UserId; room: string; seq: number; ts: number; user: UserInfo }
  | {
      v: 1;
      type: "hello";
      id: UserId;
      room: string;
      seq: number;
      ts: number;
      user: UserInfo;
      pos: CursorPoint;
      /** Bootstraps a late joiner's view of shared state — see RoomStore "hello" handling. */
      selection: string | null;
      counterValue: number;
    }
  | { v: 1; type: "move"; id: UserId; room: string; seq: number; ts: number; pos: CursorPoint }
  | { v: 1; type: "heartbeat"; id: UserId; room: string; seq: number; ts: number }
  | { v: 1; type: "leave"; id: UserId; room: string; seq: number; ts: number }
  | { v: 1; type: "select"; id: UserId; room: string; seq: number; ts: number; cardId: string | null }
  | { v: 1; type: "counter"; id: UserId; room: string; seq: number; ts: number; delta: number }
  | { v: 1; type: "reaction"; id: UserId; room: string; seq: number; ts: number; emoji: ReactionEmoji };

export type MessageType = WireMessage["type"];

/** Low-frequency identity data. Changes only on join/leave/select -> safe to hold in React state. */
export interface PresenceEntry {
  id: UserId;
  name: string;
  color: string;
  selection: string | null;
}

/** High-frequency motion data. Mutated ~30x/sec -> deliberately kept OUT of React state. */
export interface PositionEntry {
  pos: CursorPoint;
  prevPos: CursorPoint;
  updatedAt: number;
  lastSeen: number;
  lastSeq: number;
}

export type ConnectionState = "connecting" | "open" | "reconnecting" | "closed";

export type TransportKind = "websocket" | "broadcastchannel";
