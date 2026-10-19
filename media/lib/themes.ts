/**
 * The four built-in VS Code themes the walkthrough media ships in, keyed by
 * the theme suffix used in file names (`walkthrough-<step>-<theme>-...`).
 * `bodyClass` is the class the hosted page renders on <body> for that theme
 * kind (THEME_KIND_BODY_CLASSES in src/types/DashboardConstants.ts).
 */
export const THEMES = {
  dark: { id: "Dark 2026", bodyClass: "vscode-dark", colorScheme: "dark" },
  light: { id: "Light 2026", bodyClass: "vscode-light", colorScheme: "light" },
  hc: {
    id: "Default High Contrast",
    bodyClass: "vscode-high-contrast",
    colorScheme: "dark",
  },
  hclight: {
    id: "Default High Contrast Light",
    bodyClass: "vscode-high-contrast vscode-high-contrast-light",
    colorScheme: "light",
  },
} as const;

export type ThemeName = keyof typeof THEMES;

export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export const DEFAULT_THEME: ThemeName = "dark";
