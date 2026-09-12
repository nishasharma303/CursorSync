import { memo, useEffect, useRef, useSyncExternalStore } from "react";
import CursorArrow from "./CursorArrow";
import { interpolate } from "../interpolation";
import type { RoomStore } from "../store/RoomStore";
import type { CursorPoint } from "../types";

interface CursorLayerProps {
  store: RoomStore;
  selfName: string;
  selfColor: string;
  /** Ref to a mutable object the parent updates synchronously on mousemove — read every frame, never a React state value. */
  selfPosRef: React.MutableRefObject<CursorPoint>;
}

/**
 * This component re-renders ONLY when someone joins or leaves (presence
 * changes via useSyncExternalStore). Cursor motion — both remote peers and
 * the local user — is driven by a single requestAnimationFrame loop that
 * writes `transform` directly onto already-mounted DOM nodes via refs.
 * That keeps 30+ position updates/sec from ever touching React's
 * reconciler: no VDOM diff, no component re-render, just a style mutation
 * on the compositor-friendly `transform` property.
 */
function CursorLayer({ store, selfName, selfColor, selfPosRef }: CursorLayerProps) {
  const presence = useSyncExternalStore(store.subscribePresence, store.getPresenceSnapshot);
  const nodeRefs = useRef(new Map<string, HTMLDivElement | null>());
  const selfNodeRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | undefined>(undefined);

  // Drop DOM refs for peers who left, so we don't leak Map entries forever.
  useEffect(() => {
    const liveIds = new Set(presence.map((p) => p.id));
    for (const id of nodeRefs.current.keys()) {
      if (!liveIds.has(id)) nodeRefs.current.delete(id);
    }
  }, [presence]);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const positions = store.getPositions();

      for (const [id, node] of nodeRefs.current) {
        if (!node) continue;
        const entry = positions.get(id);
        if (!entry) continue;
        const { x, y } = interpolate(entry.prevPos, entry.pos, entry.updatedAt, now);
        node.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }

      if (selfNodeRef.current) {
        const { x, y } = selfPosRef.current;
        selfNodeRef.current.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      }

      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    };
    // store/selfPosRef are stable for the component's lifetime (owned by the parent).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  return (
    <>
      {presence.map((p) => (
        <CursorArrow
          key={p.id}
          ref={(el) => {
            nodeRefs.current.set(p.id, el);
          }}
          color={p.color}
          name={p.name}
        />
      ))}
      <CursorArrow ref={selfNodeRef} color={selfColor} name={`${selfName} (you)`} />
    </>
  );
}

export default memo(CursorLayer);
