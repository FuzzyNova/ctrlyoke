const path = require("path");

// Get directory of this config file
const srcDir = __dirname;
const chartsBlue = "var(--vscode-charts-blue, #4084d6)";
const chartsGreen = "var(--vscode-charts-green, #89d185)";
const chartsRed = "var(--vscode-charts-red, #c24038)";
const chartsYellow = "var(--vscode-charts-yellow, #d19a66)";

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
        "panel-sticky-bg":
          "var(--vscode-panelStickyScroll-background, var(--vscode-panel-background))",
        "sidebar-bg": "var(--vscode-sideBar-background)",
        "sidebar-drop-bg": "var(--vscode-sideBar-dropBackground)",
        "terminal-bg":
          "var(--vscode-terminal-background, var(--vscode-editor-background))",
        "focus-border": "var(--vscode-focusBorder)",
        "focus-border-hover":
          "color-mix(in srgb, var(--vscode-focusBorder) 65%, white)",
        "contrast-active-border":
          "var(--vscode-contrastActiveBorder, transparent)",
        "focus-highlight":
          "var(--vscode-list-focusHighlightForeground, #2aaaff)",
        "widget-border": "var(--vscode-widget-border)",
        "simple-find-sash-border":
          "var(--vscode-simpleFindWidget-sashBorder, var(--vscode-widget-border))",
        "widget-highlight-fg":
          "var(--vscode-editorHoverWidget-highlightForeground)",
        "widget-highlight-fg-hover":
          "color-mix(in srgb, var(--vscode-editorHoverWidget-highlightForeground) 65%, white)",
        "find-match":
          "var(--vscode-editor-findMatchBackground, rgba(39, 103, 130, 0.56))",
        "find-match-highlight":
          "var(--vscode-editor-findMatchHighlightBackground, rgba(39, 103, 130, 0.5))",
        "find-match-border":
          "var(--vscode-editor-findMatchBorder, var(--vscode-focusBorder, transparent))",

        // Buttons
        "btn-bg": "var(--vscode-button-background)",
        "btn-hover": "var(--vscode-button-hoverBackground)",
        "btn-fg": "var(--vscode-button-foreground)",
        "btn-separator": "var(--vscode-button-separator)",
        // button.border is null in most themes — transparent matches VS Code's design intent
        "btn-border": "var(--vscode-button-border, transparent)",
        // HC themes omit secondary button colors and rely on borders instead.
        // Fall back to the primary button tokens so buttons still render predictably.
        "btn-secondary-bg":
          "var(--vscode-button-secondaryBackground, var(--vscode-button-background))",
        "btn-secondary-hover":
          "var(--vscode-button-secondaryHoverBackground, var(--vscode-button-background))",
        "btn-secondary-fg":
          "var(--vscode-button-secondaryForeground, var(--vscode-button-foreground))",

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
        "charts-blue": chartsBlue,
        verified: chartsBlue,

        // Badges
        "badge-bg": "var(--vscode-badge-background)",
        "badge-fg": "var(--vscode-badge-foreground)",

        // Command Center (used for WorkflowStatus split button styling)
        "cmd-bg": "var(--vscode-commandCenter-activeBackground)",
        "cmd-fg": "var(--vscode-commandCenter-foreground)",
        "cmd-active-bg": "var(--vscode-commandCenter-debuggingBackground)",
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
        "toolbar-hover-outline":
          "var(--vscode-toolbar-hoverOutline, transparent)",
        "keybinding-bg":
          "var(--vscode-keybindingLabel-background, rgba(128,128,128,0.17))",

        // Notifications
        "notification-info-fg":
          "var(--vscode-notificationsInfoIcon-foreground)",

        // Execution status colors (semantic, theme-independent)
        "status-idle": "#2d80c4",
        "status-running": "#1caa63",
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
        "output-script-border": "rgb(200, 120, 255)",
        "output-streaming": "#4ec9b0",

        // ── Overlay scrims (status bars over mirrored terminal content) ──
        // Semi-transparent black, intentionally theme-independent — dimming
        // the terminal beneath should look consistent in light and dark themes.
        "overlay-scrim": "rgba(0, 0, 0, 0.4)",
        "overlay-scrim-strong": "rgba(0, 0, 0, 0.55)",

        // ── Source control status colors ──
        // Used by WorkspaceSourceControlPane.tsx for file status badges (A/M/D/R/U).
        // Matches VS Code's gitDecoration palette so badge colors are consistent
        // with the native Source Control view. Fallbacks are Dark+ defaults.
        "scm-added-fg":
          "var(--vscode-gitDecoration-addedResourceForeground, #73c991)",
        "scm-deleted-fg":
          "var(--vscode-gitDecoration-deletedResourceForeground, #f48771)",
        "scm-ignored-fg":
          "var(--vscode-gitDecoration-ignoredResourceForeground, #8c8c8c)",
        "scm-modified-fg":
          "var(--vscode-gitDecoration-modifiedResourceForeground, #e5ba7d)",
        "scm-renamed-fg":
          "var(--vscode-gitDecoration-renamedResourceForeground, #73c991)",
        "scm-untracked-fg":
          "var(--vscode-gitDecoration-untrackedResourceForeground, #73c991)",

        // ── Diff colors ──
        // diff-added-fg: used by UndoChangesDialog.tsx for "created" file status text.
        // The remaining diff-* tokens were only used by the old DiffView and are removed.
        "diff-added-fg": "var(--vscode-terminal-ansiGreen, #89d185)",
        // diff-hidden-bg: background for hidden-lines decoration rows in DiffView.
        "diff-hidden-bg":
          "var(--vscode-diffEditor-unchangedCodeBackground, rgba(116, 116, 116, 0.16))",

        // ── Output minimap colors ──
        // Keep diff colors aligned with VS Code's native minimap gutter tokens.
        "minimap-diff-added":
          "var(--vscode-minimapGutter-addedBackground, #72c892)",
        "minimap-diff-removed":
          "var(--vscode-minimapGutter-deletedBackground, #f28772)",
        // Reuse the theme's RGB channels but override alpha explicitly so
        // semi-transparent theme tokens (for example rgba(..., 0.6)) do not
        // lock the minimap thumb into a weaker opacity than we want.
        "minimap-thumb":
          "rgb(from var(--vscode-scrollbarSlider-background, rgba(121,121,121,0.7)) r g b / 0.7)",
        "minimap-thumb-hover":
          "rgb(from var(--vscode-scrollbarSlider-hoverBackground, rgba(100,100,100,0.8)) r g b / 0.8)",
        "minimap-thumb-active":
          "rgb(from var(--vscode-scrollbarSlider-activeBackground, rgba(191,191,191,0.9)) r g b / 0.9)",

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
        "code-block": "var(--vscode-textCodeBlock-background)",

        // ── SCM graph (commit history) colors ──
        // Themed from VS Code's scmGraph palette so commit-history ref pills and
        // graph nodes match the native Source Control graph. Fallbacks are Dark+.
        "scm-graph-local":
          "var(--vscode-scmGraph-historyItemRefColor, #57a3f8)",
        "scm-graph-remote":
          "var(--vscode-scmGraph-historyItemRemoteRefColor, #ad80d7)",
        "scm-graph-base":
          "var(--vscode-scmGraph-historyItemBaseRefColor, #ea5c00)",
        // Rotating swimlane palette (non-ref-specific lanes) — matches VS
        // Code's scmGraph.foreground1-5 tokens used by its graph renderer.
        "scm-graph-fg1": "var(--vscode-scmGraph-foreground1, #ffb000)",
        "scm-graph-fg2": "var(--vscode-scmGraph-foreground2, #dc267f)",
        "scm-graph-fg3": "var(--vscode-scmGraph-foreground3, #994f00)",
        "scm-graph-fg4": "var(--vscode-scmGraph-foreground4, #40b0a6)",
        "scm-graph-fg5": "var(--vscode-scmGraph-foreground5, #b66dff)",

        // ── Context window bar ──
        // Track (empty portion) uses a 15% tint of the foreground so it reads
        // clearly in both regular dark and HC themes without clashing with the
        // bright teal border color that HC assigns to --vscode-panel-border.
        "ctx-bar-track":
          "color-mix(in srgb, var(--vscode-foreground) 15%, transparent)",

        // ── Semantic accent colors ──
        "bash-expand-link": "#569cd6",
        favorite: "#e5c014",
        "pro-brand": "var(--vscode-focusBorder, #3994BC)",
        "scope-workspace": "#d97706",
        "scope-user": "#3b82f6",
        "indicator-success": chartsGreen,
        "indicator-error": chartsRed,
        "indicator-running": chartsYellow,

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
        "terminal-foreground":
          "var(--vscode-terminal-foreground, var(--vscode-editor-foreground))",

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
        "modal-enter": {
          from: { transform: "translateY(-100%)" },
          to: { transform: "translateY(0)" },
        },
        "modal-exit": {
          from: { transform: "translateY(0)" },
          to: { transform: "translateY(-100%)" },
        },
        "output-find-enter": {
          from: {
            opacity: "0",
            transform: "translateY(calc(-100% - 8px))",
          },
          to: {
            opacity: "1",
            transform: "translateY(0)",
          },
        },
        "output-find-exit": {
          from: {
            opacity: "1",
            transform: "translateY(0)",
          },
          to: {
            opacity: "0",
            transform: "translateY(calc(-100% - 8px))",
          },
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
        "modal-enter": "modal-enter 0.25s ease-out forwards",
        "modal-exit": "modal-exit 0.22s ease-in forwards",
        "output-find-enter": "output-find-enter 0.22s ease-out forwards",
        "output-find-exit": "output-find-exit 0.18s ease-in forwards",
      },

      zIndex: {
        // Shared app layer scale. Use these for layers that cross component
        // boundaries; keep local in-component stacking local.
        raised: "10",
        header: "20",
        overlay: "30",
        // Floating widgets confined to the main content area (e.g. the
        // output find bar) — above header-level content, but below
        // full-page drawers (History Search, Settings) so those correctly
        // cover it instead of it floating on top of them.
        "content-floating": "35",
        drawer: "40",
        floating: "50",
        panel: "100",
        // Full-viewport takeover for the output/terminal section's fullscreen
        // toggle. Above ordinary panels, but below modal dialogs so
        // Export/Undo dialogs rendered from inside the fullscreened section
        // still appear on top of it.
        "output-fullscreen": "150",
        "modal-backdrop": "200",
        modal: "210",
        "modal-prominent": "220",
        "workspace-viewer": "300",
        // Modals opened from inside the workspace viewer must sit above it.
        "viewer-modal-backdrop": "310",
        "viewer-modal": "320",
        popover: "9999",
      },

      screens: {
        xs: "380px",
      },

      borderRadius: {
        button: "4px",
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
