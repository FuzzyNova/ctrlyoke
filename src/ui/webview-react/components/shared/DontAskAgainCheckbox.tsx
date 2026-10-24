import React from "react";

interface DontAskAgainCheckboxProps {
  id: string;
  /** Full sentence shown beside the box and used as its accessible name. */
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

/**
 * The "Don't ask me again" toggle shared by every confirmation modal. Each
 * modal persists the matching `ui.confirm*` setting itself as soon as the box
 * changes, so the choice survives Cancel too.
 */
export const DontAskAgainCheckbox: React.FC<DontAskAgainCheckboxProps> = ({
  id,
  label,
  checked,
  onChange,
}) => (
  <label
    htmlFor={id}
    className="mt-4 flex items-center gap-2 cursor-pointer select-none text-sm text-description-fg hover:text-foreground transition-colors"
  >
    <input
      id={id}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      aria-label={label}
      className="w-3.5 h-3.5 accent-button-bg cursor-pointer"
    />
    {label}
  </label>
);
