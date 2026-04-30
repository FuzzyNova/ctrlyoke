import React, { useRef, useState } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { DropdownPortal } from "./DropdownPortal";

/**
 * SkillsSelect — Hybrid dropdown for the prompt-level skills property.
 *
 * The popup is rendered via a portal at document.body with position:fixed so
 * it escapes any overflow:hidden ancestors and is never clipped.
 *
 * Top section: "Default (X)" and "None" keywords where X is the resolved inherited value.
 * Below a divider: checkbox list of available skills.
 * Selecting a keyword clears the array selection; toggling checkboxes
 * switches to custom array mode (matching the PriorContextSelect pattern).
 */
export const SkillsSelect: React.FC<{
  value: string[] | null | undefined;
  onChange: (v: string[] | null | undefined) => void;
  availableSkills: Array<{ name: string; description?: string }>;
  defaultLabel?: string;
  dropdownMaxHeight?: string;
  /** When true, renders the list inline without a trigger button. Used in FooterQuickPicker. */
  inline?: boolean;
}> = ({
  value,
  onChange,
  availableSkills,
  defaultLabel,
  dropdownMaxHeight = "60vh",
  inline = false,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const popupPos = useDropdownPortalPosition(buttonRef, isOpen, dropdownMaxHeight);
  useClickOutside([buttonRef, popupRef], isOpen, () => setIsOpen(false), !inline);

  const selectedSkills = Array.isArray(value) ? value : [];

  let buttonLabel: string;
  if (value === undefined) {
    buttonLabel = defaultLabel ?? "Default";
  } else if (value === null) {
    buttonLabel = "None";
  } else if (selectedSkills.length === 0) {
    buttonLabel = "None selected";
  } else if (selectedSkills.length <= 2) {
    buttonLabel = selectedSkills.join(", ");
  } else {
    buttonLabel = `${selectedSkills.slice(0, 2).join(", ")} +${selectedSkills.length - 2}`;
  }

  const toggleSkill = (name: string) => {
    const current = Array.isArray(value) ? value : [];
    const updated = current.includes(name)
      ? current.filter((s) => s !== name)
      : [...current, name];
    onChange(updated);
  };

  // ── Shared list content ───────────────────────────────────────────────────
  const listContent = (
    <div className="overflow-y-auto min-h-0 flex-1">
      {/* Keyword options */}
      {(["default", "none"] as const).map((k) => {
        const isSelected =
          k === "default" ? value === undefined : value === null;
        const label = k === "default" ? (defaultLabel ?? "Default") : "None";
        return (
          <button
            key={k}
            type="button"
            onClick={() => {
              onChange(k === "default" ? undefined : null);
              setIsOpen(false);
            }}
            className={`w-full px-2 py-1.5 text-xs text-left flex items-center gap-2 focus:outline-none border-none ${
              isSelected
                ? "bg-dropdown-selected-bg text-list-active-fg"
                : "hover:bg-list-hover-bg cursor-pointer"
            }`}
          >
            <i
              className={`codicon codicon-check text-xxs flex-shrink-0 ${
                isSelected ? "visible" : "invisible"
              }`}
            />
            <span>{label}</span>
          </button>
        );
      })}

      {/* Skills checkbox section */}
      {availableSkills.length > 0 && (
        <>
          <div className="border-t border-dropdown-border" />
          <div className="px-2 py-1 text-xxs text-description-fg uppercase font-semibold tracking-wide">
            Select skills:
          </div>
          {availableSkills.map((skill) => {
            const isChecked = selectedSkills.includes(skill.name);
            return (
              <button
                key={skill.name}
                type="button"
                onClick={() => toggleSkill(skill.name)}
                className={`w-full px-2 py-1.5 text-xs text-left flex items-start gap-2 focus:outline-none border-none ${
                  isChecked
                    ? "bg-dropdown-selected-bg text-list-active-fg"
                    : "hover:bg-list-hover-bg cursor-pointer"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isChecked}
                  onChange={() => {}}
                  aria-hidden={true}
                  className="mt-0.5 w-3 h-3 flex-shrink-0 accent-focus-border cursor-pointer"
                  tabIndex={-1}
                />
                <span className="flex flex-col min-w-0">
                  <span className="font-medium truncate">{skill.name}</span>
                  {skill.description && (
                    <span className="text-xxs text-description-fg whitespace-normal break-words">
                      {skill.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </>
      )}
    </div>
  );

  // ── Inline mode (FooterQuickPicker) ───────────────────────────────────────
  if (inline) {
    return (
      <div className="flex flex-col flex-1 min-h-0 w-full">{listContent}</div>
    );
  }

  // ── Trigger + dropdown mode ───────────────────────────────────────────────
  return (
    <div className="relative inline-block w-full">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="w-full px-2 py-1 text-xs bg-dropdown-bg text-dropdown-fg border border-dropdown-border rounded focus:outline-none focus:border-focus-border text-left flex items-center justify-between h-7"
      >
        <span className="truncate">{buttonLabel}</span>
        <i
          className={`codicon codicon-chevron-${isOpen ? "up" : "down"} text-xxs flex-shrink-0 ml-1`}
        />
      </button>

      <DropdownPortal isOpen={isOpen} popupPos={popupPos} ref={popupRef}>
          {listContent}
        </DropdownPortal>
    </div>
  );
};
