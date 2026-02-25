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
    // Scan Streamdown bundled classes for Tailwind to include them
    path.join(srcDir, "../../../node_modules/streamdown/dist/*.js"),
  ],
  darkMode: "class",

  theme: {
    extend: {
      colors: {
        // ── VS Code theme tokens (renamed from vscode-* for brevity) ──
        "editor-bg": "var(--vscode-editor-background)",
        "editor-fg": "var(--vscode-editor-foreground)",
        foreground: "var(--vscode-foreground)",
        "panel-border": "var(--vscode-panel-border)",
        "sidebar-bg": "var(--vscode-sideBar-background)",
        "sidebar-drop-bg": "var(--vscode-sideBar-dropBackground)",
        "focus-border": "var(--vscode-focusBorder)",
        "widget-border": "var(--vscode-widget-border)",

        // Buttons
        "btn-bg": "var(--vscode-button-background)",
        "btn-hover": "var(--vscode-button-hoverBackground)",
        "btn-fg": "var(--vscode-button-foreground)",
        // button.border is null in most themes — transparent matches VS Code's design intent
        "btn-border": "var(--vscode-button-border, transparent)",
        "btn-secondary-bg": "var(--vscode-button-secondaryBackground)",
        "btn-secondary-hover": "var(--vscode-button-secondaryHoverBackground)",
        "btn-secondary-fg": "var(--vscode-button-secondaryForeground)",

        // Inputs
        "input-bg": "var(--vscode-input-background)",
        "input-fg": "var(--vscode-input-foreground)",
        // input.border is null in most themes — transparent means "no border" when unset,
        // matching VS Code's design intent. Themes that define it get the defined color.
        "input-border": "var(--vscode-input-border, transparent)",
        "input-placeholder": "var(--vscode-input-placeholderForeground)",
        "input-error-bg": "var(--vscode-inputValidation-errorBackground)",
        "input-error-fg": "var(--vscode-inputValidation-errorForeground)",
        "input-error-border": "var(--vscode-inputValidation-errorBorder)",

        // Lists
        "list-hover-bg": "var(--vscode-list-hoverBackground)",
        // list-hoverForeground is omitted by themes that rely on contrast with hover bg
        "list-hover-fg":
          "var(--vscode-list-hoverForeground, var(--vscode-foreground))",
        // Highlight color for hovered/focused list item text — defined in all themes
        "list-highlight-fg": "var(--vscode-list-highlightForeground)",
        // HC themes don't define list selection backgrounds — fall back to hoverBackground
        "list-active-bg":
          "var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground))",
        "list-active-fg":
          "var(--vscode-list-activeSelectionForeground, var(--vscode-dropdown-foreground))",
        "list-inactive-bg":
          "var(--vscode-list-inactiveSelectionBackground, var(--vscode-list-hoverBackground))",
        "list-focus-bg":
          "var(--vscode-list-focusBackground, var(--vscode-list-hoverBackground))",

        // Dropdowns
        "dropdown-bg": "var(--vscode-dropdown-background)",
        "dropdown-fg": "var(--vscode-dropdown-foreground)",
        // dropdown.border is null in most themes — transparent matches VS Code's design intent
        "dropdown-border": "var(--vscode-dropdown-border, transparent)",
        // VS Code has no dropdown-specific selection variable; uses list selection vars.
        // --vscode-dropdown-selectedBackground does not exist.
        // HC themes don't define list-activeSelectionBackground — fall back to hoverBackground.
        "dropdown-selected-bg":
          "var(--vscode-list-activeSelectionBackground, var(--vscode-list-hoverBackground))",

        // Text colors
        "description-fg": "var(--vscode-descriptionForeground)",
        "error-fg": "var(--vscode-errorForeground)",
        "warning-fg": "var(--vscode-editorWarning-foreground)",
        "info-fg": "var(--vscode-editorInfo-foreground)",
        "link-fg": "var(--vscode-textLink-foreground)",
        "link-active-fg": "var(--vscode-textLink-activeForeground)",
        "disabled-fg": "var(--vscode-disabledForeground)",

        // Badges
        "badge-bg": "var(--vscode-badge-background)",
        "badge-fg": "var(--vscode-badge-foreground)",

        // Command Center (used for WorkflowStatus split button styling)
        "cmd-bg": "var(--vscode-commandCenter-background)",
        "cmd-fg": "var(--vscode-commandCenter-foreground)",
        "cmd-active-bg": "var(--vscode-commandCenter-activeBackground)",
        "cmd-active-fg": "var(--vscode-commandCenter-activeForeground)",
        "cmd-inactive-fg": "var(--vscode-commandCenter-inactiveForeground)",
        // commandCenter.border defaults to contrastBorder (null in standard themes);
        // fall back to widget-border which is always defined in Dark+ and Light+
        "cmd-border":
          "var(--vscode-commandCenter-border, var(--vscode-widget-border))",
        "cmd-active-border":
          "var(--vscode-commandCenter-activeBorder, var(--vscode-focusBorder))",
        "cmd-inactive-border":
          "var(--vscode-commandCenter-inactiveBorder, var(--vscode-widget-border))",

        // Toolbar / keybinding
        "toolbar-hover-bg": "var(--vscode-toolbar-hoverBackground)",
        "keybinding-bg":
          "var(--vscode-keybindingLabel-background, rgba(128,128,128,0.17))",

        // Notifications
        "notification-info-fg":
          "var(--vscode-notificationsInfoIcon-foreground)",

        // Execution status colors (semantic, theme-independent)
        "status-idle": "#2d80c4",
        "status-running": "#00c278",
        "status-completed": "#26544e",
        "status-stopped": "#7e2332",
        "status-paused": "#bea307",
        "status-error": "#ff1100",
        "status-cancelling": "#ff9900",

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
