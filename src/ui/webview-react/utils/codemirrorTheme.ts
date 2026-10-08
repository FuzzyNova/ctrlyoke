import { EditorView } from "@codemirror/view";
import { SYMBOL_ICON_COLORS } from "@utils/atomicReferences";
import {
  THEME_KIND_CSS_VAR,
  VSCODE_THEME_BODY_CLASSES,
  isLightThemeKind,
  isThemeKind,
} from "@root/types/DashboardConstants";

const CODEMIRROR_THEME_SURFACES = {
  EDITOR: "editor",
  INPUT: "input",
} as const;

type ThemeSurface =
  (typeof CODEMIRROR_THEME_SURFACES)[keyof typeof CODEMIRROR_THEME_SURFACES];

export interface ThemeExtensionOptions {
  /**
   * Overrides .cm-content's font size, which otherwise follows the VS Code
   * editor font size. Any CSS font-size value is accepted (e.g. "0.75rem"
   * to match the text-xs control typography used across form controls).
   */
  fontSize?: string;
}

// Expands SYMBOL_ICON_COLORS into the two selector shapes that actually need the
// color: the completions dropdown icon (`.cm-completion-<kind> .cm-completionIcon`,
// where `.cm-completion-<kind>` comes from autocompletion()'s optionClass) and the
// atomic-reference chip icon (`.cm-atomic-ref-icon.codicon-<kind>`, see
// AtomicReferenceWidget.toDOM in CodeMirrorEditor.tsx). Both surfaces render the same
// codicon name for a given kind, so one map drives both.
function buildSymbolIconColorRules(): Record<string, { color: string }> {
  const rules: Record<string, { color: string }> = {};
  for (const [name, color] of Object.entries(SYMBOL_ICON_COLORS)) {
    rules[`.cm-completion-${name} .cm-completionIcon`] = { color };
    rules[`.cm-atomic-ref-icon.codicon-${name}`] = { color };
  }
  return rules;
}

// Gives every atomic-reference chip a left+bottom accent matching its own
// icon's color, driven off the same SYMBOL_ICON_COLORS map so a kind's chip
// accent can never drift from its icon color. Matches via `:has()` on the
// icon's codicon class rather than the chip's `data-type` attribute so
// #sym: chips (data-type="symbol") pick up their resolved SymbolKind's own
// color automatically instead of needing a flat "symbol" color that would
// misrepresent every kind but one. Rendered as an inset box-shadow (not the
// chip's actual `border`) so it never has to compete with
// `.cm-atomic-ref:hover`'s full-perimeter focus-border highlight — the two
// paint as independent layers, so hovering a chip still shows its color
// accent alongside the highlight instead of the highlight replacing it.
function buildChipAccentShadowRules(): Record<string, { boxShadow: string }> {
  const rules: Record<string, { boxShadow: string }> = {};
  for (const [name, color] of Object.entries(SYMBOL_ICON_COLORS)) {
    rules[`.cm-atomic-ref:has(.cm-atomic-ref-icon.codicon-${name})`] = {
      boxShadow: `inset 1px 0 0 0 ${color}, inset 0 -1px 0 0 ${color}`,
    };
  }
  return rules;
}

/** VS Code themed base extension for CodeMirror 6.  Shared by the prompt editor and workspace file editor. */
export function createThemeExtension(
  surface: ThemeSurface = CODEMIRROR_THEME_SURFACES.EDITOR,
  options: ThemeExtensionOptions = {}
) {
  const backgroundColor =
    surface === CODEMIRROR_THEME_SURFACES.INPUT
      ? "var(--vscode-input-background)"
      : "var(--vscode-editor-background)";
  const foregroundColor =
    surface === CODEMIRROR_THEME_SURFACES.INPUT
      ? "var(--vscode-input-foreground)"
      : "var(--vscode-editor-foreground)";
  const selectionForegroundColor =
    "var(--vscode-editor-selectionForeground, var(--vscode-editor-foreground))";
  const autocompleteSelectedOutlineColor =
    "var(--vscode-listFilterWidget-outline, transparent)";

  return EditorView.theme(
    {
      "&": {
        color: foregroundColor,
        backgroundColor,
        height: surface === CODEMIRROR_THEME_SURFACES.INPUT ? "auto" : "100%",
        ...(surface === CODEMIRROR_THEME_SURFACES.INPUT
          ? { minHeight: "inherit", maxHeight: "inherit" }
          : {}),
      },
      ".cm-scroller":
        surface === CODEMIRROR_THEME_SURFACES.INPUT
          ? {
              minHeight: "inherit",
              maxHeight: "inherit",
              overflow: "auto",
            }
          : {},
      // Keep CodeMirror's aria-live announcer completely out of layout. If it
      // falls back to normal flow, it pushes the scroller down by one or more
      // lines and looks like the editor mount div is vertically offset.
      ".cm-announced": {
        position: "absolute",
        top: 0,
        width: "1px",
        height: "1px",
        overflow: "hidden",
        clipPath: "inset(50%)",
        whiteSpace: "nowrap",
      },
      ".cm-content": {
        caretColor: "var(--vscode-editorCursor-foreground)",
        fontFamily: "var(--vscode-editor-font-family, 'Consolas, monospace')",
        fontSize: options.fontSize ?? "var(--vscode-editor-font-size, 14px)",
        padding: "8px 0",
      },
      ".cm-line": {
        padding: "0 8px",
      },
      ".cm-cursor": {
        borderLeftColor: "var(--vscode-editorCursor-foreground)",
      },
      ".cm-selectionBackground": {
        backgroundColor:
          "var(--vscode-editor-selectionBackground, rgba(57, 148, 188, 0.55)) !important",
      },
      "&.cm-focused .cm-selectionBackground": {
        backgroundColor:
          "var(--vscode-editor-selectionBackground, rgba(57, 148, 188, 0.55)) !important",
      },
      ".cm-line::selection, .cm-line ::selection": {
        color: `${selectionForegroundColor} !important`,
      },
      ".cm-activeLine":
        surface === CODEMIRROR_THEME_SURFACES.INPUT
          ? { backgroundColor: "transparent" }
          : {
              // An inset box-shadow (not outline) is intentional: outlines are
              // always painted on top of a box's descendants per spec, which
              // clipped the bottom edge of atomic-ref chip borders (see
              // .cm-atomic-ref) whenever a chip sat on the active line.
              // box-shadow paints in the background/border layer, beneath
              // in-flow children, so chip borders stay fully visible.
              boxShadow:
                "inset 0 0 0 1px var(--vscode-editor-lineHighlightBorder)",
              backgroundColor:
                "color-mix(in srgb, var(--vscode-editor-lineHighlightBackground) 40%, transparent)",
            },
      ".cm-gutters": {
        backgroundColor: "var(--vscode-editorGutter-background)",
        color: "var(--vscode-editorLineNumber-foreground)",
        border: "none",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "var(--vscode-editor-lineHighlightBackground)",
      },
      "&.cm-focused": {
        outline:
          surface === CODEMIRROR_THEME_SURFACES.INPUT
            ? "none"
            : "1px solid var(--vscode-focusBorder)",
      },
      ".cm-placeholder": {
        color: "var(--vscode-input-placeholderForeground)",
        fontStyle: "italic",
      },
      ".cm-tooltip-autocomplete": {
        backgroundColor: "var(--vscode-editorSuggestWidget-background)",
        border: "1px solid var(--vscode-editorSuggestWidget-border)",
        boxShadow: "0 2px 8px var(--vscode-widget-shadow)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": {
        fontFamily: "var(--vscode-editor-font-family, 'Consolas, monospace')",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
        backgroundColor: "var(--vscode-editorSuggestWidget-background)",
        color: "var(--vscode-editorSuggestWidget-foreground)",
        paddingTop: "3px",
        paddingBottom: "3px",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li:hover": {
        backgroundColor: "var(--vscode-list-hoverBackground)",
        color: "var(--vscode-list-hoverForeground)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor:
          "var(--vscode-editorSuggestWidget-selectedBackground, var(--vscode-editorSuggestWidget-background))",
        color:
          "var(--vscode-editorSuggestWidget-selectedForeground, var(--vscode-editorSuggestWidget-foreground))",
        outline: `1px solid ${autocompleteSelectedOutlineColor}`,
        outlineOffset: "-1px",
      },
      // Matched query characters: bold + highlight color on every row, like
      // VS Code's Quick Open list (CodeMirror's default is a plain underline).
      // The list-* tokens, not editorSuggestWidget-*: Default Dark sets
      // editorSuggestWidget-highlightForeground to the plain row foreground,
      // which leaves only the selected row's match visibly highlighted.
      ".cm-completionMatchedText": {
        textDecoration: "none",
        fontWeight: "bold",
        color: "var(--vscode-list-highlightForeground)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected] .cm-completionMatchedText":
        {
          color:
            "var(--vscode-list-focusHighlightForeground, var(--vscode-list-highlightForeground))",
        },
      // CodeMirror's own .cm-completionIcon sizes its built-in glyph set at
      // 90% with no vertical-align, which works because those glyphs are
      // plain text characters. Our codicon glyphs come from a separate font
      // whose global .codicon rule hard-codes 16px/line-height:1 — bigger
      // than the row text — so left alone they render taller than (and
      // baseline-shifted above) the completion label. Compounding with
      // .codicon here beats that rule outright instead of hoping cascade
      // order cooperates, and text-bottom lines the glyph back up with the
      // label text the way other codicon-next-to-text spots in this app do.
      ".cm-completionIcon.codicon": {
        fontSize: "90% !important",
        lineHeight: "1 !important",
        verticalAlign: "text-bottom",
      },
      ...buildSymbolIconColorRules(),
      ...buildChipAccentShadowRules(),
      ".cm-searchMatch": {
        backgroundColor:
          "var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33))",
        outline:
          "1px solid var(--vscode-editor-findMatchHighlightBorder, transparent)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor:
          "var(--vscode-editor-findMatchBackground, rgba(234, 92, 0, 0.7))",
        outline: "1px solid var(--vscode-editor-findMatchBorder, #f38518)",
      },
      ".cm-selectionMatch": {
        backgroundColor:
          "var(--vscode-editor-selectionHighlightBackground, rgba(173, 214, 255, 0.15))",
        outline:
          "1px solid var(--vscode-editor-selectionHighlightBorder, rgba(173, 214, 255, 0.4))",
      },
    },
    {
      dark:
        document.body.classList.contains(VSCODE_THEME_BODY_CLASSES.DARK) ||
        !isForwardedThemeLight(),
    }
  );
}

/** True only when the forwarded theme kind names a light theme. */
function isForwardedThemeLight(): boolean {
  const forwarded = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(THEME_KIND_CSS_VAR)
    .trim();
  return isThemeKind(forwarded) && isLightThemeKind(forwarded);
}
