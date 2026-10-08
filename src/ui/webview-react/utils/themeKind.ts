import {
  THEME_KINDS,
  THEME_KIND_CSS_VAR,
  VSCODE_THEME_BODY_CLASSES,
  isThemeKind,
  type ThemeKind,
} from "@root/types/DashboardConstants";

/**
 * Theme kind implied by VS Code's body classes, or `undefined` when none is
 * present. High-contrast light is checked before the generic high-contrast
 * class because VS Code adds both for it.
 */
export function themeKindFromBodyClasses(
  classes: Pick<DOMTokenList, "contains">
): ThemeKind | undefined {
  if (classes.contains(VSCODE_THEME_BODY_CLASSES.HIGH_CONTRAST_LIGHT)) {
    return THEME_KINDS.HIGH_CONTRAST_LIGHT;
  }
  if (classes.contains(VSCODE_THEME_BODY_CLASSES.HIGH_CONTRAST)) {
    return THEME_KINDS.HIGH_CONTRAST;
  }
  if (classes.contains(VSCODE_THEME_BODY_CLASSES.LIGHT)) {
    return THEME_KINDS.LIGHT;
  }
  if (classes.contains(VSCODE_THEME_BODY_CLASSES.DARK)) {
    return THEME_KINDS.DARK;
  }
  return undefined;
}

/**
 * Resolve the active theme kind from the document: body classes first, then
 * the forwarded `--cy-color-theme-kind` variable, defaulting to dark.
 */
export function getDocumentThemeKind(): ThemeKind {
  if (typeof document !== "undefined") {
    const fromBody = document.body
      ? themeKindFromBodyClasses(document.body.classList)
      : undefined;
    if (fromBody) return fromBody;

    const forwardedThemeKind =
      typeof window === "undefined"
        ? ""
        : window
            .getComputedStyle(document.documentElement)
            .getPropertyValue(THEME_KIND_CSS_VAR)
            .trim();
    if (isThemeKind(forwardedThemeKind)) return forwardedThemeKind;
  }

  return THEME_KINDS.DARK;
}
