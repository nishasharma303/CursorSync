import type { CursorPoint } from "./types";

/**
 * Remote cursors only get a new position every ~33ms (throttled) or worse
 * under packet loss/jitter. Snapping the DOM node straight to each update
 * looks like teleporting. Instead we keep the previous point and the new
 * point plus a timestamp, and interpolate between them over a fixed window
 * on every animation frame — same idea as client-side interpolation in
 * multiplayer games.
 *
 * INTERP_WINDOW_MS is set close to the send interval: long enough to
 * smooth jitter, short enough that motion doesn't visibly lag the real
 * cursor.
 */
export const INTERP_WINDOW_MS = 90;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function interpolate(
  prev: CursorPoint,
  next: CursorPoint,
  updatedAt: number,
  now: number,
  windowMs: number = INTERP_WINDOW_MS
): CursorPoint {
  const t = Math.min(1, Math.max(0, (now - updatedAt) / windowMs));
  return { x: lerp(prev.x, next.x, t), y: lerp(prev.y, next.y, t) };
}
