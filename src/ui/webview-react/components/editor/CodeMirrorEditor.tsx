import React, { useEffect, useRef, useCallback } from "react";
import { EditorView, placeholder, keymap } from "@codemirror/view";
import { minimalSetup } from "codemirror";
import {
  autocompletion,
  completionKeymap,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { linter } from "@codemirror/lint";
import { getVsCodeApi } from "../../hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "../../types/messages";

// Typo.js spell checker (will be loaded from window.Typo)
declare global {
  interface Window {
    Typo: new (
      lang: string,
      aff: string,
      dic: string,
      options?: object
    ) => TypoChecker;
  }
}

interface TypoChecker {
  check: (word: string) => boolean;
  suggest: (word: string) => string[];
}

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  affUri: string;
  dicUri: string;
}

/**
 * CodeMirrorEditor - CodeMirror 6 integration for prompt editing
 *
 * Features:
 * - VS Code theme integration
 * - Spell checking with Typo.js
 * - Custom autocomplete for @file and #file references
 * - Line wrapping
 * - History (undo/redo)
 * - Search support
 */
export const CodeMirrorEditor: React.FC<CodeMirrorEditorProps> = (props) => {
  const { value, onChange, affUri, dicUri } = props;
  const placeholderText =
    props.placeholder ||
    "Use @ for files and folders, # for selections and symbols";

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const typoCheckerRef = useRef<TypoChecker | null>(null);
  const onChangeRef = useRef(onChange);
  const pendingCompletionResolveRef = useRef<((value: any) => void) | null>(
    null
  );
  const pendingCompletionTriggerRef = useRef<string | null>(null);

  const vscode = getVsCodeApi();

  // Keep onChange ref current
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Initialize Typo.js spell checker
  useEffect(() => {
    const initTypoChecker = async () => {
      console.log("[CodeMirror] Loading Typo.js dictionaries...");

      try {
        const [affData, dicData] = await Promise.all([
          fetch(affUri).then((r) => r.text()),
          fetch(dicUri).then((r) => r.text()),
        ]);

        if (window.Typo) {
          typoCheckerRef.current = new window.Typo("en_US", affData, dicData, {
            platform: "any",
          });
          console.log("[CodeMirror] Typo.js dictionaries loaded");
        }
      } catch (error) {
        console.error(
          "[CodeMirror] Failed to load Typo.js dictionaries:",
          error
        );
        typoCheckerRef.current = null;
      }
    };

    initTypoChecker();
  }, [affUri, dicUri]);

  // Handle completion response from extension
  const handleCompletionResponse = useCallback((items: any[], from: number) => {
    console.log(
      `[CodeMirror] handleCompletionResponse called: ${items.length} items, from=${from}`
    );

    if (!pendingCompletionResolveRef.current) {
      console.log(
        "[CodeMirror] No pending completion resolve, ignoring response"
      );
      return;
    }

    const trigger = pendingCompletionTriggerRef.current || "";

    const completions = items.map((item, index) => {
      // Calculate boost from sortText
      let boost: number;
      if (item.sortText) {
        const prefixMatch = item.sortText.match(/^(\d+)_/);
        if (prefixMatch) {
          const prefix = parseInt(prefixMatch[1]);
          boost = 1000 - prefix * 100 - index * 0.01;
        } else {
          boost = -index;
        }
      } else {
        boost = -index;
      }

      // Map VS Code CompletionItemKind to CodeMirror type
      const kindMap: Record<number, string> = {
        0: "text",
        1: "method",
        2: "function",
        3: "function",
        4: "property",
        5: "variable",
        6: "class",
        7: "interface",
        8: "namespace",
        9: "property",
        10: "constant",
        11: "constant",
        12: "enum",
        13: "keyword",
        14: "text",
        15: "string",
        16: "file",
        17: "text",
        18: "folder",
        19: "enum",
        20: "constant",
        21: "class",
      };

      const type =
        item.kind !== undefined ? kindMap[item.kind] || "text" : "text";

      return {
        label: item.insertText || item.label,
        type,
        detail: item.detail,
        boost,
        apply: trigger + (item.insertText || item.label),
      };
    });

    pendingCompletionResolveRef.current({
      from,
      options: completions,
    });

    pendingCompletionResolveRef.current = null;
    pendingCompletionTriggerRef.current = null;
  }, []);

  // Listen for completion responses from extension
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      if (message.type === MESSAGE_TYPES.COMPLETIONS_RESPONSE) {
        handleCompletionResponse(message.items || [], message.from);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handleCompletionResponse]);

  // Custom completions source
  const customCompletions = useCallback(
    (context: any): Promise<CompletionResult | null> | null => {
      // Match @ or # patterns for completions
      const before = context.matchBefore(
        /@[a-zA-Z0-9_/.-]*|#[a-zA-Z0-9_/:.-]*/
      );

      if (!before) return null;
      if (before.from === before.to && !context.explicit) return null;

      const trigger = before.text[0]; // @ or #
      const from = before.from;

      console.log(
        `[CodeMirror] Requesting completions: trigger="${trigger}", prefix="${before.text}"`
      );

      // Request completions from extension host
      return new Promise<CompletionResult | null>((resolve) => {
        pendingCompletionResolveRef.current = resolve;
        pendingCompletionTriggerRef.current = trigger;

        vscode.postMessage({
          type: MESSAGE_TYPES.REQUEST_COMPLETIONS,
          trigger,
          prefix: before.text,
          position: from,
        });
      });
    },
    [vscode]
  );

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!editorRef.current) return;

    // Create editor instance
    const view = new EditorView({
      doc: value,
      extensions: [
        minimalSetup,
        EditorView.lineWrapping,
        history(),
        keymap.of([...historyKeymap, ...searchKeymap, ...completionKeymap]),
        placeholder(placeholderText),
        createThemeExtension(),
        createLinterThemeExtension(),
        createSpellCheckExtension(typoCheckerRef),
        autocompletion({
          override: [customCompletions],
          activateOnTyping: true,
          closeOnBlur: true,
          optionClass: (completion) =>
            `cm-completion-${completion.type || "text"}`,
        }),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newValue = update.state.doc.toString();
            onChangeRef.current(newValue);
          }
        }),
      ],
      parent: editorRef.current,
    });

    viewRef.current = view;

    // Dispatch ready event
    window.dispatchEvent(new CustomEvent("codemirror-ready"));

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [placeholderText, customCompletions]);

  // Update editor content when value prop changes externally
  useEffect(() => {
    if (!viewRef.current) return;

    const currentValue = viewRef.current.state.doc.toString();
    if (currentValue !== value) {
      viewRef.current.dispatch({
        changes: {
          from: 0,
          to: currentValue.length,
          insert: value,
        },
      });
    }
  }, [value]);

  return <div ref={editorRef} className="h-full w-full codemirror-editor" />;
};

// VS Code theme integration
function createThemeExtension() {
  return EditorView.theme(
    {
      "&": {
        color: "var(--vscode-editor-foreground)",
        backgroundColor: "var(--vscode-editor-background)",
        height: "100%",
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
        backgroundColor: "var(--vscode-editor-selectionBackground) !important",
      },
      "&.cm-focused .cm-selectionBackground": {
        backgroundColor: "var(--vscode-editor-selectionBackground) !important",
      },
      ".cm-activeLine": {
        backgroundColor: "var(--vscode-editor-lineHighlightBackground)",
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
        outline: "1px solid var(--vscode-focusBorder)",
      },
      ".cm-placeholder": {
        color: "var(--vscode-input-placeholderForeground)",
        fontStyle: "italic",
      },
      // Autocomplete dropdown styling
      ".cm-tooltip-autocomplete": {
        backgroundColor: "var(--vscode-editorSuggestWidget-background)",
        border: "1px solid var(--vscode-editorSuggestWidget-border)",
        boxShadow: "0 2px 8px var(--vscode-widget-shadow)",
      },
      ".cm-tooltip-autocomplete ul": {
        fontFamily: "var(--vscode-editor-font-family, 'Consolas, monospace')",
      },
      ".cm-tooltip-autocomplete li": {
        color: "var(--vscode-editorSuggestWidget-foreground)",
      },
      ".cm-tooltip-autocomplete li[aria-selected]": {
        backgroundColor: "var(--vscode-editorSuggestWidget-selectedBackground)",
        color: "var(--vscode-editorSuggestWidget-selectedForeground)",
      },
      // Type-based completion styling
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
    },
    { dark: document.body.classList.contains("vscode-dark") }
  );
}

// Linter theme for squiggly underlines
function createLinterThemeExtension() {
  return EditorView.baseTheme({
    ".cm-lintRange": {
      backgroundPosition: "left bottom",
      backgroundRepeat: "repeat-x",
      paddingBottom: "0.7px",
    },
    ".cm-lintRange-error": {
      backgroundImage:
        "url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%226%22 height=%223%22><path d=%22m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0%22 stroke=%22%23d11%22 fill=%22none%22 stroke-width=%22.7%22/></svg>')",
    },
    ".cm-lintRange-warning": {
      backgroundImage:
        "url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%226%22 height=%223%22><path d=%22m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0%22 stroke=%22orange%22 fill=%22none%22 stroke-width=%22.7%22/></svg>')",
    },
    ".cm-diagnosticAction": {
      display: "block",
      font: "inherit",
      border: "1px solid var(--vscode-button-border, transparent)",
      padding: "4px 8px",
      margin: "2px 0",
      backgroundColor: "var(--vscode-button-background)",
      color: "var(--vscode-button-foreground)",
      borderRadius: "2px",
      cursor: "pointer",
      textAlign: "left",
      width: "100%",
    },
    ".cm-diagnosticAction:hover": {
      backgroundColor: "var(--vscode-button-hoverBackground)",
    },
  });
}

// Spell checking with Typo.js
function createSpellCheckExtension(
  typoCheckerRef: React.RefObject<TypoChecker | null>
) {
  return linter(
    (view) => {
      if (!typoCheckerRef.current) return [];

      const diagnostics: any[] = [];

      // Only check visible ranges for performance
      for (const { from, to } of view.visibleRanges) {
        const text = view.state.doc.sliceString(from, to);

        // Get ranges to exclude from spell checking (@ and # references)
        const excludedRanges = getCompletionRanges(text);

        // Match words with contractions and hyphens
        const wordRegex = /\b[a-zA-Z]+(?:['-][a-zA-Z]+)*\b/g;
        let match;

        while ((match = wordRegex.exec(text)) !== null) {
          const word = match[0];
          const wordFrom = from + match.index;
          const wordTo = wordFrom + word.length;

          // Skip if word is within a completion range
          if (
            isInExcludedRange(
              match.index,
              match.index + word.length,
              excludedRanges
            )
          ) {
            continue;
          }

          // Skip all-caps words (likely acronyms)
          if (word === word.toUpperCase() && word.length > 1) {
            continue;
          }

          if (!typoCheckerRef.current.check(word)) {
            const checker = typoCheckerRef.current;
            const diagnostic = {
              from: wordFrom,
              to: wordTo,
              severity: "error" as const,
              message: `Spelling: "${word}"`,
              get actions() {
                if (!(this as any)._cachedActions) {
                  const suggestions = checker.suggest((this as any)._word);
                  (this as any)._cachedActions = suggestions
                    .slice(0, 5)
                    .map((suggestion: string) => ({
                      name: `Change to "${suggestion}"`,
                      apply: (view: EditorView, from: number, to: number) => {
                        view.dispatch({
                          changes: { from, to, insert: suggestion },
                        });
                      },
                    }));
                }
                return (this as any)._cachedActions;
              },
              _word: word,
              _cachedActions: null,
            };

            diagnostics.push(diagnostic);
          }
        }
      }

      return diagnostics;
    },
    {
      delay: 200,
      needsRefresh: (update) => update.docChanged || update.viewportChanged,
    }
  );
}

// Get ranges of @ and # completions to exclude from spell checking
function getCompletionRanges(
  text: string
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];

  const patterns = [/@[^\s@#]+/g, /#[^\s@#]+/g];

  for (const pattern of patterns) {
    let match;
    const regex = new RegExp(pattern.source, "g");
    while ((match = regex.exec(text)) !== null) {
      ranges.push({
        from: match.index,
        to: match.index + match[0].length,
      });
    }
  }

  return ranges;
}

// Check if a range overlaps with any excluded range
function isInExcludedRange(
  from: number,
  to: number,
  excludedRanges: Array<{ from: number; to: number }>
): boolean {
  for (const range of excludedRanges) {
    if (from < range.to && to > range.from) {
      return true;
    }
  }
  return false;
}
