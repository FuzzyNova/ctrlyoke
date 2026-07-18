import { EditorView } from "@codemirror/view";

type ThemeSurface = "editor" | "input";

// Maps codicon names (the same names produced by COMPLETION_KIND_ICONS in
// CodeMirrorEditor.tsx, e.g. "symbol-class", "folder", "source-control") to the VS
// Code symbolIcon theme variable that colors that icon, with the Dark+ theme's
// default value as the CSS fallback (see dev/reference/vscode-css-vars-darkplus.json).
// Single source for both the completions dropdown icon and the atomic-reference chip
// icon — generated into selectors for each by buildSymbolIconColorRules() below, so a
// kind's color can never drift between the two surfaces.
const SYMBOL_ICON_COLORS: Record<string, string> = {
  "symbol-text": "var(--vscode-symbolIcon-textForeground, #cccccc)",
  "symbol-method": "var(--vscode-symbolIcon-methodForeground, #b180d7)",
  "symbol-function": "var(--vscode-symbolIcon-functionForeground, #b180d7)",
  "symbol-constructor": "var(--vscode-symbolIcon-constructorForeground, #b180d7)",
  "symbol-field": "var(--vscode-symbolIcon-fieldForeground, #75beff)",
  "symbol-variable": "var(--vscode-symbolIcon-variableForeground, #75beff)",
  "symbol-class": "var(--vscode-symbolIcon-classForeground, #ee9d28)",
  "symbol-interface": "var(--vscode-symbolIcon-interfaceForeground, #75beff)",
  "symbol-module": "var(--vscode-symbolIcon-moduleForeground, #cccccc)",
  "symbol-property": "var(--vscode-symbolIcon-propertyForeground, #cccccc)",
  "symbol-value": "var(--vscode-symbolIcon-constantForeground, #cccccc)",
  "symbol-enum": "var(--vscode-symbolIcon-enumeratorForeground, #ee9d28)",
  "symbol-keyword": "var(--vscode-symbolIcon-keywordForeground, #cccccc)",
  "symbol-snippet": "var(--vscode-symbolIcon-snippetForeground, #cccccc)",
  "symbol-color": "var(--vscode-symbolIcon-colorForeground, #cccccc)",
  "symbol-file": "var(--vscode-symbolIcon-fileForeground, #cccccc)",
  folder: "var(--vscode-symbolIcon-folderForeground, #cccccc)",
  "symbol-enum-member":
    "var(--vscode-symbolIcon-enumeratorMemberForeground, #75beff)",
  "symbol-constant": "var(--vscode-symbolIcon-constantForeground, #cccccc)",
  "symbol-struct": "var(--vscode-symbolIcon-structForeground, #cccccc)",
  "symbol-event": "var(--vscode-symbolIcon-eventForeground, #ee9d28)",
  "symbol-operator": "var(--vscode-symbolIcon-operatorForeground, #cccccc)",
  "symbol-type-parameter":
    "var(--vscode-symbolIcon-typeParameterForeground, #cccccc)",
  // Not real SymbolKinds — repurposed markers (see COMPLETION_KIND_ICONS in
  // CodeMirrorEditor.tsx) — but still colored from the closest matching var so
  // they don't look unstyled next to every other completion/chip icon.
  "list-selection": "var(--vscode-symbolIcon-unitForeground, #cccccc)",
  "source-control": "var(--vscode-symbolIcon-referenceForeground, #cccccc)",
};

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

/** VS Code themed base extension for CodeMirror 6.  Shared by the prompt editor and workspace file editor. */
export function createThemeExtension(surface: ThemeSurface = "editor") {
  const backgroundColor =
    surface === "input"
      ? "var(--vscode-input-background)"
      : "var(--vscode-editor-background)";
  const foregroundColor =
    surface === "input"
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
        height: surface === "input" ? "auto" : "100%",
        ...(surface === "input"
          ? { minHeight: "inherit", maxHeight: "inherit" }
          : {}),
      },
      ".cm-scroller":
        surface === "input"
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
        fontSize: "var(--vscode-editor-font-size, 14px)",
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
        surface === "input"
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
          surface === "input" ? "none" : "1px solid var(--vscode-focusBorder)",
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
        document.body.classList.contains("vscode-dark") ||
        window
          .getComputedStyle(document.documentElement)
          .getPropertyValue("--fp-color-theme-kind")
          .trim() !== "light",
    }
  );
}
