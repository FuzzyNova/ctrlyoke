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
        "panel-bg": "var(--vscode-panel-background)",
        "panel-border": "var(--vscode-panel-border)",
        "sidebar-bg": "var(--vscode-sideBar-background)",
        "sidebar-drop-bg": "var(--vscode-sideBar-dropBackground)",
        "focus-border": "var(--vscode-focusBorder)",
        "focus-highlight":
          "var(--vscode-list-focusHighlightForeground, #2aaaff)",
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
        // Use VS Code theme vars so text is readable in all themes.
        // color-mix generates a 15% tint of the foreground color for the background.
        "severity-info": "var(--vscode-editorInfo-foreground, #59a4f9)",
        "severity-info-bg":
          "color-mix(in srgb, var(--vscode-editorInfo-foreground, #59a4f9) 15%, transparent)",
        "severity-warning": "var(--vscode-editorWarning-foreground, #cca700)",
        "severity-warning-bg":
          "color-mix(in srgb, var(--vscode-editorWarning-foreground, #cca700) 15%, transparent)",
        "severity-error": "var(--vscode-editorError-foreground, #f14c4c)",
        "severity-error-bg":
          "color-mix(in srgb, var(--vscode-editorError-foreground, #f14c4c) 15%, transparent)",

        // ── Output block border colors (constant, theme independent) ──
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

        // ── Markdown enrichment colors (VS Code symbol icon palette) ──
        // Used by MarkdownText.tsx for bold, italic, headings, and tables.
        // Fallbacks are Dark+ defaults so the UI looks reasonable on all themes.
        "md-strong-fg": "var(--vscode-symbolIcon-interfaceForeground, #75beff)",
        "md-em-fg": "var(--vscode-symbolIcon-functionForeground, #b180d7)",
        "md-heading-fg": "var(--vscode-symbolIcon-classForeground, #ee9d28)",
        "md-table-head-bg":
          "var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.1))",

        // ── Inline code color ──
        // Warm VS Code string tint for backtick inline code (no language class).
        "code-inline-fg": "var(--vscode-debugTokenExpression-string, #ce9178)",

        // ── Bash output colors ──
        "bash-expand-link": "#569cd6",
        "bash-status-success": "var(--vscode-charts-green, #89d185)",
        "bash-status-error": "var(--vscode-charts-red, #c24038)",
        "bash-status-running": "var(--vscode-charts-yellow, #d19a66)",

        // ── Terminal ANSI colors ──
        "terminal-ansiGreen": "var(--vscode-terminal-ansiGreen, #89d185)",
        "terminal-ansiYellow": "var(--vscode-terminal-ansiYellow, #e5e510)",
        "terminal-ansiRed": "var(--vscode-terminal-ansiRed, #f14c4c)",
        "terminal-ansiBrightGreen":
          "var(--vscode-terminal-ansiBrightGreen, #23d18b)",
        "terminal-ansiBrightYellow":
          "var(--vscode-terminal-ansiBrightYellow, #f5f543)",
        "terminal-ansiBrightRed":
          "var(--vscode-terminal-ansiBrightRed, #f14c4c)",

        // ── Execution state badge backgrounds (VS Code theme vars with fallbacks) ──
        "exec-idle-bg":
          "var(--vscode-statusBarItem-prominentBackground, rgba(128, 128, 128, 0.2))",
        "exec-idle-fg":
          "var(--vscode-statusBarItem-prominentForeground, var(--fg-secondary))",
        "exec-running-bg":
          "var(--vscode-progressBar-background, rgba(14, 99, 156, 0.8))",
        "exec-stopped-bg":
          "var(--vscode-editorInfo-foreground, rgba(150, 150, 150, 0.8))",

        // ── Streamdown / shadcn-ui compatibility ──────────────────────────────
        // Streamdown's table Copy/Download controls use shadcn/ui Tailwind class
        // names: bg-background, bg-sidebar, border-border, text-muted-foreground,
        // hover:text-foreground, ring-ring. Mapping them here causes the host
        // Tailwind build to generate VS Code-themed CSS for those classes.
        // 'foreground' is already mapped above.
        // Fallback to transparent where a VS Code theme may leave a value unset.
        background: "var(--vscode-editor-background)",
        sidebar: "var(--vscode-sideBar-background)",
        border: "var(--vscode-panel-border, transparent)",
        muted: {
          DEFAULT:
            "var(--vscode-list-hoverBackground, rgba(127, 127, 127, 0.1))",
          foreground: "var(--vscode-descriptionForeground)",
        },
        ring: "var(--vscode-focusBorder, transparent)",
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
        "slide-in-left": {
          "0%": { transform: "translateX(-100%)" },
          "100%": { transform: "translateX(0)" },
        },
        "slide-in-right": {
          "0%": { transform: "translateX(100%)" },
          "100%": { transform: "translateX(0)" },
        },
        "slide-out-left": {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(-100%)" },
        },
        "slide-out-right": {
          "0%": { transform: "translateX(0)" },
          "100%": { transform: "translateX(100%)" },
        },
        "slide-down-fade-in": {
          from: {
            opacity: "0",
            gridTemplateRows: "0fr",
            transform: "translateY(-4px)",
          },
          to: {
            opacity: "1",
            gridTemplateRows: "1fr",
            transform: "translateY(0)",
          },
        },
        "slide-down-fade-out": {
          from: {
            opacity: "1",
            gridTemplateRows: "1fr",
            transform: "translateY(0)",
          },
          to: {
            opacity: "0",
            gridTemplateRows: "0fr",
            transform: "translateY(-4px)",
          },
        },
        "ctx-update": {
          "0%": { filter: "brightness(2)" },
          "100%": { filter: "brightness(1)" },
        },
        // Width-based animations for the mobile sidebar chip rail.
        // Unlike translateX animations, these affect flex layout so the
        // adjacent output panel is pushed/pulled smoothly rather than
        // jumping when the rail mounts or unmounts.
        "slide-in-sidebar": {
          from: { width: "0px" },
          to: { width: "32px" },
        },
        "slide-out-sidebar": {
          from: { width: "32px" },
          to: { width: "0px" },
        },
      },

      animation: {
        "pulse-custom": "pulse-custom 2s ease-in-out infinite",
        "pulse-streaming": "pulse-streaming 1.5s ease-in-out infinite",
        "pulse-cancelling": "pulse-custom 1.5s ease-in-out infinite",
        "slide-in-left": "slide-in-left 0.25s ease-out",
        "slide-in-right": "slide-in-right 0.25s ease-out",
        "slide-out-left": "slide-out-left 0.22s ease-in forwards",
        "slide-out-right": "slide-out-right 0.22s ease-in forwards",
        "slide-down-in": "slide-down-fade-in 300ms ease-out forwards",
        "slide-down-out": "slide-down-fade-out 300ms ease-in forwards",
        "ctx-update": "ctx-update 0.4s ease-out",
        "slide-in-sidebar": "slide-in-sidebar 0.25s ease-out both",
        "slide-out-sidebar": "slide-out-sidebar 0.22s ease-in both",
      },

      fontSize: {
        xxs: ["0.625rem", { lineHeight: "1rem" }],
      },

      fontFamily: {
        mono: ["var(--vscode-editor-font-family)", "monospace"],
      },
    },
    // Override Tailwind's default border color (white) so that unsuffixed border
    // utilities like border-l, border-r, border-t, border-b use the VS Code
    // panel border variable instead.
    borderColor: ({ theme }) => ({
      ...theme("colors"),
      DEFAULT:
        "var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.35)))",
    }),
  },
};
