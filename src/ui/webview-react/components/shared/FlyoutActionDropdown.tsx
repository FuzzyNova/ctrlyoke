import { useState, useRef, useCallback, useEffect } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { constrainPopupToViewport } from "@utils/dropdownUtils";
import { DropdownPortal } from "./DropdownPortal";
import {
  ActionDropdownItemContent,
  type ActionDropdownItem,
} from "./ActionDropdown";

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

const LEVEL_ONE_MIN_WIDTH = 160;
const LEVEL_TWO_MIN_WIDTH = 240;

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
  const [isLevelOneOpen, setIsLevelOneOpen] = useState(false);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);
  const [levelTwoTop, setLevelTwoTop] = useState<number>(0);
  const [levelTwoLeft, setLevelTwoLeft] = useState<number>(0);
  const [levelTwoMaxHeight, setLevelTwoMaxHeight] = useState<number>(400);
  const [levelTwoMaxWidth, setLevelTwoMaxWidth] = useState<number>(LEVEL_TWO_MIN_WIDTH);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const levelOneDropdownRef = useRef<HTMLDivElement>(null);
  const levelTwoDropdownRef = useRef<HTMLDivElement>(null);
  const activeGroupButtonRef = useRef<HTMLButtonElement | null>(null);

  const levelOneRawPosition = useDropdownPortalPosition(buttonRef, isLevelOneOpen);
  const levelOnePopupPosition = levelOneRawPosition
    ? (() => {
        const constrained = constrainPopupToViewport({
          left: levelOneRawPosition.left,
          width: levelOneRawPosition.width,
          minWidth: Math.max(levelOneRawPosition.width ?? 0, LEVEL_ONE_MIN_WIDTH),
          preferredWidth: LEVEL_ONE_MIN_WIDTH,
        });
        return {
          ...levelOneRawPosition,
          left: constrained.left,
          width: constrained.width,
          minWidth: constrained.minWidth,
          maxWidth: constrained.maxWidth,
        };
      })()
    : null;

  const closeAll = useCallback(() => {
    setIsLevelOneOpen(false);
    setActiveGroupId(null);
    activeGroupButtonRef.current = null;
  }, []);

  useClickOutside(
    [buttonRef, levelOneDropdownRef, levelTwoDropdownRef],
    isLevelOneOpen,
    closeAll
  );

  const updateLevelTwoPosition = useCallback((groupButton: HTMLButtonElement) => {
    const rowRect = groupButton.getBoundingClientRect();
    const levelOneDropdownElement = levelOneDropdownRef.current;
    if (!levelOneDropdownElement) return;

    const levelOneRect = levelOneDropdownElement.getBoundingClientRect();
    const leftCandidate = levelOneRect.right + 4;
    const preferredLeft =
      leftCandidate + LEVEL_TWO_MIN_WIDTH > window.innerWidth
        ? levelOneRect.left - LEVEL_TWO_MIN_WIDTH - 4
        : leftCandidate;
    const constrained = constrainPopupToViewport({
      left: preferredLeft,
      minWidth: LEVEL_TWO_MIN_WIDTH,
      preferredWidth: LEVEL_TWO_MIN_WIDTH,
    });

    setLevelTwoTop(rowRect.top);
    setLevelTwoLeft(constrained.left);
    setLevelTwoMaxWidth(constrained.maxWidth);
    setLevelTwoMaxHeight(Math.max(0, window.innerHeight - rowRect.top - 8));
  }, []);

  const handleTrigger = () => {
    setIsLevelOneOpen((previousIsLevelOneOpen) => {
      if (previousIsLevelOneOpen) {
        setActiveGroupId(null);
        activeGroupButtonRef.current = null;
      }
      return !previousIsLevelOneOpen;
    });
  };

  const handleGroupClick = useCallback(
    (groupId: string, event: React.MouseEvent<HTMLButtonElement>) => {
      if (activeGroupId === groupId) {
        setActiveGroupId(null);
        activeGroupButtonRef.current = null;
        return;
      }
      setActiveGroupId(groupId);
      activeGroupButtonRef.current = event.currentTarget;
      updateLevelTwoPosition(event.currentTarget);
    },
    [activeGroupId, updateLevelTwoPosition]
  );

  const handleSelect = useCallback(
    (value: string) => {
      closeAll();
      onSelect(value);
    },
    [closeAll, onSelect]
  );

  const activeGroup = groups.find((g) => g.id === activeGroupId) ?? null;

  useEffect(() => {
    if (!isLevelOneOpen || activeGroupId === null || !activeGroupButtonRef.current) {
      return;
    }

    const refresh = () => {
      if (activeGroupButtonRef.current) {
        updateLevelTwoPosition(activeGroupButtonRef.current);
      }
    };

    refresh();
    window.addEventListener("resize", refresh);
    window.addEventListener("scroll", refresh, true);
    return () => {
      window.removeEventListener("resize", refresh);
      window.removeEventListener("scroll", refresh, true);
    };
  }, [activeGroupId, isLevelOneOpen, updateLevelTwoPosition]);

  return (
    <div className={`relative inline-block ${className}`}>
      <button
        ref={buttonRef}
        type="button"
        onClick={handleTrigger}
        className="flex w-full items-center justify-between gap-1 px-2 py-0.5 text-xs rounded bg-btn-secondary-bg text-btn-secondary-fg border border-btn-border hover:bg-btn-secondary-hover"
      >
        <span className="truncate">{label}</span>
        <i className={`codicon codicon-chevron-${isLevelOneOpen ? "up" : "down"} text-[10px]`} />
      </button>

      {/* Level 1 — group headers */}
      <DropdownPortal
        isOpen={isLevelOneOpen}
        popupPos={levelOnePopupPosition}
        ref={levelOneDropdownRef}
      >
        {groups.map((group) => (
          <button
            key={group.id}
            type="button"
            onClick={(event) => handleGroupClick(group.id, event)}
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
            ? {
                top: levelTwoTop,
                left: levelTwoLeft,
                minWidth: Math.min(LEVEL_TWO_MIN_WIDTH, levelTwoMaxWidth),
                maxWidth: levelTwoMaxWidth,
                maxHeight: levelTwoMaxHeight,
              }
            : null
        }
        ref={levelTwoDropdownRef}
      >
        {activeGroup?.items.map((item) => (
          <button
            key={item.value}
            type="button"
            disabled={item.disabled}
            title={
              [item.title, item.description].filter(Boolean).join("\n") ||
              undefined
            }
            onClick={() => handleSelect(item.value)}
            className={`block w-full text-left px-3 py-1.5 text-xs transition-colors
              ${
                item.disabled
                  ? "text-disabled-fg cursor-default"
                  : "text-dropdown-fg hover:bg-list-hover-bg hover:text-list-hover-fg cursor-pointer"
              }`}
          >
            <ActionDropdownItemContent item={item} />
          </button>
        ))}
      </DropdownPortal>
    </div>
  );
}
