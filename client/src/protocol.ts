import type { WireMessage } from "./types";
import { REACTION_EMOJIS } from "./types";

/**
 * Nothing coming off a Transport is trusted, even BroadcastChannel from our
 * own tabs. Two concrete reasons this matters, not just defensive habit:
 *
 * 1. A future WebSocket server fans messages out to potentially many rooms
 *    over shared infrastructure — a bug there (or a malicious client) could
 *    deliver a message tagged for the wrong room.
 * 2. Any other script on the same origin can open a BroadcastChannel with
 *    the same name and post arbitrary data into it.
 *
 * So every message is structurally validated AND room-checked before it
 * touches state, regardless of transport.
 */
export function isValidMessage(raw: unknown, expectedRoom: string): raw is WireMessage {
  if (typeof raw !== "object" || raw === null) return false;
  const m = raw as Record<string, unknown>;

  if (m.v !== 1) return false;
  if (typeof m.id !== "string" || m.id.length === 0 || m.id.length > 64) return false;
  if (m.room !== expectedRoom) return false;
  if (typeof m.seq !== "number" || !Number.isFinite(m.seq)) return false;
  if (typeof m.ts !== "number" || !Number.isFinite(m.ts)) return false;

  switch (m.type) {
    case "join":
      return isValidUser(m.user);
    case "hello":
      return (
        isValidUser(m.user) &&
        isValidPoint(m.pos) &&
        (m.selection === null || typeof m.selection === "string") &&
        typeof m.counterValue === "number" &&
        Number.isFinite(m.counterValue)
      );
    case "move":
      return isValidPoint(m.pos);
    case "select":
      return m.cardId === null || (typeof m.cardId === "string" && m.cardId.length <= 40);
    case "counter":
      return typeof m.delta === "number" && Number.isFinite(m.delta) && Math.abs(m.delta) <= 1;
    case "reaction":
      return typeof m.emoji === "string" && (REACTION_EMOJIS as readonly string[]).includes(m.emoji);
    case "heartbeat":
    case "leave":
      return true;
    default:
      return false;
  }
}

function isValidUser(u: unknown): u is { name: string; color: string } {
  if (typeof u !== "object" || u === null) return false;
  const x = u as Record<string, unknown>;
  return (
    typeof x.name === "string" &&
    x.name.length > 0 &&
    x.name.length <= 40 &&
    typeof x.color === "string" &&
    /^#[0-9a-fA-F]{6}$/.test(x.color)
  );
}

function isValidPoint(p: unknown): p is { x: number; y: number } {
  if (typeof p !== "object" || p === null) return false;
  const x = p as Record<string, unknown>;
  return (
    typeof x.x === "number" &&
    typeof x.y === "number" &&
    Number.isFinite(x.x) &&
    Number.isFinite(x.y)
  );
}
