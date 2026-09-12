// Smoke test for the relay server: run `node index.js` in one terminal,
// then `npm test` in another. Verifies the properties this server exists
// for — same-room relay, room isolation, shared-state op relay, and
// disconnect detection — against a real running instance, not a mock.
import WebSocket from "ws";

const URL = process.env.WS_URL ?? "ws://localhost:8080";

function connect(room) {
  return new WebSocket(`${URL}?room=${room}`);
}

function send(ws, msg) {
  ws.send(JSON.stringify(msg));
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const results = [];

  // --- same-room relay ---
  const a = connect("roomA");
  const b = connect("roomA");
  await Promise.all([new Promise((r) => a.once("open", r)), new Promise((r) => b.once("open", r))]);

  // Real clients always send "join" as their first message (RoomStore's
  // constructor calls announceJoin() immediately) — mirror that here.
  send(b, {
    v: 1,
    type: "join",
    id: "bob-early",
    room: "roomA",
    seq: 1,
    ts: Date.now(),
    user: { name: "Bob", color: "#7B5EA7" },
  });
  await wait(100);

  let bReceivedJoin = false;
  b.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "join" && msg.id === "alice") bReceivedJoin = true;
  });
  send(a, {
    v: 1,
    type: "join",
    id: "alice",
    room: "roomA",
    seq: 1,
    ts: Date.now(),
    user: { name: "Alice", color: "#E8604C" },
  });
  await wait(200);
  results.push(["same-room relay (join)", bReceivedJoin]);

  let bReceivedMove = false;
  b.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "move" && msg.id === "alice" && msg.pos.x === 42) bReceivedMove = true;
  });
  send(a, { v: 1, type: "move", id: "alice", room: "roomA", seq: 2, ts: Date.now(), pos: { x: 42, y: 7 } });
  await wait(200);
  results.push(["same-room relay (move)", bReceivedMove]);

  // --- room isolation ---
  const c = connect("roomB");
  await new Promise((r) => c.once("open", r));
  send(c, {
    v: 1,
    type: "join",
    id: "carol",
    room: "roomB",
    seq: 1,
    ts: Date.now(),
    user: { name: "Carol", color: "#3B6FA0" },
  });

  let bReceivedCarol = false;
  b.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id === "carol") bReceivedCarol = true;
  });
  await wait(300);
  results.push(["room isolation (roomA never sees roomB traffic)", !bReceivedCarol]);

  // --- shared counter op relay ---
  let bReceivedCounter = false;
  b.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "counter" && msg.delta === 1) bReceivedCounter = true;
  });
  send(a, { v: 1, type: "counter", id: "alice", room: "roomA", seq: 3, ts: Date.now(), delta: 1 });
  await wait(200);
  results.push(["shared counter op relay", bReceivedCounter]);

  // --- disconnect detection ---
  let aReceivedSyntheticLeave = false;
  a.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === "leave" && msg.id === "bob-early") aReceivedSyntheticLeave = true;
  });
  b.terminate(); // ungraceful close, no "leave" sent — server must notice via ping/pong + close
  await wait(300);
  results.push(["disconnect -> synthetic leave broadcast", aReceivedSyntheticLeave]);

  console.log("\n--- Server relay test results ---");
  let allPass = true;
  for (const [name, pass] of results) {
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
    if (!pass) allPass = false;
  }
  console.log(allPass ? "\nAll checks passed." : "\nSome checks FAILED.");

  a.close();
  c.close();
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("Test run errored — is the server running? (`npm start` in another terminal)");
  console.error(err.message);
  process.exit(1);
});
