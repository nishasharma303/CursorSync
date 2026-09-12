import "../styles/Reaction.css";

export interface ReactionBurst {
  id: string;
  emoji: string;
  name: string;
  /** Horizontal position as a percentage of the workspace width, so bursts don't all stack in one spot. */
  left: number;
}

interface ReactionLayerProps {
  reactions: ReactionBurst[];
}

/** Purely decorative float-up-and-fade layer. App owns the array and prunes entries after the animation ends. */
export default function ReactionLayer({ reactions }: ReactionLayerProps) {
  return (
    <div className="reaction-layer">
      {reactions.map((r) => (
        <div key={r.id} className="reaction-burst" style={{ left: `${r.left}%` }}>
          <span className="reaction-burst-emoji">{r.emoji}</span>
          <span className="reaction-burst-name">{r.name}</span>
        </div>
      ))}
    </div>
  );
}
