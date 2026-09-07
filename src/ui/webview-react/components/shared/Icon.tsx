import React from "react";

export interface IconProps {
  /** Codicon name, with or without the `codicon-` prefix. */
  name: string;
  /** Extra classes (size utilities such as `codicon-lg`, colors, spacing). */
  className?: string;
  style?: React.CSSProperties;
}

export const Icon: React.FC<IconProps> = ({ name, className, style }) => (
  <i
    className={`codicon ${name.startsWith("codicon-") ? name : `codicon-${name}`}${className ? ` ${className}` : ""}`}
    style={style}
    aria-hidden="true"
  />
);
