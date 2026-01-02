# VS Code Native Editor Widgets Research

## Objective

Investigate how VS Code implements native text editor widgets that support completions, spell check, and links in non-webview contexts, specifically:

1. **Source Control commit message input** - Has spell check support
2. **Copilot Chat input box** - Has completions and links
3. **Extension API** - Can we use similar patterns in FlightPath?

## Goal

Determine if FlightPath can use a native VS Code text editor widget instead of a webview textarea, which would give us:

- ✅ Completions from PromptCompletionProvider (@ and # triggers)
- ✅ Links from PromptLinkProvider (Ctrl+Click navigation)
- ✅ Spell check from Code Spell Checker
- ✅ All other VS Code editor features

## Repository

**URL:** https://github.com/microsoft/vscode

**Structure:**

```
vscode/
├── src/
│   ├── vs/
│   │   ├── workbench/
│   │   │   ├── contrib/
│   │   │   │   ├── scm/              # Source Control Management
│   │   │   │   ├── chat/             # Chat features (if available)
│   │   │   │   └── ...
│   │   │   ├── api/                  # Extension API
│   │   │   └── browser/              # Webview components
│   │   └── platform/
│   └── vscode.d.ts                   # TypeScript definitions for Extension API
└── extensions/
    └── git/                          # Git extension (uses SCM)
```

## Research Questions

### 1. Source Control Commit Message Input

**Location:** `src/vs/workbench/contrib/scm/`

**Questions:**

- [ ] What class/component implements the commit message input box?
- [ ] Is it a native editor widget or a custom HTML element?
- [ ] How does spell check integration work?
- [ ] What API is used to create the input?
- [ ] Can extensions access this same API?

**Files to examine:**

- `src/vs/workbench/contrib/scm/browser/scmEditor.ts`
- `src/vs/workbench/contrib/scm/browser/scmViewPane.ts`
- `src/vs/workbench/contrib/scm/browser/scmRepositoryRenderer.ts`
- `src/vs/workbench/contrib/scm/common/scmService.ts`

**Search terms:**

- `class SCMEditor`
- `commit message`
- `input box`
- `ICodeEditor`
- `createEditor`

### 2. Copilot Chat Input Box

**Location:** `src/vs/workbench/contrib/chat/` (may vary based on VS Code version)

**Questions:**

- [ ] What component is used for the chat input?
- [ ] How are completions triggered in the input box?
- [ ] Is it a webview or native component?
- [ ] What API enables @ mentions and completions?
- [ ] Can extensions create similar chat-like inputs?

**Files to examine:**

- `src/vs/workbench/contrib/chat/browser/chatWidget.ts`
- `src/vs/workbench/contrib/chat/browser/chatInputPart.ts`
- `src/vs/workbench/contrib/chat/browser/actions/chatActions.ts`

**Search terms:**

- `ChatWidget`
- `ChatInputPart`
- `chat input`
- `@mention`
- `completion provider`

### 3. VS Code Editor Widget API

**Location:** `src/vs/editor/` and `src/vscode.d.ts`

**Questions:**

- [ ] What is `ICodeEditor` vs `IStandaloneCodeEditor`?
- [ ] Can extensions create standalone editor instances?
- [ ] What's the difference between `TextEditor` and custom editor widgets?
- [ ] Is there a "lightweight editor" API for input boxes?
- [ ] Can webviews embed native editor widgets?

**Files to examine:**

- `src/vs/editor/editor.api.ts`
- `src/vs/editor/standalone/browser/standaloneEditor.ts`
- `src/vs/platform/editor/common/editor.ts`
- `src/vscode.d.ts` (Extension API definitions)

**Search terms:**

- `IStandaloneCodeEditor`
- `ICodeEditor`
- `createEditor`
- `MonacoEditor`
- `editor widget`

### 4. Custom Views and Webview Integration

**Location:** `src/vs/workbench/api/` and `src/vs/workbench/contrib/webview/`

**Questions:**

- [ ] Can `TreeView` or `WebviewView` contain native editor widgets?
- [ ] What's the limitation of webviews regarding native components?
- [ ] Are there hybrid approaches (native header + webview content)?
- [ ] Can we use `vscode.window.createInputBox()` with editor features?

**Files to examine:**

- `src/vs/workbench/api/browser/mainThreadWebviewViews.ts`
- `src/vs/workbench/api/common/extHostWebviewView.ts`
- `src/vs/workbench/contrib/webviewView/browser/webviewViewPane.ts`
- `src/vs/workbench/api/common/extHostQuickOpen.ts` (for InputBox)

**Search terms:**

- `WebviewViewProvider`
- `WebviewView`
- `InputBox`
- `QuickInput`
- `native widget`

## Extension API Investigation

### Current Extension APIs to Check

**From `vscode.d.ts`:**

1. **Window API:**

   ```typescript
   // Can we use these with editor features?
   vscode.window.createInputBox();
   vscode.window.createQuickPick();
   vscode.window.showInputBox();
   ```

2. **Webview API:**

   ```typescript
   // Can webviews contain native widgets?
   vscode.window.createWebviewPanel();
   vscode.window.registerWebviewViewProvider();
   ```

3. **Text Editor API:**

   ```typescript
   // Can we create standalone editors?
   vscode.window.showTextDocument();
   vscode.workspace.openTextDocument();
   ```

4. **Custom Editors:**
   ```typescript
   // Custom editor providers
   vscode.window.registerCustomEditorProvider();
   ```

**Questions:**

- [ ] Is there an API to create a native editor widget in a custom view?
- [ ] Can InputBox support completions and spell check?
- [ ] Are there undocumented/proposed APIs we could use?

## Key Code Patterns to Look For

### Pattern 1: Native Editor Creation

```typescript
// Example of what we're looking for
const editor = createCodeEditor(container, {
  lineNumbers: 'off',
  minimap: { enabled: false },
  // ... other options
});

// Register completion provider
editor.getModel().onDidChangeContent(...);
```

### Pattern 2: Webview with Native Header

```typescript
// Hybrid approach: native controls + webview content
class CustomView {
  constructor() {
    this.headerEditor = createNativeEditor(); // Native widget
    this.contentWebview = createWebview(); // Webview for complex UI
  }
}
```

### Pattern 3: TextDocument-based Input

```typescript
// Using virtual documents (our current approach)
const doc = await vscode.workspace.openTextDocument({
  content: "",
  language: "markdown",
});

const editor = await vscode.window.showTextDocument(doc);
```

## Search Strategy

### Phase 1: GitHub Code Search

Use GitHub's code search to find key implementations:

1. **Search for SCM input:**

   ```
   repo:microsoft/vscode "scm" "input" "editor" path:src/vs/workbench/contrib/scm/
   ```

2. **Search for chat input:**

   ```
   repo:microsoft/vscode "chat" "input" "completion" path:src/vs/workbench/contrib/chat/
   ```

3. **Search for standalone editor:**
   ```
   repo:microsoft/vscode "createCodeEditor" OR "IStandaloneCodeEditor"
   ```

### Phase 2: Clone and Local Search

If GitHub search is insufficient:

```bash
git clone https://github.com/microsoft/vscode.git
cd vscode

# Search for SCM input implementation
rg "class.*Input" src/vs/workbench/contrib/scm/

# Search for chat widget
rg "class.*ChatInput" src/vs/workbench/contrib/chat/

# Search for editor creation
rg "createCodeEditor|createEditor" src/vs/editor/
```

### Phase 3: VS Code Extension Samples

Check official extension samples:

- https://github.com/microsoft/vscode-extension-samples

Look for:

- Custom editor samples
- Webview view samples
- Input/completion samples

## Expected Findings

### Hypothesis 1: SCM uses native `ICodeEditor`

**If true:**

- SCM input is a full-fledged editor widget
- Spell check works because it's a real `TextDocument`
- Completions work through standard provider registration
- **Implication:** We could use the same approach if API is exposed

### Hypothesis 2: Chat uses custom input with completion API

**If true:**

- Chat input might be a specialized widget
- @ mentions use a custom completion provider
- May not be exposed in Extension API
- **Implication:** We might need to use virtual document approach

### Hypothesis 3: Webviews cannot embed native widgets

**If true:**

- Webviews are sandboxed (iframe-like)
- Cannot directly contain native VS Code UI components
- Must use HTML elements only
- **Implication:** We need virtual document or full dashboard rewrite

## Success Criteria

Research is complete when we can answer:

1. ✅ **Can extensions create native editor widgets in custom views?**
   - If YES: How? What API? Sample code?
   - If NO: What are the limitations?

2. ✅ **How does SCM commit input achieve spell check?**
   - Is it a special case or standard API?
   - Can we replicate it?

3. ✅ **Can webviews contain native editor components?**
   - If YES: How to integrate?
   - If NO: Is there a hybrid approach?

4. ✅ **What's the best approach for FlightPath?**
   - Use findings to update implementation plan
   - Decide: Virtual document, native widget, or dashboard rewrite

## Next Steps

After research:

1. Update `IN_PANEL_PROMPT_EDITOR.md` with findings
2. If native widget API exists: Create POC implementation
3. If not possible: Refine virtual document approach
4. Document decision rationale in `ARCHITECTURE.md`

## References

- **VS Code Repository:** https://github.com/microsoft/vscode
- **VS Code API Docs:** https://code.visualstudio.com/api
- **Extension Samples:** https://github.com/microsoft/vscode-extension-samples
- **VS Code Architecture:** https://github.com/microsoft/vscode/wiki/Source-Code-Organization

## Research Notes

### Finding 1: SCM Commit Message Input - Native CodeEditorWidget

- **Date:** 2026-01-01
- **Source:** `src/vs/workbench/contrib/scm/browser/scmViewPane.ts#L1884-1949`
- **Key insight:** SCM uses a **full CodeEditorWidget** instance, not a custom HTML element
- **Implementation:**
  ```typescript
  class SCMInputWidget {
    private readonly inputEditor: CodeEditorWidget;

    constructor(...) {
      // Creates a real VS Code editor widget
      this.inputEditor = instantiationService.createInstance(
        CodeEditorWidget,
        this.editorContainer,
        editorConstructionOptions,
        codeEditorWidgetOptions
      );

      // Enables standard editor contributions
      codeEditorWidgetOptions.contributions = EditorExtensionsRegistry.getSomeEditorContributions([
        CodeActionController.ID,
        SuggestController.ID,
        LinkDetector.ID,
        // ... etc
      ]);
    }
  }
  ```
- **Why it works:** Uses a real `TextModel` with language ID `'scminput'`, so all providers (completion, diagnostics, links) work natively
- **Model registration:** `src/vs/workbench/contrib/scm/browser/scm.contribution.ts#L53-56`
  ```typescript
  ModesRegistry.registerLanguage({
    id: "scminput",
    extensions: [],
    mimetypes: ["text/x-scm-input"],
  });
  ```

### Finding 2: Chat Input - Also Uses CodeEditorWidget

- **Date:** 2026-01-01
- **Source:** `src/vs/workbench/contrib/chat/browser/widget/input/chatInputPart.ts#L1531-1549`
- **Key insight:** Copilot Chat input uses **CodeEditorWidget** with custom language `'chatinput'`
- **Implementation:**
  ```typescript
  export class ChatInputPart {
    private _inputEditor: CodeEditorWidget;

    render(...) {
      const editorOptions = getSimpleCodeEditorWidgetOptions();
      editorOptions.contributions?.push(...EditorExtensionsRegistry.getSomeEditorContributions([
        ContentHoverController.ID,
        SuggestController.ID,
        LinkDetector.ID,
        // ... etc
      ]));

      this._inputEditor = scopedInstantiationService.createInstance(
        CodeEditorWidget,
        this._inputEditorElement,
        options,
        editorOptions
      );
    }
  }
  ```
- **Model creation:** Uses `Schemas.vscodeChatInput` URI scheme with `'chatinput'` language
- **Completion registration:**
  ```typescript
  // src/vs/workbench/contrib/chat/browser/widget/input/editor/chatInputCompletions.ts
  languageFeaturesService.completionProvider.register(
    { scheme: Schemas.vscodeChatInput, hasAccessToAllModels: true },
    {
      triggerCharacters: ["@", "#", "/"],
      provideCompletionItems: async (model, position, context, token) => {
        // Custom completion logic for @mentions, #variables, /commands
      },
    }
  );
  ```

### Finding 3: Webviews CANNOT Contain Native Widgets

- **Date:** 2026-01-01
- **Source:** `src/vs/workbench/contrib/webview/browser/webviewElement.ts#L149-166`
- **Key insight:** Webviews are **sandboxed iframe-based** and cannot embed native VS Code UI components
- **Why:** Webviews use `webviewExternalEndpoint` (separate origin) for security
  ```typescript
  export class WebviewElement {
    protected webviewContentEndpoint(encodedWebviewOrigin: string): string {
      // Returns external endpoint like: vscode-webview://{{uuid}}
      return webviewExternalEndpoint.replace("{{uuid}}", encodedWebviewOrigin);
    }
  }
  ```
- **Implication:** FlightPath's dashboard webview **cannot** embed a native CodeEditorWidget
- **Extension API limitation:** `vscode.window.registerWebviewViewProvider` only allows HTML content, not native widgets

### Finding 4: No Hybrid API for Webview + Native Widgets

- **Date:** 2026-01-01
- **Source:** `src/vs/workbench/api/browser/mainThreadWebviewViews.ts#L75-95`
- **Key insight:** Extension API does NOT expose a way to create native editor widgets in custom views
- **What's available:**
  - `vscode.window.createInputBox()` - Simple text input (no editor features)
  - `vscode.window.showTextDocument()` - Opens in editor pane (not in custom view)
  - `vscode.window.registerWebviewViewProvider()` - HTML-only webview
  - `vscode.window.registerCustomEditorProvider()` - For file editing, not arbitrary UI
- **No API for:** Creating a CodeEditorWidget inside a webview or custom view panel

### Finding 5: Virtual Document Approach is Industry Standard

- **Date:** 2026-01-01
- **Source:** Git extension (`extensions/git/src/gitEditor.ts#L36-59`)
- **Key insight:** Git extension uses virtual documents for commit message editing
- **Implementation:**
  ```typescript
  async handle({ commitMessagePath }: GitEditorRequest): Promise<boolean> {
    if (commitMessagePath) {
      const uri = Uri.file(commitMessagePath);
      const doc = await workspace.openTextDocument(uri);
      await window.showTextDocument(doc, { preview: false });

      return new Promise((c) => {
        const onDidClose = window.tabGroups.onDidChangeTabs(async (tabs) => {
          if (tabs.closed.some(t => t.input.uri.toString() === uri.toString())) {
            onDidClose.dispose();
            return c(true);
          }
        });
      });
    }
  }
  ```
- **Pattern:** Open virtual document → Get native editor features → Sync on close
- **Used by:** Git commits, SCM providers, interactive rebases, etc.

## Conclusion

**Can extensions create native editor widgets in custom views?**

- ❌ **NO** - Extension API does not expose this capability
- ✅ **YES (internal only)** - VS Code's own code can use `CodeEditorWidget`, but extensions cannot

**How does SCM commit input achieve spell check?**

- Uses **CodeEditorWidget** with a real `TextModel`
- Registers custom language ID (`'scminput'`)
- All editor features (spell check, completions, diagnostics) work automatically

**Can webviews contain native editor components?**

- ❌ **NO** - Webviews are iframe-based and sandboxed from native VS Code UI

**What's the best approach for FlightPath?**

1. **Recommended:** Virtual Document Approach (Option 1 from IN_PANEL_PROMPT_EDITOR.md)
   - Create `untitled:` document with `languageId: 'flightpath-prompt'`
   - Open in background editor column (viewColumn 3+, preserveFocus)
   - Sync changes bidirectionally with dashboard
   - All existing providers work automatically
   - Spell check works natively

2. **Alternative:** Hybrid Approach (Option 4)
   - Simple textarea in dashboard
   - "Edit in VS Code" button opens virtual document
   - Simpler but requires context switching

3. **Not Recommended:** Monaco Editor in webview
   - Would require reimplementing all providers
   - No spell check integration
   - Large bundle size (~5MB)

**Next steps for FlightPath:**

1. Implement virtual document approach in `FlightPathDashboardProvider`
2. Register `'flightpath-prompt'` language ID
3. Ensure `PromptCompletionProvider` and `PromptLinkProvider` activate for this language
4. Add bidirectional sync between webview and virtual document
