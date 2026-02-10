const path = require("path");

// Get directory of this config file
const srcDir = __dirname;

module.exports = {
  content: [
    path.join(srcDir, "index.html"),
    path.join(srcDir, "*.{ts,tsx}"), // Scan root-level .ts/.tsx files (App.tsx, main.tsx, constants.ts, etc.)
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
        "vscode-border": "var(--vscode-panel-border, var(--border-color))",
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
        "status-idle": "#1064a8",
        "status-running": "#48924b",
        "status-completed": "#265428",
        "status-stopped": "#750800",
        "status-paused": "#a09000",
        "status-error": "#ff1100",
        "status-cancelling": "#FF9800",

        // ── Severity colors (status messages) ──
        "severity-info": "rgb(156, 220, 254)",
        "severity-info-bg": "rgba(156, 220, 254, 0.15)",
        "severity-warning": "rgb(252, 175, 62)",
        "severity-warning-bg": "rgba(252, 175, 62, 0.15)",
        "severity-error": "rgb(244, 71, 71)",
        "severity-error-bg": "rgba(244, 71, 71, 0.15)",

        // ── Output block border colors ──
        "output-prompt-border": "rgb(100, 100, 255)",
        "output-command-border": "rgb(255, 200, 100)",
        "output-streaming": "#4ec9b0",

        // ── Diff colors (VS Code theme vars with fallbacks) ──
        "diff-added-bg":
          "var(--vscode-diffEditor-insertedTextBackground, rgba(155, 185, 85, 0.2))",
        "diff-added-fg": "var(--vscode-terminal-ansiGreen, #89d185)",
        "diff-removed-bg":
          "var(--vscode-diffEditor-removedTextBackground, rgba(255, 0, 0, 0.2))",
        "diff-removed-fg": "var(--vscode-terminal-ansiRed, #f14c4c)",
        "diff-context-fg": "var(--vscode-editor-foreground, #cccccc)",
        "diff-line-num": "var(--vscode-editorLineNumber-foreground, #858585)",

        // ── Bash output colors ──
        "bash-expand-link": "#569cd6",
        "bash-status-success": "var(--vscode-charts-green, #89d185)",
        "bash-status-error": "var(--vscode-charts-red, #c24038)",
        "bash-status-running": "var(--vscode-charts-yellow, #d19a66)",

        // ── Execution state badge backgrounds (VS Code theme vars with fallbacks) ──
        "exec-idle-bg":
          "var(--vscode-statusBarItem-prominentBackground, rgba(128, 128, 128, 0.2))",
        "exec-idle-fg":
          "var(--vscode-statusBarItem-prominentForeground, var(--fg-secondary))",
        "exec-running-bg":
          "var(--vscode-progressBar-background, rgba(14, 99, 156, 0.8))",
        "exec-stopped-bg":
          "var(--vscode-editorInfo-foreground, rgba(150, 150, 150, 0.8))",

        // ── VS Code theme tokens ──
        "vscode-description-fg": "var(--vscode-descriptionForeground)",
        "vscode-error-fg": "var(--vscode-errorForeground)",
      },

      keyframes: {
        "pulse-custom": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.7" },
        },
        "pulse-streaming": {
          "0%, 100%": { opacity: "1" },
          "50%": { opacity: "0.5" },
        },
      },

      animation: {
        "pulse-custom": "pulse-custom 2s ease-in-out infinite",
        "pulse-streaming": "pulse-streaming 1.5s ease-in-out infinite",
        "pulse-cancelling": "pulse-custom 1.5s ease-in-out infinite",
      },

      fontFamily: {
        mono: ["var(--vscode-editor-font-family)", "monospace"],
      },
    },
  },
};
