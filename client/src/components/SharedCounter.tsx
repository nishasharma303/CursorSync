import "../styles/SharedCounter.css";

interface SharedCounterProps {
  value: number;
  onDelta: (delta: 1 | -1) => void;
}

/**
 * The value shown here is the sum of every +1/-1 op this client has
 * observed (see RoomStore's counter CRDT doc) — not a single authoritative
 * number pushed from a server. Two people can click +1 at the same instant
 * from different peers and both increments land; nothing gets lost the way
 * it would with a naive "read-then-write the new total" approach.
 */
export default function SharedCounter({ value, onDelta }: SharedCounterProps) {
  return (
    <div className="shared-counter">
      <button onClick={() => onDelta(-1)} aria-label="decrement" className="shared-counter-btn">
        −
      </button>
      <div className="shared-counter-value">{value}</div>
      <button onClick={() => onDelta(1)} aria-label="increment" className="shared-counter-btn">
        +
      </button>
    </div>
  );
}
