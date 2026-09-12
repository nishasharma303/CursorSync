import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const HEARTBEAT_SWEEP_MS = 15000;

/**
 * This server is deliberately "dumb": it does not merge cursor position or
 * presence itself — the frontend's RoomStore already knows how to do that
 * (join -> hello handshake, seq-gated last-write-wins, a CRDT counter for
 * the shared +1/-1 demo). The server's actual job is everything a browser
 * tab can't do for itself:
 *
 *   - accept WebSocket connections and know which room each one is in
 *   - keep rooms isolated (a message tagged for room A never reaches room B)
 *   - relay every valid message to the rest of that room
 *   - notice when a connection dies (even an ungraceful one) and turn that
 *     into a "leave" broadcast, so peers aren't stuck waiting forever
 *
 * That's genuinely what "Room Manager" means here: a registry of which
 * sockets belong to which room, not an owner of cursor/selection/counter
 * state. Swapping this dumb-relay model for a server-authoritative one
 * later (e.g. if you wanted to stop trusting clients entirely) would only
 * mean validating message *contents* here too, not restructuring anything.
 */

const wss = new WebSocketServer({ port: PORT });

/** roomName -> Map<clientId, { ws }> */
const rooms = new Map();

function getRoom(name) {
  let room = rooms.get(name);
  if (!room) {
    room = new Map();
    rooms.set(name, room);
  }
  return room;
}

function dropRoomIfEmpty(name, room) {
  if (room.size === 0) rooms.delete(name);
}

function broadcast(room, message, exceptId) {
  const payload = JSON.stringify(message);
  for (const [id, client] of room) {
    if (id === exceptId) continue;
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(payload);
  }
}

/**
 * Structural + room-scope validation. This mirrors protocol.ts on the
 * client deliberately — validation happens at every hop that touches a
 * message, not just once at the edge. A message that fails this never gets
 * relayed, so a malformed or wrong-room payload can't poison another
 * client's state.
 */
function isValidEnvelope(msg, expectedRoom) {
  return (
    msg !== null &&
    typeof msg === "object" &&
    msg.v === 1 &&
    typeof msg.id === "string" &&
    msg.id.length > 0 &&
    msg.id.length <= 64 &&
    msg.room === expectedRoom &&
    typeof msg.seq === "number" &&
    typeof msg.ts === "number" &&
    typeof msg.type === "string"
  );
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "", `http://${req.headers.host}`);
  const room = url.searchParams.get("room");

  if (!room) {
    ws.close(1008, "room query param required");
    return;
  }

  const connectionId = randomUUID(); // used only until the client's own "join" tells us its id
  let clientId = null;
  ws.isAlive = true;

  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return; // drop unparseable frames silently
    }

    if (!isValidEnvelope(msg, room)) return;

    const roomState = getRoom(room);

    if (msg.type === "join") {
      clientId = msg.id;
      roomState.set(clientId, { ws });
      console.log(`[join]     room=${room} id=${clientId} users=${roomState.size}`);
    } else if (msg.type === "leave" && clientId) {
      roomState.delete(clientId);
      console.log(`[leave]    room=${room} id=${clientId} users=${roomState.size}`);
      dropRoomIfEmpty(room, roomState);
    }

    // Relay to every other socket in the room — join/hello/move/heartbeat/
    // select/counter/leave all flow through this one path unmodified.
    broadcast(roomState, msg, clientId ?? connectionId);
  });

  ws.on("close", () => {
    if (!clientId) return; // never completed a join — nothing to announce
    const roomState = rooms.get(room);
    if (!roomState || !roomState.has(clientId)) return;

    roomState.delete(clientId);
    console.log(`[disconnect] room=${room} id=${clientId} users=${roomState.size}`);

    // Synthesize the "leave" the client didn't get a chance to send. seq is
    // set to Number.MAX_SAFE_INTEGER so it always clears the client-side
    // seq-gate (protocol.ts / RoomStore treat "leave" as always-applies
    // anyway, but this keeps the message internally consistent).
    broadcast(roomState, {
      v: 1,
      type: "leave",
      id: clientId,
      room,
      seq: Number.MAX_SAFE_INTEGER,
      ts: Date.now(),
    });
    dropRoomIfEmpty(room, roomState);
  });

  ws.on("error", () => {
    // A subsequent "close" event always follows an "error" on ws sockets,
    // so cleanup happens there — nothing additional needed here.
  });
});

// ws has no built-in "did the TCP connection actually die" signal — a
// half-open connection (cable pulled, laptop closed) looks identical to a
// healthy idle one until you probe it. Ping everyone on an interval; if a
// socket didn't pong since the last sweep, terminate it, which fires the
// "close" handler above and cleans up room state.
const sweep = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_SWEEP_MS);

wss.on("close", () => clearInterval(sweep));

console.log(`cursor-sync WebSocket server listening on ws://localhost:${PORT}`);
