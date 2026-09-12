import type { Transport } from "../transport/Transport";
import type {
  ConnectionState,
  CursorPoint,
  PositionEntry,
  PresenceEntry,
  ReactionEmoji,
  UserId,
  UserInfo,
  WireMessage,
} from "../types";
import { isValidMessage } from "../protocol";

const STALE_MS = 6000;
const HEARTBEAT_MS = 2000;

type Unsubscribe = () => void;

/**
 * All real-time state sync logic lives here, deliberately outside React.
 * Two reasons:
 *
 * 1. Testability — this class has zero dependency on React and can be unit
 *    tested with a fake Transport.
 * 2. Render control — presence (who's here) and position (where their
 *    cursor is) are split into two independently-subscribable slices on
 *    purpose. Presence changes rarely and is cheap to re-render on.
 *    Position changes ~30x/sec per peer and MUST NOT drive React re-renders
 *    or the app will jank under load. See CursorLayer.tsx for how position
 *    is consumed imperatively instead.
 */
export class RoomStore {
  private presence = new Map<UserId, PresenceEntry>();
  private positions = new Map<UserId, PositionEntry>();
  private seenIds = new Set<UserId>(); // dedupes "X joined" toasts across repeat join broadcasts
  private presenceListeners = new Set<() => void>();
  private toastListeners = new Set<(text: string) => void>();
  private connectionListeners = new Set<(s: ConnectionState) => void>();
  private counterListeners = new Set<() => void>();
  private reactionListeners = new Set<(id: UserId, emoji: ReactionEmoji) => void>();
  private cachedPresenceSnapshot: PresenceEntry[] = [];
  private seq = 0;
  private connectionState: ConnectionState;
  private heartbeatTimer: ReturnType<typeof setInterval>;
  private pruneTimer: ReturnType<typeof setInterval>;
  private lastKnownSelfPos: CursorPoint = { x: -100, y: -100 };
  private destroyed = false;

  // ---- shared counter: op-based (not value-based) sync -------------------
  // Each +1/-1 click is a discrete, uniquely-identified operation
  // (`${senderId}:${seq}`). The total is the sum of every distinct op this
  // client has ever seen, applied in ANY order. That commutativity is what
  // makes it safe over a dumb relay with no server-side arbiter: two
  // concurrent clicks from different peers can never overwrite one another
  // the way a naive "send the new total" approach would. It's a minimal
  // grow/shrink counter CRDT, not a generic value that gets last-write-wins.
  private counterValue = 0;
  private appliedCounterOps = new Set<string>();

  constructor(
    private transport: Transport,
    private room: string,
    private selfId: UserId,
    private self: UserInfo
  ) {
    this.connectionState = transport.getState();
    transport.onMessage(this.handleMessage);
    transport.onStateChange(this.handleStateChange);

    this.announceJoin();

    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), HEARTBEAT_MS);
    this.pruneTimer = setInterval(() => this.pruneStale(), HEARTBEAT_MS);
  }

  // ---- outbound ---------------------------------------------------------

  private nextSeq(): number {
    return ++this.seq;
  }

  private announceJoin(): void {
    this.send({
      v: 1,
      type: "join",
      id: this.selfId,
      room: this.room,
      seq: this.nextSeq(),
      ts: Date.now(),
      user: this.self,
    });
  }

  private sendHeartbeat(): void {
    this.send({
      v: 1,
      type: "heartbeat",
      id: this.selfId,
      room: this.room,
      seq: this.nextSeq(),
      ts: Date.now(),
    });
  }

  sendMove(pos: CursorPoint): void {
    this.lastKnownSelfPos = pos;
    this.send({
      v: 1,
      type: "move",
      id: this.selfId,
      room: this.room,
      seq: this.nextSeq(),
      ts: Date.now(),
      pos,
    });
  }

  /** cardId === null clears the selection. This is presence-like data — low frequency, fine to re-render on. */
  sendSelect(cardId: string | null): void {
    this.mySelection = cardId;
    this.send({
      v: 1,
      type: "select",
      id: this.selfId,
      room: this.room,
      seq: this.nextSeq(),
      ts: Date.now(),
      cardId,
    });
  }

  /** Applies optimistically to our own local total, then broadcasts the op so peers apply the same op. */
  sendCounterDelta(delta: 1 | -1): void {
    const seq = this.nextSeq();
    this.counterValue += delta;
    this.appliedCounterOps.add(`${this.selfId}:${seq}`);
    this.emitCounter();
    this.send({
      v: 1,
      type: "counter",
      id: this.selfId,
      room: this.room,
      seq,
      ts: Date.now(),
      delta,
    });
  }

  /** Fire-and-forget: applies locally (so your own burst animates immediately) then broadcasts for peers. */
  sendReaction(emoji: ReactionEmoji): void {
    const seq = this.nextSeq();
    this.reactionListeners.forEach((l) => l(this.selfId, emoji));
    this.send({
      v: 1,
      type: "reaction",
      id: this.selfId,
      room: this.room,
      seq,
      ts: Date.now(),
      emoji,
    });
  }

  private send(msg: WireMessage): void {
    if (this.destroyed) return;
    this.transport.send(msg);
  }

  // ---- inbound ------------------------------------------------------------

  private handleStateChange = (s: ConnectionState): void => {
    this.connectionState = s;
    this.connectionListeners.forEach((l) => l(s));
    // A reconnecting transport lost the server's memory of us (and vice
    // versa). Re-announcing on "open" is the recovery step: it makes every
    // peer re-run the join->hello handshake and rebuild presence, instead
    // of everyone being permanently stale after one dropped connection.
    if (s === "open") this.announceJoin();
  };

  private handleMessage = (raw: unknown): void => {
    if (!isValidMessage(raw, this.room)) return; // malformed or wrong-room -> dropped silently
    if (raw.id === this.selfId) return; // ignore our own echoes (a fan-out server may reflect senders)

    const existingPos = this.positions.get(raw.id);

    // Out-of-order guard for LAST-WRITE-WINS fields (position, selection,
    // presence identity). Sequence numbers are per-sender and monotonic
    // across every message type that sender emits, so a stale "move" or
    // "select" arriving after a newer one is dropped rather than rewinding
    // state. "leave", "counter", and "reaction" are exempt: leave always
    // applies (an old in-flight message can't resurrect a peer that's
    // gone), counter is an op-log rather than last-write-wins, and a
    // reaction is a fire-and-forget visual burst with no state to rewind.
    const isOrderSensitive = raw.type !== "leave" && raw.type !== "counter" && raw.type !== "reaction";
    if (isOrderSensitive && existingPos && raw.seq <= existingPos.lastSeq) return;

    switch (raw.type) {
      case "join": {
        // Duplicate joins happen legitimately: React 18 StrictMode
        // double-invokes effects in dev, and a reconnecting transport
        // re-announces on purpose. `seenIds` makes the *toast* idempotent
        // without discarding the message itself.
        const isFirstSeen = !this.seenIds.has(raw.id);
        this.seenIds.add(raw.id);
        this.upsertPresence(raw.id, raw.user, this.presence.get(raw.id)?.selection ?? null);
        this.touchPosition(raw.id, existingPos?.pos, raw.seq);
        if (isFirstSeen) this.toast(`${raw.user.name} joined`);
        // Answer directly (not a broadcast re-join) so exactly one message
        // teaches the new peer our position AND bootstraps their view of
        // shared state (our selection, our best-known counter total) —
        // without it a late joiner would see selections/counter stuck at
        // their initial values until the next unrelated event nudges them.
        this.send({
          v: 1,
          type: "hello",
          id: this.selfId,
          room: this.room,
          seq: this.nextSeq(),
          ts: Date.now(),
          user: this.self,
          pos: this.lastKnownSelfPos,
          selection: this.mySelection,
          counterValue: this.counterValue,
        });
        break;
      }
      case "hello":
        this.seenIds.add(raw.id);
        this.upsertPresence(raw.id, raw.user, raw.selection);
        this.setPosition(raw.id, raw.pos, raw.seq);
        // CRDT bootstrap: any peer's counterValue is the sum of every op
        // THEY'VE observed, which is always <= the true global total and
        // monotonically non-decreasing. Taking the max across every hello
        // we receive converges on the right number without needing a
        // server to hand us one authoritative value.
        if (raw.counterValue > this.counterValue) {
          this.counterValue = raw.counterValue;
          this.emitCounter();
        }
        break;
      case "move":
        // A move for an id we've never seen presence for (e.g. hello lost
        // in transit) is still applied to positions so the cursor appears;
        // presence backfills once hello/join eventually lands.
        this.setPosition(raw.id, raw.pos, raw.seq);
        break;
      case "select": {
        const p = this.presence.get(raw.id);
        if (p) {
          this.presence.set(raw.id, { ...p, selection: raw.cardId });
          this.emitPresence();
        }
        this.touchPosition(raw.id, existingPos?.pos, raw.seq);
        break;
      }
      case "counter": {
        const opKey = `${raw.id}:${raw.seq}`;
        if (!this.appliedCounterOps.has(opKey)) {
          this.appliedCounterOps.add(opKey);
          this.counterValue += raw.delta;
          this.emitCounter();
        }
        this.touchPosition(raw.id, existingPos?.pos, raw.seq);
        break;
      }
      case "heartbeat":
        this.touchPosition(raw.id, existingPos?.pos, raw.seq);
        break;
      case "reaction":
        this.touchPosition(raw.id, existingPos?.pos, raw.seq);
        this.reactionListeners.forEach((l) => l(raw.id, raw.emoji));
        break;
      case "leave": {
        const p = this.presence.get(raw.id);
        if (p) this.toast(`${p.name} left`);
        this.removePeer(raw.id);
        break;
      }
    }
  };

  private mySelection: string | null = null;

  private upsertPresence(id: UserId, user: UserInfo, selection: string | null): void {
    const current = this.presence.get(id);
    if (current && current.name === user.name && current.color === user.color) return;
    this.presence.set(id, { id, name: user.name, color: user.color, selection: current?.selection ?? selection });
    this.emitPresence();
  }

  private setPosition(id: UserId, pos: CursorPoint, seq: number): void {
    const now = Date.now();
    const existing = this.positions.get(id);
    this.positions.set(id, {
      pos,
      prevPos: existing?.pos ?? pos,
      updatedAt: now,
      lastSeen: now,
      lastSeq: seq,
    });
    // Deliberately no emitPresence() here — position is read imperatively
    // by CursorLayer's animation loop via getPositions(), not through
    // React's subscription model.
  }

  private touchPosition(id: UserId, keepPos: CursorPoint | undefined, seq: number): void {
    const now = Date.now();
    const existing = this.positions.get(id);
    this.positions.set(id, {
      pos: keepPos ?? existing?.pos ?? { x: -100, y: -100 },
      prevPos: existing?.prevPos ?? keepPos ?? { x: -100, y: -100 },
      updatedAt: existing?.updatedAt ?? now,
      lastSeen: now,
      lastSeq: Math.max(seq, existing?.lastSeq ?? 0),
    });
  }

  private removePeer(id: UserId): void {
    this.presence.delete(id);
    this.positions.delete(id);
    this.seenIds.delete(id);
    this.emitPresence();
  }

  private pruneStale(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, pos] of this.positions) {
      if (now - pos.lastSeen > STALE_MS) {
        const p = this.presence.get(id);
        if (p) this.toast(`${p.name} disconnected`);
        this.presence.delete(id);
        this.positions.delete(id);
        this.seenIds.delete(id);
        changed = true;
      }
    }
    if (changed) this.emitPresence();
  }

  // ---- subscriptions ------------------------------------------------------

  subscribePresence = (listener: () => void): Unsubscribe => {
    this.presenceListeners.add(listener);
    return () => this.presenceListeners.delete(listener);
  };

  /** Stable reference between emits, new reference on each emit — required for useSyncExternalStore. */
  getPresenceSnapshot = (): PresenceEntry[] => this.cachedPresenceSnapshot;

  private emitPresence(): void {
    this.cachedPresenceSnapshot = Array.from(this.presence.values());
    this.presenceListeners.forEach((l) => l());
  }

  /** Read imperatively from a rAF loop — never wired into React state. */
  getPositions(): ReadonlyMap<UserId, PositionEntry> {
    return this.positions;
  }

  subscribeCounter = (listener: () => void): Unsubscribe => {
    this.counterListeners.add(listener);
    return () => this.counterListeners.delete(listener);
  };

  getCounterSnapshot = (): number => this.counterValue;

  private emitCounter(): void {
    this.counterListeners.forEach((l) => l());
  }

  onToast(listener: (text: string) => void): Unsubscribe {
    this.toastListeners.add(listener);
    return () => this.toastListeners.delete(listener);
  }

  private toast(text: string): void {
    this.toastListeners.forEach((l) => l(text));
  }

  onConnectionState(listener: (s: ConnectionState) => void): Unsubscribe {
    this.connectionListeners.add(listener);
    listener(this.connectionState);
    return () => this.connectionListeners.delete(listener);
  }

  onReaction(listener: (id: UserId, emoji: ReactionEmoji) => void): Unsubscribe {
    this.reactionListeners.add(listener);
    return () => this.reactionListeners.delete(listener);
  }

  // ---- lifecycle ----------------------------------------------------------

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.transport.send({
      v: 1,
      type: "leave",
      id: this.selfId,
      room: this.room,
      seq: this.nextSeq(),
      ts: Date.now(),
    });
    clearInterval(this.heartbeatTimer);
    clearInterval(this.pruneTimer);
    this.transport.close();
    this.presenceListeners.clear();
    this.toastListeners.clear();
    this.connectionListeners.clear();
    this.counterListeners.clear();
    this.reactionListeners.clear();
    this.presence.clear();
    this.positions.clear();
    this.seenIds.clear();
    this.appliedCounterOps.clear();
  }
}
