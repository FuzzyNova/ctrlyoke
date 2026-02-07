const path = require("path");

// Get directory of this config file
const srcDir = __dirname;

module.exports = {
  content: [
    path.join(srcDir, "index.html"),
    path.join(srcDir, "main.tsx"),
    path.join(srcDir, "App.tsx"),
    path.join(srcDir, "components/**/*.{ts,tsx}"),
    path.join(srcDir, "hooks/**/*.{ts,tsx}"),
    path.join(srcDir, "store/**/*.{ts,tsx}"),
    path.join(srcDir, "utils/**/*.{ts,tsx}"),
  ],
  darkMode: "class",

  theme: {
    extend: {
      colors: {
        "vscode-bg": "var(--vscode-editor-background)",
        "vscode-fg": "var(--vscode-editor-foreground)",
        "vscode-border": "var(--vscode-panel-border)",
        "vscode-primary": "var(--vscode-button-background)",
        "vscode-primary-hover": "var(--vscode-button-hoverBackground)",
        "vscode-primary-fg": "var(--vscode-button-foreground)",
        "vscode-secondary": "var(--vscode-button-secondaryBackground)",
        "vscode-secondary-hover":
          "var(--vscode-button-secondaryHoverBackground)",
        "vscode-secondary-fg": "var(--vscode-button-secondaryForeground)",
        "vscode-input-bg": "var(--vscode-input-background)",
        "vscode-input-fg": "var(--vscode-input-foreground)",
        "vscode-input-border": "var(--vscode-input-border)",
        "vscode-list-hover": "var(--vscode-list-hoverBackground)",
        "vscode-list-active": "var(--vscode-list-activeSelectionBackground)",

        // Execution status colors (semantic, theme-independent)
        "status-idle": "#1064a8", // Blue - waiting/queued
        "status-running": "#48924b", // Light green - active
        "status-completed": "#265428", // Dark green - success
        "status-stopped": "#750800", // Orange - user stopped
        "status-paused": "#a09000", // Amber - paused
        "status-error": "#ff1100", // Red - error/failed750800
        "status-cancelling": "#FF9800", // Orange - cancelling
      },
    },
  },
};
