import React, { useEffect, useRef } from "react";
import { EditorView, placeholder } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { autocompletion } from "@codemirror/autocomplete";
import { linter } from "@codemirror/lint";

// Typo.js spell checker (will be loaded from window.Typo)
declare global {
  interface Window {
    Typo: any;
    CM: any;
  }
}

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  affUri: string;
  dicUri: string;
}

export const CodeMirrorEditor: React.FC<CodeMirrorEditorProps> = (props) => {
  const { value, onChange, affUri, dicUri } = props;
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const typoCheckerRef = useRef<any>(null);
  const onChangeRef = useRef(onChange);

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

        typoCheckerRef.current = new window.Typo("en_US", affData, dicData, {
          platform: "any",
        });

        console.log("[CodeMirror] Typo.js dictionaries loaded");
      } catch (error) {
        console.error(
          "[CodeMirror] Failed to load Typo.js dictionaries:",
          error
        );
        typoCheckerRef.current = null;
      }
    };

    if (window.Typo) {
      initTypoChecker();
    }
  }, [affUri, dicUri]);

  // Initialize CodeMirror editor
  useEffect(() => {
    if (!editorRef.current) return;

    // Create editor instance
    const view = new EditorView({
      doc: value,
      extensions: [
        basicSetup,
        EditorView.lineWrapping,
        placeholder(props.placeholder || ""),
        markdown(),
        autocompletion({
          activateOnTyping: true,
          closeOnBlur: true,
        }),
        createThemeExtension(),
        createSpellCheckExtension(typoCheckerRef),
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

    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []); // Only initialize once

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

  return <div ref={editorRef} className="h-full w-full" />;
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
        caretColor: "transparent",
        fontFamily: "var(--vscode-editor-font-family, 'Consolas, monospace')",
        fontSize: "var(--vscode-editor-font-size, 14px)",
        padding: "8px 0",
      },
      ".cm-line": {
        padding: "0 4px",
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
      "&.cm-focused": {
        outline: "1px solid var(--vscode-focusBorder)",
      },
      ".cm-placeholder": {
        color: "var(--vscode-input-placeholderForeground)",
        fontStyle: "italic",
      },
      // Linter theme for spell checking
      ".cm-lintRange": {
        backgroundPosition: "left bottom",
        backgroundRepeat: "repeat-x",
        paddingBottom: "0.7px",
      },
      ".cm-lintRange-error": {
        backgroundImage:
          "url('data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%226%22 height=%223%22><path d=%22m0 2.5 l2 -1.5 l1 0 l2 1.5 l1 0%22 stroke=%22%23d11%22 fill=%22none%22 stroke-width=%22.7%22/></svg>')",
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
    },
    { dark: document.body.classList.contains("vscode-dark") }
  );
}

// Spell checking with Typo.js
function createSpellCheckExtension(typoCheckerRef: React.RefObject<any>) {
  return linter(
    (view) => {
      if (!typoCheckerRef.current) return [];

      const diagnostics: any[] = [];

      // Only check visible ranges for performance
      for (let { from, to } of view.visibleRanges) {
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
            // Lazy loading: suggestions generated on demand
            const diagnostic = {
              from: wordFrom,
              to: wordTo,
              severity: "error" as const,
              message: `Spelling: "${word}"`,
              get actions() {
                if (!(this as any)._cachedActions) {
                  const suggestions = (typoCheckerRef.current as any).suggest(
                    (this as any)._word
                  );
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
function getCompletionRanges(text: string) {
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
) {
  for (const range of excludedRanges) {
    if (from < range.to && to > range.from) {
      return true;
    }
  }
  return false;
}
