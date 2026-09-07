import React from "react";

export interface IconProps {
  /** Codicon name, with or without the `codicon-` prefix. */
  name: string;
  /** Extra classes (size utilities such as `codicon-lg`, colors, spacing). */
  className?: string;
  style?: React.CSSProperties;
  /** Preserve existing hover and query metadata on migrated icons. */
  title?: string;
  /**
   * Name for an icon that carries meaning on its own (a status glyph, a
   * change-type badge). Supplying it promotes the icon to `role="img"` and
   * drops `aria-hidden` — the two cannot coexist, because `aria-hidden="true"`
   * removes the element from the accessibility tree and takes the label with
   * it. Leave it unset for decorative icons, which is the overwhelming
   * majority: name the parent control instead.
   */
  "aria-label"?: string;
}

export const Icon: React.FC<IconProps> = ({
  name,
  className,
  style,
  title,
  "aria-label": ariaLabel,
}) => (
  <i
    className={`codicon ${name.startsWith("codicon-") ? name : `codicon-${name}`}${className ? ` ${className}` : ""}`}
    style={style}
    aria-hidden={ariaLabel ? undefined : "true"}
    role={ariaLabel ? "img" : undefined}
    title={title}
    aria-label={ariaLabel}
  />
);
