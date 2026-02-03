module.exports = {
  content: [
    "./index.html",
    "./main.tsx",
    "./App.tsx",
    "./components/**/*.{ts,tsx}",
    "./hooks/**/*.{ts,tsx}",
    "./store/**/*.{ts,tsx}",
    "./utils/**/*.{ts,tsx}",
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
      },
    },
  },
};
