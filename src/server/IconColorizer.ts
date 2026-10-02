import {
  ICON_BG_COLOR_DEFAULT,
  ICON_COLOR_PATTERN,
  ICON_FG_COLOR_DEFAULT,
} from "../types/IconColorDefaults";

export interface HostedIconColors {
  bg: string;
  fg: string;
}

/** Resolve persisted icon colors against the settings schema's hex contract. */
export function resolveHostedIconColors(serverSettings: {
  iconBgColor?: unknown;
  iconFgColor?: unknown;
}): HostedIconColors {
  const pattern = new RegExp(ICON_COLOR_PATTERN);
  const bg = serverSettings.iconBgColor;
  const fg = serverSettings.iconFgColor;
  return {
    bg: typeof bg === "string" && pattern.test(bg) ? bg : ICON_BG_COLOR_DEFAULT,
    fg: typeof fg === "string" && pattern.test(fg) ? fg : ICON_FG_COLOR_DEFAULT,
  };
}

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
