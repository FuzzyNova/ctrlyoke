import React from "react";
import type { LucideIcon as LucideIconComponent } from "lucide-react";

/**
 * Box sizes matching the codicon size classes in globals.css: the default
 * `.codicon` (16px), `.codicon-lg` (20px) and `.codicon-xl` (24px). A number
 * is a pixel size for the rare inline-in-text use that needs a smaller glyph.
 */
const LUCIDE_ICON_SIZES = {
  md: 16,
  lg: 20,
  xl: 24,
} as const;

export type LucideIconSize = keyof typeof LUCIDE_ICON_SIZES | number;

/**
 * Lucide draws 2px outlines on a 24px grid, which reads heavier than a filled
 * 16px codicon. A thinner, non-scaling stroke keeps the line the same width in
 * screen pixels at every size, so a Lucide icon sits next to codicons without
 * looking bolder.
 */
const LUCIDE_STROKE_WIDTH = 1.25;

export interface LucideIconProps {
  /** The Lucide component itself (a named import), never a name string. */
  icon: LucideIconComponent;
  /** Defaults to `md`, the same 16px box as a codicon. */
  size?: LucideIconSize;
  /** Extra classes (colors, spacing, alignment overrides). */
  className?: string;
  style?: React.CSSProperties;
  /**
   * Name for an icon that carries meaning on its own. Same contract as
   * `Icon`: supplying it promotes the icon to `role="img"` and drops
   * `aria-hidden`; leave it unset for decorative icons and name the parent
   * control instead. Lucide only adds `aria-hidden` itself when no `aria-*`,
   * `role` or `title` prop is passed, so it is set explicitly here.
   */
  "aria-label"?: string;
}

/**
 * Renders a Lucide icon sized, weighted and aligned like a codicon. Codicons
 * via `Icon` remain the first choice; use this only when no codicon fits.
 */
export const LucideIcon: React.FC<LucideIconProps> = ({
  icon: Component,
  size = "md",
  className,
  style,
  "aria-label": ariaLabel,
}) => (
  <Component
    size={typeof size === "number" ? size : LUCIDE_ICON_SIZES[size]}
    strokeWidth={LUCIDE_STROKE_WIDTH}
    nonScalingStroke
    className={`cy-lucide-icon${className ? ` ${className}` : ""}`}
    style={style}
    aria-hidden={ariaLabel ? undefined : "true"}
    role={ariaLabel ? "img" : undefined}
    aria-label={ariaLabel}
    focusable="false"
  />
);
