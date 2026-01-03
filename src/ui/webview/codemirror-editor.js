/**
 * CodeMirrorPromptEditor - Modern text editor for FlightPath prompts
 * Replaces contenteditable-based prompt-editor.js
 *
 * Features:
 * - Native spell checking
 * - Custom autocomplete for @file and #file references
 * - Clickable links with Ctrl+Click
 * - VS Code theme integration
 * - Undo/redo, search, multiple selections
 */

(function () {
  // Will be populated when CodeMirror modules are loaded
  let CM = null;

  class CodeMirrorPromptEditor {
    constructor(containerElement, affUri, dicUri) {
      this.container = containerElement;
      this.view = null;
      this.onChangeCallback = null;
      this.pendingCompletionResolve = null;
      this.typoChecker = null;
      this.affUri = affUri;
      this.dicUri = dicUri;

      this.init();
    }

    async init() {
      // Wait for CodeMirror to be available
      await this.waitForCodeMirror();

      // Initialize Typo.js spell checker (parallel with CodeMirror)
      this.initTypoChecker(this.affUri, this.dicUri);

      // Create editor instance
      this.view = new CM.EditorView({
        doc: "",
        extensions: this.buildExtensions(),
        parent: this.container,
      });
    }

    async waitForCodeMirror() {
      return new Promise((resolve) => {
        const checkInterval = setInterval(() => {
          if (window.CM) {
            CM = window.CM;
            clearInterval(checkInterval);
            resolve();
          }
        }, 50);
      });
    }

    buildExtensions() {
      const { EditorView, keymap, ViewPlugin, Decoration } = CM;
      const { basicSetup } = CM;
      const { autocompletion } = CM;

      return [
        basicSetup,
        this.themeExtension(),
        this.spellCheckExtension(),
        this.autocompletionExtension(),
        this.linkDecorationExtension(),
        this.updateListenerExtension(),
        this.keymapExtension(),
        this.clickHandlerExtension(),
      ];
    }

    // Theme matching VS Code
    themeExtension() {
      const { EditorView } = CM;

      return EditorView.theme(
        {
          "&": {
            color: "var(--vscode-editor-foreground)",
            backgroundColor: "var(--vscode-editor-background)",
            height: "100%",
          },
          ".cm-content": {
            caretColor: "var(--vscode-editorCursor-foreground)",
            fontFamily:
              "var(--vscode-editor-font-family, 'Consolas, monospace')",
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
            backgroundColor:
              "var(--vscode-editor-selectionBackground) !important",
          },
          "&.cm-focused .cm-selectionBackground": {
            backgroundColor:
              "var(--vscode-editor-selectionBackground) !important",
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
          ".cm-link": {
            color: "var(--vscode-textLink-foreground)",
            textDecoration: "underline",
            cursor: "pointer",
          },
          ".cm-link:hover": {
            color: "var(--vscode-textLink-activeForeground)",
          },
          "&.cm-focused": {
            outline: "1px solid var(--vscode-focusBorder)",
          },
        },
        { dark: document.body.classList.contains("vscode-dark") }
      );
    }

    // Typo.js spell checking via CodeMirror linter
    spellCheckExtension() {
      const { linter } = CM;

      return linter(
        (view) => {
          if (!this.typoChecker) return [];

          const diagnostics = [];
          const text = view.state.doc.toString();
          const wordRegex = /\b[a-zA-Z]+\b/g;
          let match;

          while ((match = wordRegex.exec(text)) !== null) {
            const word = match[0];
            if (!this.typoChecker.check(word)) {
              const from = match.index;
              const to = from + word.length;

              const suggestions = this.typoChecker.suggest(word);
              const message =
                suggestions.length > 0
                  ? `Spelling: "${word}". Suggestions: ${suggestions.slice(0, 3).join(", ")}`
                  : `Spelling: "${word}"`;

              diagnostics.push({
                from: from,
                to: to,
                severity: "warning",
                message: message,
                actions: suggestions.slice(0, 5).map((suggestion) => ({
                  name: `Change to "${suggestion}"`,
                  apply: (view, from, to) => {
                    view.dispatch({
                      changes: { from, to, insert: suggestion },
                    });
                  },
                })),
              });
            }
          }

          return diagnostics;
        },
        {
          delay: 300, // Debounce spell checking
        }
      );
    }

    // Initialize Typo.js checker
    async initTypoChecker(affUri, dicUri) {
      console.log("[CodeMirror] Loading Typo.js dictionaries...");

      try {
        const [affData, dicData] = await Promise.all([
          fetch(affUri).then((r) => r.text()),
          fetch(dicUri).then((r) => r.text()),
        ]);

        this.typoChecker = new Typo("en_US", affData, dicData, {
          platform: "any",
        });

        console.log("[CodeMirror] Typo.js dictionaries loaded");
      } catch (error) {
        console.error(
          "[CodeMirror] Failed to load Typo.js dictionaries:",
          error
        );
        this.typoChecker = null;
      }
    }

    // Autocomplete for @file and #file
    autocompletionExtension() {
      const { autocompletion } = CM;

      return autocompletion({
        override: [this.customCompletions.bind(this)],
        activateOnTyping: true,
        closeOnBlur: true,
      });
    }

    customCompletions(context) {
      // Match @file or #file patterns
      const before = context.matchBefore(
        /@[a-zA-Z0-9_/.-]*|#file:[a-zA-Z0-9_/.-]*/
      );

      if (!before) return null;

      const trigger = before.text[0]; // @ or #
      const from = before.from;

      // Request completions from extension host
      return new Promise((resolve) => {
        this.pendingCompletionResolve = resolve;

        const vscode = window.vscode || window.acquireVsCodeApi();
        vscode.postMessage({
          type: "requestCompletions",
          trigger: trigger,
          prefix: before.text,
          position: from,
        });
      });
    }

    // Handle completion response from extension
    handleCompletionResponse(items, from) {
      if (!this.pendingCompletionResolve) return;

      const completions = items.map((item) => ({
        label: item.label,
        type: item.kind || "text",
        apply: item.insertText || item.label,
        detail: item.detail,
        info: item.documentation,
      }));

      this.pendingCompletionResolve({
        from: from,
        options: completions,
      });

      this.pendingCompletionResolve = null;
    }

    // Decorate #file: links
    linkDecorationExtension() {
      const { ViewPlugin, Decoration } = CM;

      const linkPlugin = ViewPlugin.fromClass(
        class {
          decorations;

          constructor(view) {
            this.decorations = this.buildDecorations(view);
          }

          update(update) {
            if (update.docChanged || update.viewportChanged) {
              this.decorations = this.buildDecorations(update.view);
            }
          }

          buildDecorations(view) {
            const builder = new CM.RangeSetBuilder();
            const regex = /#file:([a-zA-Z0-9_/.-]+)(?::(\d+)(?:-(\d+))?)?/g;

            for (let { from, to } of view.visibleRanges) {
              const text = view.state.doc.sliceString(from, to);
              let match;

              while ((match = regex.exec(text)) !== null) {
                const matchFrom = from + match.index;
                const matchTo = matchFrom + match[0].length;

                builder.add(
                  matchFrom,
                  matchTo,
                  Decoration.mark({
                    class: "cm-link",
                    attributes: {
                      "data-path": match[1],
                      "data-line-start": match[2] || "",
                      "data-line-end": match[3] || "",
                    },
                  })
                );
              }
            }

            return builder.finish();
          }
        },
        {
          decorations: (v) => v.decorations,
        }
      );

      return linkPlugin;
    }

    // Handle Ctrl+Click on links
    clickHandlerExtension() {
      const { EditorView } = CM;

      return EditorView.domEventHandlers({
        click: (event, view) => {
          if (!(event.ctrlKey || event.metaKey)) return false;

          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos === null) return false;

          // Check if we clicked on a link decoration
          const target = event.target;
          if (target.classList.contains("cm-link")) {
            const path = target.getAttribute("data-path");
            const lineStart = target.getAttribute("data-line-start");
            const lineEnd = target.getAttribute("data-line-end");

            const vscode = window.vscode || window.acquireVsCodeApi();
            vscode.postMessage({
              type: "openFile",
              path: path,
              lineStart: lineStart ? parseInt(lineStart) : undefined,
              lineEnd: lineEnd ? parseInt(lineEnd) : undefined,
            });

            event.preventDefault();
            return true;
          }

          return false;
        },
      });
    }

    // Update listener for change notifications
    updateListenerExtension() {
      const { EditorView } = CM;

      return EditorView.updateListener.of((update) => {
        if (update.docChanged && this.onChangeCallback) {
          this.onChangeCallback(this.getText());
        }
      });
    }

    // Custom keybindings
    keymapExtension() {
      const { keymap } = CM;
      const { defaultKeymap } = CM;

      return keymap.of([
        ...defaultKeymap,
        // Add custom keybindings here if needed
        // { key: "Ctrl-Enter", run: () => { /* trigger run */ return true; } }
      ]);
    }

    // Public API
    getText() {
      return this.view ? this.view.state.doc.toString() : "";
    }

    setText(text) {
      if (!this.view) return;

      const { EditorView } = CM;
      this.view.dispatch({
        changes: {
          from: 0,
          to: this.view.state.doc.length,
          insert: text,
        },
      });
    }

    clear() {
      this.setText("");
    }

    focus() {
      if (this.view) {
        this.view.focus();
      }
    }

    onChange(callback) {
      this.onChangeCallback = callback;
    }

    destroy() {
      if (this.view) {
        this.view.destroy();
        this.view = null;
      }
    }
  }

  // Export to global scope
  window.CodeMirrorPromptEditor = CodeMirrorPromptEditor;
})();
