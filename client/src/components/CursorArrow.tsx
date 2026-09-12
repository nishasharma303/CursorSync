import { forwardRef } from "react";
import "../styles/Cursor.css";

interface CursorArrowProps {
  color: string;
  name: string;
}

/**
 * Deliberately has no x/y props. Position is set imperatively via
 * ref.current.style.transform by CursorLayer's animation loop, so moving a
 * cursor never triggers React's render/diff cycle — only a style mutation
 * on an already-mounted DOM node. React.memo still matters here: it stops
 * this component from being re-rendered when a SIBLING's identity changes.
 */
const CursorArrow = forwardRef<HTMLDivElement, CursorArrowProps>(({ color, name }, ref) => {
  return (
    <div ref={ref} className="cursor-arrow">
      <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
        <path
          d="M4 2L22 12.5L13.2 14.3L9.5 22.5L4 2Z"
          fill={color}
          stroke="#ffffff"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
      <div className="cursor-arrow-label" style={{ background: color }}>
        {name}
      </div>
    </div>
  );
});

CursorArrow.displayName = "CursorArrow";

export default CursorArrow;
