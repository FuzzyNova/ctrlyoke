# FlightPath Prompt Editor UI - Design Brainstorming

**Status**: 🎨 Design Phase - Brainstorming Options  
**Last Updated**: November 5, 2025  
**Author**: Nathan

---

## 🎯 Goals

Create a dedicated prompt editor that provides:

1. **Context-aware text editing** with Copilot Chat-like features:
   - `#` triggers file picker (like `#file:path/to/file.ts`)
   - `#selection` transforms into currently selected code
   - Support for line ranges (`#file:path:45-120`)
   - `@workspace` for workspace-wide context

2. **Spell checking integration**:
   - Leverage Code Spell Checker extension when installed
   - Provide native spell-check experience in the editor

3. **Rich metadata controls**:
   - Model picker (claude-sonnet-4.5, gpt-5, etc.)
   - Agent/mode selector
   - End condition configuration
   - Additional prompt options

4. **Seamless VS Code integration**:
   - Natural location in VS Code UI
   - Consistent with VS Code design patterns
   - Easy to discover and use

---

## 📐 Architecture Options

### Option A: WebView Panel in Bottom Panel (Like GitLens)

**Location**: Bottom panel alongside Problems, Output, Terminal, Debug Console

**Implementation**:

```typescript
// Register view container
vscode.window.registerWebviewViewProvider(
  "flightpath.promptEditor",
  webviewProvider
);
```

**Package.json contribution**:

```json
{
  "contributes": {
    "viewsContainers": {
      "panel": [
        {
          "id": "flightpath",
          "title": "FlightPath",
          "icon": "resources/flightpath-icon.svg"
        }
      ]
    },
    "views": {
      "flightpath": [
        {
          "type": "webview",
          "id": "flightpath.promptEditor",
          "name": "Prompt Editor"
        }
      ]
    }
  }
}
```

**Pros**:

- Always accessible without opening new tabs
- Persistent across workspace sessions
- Users can resize and dock as needed
- Similar to familiar extensions (GitLens, Test Explorer)
- Can stay open while editing other files

**Cons**:

- Limited vertical space in bottom panel
- Webview doesn't get native VS Code editor features automatically
- Must implement custom context-aware input
- Panel space is competitive (many extensions use it)

---

### Option B: Custom Editor for .prompt.json Files

**Location**: Opens in editor area as dedicated editor for `.prompt.json` and `.flightpath.json` files

**Implementation**:

```typescript
vscode.window.registerCustomEditorProvider(
  "flightpath.promptEditor",
  customEditorProvider,
  {
    webviewOptions: { retainContextWhenHidden: true },
  }
);
```

**Package.json contribution**:

```json
{
  "contributes": {
    "customEditors": [
      {
        "viewType": "flightpath.promptEditor",
        "displayName": "FlightPath Prompt Editor",
        "selector": [
          { "filenamePattern": "*.prompt.json" },
          { "filenamePattern": "*.flightpath.json" }
        ],
        "priority": "default"
      }
    ]
  }
}
```

**Pros**:

- Full editor space (more room for complex prompts)
- Direct association with prompt files
- Can toggle between JSON source and UI editor
- Familiar editing experience
- Can leverage VS Code's text document infrastructure

**Cons**:

- Requires opening a file (not as quick for one-off prompts)
- Custom editor webview still requires custom implementation
- Users might prefer raw JSON editing

---

### Option C: Command Palette Quick Input with Rich UI

**Location**: Command palette opens a multi-step quick input with rich components

**Implementation**:

```typescript
vscode.window.showQuickPick(items, {
  canPickMany: false,
  placeHolder: "Select prompt options...",
});

// For text input
vscode.window.showInputBox({
  prompt: "Enter your prompt",
  placeHolder: "@workspace #file:src/extension.ts /explain ...",
  validateInput: (value) => {
    /* validation */
  },
});
```

**Pros**:

- Native VS Code UI (no webview needed)
- Fast and lightweight
- Keyboard-driven workflow
- No custom HTML/CSS to maintain

**Cons**:

- Limited UI customization
- Cannot easily show rich context previews
- No spell checking integration
- Multi-step flow can be cumbersome
- No way to implement `#` trigger behavior in native input box

---

### Option D: Dedicated New Window/Tab (New Document)

**Location**: Opens as a new untitled document with custom language support

**Implementation**:

```typescript
// Create untitled document with custom language
const doc = await vscode.workspace.openTextDocument({
  content: "",
  language: "flightpath-prompt",
});

await vscode.window.showTextDocument(doc);
```

**With custom language contribution**:

```json
{
  "contributes": {
    "languages": [
      {
        "id": "flightpath-prompt",
        "aliases": ["FlightPath Prompt"],
        "extensions": [".flightpath-prompt"]
      }
    ]
  }
}
```

**Pros**:

- Full editor capabilities (syntax highlighting, etc.)
- Can leverage native text editor features
- Familiar editing experience
- Large editing space

**Cons**:

- Requires custom language server for context-aware features
- No native UI for metadata (model picker, etc.)
- Needs separate save workflow to create .prompt.json file
- Users must learn custom syntax

---

## 🎨 Context-Aware Input Implementation

### Challenge: Native `#` File Picker Like Copilot Chat

VS Code's native `#` context picker in Copilot Chat is **not** a public API. We need to implement our own.

### Solution Options

#### Option 1: Completion Provider in Custom Language

**For**: Option D (New Document with custom language)

```typescript
vscode.languages.registerCompletionItemProvider(
  { language: "flightpath-prompt" },
  {
    provideCompletionItems(document, position, token, context) {
      const line = document.lineAt(position.line).text;
      const prefix = line.substring(0, position.character);

      // Trigger on # character
      if (prefix.endsWith("#")) {
        return getFileCompletions();
      }

      // Trigger on @ character
      if (prefix.endsWith("@")) {
        return getWorkspaceCompletions();
      }

      return undefined;
    },
  },
  "#",
  "@" // Trigger characters
);
```

**Pros**:

- Native VS Code completion UI
- Familiar UX for developers
- Built-in filtering and search
- Keyboard navigation

**Cons**:

- Requires custom language definition
- Cannot easily show file tree structure
- Limited preview capabilities

---

#### Option 2: Webview with Monaco Editor + Custom Suggestions

**For**: Options A or B (Webview-based editors)

```html
<!-- In webview HTML -->
<script src="monaco-editor/min/vs/loader.js"></script>
<script>
  require.config({ paths: { vs: "monaco-editor/min/vs" } });
  require(["vs/editor/editor.main"], function () {
    const editor = monaco.editor.create(document.getElementById("container"), {
      value: "",
      language: "markdown",
    });

    // Custom completion provider
    monaco.languages.registerCompletionItemProvider("markdown", {
      triggerCharacters: ["#", "@"],
      provideCompletionItems: async (model, position) => {
        const word = model.getWordUntilPosition(position);

        if (word.word.startsWith("#")) {
          // Get files from extension host
          const files = await vscode.postMessage({
            command: "getFiles",
          });

          return {
            suggestions: files.map((f) => ({
              label: `#file:${f.path}`,
              kind: monaco.languages.CompletionItemKind.File,
              insertText: `#file:${f.path}`,
            })),
          };
        }
      },
    });
  });
</script>
```

**Pros**:

- Full control over editor behavior
- Rich UI possibilities (file tree, previews)
- Can implement exact Copilot Chat-like behavior
- Syntax highlighting and other Monaco features

**Cons**:

- Requires bundling Monaco Editor (~5MB)
- More complex webview implementation
- Communication overhead between webview and extension host
- Must maintain separate editor instance

---

#### Option 3: Hybrid - Input Box + Quick Pick

**For**: Option C (Command Palette approach)

```typescript
// Step 1: Text input with special syntax
const prompt = await vscode.window.showInputBox({
  prompt: "Enter prompt (type ## to add files)",
  placeHolder: "@workspace /explain Fix error handling",
});

// Step 2: Parse ## markers and show file picker
const hasFileMarker = prompt?.includes("##");
if (hasFileMarker) {
  const files = await vscode.window.showQuickPick(getWorkspaceFiles(), {
    canPickMany: true,
    placeHolder: "Select files to include",
  });

  // Replace ## with #file:... syntax
  const updatedPrompt = prompt.replace(
    "##",
    files.map((f) => `#file:${f.path}`).join(" ")
  );
}
```

**Pros**:

- No custom UI needed
- Leverages native VS Code components
- Simple implementation

**Cons**:

- Not as seamless as inline `#` trigger
- Requires learning special marker syntax (`##`)
- Multi-step workflow interrupts flow

---

## 🔤 Spell Check Integration

### Understanding Code Spell Checker

The [Code Spell Checker extension](https://marketplace.visualstudio.com/items?itemName=streetsidesoftware.code-spell-checker) works by:

1. Registering **diagnostic providers** for supported languages
2. Adding **code actions** for spelling corrections
3. Using VS Code's native **diagnostic system** (squiggly underlines)

### Integration Options

#### Option 1: Enable Spell Check on Custom Language

**For**: Options where we define a custom language

```json
{
  "contributes": {
    "languages": [
      {
        "id": "flightpath-prompt",
        "aliases": ["FlightPath Prompt"],
        "extensions": [".flightpath-prompt"]
      }
    ]
  }
}
```

Then users configure Code Spell Checker:

```json
{
  "cSpell.enabledLanguageIds": ["flightpath-prompt"]
}
```

**Pros**:

- Automatic if user has Code Spell Checker installed
- Zero implementation on our side
- Native VS Code diagnostic experience

**Cons**:

- Requires user configuration
- Only works if Code Spell Checker is installed
- Limited to text-based editors (not webviews)

---

#### Option 2: Programmatically Enable Spell Check

**For**: Custom editor or document-based approaches

```typescript
// When opening prompt editor
const config = vscode.workspace.getConfiguration("cSpell");
const enabledLanguages = config.get<string[]>("enabledLanguageIds") || [];

if (!enabledLanguages.includes("flightpath-prompt")) {
  await config.update(
    "enabledLanguageIds",
    [...enabledLanguages, "flightpath-prompt"],
    vscode.ConfigurationTarget.Global
  );
}
```

**Pros**:

- Automatic setup for users
- One-time configuration
- User doesn't need to know about configuration

**Cons**:

- Modifies user settings without explicit consent
- Still requires Code Spell Checker extension
- Could conflict with user preferences

---

#### Option 3: Detect and Prompt User

**Best Practice Approach**

```typescript
async function setupSpellCheck(): Promise<void> {
  // Check if Code Spell Checker is installed
  const cspellExt = vscode.extensions.getExtension(
    "streetsidesoftware.code-spell-checker"
  );

  if (!cspellExt) {
    const result = await vscode.window.showInformationMessage(
      "Install Code Spell Checker for spell checking in FlightPath prompts?",
      "Install",
      "Not Now"
    );

    if (result === "Install") {
      await vscode.commands.executeCommand(
        "workbench.extensions.installExtension",
        "streetsidesoftware.code-spell-checker"
      );
    }
    return;
  }

  // Check if spell check is enabled for our language
  const config = vscode.workspace.getConfiguration("cSpell");
  const enabledLanguages = config.get<string[]>("enabledLanguageIds") || [];

  if (!enabledLanguages.includes("flightpath-prompt")) {
    const result = await vscode.window.showInformationMessage(
      "Enable spell checking for FlightPath prompts?",
      "Enable",
      "Not Now"
    );

    if (result === "Enable") {
      await config.update(
        "enabledLanguageIds",
        [...enabledLanguages, "flightpath-prompt"],
        vscode.ConfigurationTarget.Global
      );
    }
  }
}
```

**Pros**:

- Respects user choice
- Provides guidance
- Graceful degradation if not installed

**Cons**:

- Requires prompting user
- Not automatic

---

#### Option 4: Webview with Custom Spell Check

**For**: Webview-based editors (Options A & B)

```html
<script>
  // Use browser's native spell check
  const editor = document.getElementById("prompt-editor");
  editor.setAttribute("spellcheck", "true");

  // Or integrate a JavaScript spell checker
  import Typo from "typo-js";
  const dictionary = new Typo("en_US");

  editor.addEventListener("input", () => {
    const words = editor.value.split(/\s+/);
    words.forEach((word) => {
      if (!dictionary.check(word)) {
        // Highlight as misspelled
      }
    });
  });
</script>
```

**Pros**:

- Independent of Code Spell Checker extension
- Works in any environment
- Full control over spell check behavior

**Cons**:

- Requires bundling dictionary files
- More implementation work
- Not integrated with user's custom dictionaries
- Doesn't respect Code Spell Checker settings

---

## 🎛️ UI Layout Designs

### Design A: Bottom Panel WebView with Sidebar Controls

```
┌─────────────────────────────────────────────────────────┐
│ FlightPath Prompt Editor                         [─][×] │
├───────────┬─────────────────────────────────────────────┤
│ Settings  │ Prompt Text                                 │
│           │ ┌───────────────────────────────────────┐   │
│ Model:    │ │ @workspace /explain                   │   │
│ [v] GPT-4 │ │ #file:src/extension.ts                │   │
│           │ │                                        │   │
│ Agent:    │ │ Analyze the FlightPath architecture   │   │
│ [v] Chat  │ │ and suggest improvements based on     │   │
│           │ │ SOLID principles.                      │   │
│ End Cond: │ │                                        │   │
│ [ ] None  │ └───────────────────────────────────────┘   │
│           │                                             │
│           │ [💾 Save] [▶️ Run] [📋 Copy]                │
└───────────┴─────────────────────────────────────────────┘
```

**Features**:

- Left sidebar for metadata/settings
- Main text area for prompt
- Action buttons at bottom
- Always accessible in panel

---

### Design B: Full Editor Tab with Toolbar

```
┌─────────────────────────────────────────────────────────┐
│ untitled-prompt.flightpath                        [─][×] │
├─────────────────────────────────────────────────────────┤
│ Model: [claude-sonnet-4.5 v] │ Agent: [Chat v] │ [💾] [▶️] │
├─────────────────────────────────────────────────────────┤
│ @workspace /explain                                     │
│ #file:src/extension.ts                                  │
│                                                         │
│ Analyze the FlightPath architecture and suggest        │
│ improvements based on SOLID principles.                 │
│                                                         │
│ ## End Condition                                        │
│ Script: check_improvements.py                           │
│ Returns: true                                           │
│                                                         │
│                                                         │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

**Features**:

- Full editor space
- Toolbar for quick access to settings
- Markdown-style syntax for end conditions
- Familiar editor experience

---

### Design C: Side Panel with Rich Form

```
┌─────────────────────┐
│ FlightPath          │
│ ─────────────────── │
│ Create Prompt       │
│                     │
│ 🎯 Prompt           │
│ ┌─────────────────┐ │
│ │ @workspace      │ │
│ │ /explain        │ │
│ │                 │ │
│ │ Analyze...      │ │
│ └─────────────────┘ │
│                     │
│ 📁 Context          │
│ ☑ Workspace         │
│ ☐ Current File      │
│ ☐ Selection         │
│                     │
│ 🤖 Model            │
│ ● claude-sonnet-4.5 │
│ ○ gpt-5             │
│ ○ claude-haiku-4.5  │
│                     │
│ ✓ End Condition     │
│ Script: [Browse...] │
│ Returns: true       │
│                     │
│ [💾 Save to File]   │
│ [▶️ Run Now]         │
└─────────────────────┘
```

**Features**:

- Form-based UI
- Radio buttons and checkboxes
- File browser integration
- Wizard-like experience

---

## 🔧 Metadata Controls

### Model Picker

**Options**:

1. **Dropdown in UI**

   ```typescript
   <select id="model">
     <option value="claude-sonnet-4.5">Claude Sonnet 4.5</option>
     <option value="gpt-5">GPT-5</option>
     <option value="claude-haiku-4.5">Claude Haiku 4.5</option>
   </select>
   ```

2. **Quick Pick Command**

   ```typescript
   const model = await vscode.window.showQuickPick([
     { label: "Claude Sonnet 4.5", value: "claude-sonnet-4.5" },
     { label: "GPT-5", value: "gpt-5" },
     { label: "Claude Haiku 4.5", value: "claude-haiku-4.5" },
   ]);
   ```

3. **Command Palette Shortcut**
   ```typescript
   vscode.commands.registerCommand("flightpath.setModel", async () => {
     /* ... */
   });
   ```

### Agent/Mode Selector

**Options**:

- Chat (conversational)
- Code (code generation)
- Fix (error fixing)
- Explain (explanations)
- Test (test generation)

Could be:

- Dropdown
- Radio buttons
- Segmented control

### Selection Context

**For capturing current selection**:

```typescript
const editor = vscode.window.activeTextEditor;
if (editor && !editor.selection.isEmpty) {
  const selection = editor.selection;
  const document = editor.document;
  const filePath = vscode.workspace.asRelativePath(document.uri);

  const startLine = selection.start.line + 1; // 1-indexed
  const endLine = selection.end.line + 1;

  const contextString = `#file:${filePath}:${startLine}-${endLine}`;

  // Auto-insert into prompt editor
  insertText(contextString);
}
```

---

## 📊 Comparison Matrix

| Feature                       | Bottom Panel (A) | Custom Editor (B) | Command Palette (C) | New Document (D)  |
| ----------------------------- | ---------------- | ----------------- | ------------------- | ----------------- |
| **Always Accessible**         | ✅ Yes           | ❌ No             | ✅ Yes              | ❌ No             |
| **Large Editing Space**       | ❌ Limited       | ✅ Yes            | ❌ No               | ✅ Yes            |
| **Context-Aware Input**       | 🔶 Custom        | 🔶 Custom         | ❌ Difficult        | ✅ Completion API |
| **Spell Check**               | 🔶 Custom        | 🔶 Custom         | ❌ No               | ✅ Native         |
| **Implementation Complexity** | 🔴 High          | 🔴 High           | 🟢 Low              | 🟡 Medium         |
| **File Association**          | ❌ No            | ✅ Yes            | ❌ No               | ❌ No             |
| **Metadata UI**               | ✅ Easy          | ✅ Easy           | 🟡 Multi-step       | ❌ Limited        |
| **Preview/Run**               | ✅ Easy          | ✅ Easy           | 🟡 Separate         | 🟡 Separate       |
| **User Familiarity**          | ✅ High          | ✅ High           | ✅ High             | 🟡 Medium         |

**Legend**: ✅ Excellent | 🟡 Good | 🔶 Requires Work | ❌ Poor/Not Available | 🔴 High | 🟡 Medium | 🟢 Low

---

## 💡 Recommended Approach

### Hybrid Strategy: Best of Multiple Worlds

**Phase 1: Enhanced JSON Editing (Immediate)**

1. Keep current `.prompt.json` and `.flightpath.json` workflow
2. Add **Completion Providers** for JSON files:
   - Trigger on `#` to show file picker in JSON string values
   - Trigger on `@` to show workspace context options
   - Validate end condition paths

```typescript
vscode.languages.registerCompletionItemProvider(
  { pattern: "**/*.{prompt,flightpath}.json" },
  {
    provideCompletionItems(document, position) {
      // Check if we're inside a "prompt" string
      const line = document.lineAt(position).text;
      if (isInsidePromptString(line, position)) {
        if (line.substring(0, position.character).endsWith("#")) {
          return getFileCompletions();
        }
      }
    },
  },
  "#",
  "@"
);
```

**Pros**:

- No UI changes required
- Leverages existing JSON infrastructure
- Spell check works automatically (Code Spell Checker supports JSON strings)
- Quick to implement

**Cons**:

- Still editing JSON (syntax overhead)
- Limited UX compared to dedicated editor

---

**Phase 2: Bottom Panel View (Enhanced Experience)**

Create a WebView in the bottom panel with:

1. **Monaco Editor** for prompt text (with custom completions)
2. **Form controls** for metadata (model, agent, end condition)
3. **Action buttons** (Save, Run, Copy)
4. **File browser** integration for `#file:...` insertion
5. **Selection capture** button

```typescript
// Register webview view provider
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider(
    "flightpath.promptEditor",
    new PromptEditorViewProvider(context)
  )
);
```

**Pros**:

- Best UX for creating prompts
- Always accessible
- Rich metadata controls
- Can implement custom spell check

**Cons**:

- More implementation work
- Requires Monaco Editor bundling

---

**Phase 3: Custom Editor (Future)**

Add custom editor for `.prompt.json` files:

- Opens in editor area
- Toggle between "Form View" and "Source View"
- Full integration with file system

```typescript
vscode.window.registerCustomEditorProvider(
  "flightpath.promptEditor",
  customEditorProvider
);
```

---

## 🚀 Next Steps

### Immediate Actions

1. **Prototype Completion Provider** for JSON files
   - Test `#` and `@` triggers in JSON string contexts
   - Validate feasibility of context-aware completions in JSON

2. **Research Monaco Editor Integration**
   - Bundle size implications
   - WebView security considerations
   - Communication patterns with extension host

3. **Spike: Spell Check in JSON**
   - Test if Code Spell Checker works in JSON string values
   - Document configuration needed

4. **UI Mockups**
   - Create higher-fidelity mockups for panel view
   - Get user feedback on layout options

### Questions to Answer

1. **Should we support both UI and JSON workflows?**
   - Pro: Power users prefer JSON, beginners prefer UI
   - Con: Maintenance burden for two workflows

2. **Do we need model selection in the prompt file?**
   - Currently model is a workspace setting
   - Should each prompt specify its own model?

3. **How to handle multi-prompt workflows in UI?**
   - Tabs within the editor?
   - List view with expand/collapse?
   - Separate files only?

4. **Integration with existing JSON files?**
   - Should UI editor be able to open/edit existing files?
   - Or is it only for creating new prompts?

---

## 📚 References

- [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview)
- [Custom Editors](https://code.visualstudio.com/api/extension-guides/custom-editors)
- [Completion Provider](https://code.visualstudio.com/api/language-extensions/programmatic-language-features#show-code-completion-proposals)
- [Code Spell Checker](https://marketplace.visualstudio.com/items?itemName=streetsidesoftware.code-spell-checker)
- [Monaco Editor](https://microsoft.github.io/monaco-editor/)
- [Chat Participant API](https://code.visualstudio.com/api/extension-guides/chat)

---

**Document Version**: 1.0  
**Contributors**: Nathan  
**Status**: Open for discussion and feedback
