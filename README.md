# Cursor Sync — Engineering Review

A real-time multiplayer workspace: synced cursors, a shared card selection,
and a shared counter. Ships with a real Node + `ws` relay server — this is
no longer a same-browser-only demo.

## Run it (two terminals)

**Terminal 1 — the server:**
```
cd server
npm install
npm start
```
You should see `cursor-sync WebSocket server listening on ws://localhost:8080`.

**Terminal 2 — the frontend:**
```
npm install
npm run dev
```
Open the printed localhost URL in two or more browser tabs (or two
different browsers, or two different machines on the same network with
`VITE_WS_URL` pointed at the server's real address). Join the same room
name in each with transport set to **WebSocket server**. Move your mouse,
click a card, click +1/−1 — everything syncs live across all of them.

```
npm run typecheck   # tsc --noEmit, strict mode
npm run build        # typecheck + production bundle
```

To verify the server in isolation (useful if something looks wrong and you
want to rule out the frontend):
```
cd server
npm test
```
This spins up real WebSocket connections and checks relay, room isolation,
shared-counter relay, and disconnect detection against your running
server — not mocks.

---

## The demo flow

```
Landing → enter name + room → Join → Workspace
   → WebSocket CONNECTED (badge, top-left)
   → see other users (presence + cursor arrows)
   → move cursors (synced ~30/sec, interpolated smooth)
   → select a card (bottom-left — "Nisha selected Roadmap")
   → change the shared counter (bottom-right — everyone sees the same value)
   → Leave room / close tab → others see you disappear
   → rejoin → you reappear, counter and selections are still correct
```

---

## Engineering Decisions

**Why BroadcastChannel was used for local development**
`BroadcastChannel` gives same-origin tabs a pub/sub channel with zero
infrastructure — no server, no signaling, no auth. That made it ideal for
building the *hard* part first (state sync, protocol, rendering) without
also standing up a backend. It's still in the codebase, selectable from the
join screen's transport dropdown, as living proof that `RoomStore` really
doesn't care what it's talking to. Its ceiling is also its tradeoff: it
never leaves the browser process, so it cannot sync across devices, users,
or even a different browser on the same machine.

**Why WebSockets are appropriate for production**
Real multiplayer requires a server in the loop: to relay messages between
different devices/networks, and to be a neutral third party neither client
has to trust the other to reach directly. WebSockets give a persistent,
low-latency, bidirectional channel suited to a stream of small frequent
updates — a much better fit than request/response HTTP for 30
messages/second of cursor traffic. `server/index.js` is a real, running,
tested Node + `ws` server — not a scaffold anymore.

**Why the server is a relay, not an authority, for cursors and selection**
`server/index.js` deliberately does not merge cursor position or presence
itself. It tracks which socket is in which room and relays valid messages
to the rest of that room — the exact same job `BroadcastChannelTransport`
does locally, just across a real network with real disconnect handling.
The frontend's `RoomStore` already knows how to merge join/hello/move into
correct state (seq-gated last-write-wins); duplicating that logic
server-side would just be two implementations of the same merge to keep in
sync. What the server adds that a browser tab structurally cannot: identity
across devices, and knowing for certain when a connection has died.

**Why the shared counter works differently (op-relay, not authority)**
The counter is **not** a value the server computes and hands back — it's a
sum of discrete +1/−1 operations, each uniquely identified by
`${senderId}:${seq}`, applied by every client independently. That's a
minimal grow/shrink-counter CRDT: commutative and idempotent, so it gives
the correct total regardless of delivery order or duplicate delivery,
without needing a central arbiter. Two people clicking +1 at the same
instant from different peers both land — nothing gets lost the way it
would with a naive "read the total, send total+1" approach. A late joiner
bootstraps their counter from the highest `counterValue` seen in any
`hello` reply, which is always ≤ the true total and only ever grows, so
taking the max across replies converges correctly.

**How shared selection works**
Selection is presence-like data (`PresenceEntry.selection`), synced with
the exact same seq-gated last-write-wins rule as cursor position — no new
mechanism needed. Selecting a card broadcasts `{type:"select", cardId}`;
everyone renders whoever has each card selected. Clicking your own
selected card sends `cardId: null`, an explicit "nobody has this selected"
state rather than an implicit one.

**Why cursor events are throttled**
Native `mousemove` fires far faster than needed for smooth-looking remote
motion, and every event has a real network cost. `App.tsx` updates the
*local* render path on every event (cheap — a ref write) but throttles the
*network send* to ~30/sec.

**How rooms are isolated**
Two layers. `BroadcastChannelTransport` scopes at the transport level
(each room = its own channel name). The real server scopes by socket
membership per room name AND validates `message.room === expectedRoom`
before relaying — so even a buggy or malicious client can't leak a message
tagged for the wrong room into one it's connected to.

**How stale users are detected**
Client-side: heartbeats every 2s, pruned after 6s silent (catches a hung
tab that never sends `leave`). Server-side, independently: `ws` ping/pong
every 15s — a socket that doesn't pong gets terminated, which fires a
synthetic `leave` broadcast to the rest of its room. Two independent
detection paths because a dead browser tab and a dead TCP connection are
different failure modes and neither implies the other.

**How reconnection works**
`WebSocketTransport` implements exponential backoff with jitter (500ms
base, 10s cap). On reconnect (`state -> "open"`), `RoomStore` re-runs
`announceJoin()` — a reconnect looks identical to a fresh join from the
rest of the system's point of view. A bounded outbox (20 messages) queues
sends made while disconnected.

**How unnecessary React renders are avoided**
State is split by update frequency. **Presence** (join/leave/select —
rare) flows through `useSyncExternalStore` and drives a real render.
**Position** (~30/sec/peer) is read imperatively: `CursorLayer` runs one
`requestAnimationFrame` loop that writes `style.transform` straight onto
already-mounted DOM nodes via refs, never touching React's render/diff
cycle. Positions are interpolated between the last two known points over a
fixed window so sparse network updates read as smooth motion.

**How the transport abstraction enabled the BroadcastChannel → WebSocket migration**
It already happened — that's the point. `RoomStore` depends only on the
`Transport` interface. The join screen's dropdown literally constructs a
different concrete class depending on selection:
```ts
const transport: Transport =
  transportKind === "websocket"
    ? new WebSocketTransport(WS_URL, room)
    : new BroadcastChannelTransport(room);
```
Nothing in `RoomStore`, `protocol.ts`, `CursorLayer`, `SharedCards`,
`SharedCounter`, or the rendering logic in `App` changed to support this.

---

## Architecture

**Local demo path (still available, BroadcastChannel):**
```
Tab A  ──┐
Tab B  ──┼── BroadcastChannel("cursor-room:<room>") ── same browser, same origin
Tab C  ──┘
```
No server, no network, no cross-device delivery. Kept as a zero-setup demo
mode and as proof of the transport abstraction.

**Production path (implemented, `server/index.js`):**
```
Browser
   ↓
WebSocket
   ↓
WebSocket Gateway     (accepts connections, reads ?room= from the URL)
   ↓
Room Manager          (rooms: Map<roomName, Map<clientId, socket>>)
   ↓
Room State            (membership only — see "why the server is a relay" above)
   ↓
Connected Clients     (every other socket currently in that room)
```

- **Browser** — runs the unchanged `RoomStore`/`CursorLayer`/UI code; only
  the `Transport` implementation differs from the local path.
- **WebSocket** — persistent connection carrying the same `WireMessage`
  JSON shapes defined in `types.ts`, now serialized over the network
  instead of passed in-process.
- **WebSocket Gateway** — `wss.on("connection", ...)` in `server/index.js`;
  parses `room` off the query string, rejects connections without one.
- **Room Manager** — the `rooms` Map plus `getRoom`/`dropRoomIfEmpty`
  helpers; tracks which client ids are in which room.
- **Room State** — deliberately thin: just `{ ws }` per client id. All
  cursor/selection/counter merge logic stays client-side, as covered above.
- **Connected Clients** — every other socket in that room's membership,
  reached via `broadcast()`.

The one thing not implemented on the server, on purpose: authentication,
and any validation of message *contents* beyond structure/room (a client
could still lie about its own cursor position — there's no reason to stop
it for a cursor demo, but a production system with real stakes would add
per-message authorization here, at the same envelope-check layer that
already exists).

---

## Design Notes by Review Area

| # | Area | Where | Approach |
|---|------|-------|----------|
| 1 | Transport abstraction | `transport/Transport.ts` | Single interface; `RoomStore` never imports a concrete transport |
| 2 | Message protocol | `types.ts` | Discriminated union (`WireMessage`), versioned (`v: 1`), per-sender `seq` + `ts`; extended with `select`/`counter` |
| 3 | Cursor throttling | `App.tsx` | Network send capped ~30/sec; local render path unthrottled |
| 4 | Cursor interpolation | `interpolation.ts` | Lerp between last two points over a fixed window, sampled per animation frame |
| 5 | React rendering perf | `CursorLayer.tsx` | Presence via `useSyncExternalStore` (rare renders); position via rAF + direct DOM writes (no renders) |
| 6 | State synchronization | `RoomStore.ts` | join→hello handshake bootstraps position + selection + counter for late joiners; seq-gated apply order |
| 7 | Room isolation | `BroadcastChannelTransport.ts`, `protocol.ts`, `server/index.js` | Channel-name / socket-membership scoping + payload-level room check on both client and server |
| 8 | Race conditions | `RoomStore.ts` | Monotonic seq per sender rejects out-of-order applies for last-write-wins fields; counter uses op-dedup instead since it's not last-write-wins |
| 9 | Duplicate join messages | `RoomStore.ts` | `seenIds` makes the join *toast* idempotent without discarding the message |
| 10 | Stale users | `RoomStore.ts`, `server/index.js` | Client: heartbeat/prune (6s). Server: `ws` ping/pong sweep (15s), independently |
| 11 | Disconnect handling | `App.tsx`, `server/index.js` | Client sends explicit `leave` on unload/pagehide; server's `close` handler synthesizes `leave` for ungraceful drops |
| 12 | Reconnection architecture | `WebSocketTransport.ts` | Exponential backoff + jitter, bounded outbox, auto re-join on reconnect |
| 13 | Message validation | `protocol.ts` (client), `server/index.js` (server) | Structural + room validation at both hops, independently |
| 14 | TypeScript type safety | whole frontend | `strict`, `noUncheckedIndexedAccess`, discriminated unions, verified with `tsc --noEmit` |
| 15 | Memory cleanup | `RoomStore.destroy()`, `server/index.js` room cleanup | Clears intervals/listeners/transport; server deletes empty rooms from its Map |
| 16 | Event listener cleanup | `App.tsx`, `CursorLayer.tsx` | Every `addEventListener`/subscribe has a matching cleanup; stale DOM refs pruned when peers leave |

## Verified, not just claimed

- `npm run typecheck` and `npm run build` in the frontend both pass clean.
- `cd server && npm test` runs real WebSocket clients against a real
  running server instance and checks: same-room relay, room isolation,
  shared-counter op relay, and disconnect → synthetic leave broadcast.
  All five checks pass.

## Known limitations (by design, not oversight)

- No authentication — anyone who knows a room name and the server URL can
  join it. A production gateway would authenticate before accepting the
  connection.
- No validation of message *content* correctness (e.g. a client claiming
  an implausible cursor position) — only structure and room are checked.
  Fine for a cursor demo; a system with real stakes would add this at the
  same layer.
- No persistence — all room state (client-side merge, server-side
  membership) lives in memory and disappears when the process restarts.
- Interpolation window (90ms) is a fixed constant, not adaptive to
  measured network jitter per peer.
