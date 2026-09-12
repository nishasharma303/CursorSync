import type { PresenceEntry } from "../types";
import "../styles/SharedCards.css";

export const CARD_IDS = ["Roadmap", "Design Review", "Sprint Planning", "Retro"] as const;

interface SharedCardsProps {
  presence: PresenceEntry[];
  mySelection: string | null;
  selfColor: string;
  onSelect: (cardId: string | null) => void;
}

/**
 * Deliberately the smallest possible "shared state" demo beyond cursors:
 * one field (selection) per user, last-write-wins, exactly the same merge
 * rule RoomStore already uses for position. Clicking a card the user has
 * already selected deselects it (cardId -> null) rather than toggling
 * between cards, so "nobody selected" is a representable, visible state.
 */
export default function SharedCards({ presence, mySelection, selfColor, onSelect }: SharedCardsProps) {
  return (
    <div className="shared-cards">
      {CARD_IDS.map((cardId) => {
        const selectedByMe = mySelection === cardId;
        const selectedByOthers = presence.filter((p) => p.selection === cardId);
        const isSelected = selectedByMe || selectedByOthers.length > 0;
        const badgeColor = selectedByMe ? selfColor : selectedByOthers[0]?.color;

        return (
          <button
            key={cardId}
            onClick={() => onSelect(selectedByMe ? null : cardId)}
            className="shared-cards-btn"
            style={{ border: isSelected ? `2px solid ${badgeColor}` : "1px solid #D8DAD3" }}
          >
            {cardId}
            {isSelected && (
              <span className="shared-cards-badge" style={{ color: badgeColor }}>
                {selectedByMe ? "you" : selectedByOthers[0]?.name}
                {selectedByOthers.length > 1 ? ` +${selectedByOthers.length - 1}` : ""}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
