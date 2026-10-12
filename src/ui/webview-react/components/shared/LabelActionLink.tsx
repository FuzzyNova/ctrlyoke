import React from "react";

/** Small all-caps link styling for a field action sitting right-aligned on the field's label row. */
export const LABEL_ACTION_LINK_CLASS =
  "text-xxs font-semibold uppercase text-link-fg hover:underline cursor-pointer transition-colors bg-transparent border-0 p-0";

/** Muted all-caps text that shares a label row with a {@link LabelActionLink}. */
export const LABEL_ACTION_NOTE_CLASS =
  "text-xxs font-semibold uppercase text-description-fg";

type LabelActionLinkProps = Omit<
  React.ButtonHTMLAttributes<HTMLButtonElement>,
  "type"
>;

/**
 * A field's label on the left and an optional {@link LabelActionLink} (or
 * note) right-aligned on the same row. The action stays outside the `<label>`
 * so clicking it never forwards to the control.
 */
export const FieldLabelRow: React.FC<{
  htmlFor: string;
  children: React.ReactNode;
  action?: React.ReactNode;
  labelClassName?: string;
}> = ({
  htmlFor,
  children,
  action,
  labelClassName = "text-sm text-foreground",
}) => (
  <div className="mb-1 flex min-h-[18px] flex-wrap items-center justify-between gap-x-2">
    <label htmlFor={htmlFor} className={`min-w-0 ${labelClassName}`}>
      {children}
    </label>
    {/* ml-auto keeps the action right-aligned when it wraps under a long label. */}
    {action && <span className="ml-auto">{action}</span>}
  </div>
);

/**
 * A field-level action such as "Set as Default", drawn as an all-caps link on
 * the same row as the field's label, right-aligned.
 */
export const LabelActionLink: React.FC<LabelActionLinkProps> = ({
  className,
  ...props
}) => (
  <button
    type="button"
    className={`${LABEL_ACTION_LINK_CLASS}${className ? ` ${className}` : ""}`}
    {...props}
  />
);
