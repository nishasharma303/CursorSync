import type { PresenceEntry } from "../types";
import "../styles/PresenceList.css";

interface PresenceListProps {
  presence: PresenceEntry[];
  selfName: string;
  selfColor: string;
}

/** Expands the "N others online" line into an actual roster — reuses presence data App already holds. */
export default function PresenceList({ presence, selfName, selfColor }: PresenceListProps) {
  return (
    <div className="presence-list">
      <div className="presence-list-item">
        <span className="presence-list-dot" style={{ background: selfColor }} />
        {selfName} (you)
      </div>
      {presence.map((p) => (
        <div key={p.id} className="presence-list-item">
          <span className="presence-list-dot" style={{ background: p.color }} />
          {p.name}
          {p.selection && <span className="presence-list-selection"> · viewing {p.selection}</span>}
        </div>
      ))}
    </div>
  );
}
