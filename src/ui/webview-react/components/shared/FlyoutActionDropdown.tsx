import { useState, useRef, useCallback } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { DropdownPortal } from "./DropdownPortal";
import type { ActionDropdownItem } from "./ActionDropdown";

// ============================================================================
// Public types
// ============================================================================

export interface FlyoutGroup {
  id: string;
  label: string;
  items: ActionDropdownItem[];
}

export interface FlyoutActionDropdownProps {
  label: string;
  groups: FlyoutGroup[];
  onSelect: (value: string) => void;
  className?: string;
}

// ============================================================================
// Component
// ============================================================================

const L2_MIN_WIDTH = 160;

/**
 * A two-level flyout dropdown.
 *
 * Level 1 shows group headers with a ▶ chevron. Clicking a header opens a
 * second portal to the right of Level 1 (flipping left when near the viewport
 * edge) containing that group's items. Click-outside closes both levels.
 */
export function FlyoutActionDropdown({
  label,
  groups,
  onSelect,
  className = "",
}: FlyoutActionDropdownProps) {
  const [l1Open, setL1Open] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [l2Top, setL2Top] = useState<number>(0);
  const [l2Left, setL2Left] = useState<number>(0);
  const [l2MaxHeight, setL2MaxHeight] = useState<number>(400);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const l1Ref = useRef<HTMLDivElement>(null);
  const l2Ref = useRef<HTMLDivElement>(null);

  const l1RawPos = useDropdownPortalPosition(buttonRef, l1Open);
  const l1Pos = l1RawPos
    ? { ...l1RawPos, minWidth: Math.max(l1RawPos.width ?? 0, L2_MIN_WIDTH) }
    : null;

  const closeAll = useCallback(() => {
    setL1Open(false);
    setActiveGroupId(null);
  }, []);

  useClickOutside([buttonRef, l1Ref, l2Ref], l1Open, closeAll);

  const handleTrigger = () => {
    setL1Open((prev) => {
      if (prev) setActiveGroupId(null);
      return !prev;
    });
  };

  const handleGroupClick = useCallback(
    (groupId: string, e: React.MouseEvent<HTMLButtonElement>) => {
      if (activeGroupId === groupId) {
        setActiveGroupId(null);
        return;
      }
      setActiveGroupId(groupId);

      const rowRect = e.currentTarget.getBoundingClientRect();
      const l1El = l1Ref.current;
      if (l1El) {
        const l1Rect = l1El.getBoundingClientRect();
        const leftCandidate = l1Rect.right + 4;
        const left =
          leftCandidate + L2_MIN_WIDTH > window.innerWidth
            ? l1Rect.left - L2_MIN_WIDTH - 4
            : leftCandidate;
        setL2Top(rowRect.top);
        setL2Left(left);
        setL2MaxHeight(window.innerHeight - rowRect.top - 8);
      }
    },
    [activeGroupId]
  );

  const handleSelect = useCallback(
    (value: string) => {
      closeAll();
      onSelect(value);
    },
    [closeAll, onSelect]
  );

  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleTrigger}
        className="flex items-center gap-1 px-2 py-0.5 text-xs rounded bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border hover:bg-btn-secondary-hover"
      >
        {label}
        <i className={`codicon codicon-chevron-${l1Open ? "up" : "down"} text-[10px]`} />
      </button>

      {/* Level 1 — group headers */}
      <DropdownPortal isOpen={l1Open} popupPos={l1Pos} ref={l1Ref}>
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            onClick={(e) => handleGroupClick(group.id, e)}
            className={`flex items-center justify-between w-full px-3 py-1.5 text-xs transition-colors cursor-pointer
              ${
                activeGroupId === group.id
                  ? "bg-list-active-bg text-list-active-fg"
                  : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg"
              }`}
          >
            <span>{group.label}</span>
            <i className="codicon codicon-chevron-right text-[10px] opacity-60 ml-3" />
          </button>
        ))}
      </DropdownPortal>

      {/* Level 2 — items for the active group */}
      <DropdownPortal
        isOpen={activeGroupId !== null}
        popupPos={
          activeGroupId !== null
            ? { top: l2Top, left: l2Left, minWidth: L2_MIN_WIDTH, maxHeight: l2MaxHeight }
            : null
        }
        ref={l2Ref}
      >
        {activeGroup?.items.map((item) => (
          <button
            key={item.value}
            type="button"
            disabled={item.disabled}
            title={item.title}
            onClick={() => handleSelect(item.value)}
            className={`block w-full text-left px-3 py-1.5 text-xs transition-colors
              ${
                item.disabled
                  ? "text-disabled-fg cursor-default"
                  : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg cursor-pointer"
              }`}
          >
            {item.label}
          </button>
        ))}
      </DropdownPortal>
    </div>
  );
}
