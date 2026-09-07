import React from "react";

export interface IconProps {
  /** Codicon name, with or without the `codicon-` prefix. */
  name: string;
  /** Extra classes (size utilities such as `codicon-lg`, colors, spacing). */
  className?: string;
  style?: React.CSSProperties;
  /** Preserve existing hover and query metadata on migrated icons. */
  title?: string;
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
    aria-hidden="true"
    title={title}
    aria-label={ariaLabel}
  />
);
