# Prompt Editor Replacement: CodeMirror vs Monaco Recommendation

**Date:** January 2, 2026  
**Status:** Recommendation for replacing contenteditable-based prompt editor  
**Author:** Research based on industry analysis and FlightPath requirements

## Executive Summary

The current contenteditable-based prompt editor implementation has proven problematic with:

- **Cursor jumping** during spell-check operations
- **Blank line collapse** when manipulating HTML structure
- **Complex cursor position restoration** requiring extensive offset calculations and DOM walking
- **Zero-width space workarounds** to maintain blank lines
- **Fragile synchronization** between text extraction and HTML generation

**Recommendation:** Replace with **CodeMirror 6** for the following reasons:

1. Purpose-built for text editing with predictable behavior
2. Smaller bundle size (300KB core vs 5-10MB Monaco)
3. Native spell checking support via browser or WASM
4. Extensible autocomplete system ready for custom completions
5. Mobile-friendly and accessible
6. Better suited for VS Code webview CSP restrictions

## Problem Analysis: Current contenteditable Implementation

### Issues Observed

From git diff analysis and `WHITESPACE_BUG_FIX.md`:

1. **Whitespace Handling**
   - HTML escaping collapses multiple spaces and newlines
   - Required custom `escapeHTMLLine()` to preserve spacing
   - BR vs DIV element confusion for line breaks
   - Zero-width spaces (`&#8203;`) used to maintain blank lines

2. **Cursor Position Management**
   - Complex offset calculation with `getTextWithNewlines()` and `getTextWithNewlinesFrom()`
   - Multi-level DOM traversal to map text offsets to DOM positions
   - DIV transition tracking with `previousDivIndex` logic
   - Raw text offset vs clean text offset mismatches
   - Extensive logging required to debug cursor restoration (300+ lines added)

3. **Spell Check Integration**
   - Rebuilding entire HTML structure on every spell check
   - Cursor position save/restore cycle after each rebuild
   - Risk of cursor jumping when spell check runs during typing
   - Manual misspelled word tracking with `Set<string>`

4. **Architecture Complexity**
   - 843 lines of JavaScript just for basic editor functionality
   - Multiple helper functions for DOM manipulation
   - Fragile state management with `isUpdatingHighlights` flag
   - No built-in support for future features (completions, links)

### Root Cause

**contenteditable was never designed for programmatic manipulation.** It's intended for simple WYSIWYG editing, not code/text editors where:

- Content structure changes frequently (spell check highlighting)
- Cursor position must be preserved precisely
- Multi-line text with whitespace significance is common
- Programmatic updates happen during user input

## Editor Comparison: CodeMirror 6 vs Monaco Editor

### Bundle Size

| Editor            | Core Size | With Features                  | Impact on Extension |
| ----------------- | --------- | ------------------------------ | ------------------- |
| **CodeMirror 6**  | ~300KB    | ~500KB with spell/autocomplete | ✅ Minimal (+0.5MB) |
| **Monaco Editor** | 5-10MB    | 5-10MB (all-inclusive)         | ⚠️ Large (+5-10MB)  |

**Winner:** CodeMirror 6 (17-33x smaller)

### Architecture

| Aspect               | CodeMirror 6                     | Monaco Editor                     |
| -------------------- | -------------------------------- | --------------------------------- |
| **State Model**      | Immutable state, functional core | Mutable model, imperative         |
| **Extension System** | Facet-based, composable          | VS Code-aligned, global config    |
| **Modularity**       | Highly modular, tree-shakeable   | Monolithic with language services |
| **Configuration**    | Per-instance, isolated           | Shared global state               |

**Winner:** CodeMirror 6 (better modularity, multi-instance support)

### Feature Comparison

| Feature                 | CodeMirror 6                  | Monaco Editor            | FlightPath Needs                  |
| ----------------------- | ----------------------------- | ------------------------ | --------------------------------- |
| **Spell Checking**      | Browser native or WASM plugin | ❌ Not built-in          | ✅ Required                       |
| **Autocomplete**        | Built-in, extensible          | Built-in, comprehensive  | ✅ Required (@file, #file)        |
| **Syntax Highlighting** | Lezer parser system           | TextMate grammars        | ⚠️ Nice-to-have                   |
| **Mobile Support**      | ✅ First-class                | ⚠️ Limited               | ✅ Important                      |
| **Accessibility**       | ✅ Screen reader support      | ✅ Screen reader support | ✅ Required                       |
| **Link Detection**      | Custom decorations            | Built-in                 | ✅ Required (#file:path:line)     |
| **Theming**             | CSS variables                 | VS Code theme format     | ✅ Required (VS Code theme match) |
| **Multi-line Editing**  | ✅ Native support             | ✅ Native support        | ✅ Required                       |

**Winner:** CodeMirror 6 (better spell checking, mobile support)

### VS Code Webview Compatibility

#### Content Security Policy (CSP)

**CodeMirror 6:**

- ✅ Works with strict CSP (`script-src 'self'`)
- ✅ No inline styles required
- ✅ All styling via external CSS
- ✅ No eval() or dynamic code generation

**Monaco Editor:**

- ⚠️ Requires `style-src 'unsafe-inline'` for inline styles ([GitHub Issue #4927](https://github.com/microsoft/monaco-editor/issues/4927))
- ⚠️ Uses web workers (need `worker-src` CSP directive)
- ⚠️ Complex loader setup for webviews
- ⚠️ Not officially designed for webview embedding

**Winner:** CodeMirror 6 (no CSP violations)

#### Loading in Webviews

**CodeMirror 6:**

```javascript
// Simple script loading via webview URI
<script src="{{codemirrorUri}}"></script>
<script>
  const editor = new EditorView({
    doc: "Initial text",
    extensions: [/* ... */],
    parent: document.getElementById('editor')
  });
</script>
```

**Monaco Editor:**

```javascript
// Complex AMD loader setup
require.config({ paths: { vs: "{{monacoUri}}" } });
require(["vs/editor/editor.main"], function () {
  monaco.editor.create(container, {
    /* ... */
  });
});
// Requires careful path management and CSP tuning
```

**Winner:** CodeMirror 6 (simpler integration)

### Development Experience

**CodeMirror 6:**

- ✅ Excellent documentation with examples
- ✅ Active community forum (discuss.codemirror.net)
- ✅ Modern ES6 modules
- ✅ TypeScript definitions included
- ✅ Gradual learning curve (start simple, add features)

**Monaco Editor:**

- ✅ Familiar to VS Code extension developers
- ✅ TypeScript-first
- ⚠️ Complex setup for webviews
- ⚠️ Heavy documentation (VS Code oriented)
- ⚠️ Steep learning curve for basic usage

**Winner:** CodeMirror 6 (easier to start, better docs)

### Performance

| Scenario            | CodeMirror 6                   | Monaco Editor                    |
| ------------------- | ------------------------------ | -------------------------------- |
| **Initial Load**    | Fast (~100ms)                  | Slow (~500ms+ with workers)      |
| **Large Documents** | Excellent (viewport rendering) | Excellent (tokenization caching) |
| **Typing Latency**  | Low (<16ms)                    | Low (<16ms)                      |
| **Memory Usage**    | Low (minimal overhead)         | High (language services)         |

**Winner:** Tie (both perform well for FlightPath use case)

## CodeMirror 6: Detailed Implementation Plan

### 1. Core Editor Setup

**Package Installation:**

```bash
npm install @codemirror/state @codemirror/view @codemirror/commands @codemirror/language
```

**Basic Integration (dashboard.html):**

```html
<!-- Load CodeMirror core -->
<script src="{{codemirrorCoreUri}}"></script>
<script src="{{codemirrorViewUri}}"></script>
<script src="{{codemirrorStateUri}}"></script>
<script src="{{codemirrorCommandsUri}}"></script>

<div id="prompt-editor"></div>

<script>
  const { EditorView, keymap, basicSetup } = CM;

  const editor = new EditorView({
    doc: "",
    extensions: [
      basicSetup, // Line numbers, undo/redo, search, etc.
      keymap.of([
        /* custom keybindings */
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          // Notify extension of changes
          vscode.postMessage({
            type: "promptChanged",
            text: editor.state.doc.toString(),
          });
        }
      }),
    ],
    parent: document.getElementById("prompt-editor"),
  });
</script>
```

**Estimated Effort:** 1 day

### 2. Spell Checking

**Option A: Browser Native (Recommended)**

```javascript
import { EditorView } from "@codemirror/view";

const spellcheck = EditorView.contentAttributes.of({
  spellcheck: "true",
});

const editor = new EditorView({
  extensions: [basicSetup, spellcheck],
});
```

- ✅ Free, works immediately
- ✅ Respects OS/browser dictionaries
- ⚠️ Limited to system languages

**Option B: WASM Plugin (Advanced)**

```javascript
import { linter } from "@codemirror/lint";
import { spellchecker } from "spellchecker-wasm"; // Example package

const spellCheckLinter = linter(async (view) => {
  const text = view.state.doc.toString();
  const checker = await spellchecker.load("en-US");
  const diagnostics = [];

  // Check words and create diagnostics
  // Return array of { from, to, severity: "error", message: "..." }

  return diagnostics;
});

const editor = new EditorView({
  extensions: [basicSetup, spellCheckLinter],
});
```

- ✅ Full control over dictionary
- ✅ Custom word suggestions
- ⚠️ Requires WASM file loading
- ⚠️ More complex setup

**Recommendation:** Start with Option A (browser native), add Option B if needed.

**Estimated Effort:**

- Browser native: 1 hour
- WASM plugin: 1-2 days

### 3. Autocomplete for @file and #file

**Architecture:**

```
User types @ or #
    ↓
CodeMirror autocomplete extension detects trigger
    ↓
postMessage to extension host: requestCompletions
    ↓
Extension reuses PromptCompletionProvider logic
    ↓
Returns: [{ label: "src/extension.ts", type: "file" }, ...]
    ↓
CodeMirror shows completion dropdown
    ↓
User selects → insert into document
```

**Implementation:**

```javascript
import { autocompletion } from "@codemirror/autocomplete";

function customCompletions(context) {
  const word = context.matchBefore(/@[a-zA-Z0-9_/.-]*|#[a-zA-Z0-9_/:-]*/);

  if (!word) return null;

  const trigger = word.text[0]; // @ or #

  // Request completions from extension
  return new Promise((resolve) => {
    // Store resolve callback
    window.pendingCompletionResolve = resolve;

    vscode.postMessage({
      type: "requestCompletions",
      trigger: trigger,
      position: context.pos,
    });
  });
}

// Extension host responds via postMessage
window.addEventListener("message", (event) => {
  if (event.data.type === "completionsResponse") {
    const completions = event.data.items.map((item) => ({
      label: item.label,
      type: item.kind,
      apply: item.insertText,
    }));

    if (window.pendingCompletionResolve) {
      window.pendingCompletionResolve({
        from: event.data.from,
        options: completions,
      });
      window.pendingCompletionResolve = null;
    }
  }
});

const editor = new EditorView({
  extensions: [basicSetup, autocompletion({ override: [customCompletions] })],
});
```

**Extension Host (FlightPathDashboardProvider.ts):**

```typescript
private handleCompletionRequest(trigger: string, position: number): void {
  // Reuse existing logic from PromptCompletionProvider
  const items = this.getCompletionItems(trigger);

  this.postMessage({
    type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
    items: items.map(item => ({
      label: item.label,
      kind: item.kind,
      insertText: item.insertText
    })),
    from: position - trigger.length
  });
}
```

**Estimated Effort:** 2-3 days

### 4. Link Detection and Click Handling

**Implementation:**

```javascript
import { Decoration, ViewPlugin } from "@codemirror/view";

const linkPlugin = ViewPlugin.fromClass(class {
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
    const decorations = [];
    const regex = /#file:([a-zA-Z0-9_/.-]+)(?::(\d+)(?:-(\d+))?)?/g;

    for (let { from, to } of view.visibleRanges) {
      const text = view.state.doc.sliceString(from, to);
      let match;

      while ((match = regex.exec(text)) !== null) {
        decorations.push(
          Decoration.mark({
            class: "cm-link",
            attributes: {
              "data-path": match[1],
              "data-line-start": match[2],
              "data-line-end": match[3]
            }
          }).range(from + match.index, from + match.index + match[0].length)
        );
      }
    }

    return Decoration.set(decorations);
  }
});

// Click handler
EditorView.domEventHandlers({
  click: (event, view) => {
    if (event.ctrlKey || event.metaKey) {
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      const decorations = view.state.field(linkPlugin);

      // Find decoration at position and extract data attributes
      // Send message to extension to open file
      vscode.postMessage({
        type: 'openFile',
        path: /* extracted from decoration */,
        lineStart: /* ... */,
        lineEnd: /* ... */
      });
    }
  }
});
```

**Estimated Effort:** 1-2 days

### 5. Theme Integration

**Match VS Code Theme:**

```javascript
import { EditorView } from "@codemirror/view";

const vsCodeTheme = EditorView.theme({
  "&": {
    color: "var(--vscode-editor-foreground)",
    backgroundColor: "var(--vscode-editor-background)",
  },
  ".cm-content": {
    caretColor: "var(--vscode-editorCursor-foreground)",
    fontFamily: "var(--vscode-editor-font-family)",
    fontSize: "var(--vscode-editor-font-size)",
  },
  ".cm-line": {
    padding: "0 2px 0 4px",
  },
  ".cm-selectionBackground": {
    backgroundColor: "var(--vscode-editor-selectionBackground)",
  },
  ".cm-link": {
    color: "var(--vscode-textLink-foreground)",
    textDecoration: "underline",
    cursor: "pointer",
  },
  // ... more theme mappings
});

const editor = new EditorView({
  extensions: [basicSetup, vsCodeTheme],
});
```

**Estimated Effort:** 1 day

### 6. Build Configuration

**esbuild.js updates:**

```javascript
// Copy CodeMirror modules to out/ui/webview/lib/codemirror/
const copyCodeMirrorPlugin = {
  name: "copy-codemirror",
  setup(build) {
    build.onEnd(() => {
      const cmModules = [
        "node_modules/@codemirror/state/dist/index.js",
        "node_modules/@codemirror/view/dist/index.js",
        "node_modules/@codemirror/commands/dist/index.js",
        "node_modules/@codemirror/language/dist/index.js",
        "node_modules/@codemirror/autocomplete/dist/index.js",
        "node_modules/@codemirror/lint/dist/index.js",
      ];

      cmModules.forEach((src) => {
        const dest = src.replace("node_modules/", "out/ui/webview/lib/");
        fs.copyFileSync(src, dest);
      });
    });
  },
};

// Add to plugins array
plugins: [copyWebviewPlugin, copyCodeMirrorPlugin];
```

**Estimated Effort:** 0.5 days

## Migration Plan

### Phase 1: Proof of Concept (2 days)

- [ ] Install CodeMirror packages
- [ ] Create minimal editor in dashboard
- [ ] Test basic editing, undo/redo
- [ ] Verify CSP compatibility
- [ ] Validate bundle size impact

### Phase 2: Feature Parity (5-7 days)

- [ ] Implement browser native spell checking
- [ ] Add autocomplete for @file references
- [ ] Add autocomplete for #file:path references
- [ ] Implement link detection and click handling
- [ ] Match VS Code theme styling
- [ ] Migrate existing editor UI controls (Run, Append, etc.)

### Phase 3: Polish (2-3 days)

- [ ] Add keyboard shortcuts (Ctrl+Enter to run, etc.)
- [ ] Implement character/word count
- [ ] Add placeholder text styling
- [ ] Test accessibility (screen readers, keyboard nav)
- [ ] Mobile testing and optimization
- [ ] Performance testing with large prompts

### Phase 4: Cleanup (1 day)

- [ ] Remove old prompt-editor.js (843 lines removed!)
- [ ] Remove Typo.js dependency
- [ ] Remove .aff/.dic dictionary files
- [ ] Update dashboard.html to remove old editor references
- [ ] Update documentation

**Total Estimated Effort:** 10-13 days

## Why Not Monaco Editor?

Despite being "the editor of VS Code," Monaco is **not recommended** for FlightPath:

### 1. Bundle Size Impact

- **Monaco:** +5-10MB to extension VSIX
- **CodeMirror:** +0.5MB to extension VSIX
- **Difference:** 10-20x larger bundle

### 2. CSP Violations

- Monaco uses inline styles (`style-src 'unsafe-inline'` required)
- VS Code webviews should avoid `unsafe-inline` for security
- [Open issue since June 2025](https://github.com/microsoft/monaco-editor/issues/4927)

### 3. Over-Engineering for Use Case

- FlightPath needs: multi-line text editing, spell check, simple completions
- Monaco provides: Full TypeScript language server, debugging, IntelliSense, minimap, etc.
- 90% of Monaco's features would go unused

### 4. Mobile Support

- Monaco explicitly states: **"not supported in mobile browsers"**
- CodeMirror has first-class mobile support
- FlightPath dashboard should be mobile-friendly

### 5. Webview Integration Complexity

- Monaco requires AMD loader configuration
- Complex path resolution for VS Code context
- CodeMirror works with simple script tag

## Conclusion

**Switch to CodeMirror 6** for the prompt editor replacement.

**Key Benefits:**

1. ✅ **Solves current issues:** No more cursor jumping, blank line collapse, or complex offset calculations
2. ✅ **Small bundle size:** 300KB core vs 5-10MB Monaco (17-33x smaller)
3. ✅ **Built-in features:** Spell checking (browser native), autocomplete, theming
4. ✅ **Better for webviews:** No CSP violations, simple integration
5. ✅ **Mobile-friendly:** First-class touch support
6. ✅ **Extensible:** Easy to add custom features (completions, links)
7. ✅ **Industry proven:** Used by Replit, Sourcegraph, CodePen, Overleaf

**Monaco would be overkill** for FlightPath's needs and introduces unnecessary complexity, bundle bloat, and CSP issues.

**Estimated Timeline:** 10-13 days for full implementation with feature parity and polish.

## References

- [CodeMirror 6 Official Site](https://codemirror.net/)
- [CodeMirror 6 Examples](https://codemirror.net/examples/)
- [CodeMirror Autocomplete Guide](https://codemirror.net/examples/autocompletion/)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
- [Monaco CSP Issue #4927](https://github.com/microsoft/monaco-editor/issues/4927)
- [CodeMirror vs Monaco Comparison](https://agenthicks.com/research/codemirror-vs-monaco-editor-comparison)
- [IN_PANEL_PROMPT_EDITOR.md](./IN_PANEL_PROMPT_EDITOR.md) - Original research
- [WEBVIEW_CUSTOM_COMPLETIONS.md](./WEBVIEW_CUSTOM_COMPLETIONS.md) - Custom completions design
