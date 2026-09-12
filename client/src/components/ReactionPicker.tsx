import { REACTION_EMOJIS } from "../types";
import type { ReactionEmoji } from "../types";
import "../styles/ReactionPicker.css";

interface ReactionPickerProps {
  onReact: (emoji: ReactionEmoji) => void;
}

/** Bottom-center emoji bar. Sends a fire-and-forget reaction op — same pattern as SharedCounter's +1/-1. */
export default function ReactionPicker({ onReact }: ReactionPickerProps) {
  return (
    <div className="reaction-picker">
      {REACTION_EMOJIS.map((emoji) => (
        <button
          key={emoji}
          onClick={() => onReact(emoji)}
          className="reaction-picker-btn"
          aria-label={`React with ${emoji}`}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}
