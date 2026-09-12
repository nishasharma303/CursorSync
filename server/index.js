import { WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";

const PORT = process.env.PORT ? Number(process.env.PORT) : 8080;
const HEARTBEAT_SWEEP_MS = 15000;



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
    broadcast(roomState, msg, clientId ?? connectionId);
  });

  ws.on("close", () => {
    if (!clientId) return; // never completed a join — nothing to announce
    const roomState = rooms.get(room);
    if (!roomState || !roomState.has(clientId)) return;

    roomState.delete(clientId);
    console.log(`[disconnect] room=${room} id=${clientId} users=${roomState.size}`);

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
  });
});


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

console.log(`cursor-sync WebSocket server listening on port ${PORT}`);