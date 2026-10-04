import {
  INHERIT_DEFAULT_OPTION,
  NONE_OPTION,
} from "@root/types/DashboardConstants";
import React, { useId, useRef, useState } from "react";
import { useDropdownPortalPosition } from "@hooks/useDropdownPortalPosition";
import { useClickOutside } from "@hooks/useClickOutside";
import { useHideableOptions } from "@hooks/useHideableOptions";
import { DropdownPortal } from "./DropdownPortal";
import { DropdownHiddenToggle } from "./DropdownHiddenToggle";
import {
  dropdownBorderClass,
  dropdownWarningClass,
} from "@utils/dropdownValidation";
import type { HideableProps } from "./CustomSelect";
import { Icon } from "./Icon";
import { schemaAriaLabel, schemaTitle } from "@utils/schemaPropertyLabels";
import {
  SKILLS_SELECTION_OPTIONS_META,
  toSelectOptions,
} from "@root/types/SchemaUiMetadata";

interface SkillOption {
  name: string;
  description?: string;
}

interface SkillsSelectProps extends HideableProps {
  id?: string;
  value: string[] | null | undefined;
  onChange: (v: string[] | null | undefined) => void;
  availableSkills: SkillOption[];
  defaultLabel?: string;
  placeholder?: string;
  dropdownMaxHeight?: string;
  /** When true, renders the list inline without a trigger button. Used in FooterQuickPicker. */
  inline?: boolean;
  /** Soft validation message for values unavailable in the current workspace. */
  warning?: string;
  /** Accessible name for the field represented by the trigger. */
  triggerAriaLabel?: string;
  /** Schema property represented by this selector. */
  schemaPath?: string;
  disabled?: boolean;
  disabledReason?: string;
  mixed?: boolean;
  onSelectMixed?: () => void;
}

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
export const SkillsSelect: React.FC<SkillsSelectProps> = ({
  id,
  value,
  onChange,
  availableSkills,
  defaultLabel,
  placeholder,
  dropdownMaxHeight = "60vh",
  inline = false,
  disabled = false,
  disabledReason,
  mixed = false,
  onSelectMixed,
  namespace,
  hiddenValues = [],
  onHideOption,
  onUnhideOption,
  nonHideableValues = [],
  warning,
  triggerAriaLabel = "Skills",
  schemaPath = "skills",
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const reactId = useId();
  const listboxId = id
    ? `${id}-listbox`
    : `skills-listbox-${reactId.replace(/:/g, "")}`;
  const [showHidden, setShowHidden] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  const selectedSkills = Array.isArray(value) ? value : [];
  const {
    hideEnabled,
    visible: visibleSkills,
    hidden: hiddenSkills,
  } = useHideableOptions(
    availableSkills,
    (skill) => skill.name,
    hiddenValues,
    namespace
  );

  const popupPos = useDropdownPortalPosition(
    buttonRef,
    isOpen,
    dropdownMaxHeight
  );
  useClickOutside(
    [buttonRef, popupRef],
    isOpen,
    () => {
      setIsOpen(false);
      setShowHidden(false);
    },
    !inline
  );

  let buttonLabel: string;
  if (mixed) {
    buttonLabel = "(mixed)";
  } else if (value === undefined) {
    buttonLabel = defaultLabel ?? "Default";
  } else if (value === null) {
    buttonLabel = "None";
  } else if (selectedSkills.length === 0) {
    buttonLabel = placeholder ?? "None selected";
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
    onChange(updated.length === 0 ? undefined : updated);
  };

  const canHide = (skillName: string) =>
    hideEnabled &&
    !selectedSkills.includes(skillName) &&
    !nonHideableValues.includes(skillName);

  const handleKeywordSelect = (keyword: string) => {
    onChange(
      keyword === INHERIT_DEFAULT_OPTION
        ? undefined
        : keyword === NONE_OPTION
          ? null
          : value
    );
    setIsOpen(false);
    setShowHidden(false);
  };

  const handleHiddenSkillSelect = (skillName: string) => {
    onUnhideOption?.(skillName);
    if (!selectedSkills.includes(skillName)) {
      toggleSkill(skillName);
    }
  };

  const hiddenToggleBar = hideEnabled ? (
    <DropdownHiddenToggle
      hiddenCount={hiddenSkills.length}
      showHidden={showHidden}
      onToggle={() => setShowHidden((s) => !s)}
    />
  ) : null;

  const listContent = (
    <div className="overflow-y-auto min-h-0 flex-1">
      {mixed && (
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            onSelectMixed?.();
            setIsOpen(false);
          }}
          aria-label="(mixed), skills"
          className="w-full px-2 py-1.5 text-xs text-left"
        >
          (mixed)
        </button>
      )}
      {toSelectOptions(SKILLS_SELECTION_OPTIONS_META, schemaPath).map(
        (option) => {
          const keyword = option.value;
          const isSelected =
            keyword === INHERIT_DEFAULT_OPTION
              ? value === undefined
              : value === null;
          const label =
            keyword === INHERIT_DEFAULT_OPTION
              ? (defaultLabel ?? "Inherit")
              : option.label;
          const schemaValue = option.pseudo ?? keyword;
          return (
            <button
              key={keyword}
              type="button"
              disabled={disabled}
              onClick={() => handleKeywordSelect(keyword)}
              aria-label={schemaAriaLabel(label, schemaPath, schemaValue)}
              title={schemaTitle(schemaPath, schemaValue)}
              className={`w-full px-2 py-1.5 text-xs text-left flex items-center gap-2 focus:outline-none border-none ${
                isSelected
                  ? "bg-dropdown-selected-bg text-list-active-fg cy-dropdown-row-selected"
                  : "hover:bg-list-hover-bg cursor-pointer cy-dropdown-row"
              }`}
            >
              <Icon
                name="check"
                className={`text-xxs flex-shrink-0 ${
                  isSelected ? "visible" : "invisible"
                }`}
              />
              <span
                data-testid={
                  keyword === INHERIT_DEFAULT_OPTION
                    ? "inherited-skills-label"
                    : undefined
                }
              >
                {label}
              </span>
            </button>
          );
        }
      )}

      {availableSkills.length > 0 && (
        <>
          <div className="border-t border-dropdown-border" />
          <div className="px-2 py-1 text-xxs text-description-fg uppercase font-semibold tracking-wide">
            Select skills:
          </div>
          {visibleSkills.map((skill) => {
            const isChecked = selectedSkills.includes(skill.name);
            return (
              <div
                key={skill.name}
                title={skill.description}
                className={`group w-full flex items-start focus:outline-none border-none ${
                  isChecked
                    ? "bg-dropdown-selected-bg text-list-active-fg cy-dropdown-row-selected"
                    : "hover:bg-list-hover-bg cy-dropdown-row"
                }`}
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => toggleSkill(skill.name)}
                  className="flex-1 min-w-0 px-2 py-1.5 text-xs text-left flex items-start gap-2 focus:outline-none border-none bg-transparent cursor-pointer"
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
                      <span className="text-xxs text-description-fg truncate">
                        {skill.description}
                      </span>
                    )}
                  </span>
                </button>
                {canHide(skill.name) && (
                  <button
                    type="button"
                    disabled={disabled}
                    title="Hide this option"
                    aria-label="Hide this option"
                    onClick={(e) => {
                      e.stopPropagation();
                      onHideOption?.(skill.name);
                    }}
                    className="flex-shrink-0 px-1.5 py-1.5 opacity-0 group-hover:opacity-100 focus:opacity-100 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent transition-opacity"
                  >
                    <Icon name="eye-closed" className="text-xs" />
                  </button>
                )}
              </div>
            );
          })}

          {hideEnabled && showHidden && hiddenSkills.length > 0 && (
            <>
              <div className="border-t border-dropdown-border my-0" />
              {hiddenSkills.map((skill) => {
                const isChecked = selectedSkills.includes(skill.name);
                return (
                  <div
                    key={skill.name}
                    title={skill.description}
                    className="group w-full flex items-start opacity-60 italic hover:bg-list-hover-bg cy-dropdown-row"
                  >
                    <button
                      type="button"
                      disabled={disabled}
                      title="Unhide this option"
                      aria-label="Unhide this option"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUnhideOption?.(skill.name);
                      }}
                      className="flex-shrink-0 px-1.5 py-1.5 text-description-fg hover:text-foreground focus:outline-none border-none bg-transparent"
                    >
                      <Icon name="eye" className="text-xs" />
                    </button>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => handleHiddenSkillSelect(skill.name)}
                      className="flex-1 min-w-0 pr-2 py-1.5 text-xs text-left text-description-fg focus:outline-none border-none bg-transparent cursor-pointer"
                    >
                      <span className="flex flex-col min-w-0">
                        <span className="truncate">
                          {skill.name}
                          {isChecked ? " (selected)" : ""}
                        </span>
                        {skill.description && (
                          <span className="text-xxs truncate">
                            {skill.description}
                          </span>
                        )}
                      </span>
                    </button>
                  </div>
                );
              })}
            </>
          )}
        </>
      )}
    </div>
  );

  if (inline) {
    return (
      <div className="flex flex-col flex-1 min-h-0 w-full">
        {listContent}
        {hiddenToggleBar}
      </div>
    );
  }

  return (
    <div className="relative inline-block w-full">
      <button
        id={id}
        ref={buttonRef}
        type="button"
        disabled={disabled}
        onClick={() =>
          setIsOpen((prev) => {
            if (prev) {
              setShowHidden(false);
            }
            return !prev;
          })
        }
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-label={schemaAriaLabel(
          triggerAriaLabel,
          schemaPath,
          value === undefined
            ? { omit: true }
            : value === null
              ? null
              : JSON.stringify(value)
        )}
        title={
          disabled && disabledReason
            ? disabledReason
            : schemaTitle(
                schemaPath,
                value === undefined
                  ? { omit: true }
                  : value === null
                    ? null
                    : JSON.stringify(value)
              )
        }
        className={`cy-select-trigger cy-dropdown-row ${dropdownBorderClass(warning)}`}
      >
        <span className="truncate">{buttonLabel}</span>
        <Icon
          name={`chevron-${isOpen ? "up" : "down"}`}
          className="text-xxs flex-shrink-0 ml-1"
        />
      </button>
      {warning && (
        <span
          className={`text-xxs mt-0.5 block ${dropdownWarningClass(warning)}`}
        >
          {warning}
        </span>
      )}

      <DropdownPortal
        isOpen={isOpen}
        popupPos={popupPos}
        ref={popupRef}
        id={listboxId}
        role="listbox"
      >
        {listContent}
        {hiddenToggleBar}
      </DropdownPortal>
    </div>
  );
};
