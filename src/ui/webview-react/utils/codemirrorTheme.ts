import { EditorView } from "@codemirror/view";

type ThemeSurface = "editor" | "input";

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
      ".cm-activeLine":
        surface === "input"
          ? { backgroundColor: "transparent" }
          : {
              outline: "1px solid var(--vscode-editor-lineHighlightBorder)",
              outlineOffset: "-1px",
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
        color: "var(--vscode-editorSuggestWidget-foreground)",
        paddingTop: "3px",
        paddingBottom: "3px",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li:hover": {
        backgroundColor: "var(--vscode-list-hoverBackground)",
        color: "var(--vscode-list-hoverForeground)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--vscode-editorSuggestWidget-selectedBackground)",
        color: "var(--vscode-editorSuggestWidget-selectedForeground)",
      },
      ".cm-completion-file .cm-completionIcon": {
        color: "var(--vscode-symbolIcon-fileForeground, #858585)",
      },
      ".cm-completion-folder .cm-completionIcon": {
        color: "var(--vscode-symbolIcon-folderForeground, #dcb67a)",
      },
      ".cm-completion-class .cm-completionLabel": {
        color: "var(--vscode-symbolIcon-classForeground, #ee9d28)",
      },
      ".cm-completion-method .cm-completionLabel": {
        color: "var(--vscode-symbolIcon-methodForeground, #b180d7)",
      },
      ".cm-completion-function .cm-completionLabel": {
        color: "var(--vscode-symbolIcon-functionForeground, #b180d7)",
      },
      ".cm-completion-property .cm-completionLabel": {
        color: "var(--vscode-symbolIcon-propertyForeground, #75beff)",
      },
      ".cm-completion-variable .cm-completionLabel": {
        color: "var(--vscode-symbolIcon-variableForeground, #75beff)",
      },
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
