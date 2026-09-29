import {
  ICON_BG_COLOR_DEFAULT,
  ICON_FG_COLOR_DEFAULT,
} from "../types/IconColorDefaults";

const DEFAULT_ICON_COLORS_PATTERN = new RegExp(
  `${ICON_BG_COLOR_DEFAULT}|${ICON_FG_COLOR_DEFAULT}`,
  "gi"
);

/** Recolors SVG defaults in one pass so replacement colors cannot collide. */
export function colorizeSvg(
  svg: string,
  bgColor: string,
  fgColor: string
): string {
  return svg.replace(DEFAULT_ICON_COLORS_PATTERN, (match) =>
    match.toUpperCase() === ICON_BG_COLOR_DEFAULT.toUpperCase()
      ? bgColor
      : fgColor
  );
}
