# FlightPath React + Tailwind Migration Plan

**Date:** February 2, 2026
**Duration:** 16 days
**Goal:** Migrate ~11,241 lines of vanilla JS/SCSS to React + TypeScript + Tailwind with resizable panel layout, merging the Settings panel into the dashboard view and removing legacy layout toggle controls.

---

## Architecture Overview

### Final Layout

```
┌─────────────────────────────────────────────────────────────┐
│ Header (fixed)                                              │
├─────────┬───┬─────────────────────┬───┬───────────────────┤
│         │ ║ │                     │ ║ │                   │
│ Prompts │ ║ │   Output Section    │ ║ │    Settings       │
│         │ ║ ├─────────────────────┤ ║ │    (optional)     │
│         │ ║ │ ═══════════════════ │ ║ │                   │
│         │ ║ │   Editor Section    │ ║ │                   │
│         │ ║ │                     │ ║ │                   │
└─────────┴───┴─────────────────────┴───┴───────────────────┘
    ↑      ↑           ↑              ↑          ↑
Resizable  │      Resizable           │      Resizable
  Panel    │   (vertical split)       │        Panel
         Drag                        Drag
        handle                      handle
```

**Key Features:**

- User can drag dividers to resize panels
- Panel sizes persist to localStorage
- Settings drawer toggleable (shows/hides) inside the same dashboard view (no separate settings webview)
- All panels have min/max size constraints
- Smooth resize animations
- Legacy layout toggle buttons (vertical/horizontal/swap) are removed; the resizable layout replaces them

### Technology Stack

| Package                | Version | Purpose           |
| ---------------------- | ------- | ----------------- |
| react                  | latest  | UI framework      |
| react-dom              | latest  | React rendering   |
| typescript             | latest  | Type safety       |
| zustand                | latest  | State management  |
| tailwindcss            | latest  | Utility CSS       |
| react-resizable-panels | latest  | Resizable layout  |
| @vitejs/plugin-react   | latest  | Vite React plugin |
| vite                   | latest  | Build tool + HMR  |
| codemirror             | latest  | Code editor       |

**Note:** All packages use latest stable versions. npm will install compatible ranges (^) automatically.

---

## Project Structure

```
src/ui/webview-react/
├── App.tsx                         # Root with PanelGroup layout
├── main.tsx                        # Entry point
├── index.html                      # Vite template
│
├── components/
│   ├── layout/
│   │   ├── Header.tsx              # Workflow controls, status, buttons
│   │   ├── PromptsPanel.tsx        # Prompts list
│   │   ├── OutputSection.tsx       # CLI output rendering
│   │   ├── EditorSection.tsx       # CodeMirror editor
│   │   └── SettingsDrawer.tsx      # Settings form
│   │
│   ├── prompts/
│   │   ├── PromptItem.tsx
│   │   ├── StatusIcon.tsx
│   │   └── PromptCounter.tsx
│   │
│   ├── output/
│   │   ├── CliOutput.tsx
│   │   ├── ToolCallOutput.tsx
│   │   ├── BashOutput.tsx
│   │   └── StatusMessage.tsx
│   │
│   ├── editor/
│   │   ├── PromptEditor.tsx
│   │   ├── PropertiesDrawer.tsx
│   │   ├── EditorFooter.tsx
│   │   └── PropertyControls/
│   │
│   ├── workflow/
│   │   ├── WorkflowControls.tsx
│   │   ├── WorkflowStatus.tsx
│   │   ├── TemplateModal.tsx
│   │   └── RecentWorkflows.tsx
│   │
│   ├── settings/
│   │   ├── SettingsForm.tsx
│   │   ├── WorkflowProperties.tsx
│   │   └── SessionSettings.tsx
│   │
│   └── shared/
│       ├── Button.tsx
│       ├── Input.tsx
│       ├── Select.tsx
│       ├── Modal.tsx
│       ├── Collapsible.tsx
│       └── SplitButton.tsx
│
├── hooks/
│   ├── useVsCodeApi.ts             # VS Code API singleton
│   ├── useMessageHandler.ts        # Message routing
│   ├── useLocalStorage.ts
│   └── useDebounce.ts
│
├── store/
│   ├── workflowStore.ts            # Prompts, execution state
│   ├── editorStore.ts              # Editor mode, selection
│   ├── uiStore.ts                  # Layout, collapse states
│   └── settingsStore.ts            # Model options, agents
│
├── utils/
│   ├── time.ts
│   ├── string.ts
│   ├── prompt.ts
│   ├── endCondition.ts
│   └── constants.ts
│
├── types/
│   ├── vscode.ts
│   ├── messages.ts
│   └── index.ts
│
└── styles/
    ├── globals.css                 # Tailwind imports + base
    ├── themes.css                  # VS Code theme variables
    └── codemirror.css              # Editor overrides
```

---

## Parity Requirements (Must Not Regress)

### Message Coverage Matrix (Dashboard + Settings)

All message types currently used by the dashboard/settings webviews must be handled in React:

**Dashboard messages (from extension):**

- INIT, FILE_SELECTED, SESSION_RESTORED, PROMPTS_EXTENDED, PROMPT_DELETED
- EXECUTION_STARTED, EXECUTION_STATE_CHANGED, EXECUTION_COMPLETED
- PROGRESS_UPDATE, STEP_STATUS_CHANGED, RETRY_ATTEMPT_CHANGED
- CLI_OUTPUT, CLI_STREAMING_CHUNK, CLI_STREAMING_EVENTS, STATUS_MESSAGE
- WORKFLOW_NAME_UPDATED, RECENT_WORKFLOWS
- OPEN_NEW_WORKFLOW_MODAL, TEMPLATE_INFO, DEFAULT_TEMPLATE_SET, WORKFLOW_CREATED, CLOSE_MODAL
- MODEL_OPTIONS_UPDATE

**Settings messages (from extension):**

- INIT, WORKFLOW_PROPERTIES_UPDATE, WORKFLOW_LOADED, WORKFLOW_UNLOADED
- MODEL_OPTIONS_UPDATE, PROVIDER_STATUS_UPDATE, AGENTS_UPDATE
- CONFIG_VALUE

**Dashboard → extension:**

- READY, RUN, PAUSE, RESUME, STOP, SHOW_OUTPUT
- SELECT_FILE, APPEND_FILE, CLEAR_WORKFLOW
- EXECUTE_PROMPT, UPDATE_PROMPT, DELETE_PROMPT
- REQUEST_COMPLETIONS, OPEN_FILE
- NEW_WORKFLOW, TEMPLATE_SELECTED, SET_DEFAULT_TEMPLATE, CREATE_WORKFLOW, CREATE_NEW_TEMPLATE
- UPDATE_WORKFLOW_NAME, GET_RECENT_WORKFLOWS, LOAD_WORKFLOW, CLEAR_WORKFLOW_HISTORY
- EXPORT_OUTPUT

**Settings → extension (now in the same React view):**

- CHANGE_PROVIDER, CHANGE_MODEL, CHANGE_AGENT, CHANGE_EXECUTION_MODE
- CHANGE_RESUME_SESSION, CHANGE_DYNAMIC_QUEUE
- UPDATE_WORKFLOW_PROPERTY, SET_AS_DEFAULT
- GET_CONFIG, UPDATE_CONFIG, OPEN_SETTINGS

### UI/Behavior Parity Checklist

- Prompts list shows status icon, retries, end-condition results, and messages
- Output renders structured CLI events (tool calls, file edits/writes, diffs, bash output, errors)
- Streaming output is incremental (chunks + events)
- Autoscroll toggle persists and behaves like today
- Prompt editor uses CodeMirror + spell check + tokenizer count
- Prompt CRUD: add, update, delete, cancel edit, edit selection
- Properties drawer: provider/model/agent/resume/sessionId/dynamic/end condition
- Workflow split button: new/load/queue actions + recent workflows + inline rename
- Template modal with variables, default template, and validations
- Global shortcuts preserved (Ctrl/Cmd+Shift+N/T/L/Q)
- Output export matches current markdown format and workflow naming
- Settings: provider availability, model options, agents, workflow properties, set-as-default
- Config: respect gitignore, execution mode, open settings action

### State Persistence & Storage

- Use VS Code webview state (`vscode.getState()` / `vscode.setState()`) for:
  - New prompt draft text
  - Prompt name
  - Prompt properties in new-prompt mode
- Use localStorage for:
  - Panel sizes (react-resizable-panels)
  - Section collapse states (prompts/output/editor)
  - Autoscroll preference
- Ensure persistence is skipped for edit mode (mirrors current behavior)

### Dependency Migration Strategy

**Current vanilla JS dependencies → React equivalents:**

| Current Asset | Current Approach | React Migration | Rationale |
|--------------|------------------|-----------------|-----------|
| **diff.js** | Pre-bundled script | npm package `diff` | Better tree-shaking, type safety |
| **gpt-tokenizer.js** | Pre-bundled script | npm package `gpt-tokenizer` | Type safety, easier updates |
| **CodeMirror** | CDN loader | npm packages `@codemirror/*` | SSR compatibility, proper React integration |
| **Typo.js** | Script tag | Keep script tag + copy dictionaries | No good npm alternative exists |
| **Dictionaries** | Static files | Copy with `vite-plugin-static-copy` | Required for Typo.js spell checking |
| **Codicons** | CSS file | Copy with plugin or import | VS Code icon consistency |
| **Custom icons** | Auto-generated CSS | Run generation in build | SVG → CSS data URIs |

**Migration approach:**

1. **Replace pre-bundled scripts with npm packages** for diff, gpt-tokenizer, and CodeMirror
2. **Copy static assets** (dictionaries, codicons, custom icons) using Vite plugins
3. **Preserve Typo.js** via script tag (no npm alternative maintains feature parity)
4. **Generate custom icons CSS** as part of build process

### Assets & CSP Parity

- **Migrated to npm packages:**
  - diff.js → `diff` npm package (type-safe, tree-shakeable)
  - gpt-tokenizer.js → `gpt-tokenizer` npm package
  - CodeMirror CDN loader → `@codemirror/*` npm packages
- **Copied static assets:**
  - codicons/ → Copied with `vite-plugin-static-copy`
  - custom-icons.css → Generated from SVG icons during build
  - dictionaries/ → Copied for Typo.js spell checking
  - typo.js → Loaded via script tag (preserved legacy approach)
- All assets must be loaded via webview URIs (CSP-compliant, no inline scripts)
- Preserve theme variables (use `--vscode-*` only)

### Layout Controls Removal

- Remove legacy layout buttons (vertical/horizontal/swap)
- React resizable panels are the only layout control; panel swapping is out-of-scope

### Corner Cases to Cover

- Session ID input enabled only when resume session is true; numeric parsing supported
- Provider change updates model dropdown before setting selected model
- Model options empty state for Copilot until registry loads
- Editing prompt preserves new-prompt draft state on cancel
- Prompt delete confirms with modal and returns to new prompt mode
- Export output uses workspace .flightpath/output fallback and respects user save location
- Streaming output updates visible section without losing autoscroll state
- Queue extension preserves existing prompt statuses and details
- Workflow loaded/unloaded properly toggles settings state
- Recent workflows list handles empty state and clear history
- End condition enable/disable updates all dependent fields

---

## Implementation Plan

### Phase 1: Foundation (Days 1-4)

#### Day 1: Dependencies & Build Setup

1. **Install dependencies:**

```bash
# React core dependencies (latest stable versions)
npm install react react-dom zustand react-resizable-panels

# Dev dependencies (build tools)
npm install -D @vitejs/plugin-react vite tailwindcss postcss autoprefixer
npm install -D @types/react @types/react-dom typescript

# CodeMirror packages (replace CDN loader)
npm install @codemirror/state @codemirror/view @codemirror/commands
npm install @codemirror/lang-markdown @codemirror/search @codemirror/autocomplete

# Migrated bundled scripts to npm packages
npm install diff gpt-tokenizer
npm install -D @types/diff

# Static asset copying
npm install -D vite-plugin-static-copy
```

**Notes:**
- All packages install latest stable versions with compatible ranges (^)
- React 19.x is current stable (as of Feb 2026)
- Typo.js remains as script tag (no npm alternative)
- Dictionaries will be copied by vite-plugin-static-copy

2. **Create Vite config** (`src/ui/webview-react/vite.config.ts`):

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";
import path from "path";

export default defineConfig({
  plugins: [
    react(),
    // Copy static assets that React build needs
    viteStaticCopy({
      targets: [
        // Copy dictionaries for Typo.js spell checking
        {
          src: "../webview/dictionaries/**/*",
          dest: "dictionaries",
        },
        // Copy codicons CSS for VS Code icons
        {
          src: "../webview/codicons/**/*",
          dest: "codicons",
        },
        // Copy custom icons CSS (auto-generated from SVG files)
        {
          src: "../webview/custom-icons.css",
          dest: "assets",
        },
      ],
    }),
  ],

  root: path.resolve(__dirname),

  build: {
    outDir: path.resolve(__dirname, "../../../out/ui/webview-react"),
    emptyOutDir: true,
    minify: "esbuild",
    sourcemap: true,
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
  },

  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      "@components": path.resolve(__dirname, "components"),
      "@hooks": path.resolve(__dirname, "hooks"),
      "@store": path.resolve(__dirname, "store"),
      "@utils": path.resolve(__dirname, "utils"),
      "@types": path.resolve(__dirname, "types"),
    },
  },

  server: {
    port: 5173,
    strictPort: true,
  },
});
```

3. **Create Tailwind config** (`src/ui/webview-react/tailwind.config.js`):

```javascript
module.exports = {
  content: ["./index.html", "./**/*.{ts,tsx}"],
  darkMode: "class",

  theme: {
    extend: {
      colors: {
        "vscode-bg": "var(--vscode-editor-background)",
        "vscode-fg": "var(--vscode-editor-foreground)",
        "vscode-border": "var(--vscode-panel-border)",
        "vscode-primary": "var(--vscode-button-background)",
        "vscode-primary-hover": "var(--vscode-button-hoverBackground)",
        "vscode-primary-fg": "var(--vscode-button-foreground)",
        "vscode-secondary": "var(--vscode-button-secondaryBackground)",
        "vscode-secondary-hover":
          "var(--vscode-button-secondaryHoverBackground)",
        "vscode-secondary-fg": "var(--vscode-button-secondaryForeground)",
        "vscode-input-bg": "var(--vscode-input-background)",
        "vscode-input-fg": "var(--vscode-input-foreground)",
        "vscode-input-border": "var(--vscode-input-border)",
        "vscode-list-hover": "var(--vscode-list-hoverBackground)",
        "vscode-list-active": "var(--vscode-list-activeSelectionBackground)",
      },
    },
  },
};
```

4. **Update package.json scripts:**

```json
{
  "scripts": {
    "compile": "npm run compile:extension && npm run compile:webview",
    "compile:extension": "tsc -p ./",
    "compile:webview": "npm run generate-custom-icons && vite build --config src/ui/webview-react/vite.config.ts",

    "watch": "npm run watch:extension & npm run watch:webview",
    "watch:extension": "tsc -watch -p ./",
    "watch:webview": "npm run generate-custom-icons && vite build --watch --config src/ui/webview-react/vite.config.ts",

    "dev:webview": "npm run generate-custom-icons && vite --config src/ui/webview-react/vite.config.ts",

    "build:prod": "npm run build:extension && npm run build:webview",
    "build:extension": "tsc -p ./",
    "build:webview": "npm run generate-custom-icons && vite build --config src/ui/webview-react/vite.config.ts --mode production",

    "generate-custom-icons": "node scripts/generate-custom-icons.js"
  }
}
```

**Note:** The `generate-custom-icons` script must run before Vite build to ensure custom-icons.css exists for the static copy plugin.

#### Day 2: Core Files

1. **Create entry point** (`src/ui/webview-react/main.tsx`):

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles/globals.css";

const root = document.getElementById("root");
if (root) {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
```

2. **Create HTML template** (`src/ui/webview-react/index.html`):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>FlightPath</title>
    <!-- Typo.js for spell checking (no npm alternative) -->
    <!-- Note: Path will be replaced with webview URI by FlightPathWebviewProvider -->
    <script src="{{typoUri}}"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

**Note:** Typo.js script tag uses placeholder that gets replaced by `FlightPathWebviewProvider._getHtmlForWebview()` (same pattern as current dashboard.html).

3. **Create global styles** (`src/ui/webview-react/styles/globals.css`):

```css
@tailwind base;
@tailwind components;
@tailwind utilities;

/* Import VS Code icon fonts (copied by vite-plugin-static-copy) */
@import "../codicons/codicon.css";

/* Import custom icons CSS (auto-generated from SVG files, copied by plugin) */
@import "../custom-icons.css";

@layer base {
  * {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
  }

  html,
  body,
  #root {
    height: 100%;
    width: 100%;
    overflow: hidden;
  }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-editor-foreground);
    background: var(--vscode-editor-background);
  }
}

@layer components {
  .btn-primary {
    @apply px-3 py-1.5 bg-vscode-primary text-vscode-primary-fg rounded
           hover:bg-vscode-primary-hover transition-colors;
  }

  .btn-secondary {
    @apply px-3 py-1.5 bg-vscode-secondary text-vscode-secondary-fg rounded
           hover:bg-vscode-secondary-hover transition-colors;
  }

  .input-field {
    @apply px-2 py-1 bg-vscode-input-bg text-vscode-input-fg border
           border-vscode-input-border rounded focus:outline-none focus:ring-1
           focus:ring-vscode-primary;
  }

  .resize-handle {
    @apply bg-vscode-border hover:bg-vscode-primary transition-colors;
  }

  .resize-handle[data-panel-group-direction="horizontal"] {
    @apply w-1 cursor-col-resize;
  }

  .resize-handle[data-panel-group-direction="vertical"] {
    @apply h-1 cursor-row-resize;
  }
}
```

4. **Create VS Code API hook** (`src/ui/webview-react/hooks/useVsCodeApi.ts`):

```typescript
import { useEffect, useState } from "react";

interface VsCodeApi {
  postMessage: (message: any) => void;
  getState: () => any;
  setState: (state: any) => void;
}

let vscodeApi: VsCodeApi | undefined;

export function useVsCodeApi(): VsCodeApi {
  const [api, setApi] = useState<VsCodeApi | undefined>(vscodeApi);

  useEffect(() => {
    if (!vscodeApi) {
      // @ts-ignore - Injected by VS Code
      vscodeApi = acquireVsCodeApi();
      setApi(vscodeApi);
    }
  }, []);

  if (!api) {
    throw new Error("VS Code API not available");
  }

  return api;
}

export function getVsCodeApi(): VsCodeApi {
  if (!vscodeApi) {
    // @ts-ignore
    vscodeApi = acquireVsCodeApi();
  }
  return vscodeApi;
}
```

5. **Create message handler hook** (`src/ui/webview-react/hooks/useMessageHandler.ts`):

```typescript
import { useEffect } from "react";

type MessageHandler = (message: any) => void;
type MessageHandlerMap = Record<string, MessageHandler>;

export function useMessageHandler(handlers: MessageHandlerMap) {
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      const message = event.data;
      const handler = handlers[message.type];

      if (handler) {
        handler(message);
      } else {
        console.warn(`Unhandled message: ${message.type}`);
      }
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [handlers]);
}
```

#### Day 3: Zustand Stores & Utility Functions

**Create utility wrappers for migrated npm packages:**

1. **Diff utility** (`src/ui/webview-react/utils/diff.ts`):

```typescript
import * as Diff from "diff";

/**
 * Generate unified diff between old and new text
 * Wrapper around diff npm package for type safety
 */
export function generateDiff(oldText: string, newText: string): string {
  const patch = Diff.createPatch(
    "file",
    oldText,
    newText,
    "before",
    "after"
  );
  return patch;
}

/**
 * Apply diff patch to text
 */
export function applyDiff(text: string, patch: string): string {
  const result = Diff.applyPatch(text, patch);
  return typeof result === "string" ? result : text;
}
```

2. **Token counter utility** (`src/ui/webview-react/utils/tokenizer.ts`):

```typescript
import { encode } from "gpt-tokenizer";

/**
 * Count tokens in text using GPT tokenizer
 * Wrapper around gpt-tokenizer npm package
 */
export function countTokens(text: string): number {
  try {
    const tokens = encode(text);
    return tokens.length;
  } catch (error) {
    console.error("Token counting failed:", error);
    return 0;
  }
}
```

3. **Create workflow store** (`src/ui/webview-react/store/workflowStore.ts`):

```typescript
import { create } from "zustand";

interface WorkflowState {
  fileName: string | null;
  workflowName: string | null;
  prompts: any[];
  executionState: "idle" | "running" | "paused" | "completed" | "error";
  currentStep: number;
  totalSteps: number;
  cliOutputs: Record<number, string[]>;
  retryStates: Record<number, { currentRetry: number; maxRetries: number }>;
  statusMessages: Record<number, string[]>;

  setFileName: (fileName: string | null) => void;
  setWorkflowName: (name: string | null) => void;
  setPrompts: (prompts: any[]) => void;
  updatePrompt: (index: number, updates: any) => void;
  setExecutionState: (state: any) => void;
  setCurrentStep: (step: number) => void;
  addCliOutput: (stepIndex: number, output: string) => void;
  setRetryState: (
    stepIndex: number,
    currentRetry: number,
    maxRetries: number
  ) => void;
  addStatusMessage: (stepIndex: number, message: string) => void;
  resetWorkflow: () => void;
}

export const useWorkflowStore = create<WorkflowState>((set) => ({
  fileName: null,
  workflowName: null,
  prompts: [],
  executionState: "idle",
  currentStep: 0,
  totalSteps: 0,
  cliOutputs: {},
  retryStates: {},
  statusMessages: {},

  setFileName: (fileName) => set({ fileName }),
  setWorkflowName: (workflowName) => set({ workflowName }),
  setPrompts: (prompts) => set({ prompts, totalSteps: prompts.length }),

  updatePrompt: (index, updates) =>
    set((state) => ({
      prompts: state.prompts.map((p, i) =>
        i === index ? { ...p, ...updates } : p
      ),
    })),

  setExecutionState: (executionState) => set({ executionState }),
  setCurrentStep: (currentStep) => set({ currentStep }),

  addCliOutput: (stepIndex, output) =>
    set((state) => ({
      cliOutputs: {
        ...state.cliOutputs,
        [stepIndex]: [...(state.cliOutputs[stepIndex] || []), output],
      },
    })),

  setRetryState: (stepIndex, currentRetry, maxRetries) =>
    set((state) => ({
      retryStates: {
        ...state.retryStates,
        [stepIndex]: { currentRetry, maxRetries },
      },
    })),

  addStatusMessage: (stepIndex, message) =>
    set((state) => ({
      statusMessages: {
        ...state.statusMessages,
        [stepIndex]: [...(state.statusMessages[stepIndex] || []), message],
      },
    })),

  resetWorkflow: () =>
    set({
      fileName: null,
      workflowName: null,
      prompts: [],
      executionState: "idle",
      currentStep: 0,
      totalSteps: 0,
      cliOutputs: {},
      retryStates: {},
      statusMessages: {},
    }),
}));
```

2. **Create UI store** (`src/ui/webview-react/store/uiStore.ts`):

```typescript
import { create } from "zustand";
import { persist } from "zustand/middleware";

interface UiState {
  promptsCollapsed: boolean;
  outputCollapsed: boolean;
  editorCollapsed: boolean;
  propertiesDrawerOpen: boolean;
  settingsDrawerOpen: boolean;
  autoscrollEnabled: boolean;

  togglePromptsCollapse: () => void;
  toggleOutputCollapse: () => void;
  toggleEditorCollapse: () => void;
  togglePropertiesDrawer: () => void;
  toggleSettingsDrawer: () => void;
  setAutoscroll: (enabled: boolean) => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      promptsCollapsed: false,
      outputCollapsed: false,
      editorCollapsed: false,
      propertiesDrawerOpen: false,
      settingsDrawerOpen: false,
      autoscrollEnabled: true,

      togglePromptsCollapse: () =>
        set((state) => ({ promptsCollapsed: !state.promptsCollapsed })),
      toggleOutputCollapse: () =>
        set((state) => ({ outputCollapsed: !state.outputCollapsed })),
      toggleEditorCollapse: () =>
        set((state) => ({ editorCollapsed: !state.editorCollapsed })),
      togglePropertiesDrawer: () =>
        set((state) => ({ propertiesDrawerOpen: !state.propertiesDrawerOpen })),
      toggleSettingsDrawer: () =>
        set((state) => ({ settingsDrawerOpen: !state.settingsDrawerOpen })),
      setAutoscroll: (enabled) => set({ autoscrollEnabled: enabled }),
    }),
    {
      name: "flightpath-ui-state",
    }
  )
);
```

3. **Create editor store** (`src/ui/webview-react/store/editorStore.ts`):

```typescript
import { create } from "zustand";

interface EditorState {
  selectedPromptIndex: number | null;
  originalPromptData: any | null;
  hasActiveQueue: boolean;
  promptText: string;
  promptName: string;

  selectPrompt: (index: number | null) => void;
  setOriginalPromptData: (data: any) => void;
  setHasActiveQueue: (hasQueue: boolean) => void;
  setPromptText: (text: string) => void;
  setPromptName: (name: string) => void;
  resetEditor: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  selectedPromptIndex: null,
  originalPromptData: null,
  hasActiveQueue: false,
  promptText: "",
  promptName: "",

  selectPrompt: (index) => set({ selectedPromptIndex: index }),
  setOriginalPromptData: (data) => set({ originalPromptData: data }),
  setHasActiveQueue: (hasQueue) => set({ hasActiveQueue: hasQueue }),
  setPromptText: (text) => set({ promptText: text }),
  setPromptName: (name) => set({ promptName: name }),

  resetEditor: () =>
    set({
      selectedPromptIndex: null,
      originalPromptData: null,
      promptText: "",
      promptName: "",
    }),
}));
```

4. **Create settings store** (`src/ui/webview-react/store/settingsStore.ts`):

```typescript
import { create } from "zustand";

interface SettingsState {
  modelOptions: Record<string, string[]>;
  availableAgents: Array<{ name: string; path: string }>;
  providerStatus: Record<string, "available" | "checking" | "unavailable">;

  setModelOptions: (options: Record<string, string[]>) => void;
  setAvailableAgents: (agents: Array<{ name: string; path: string }>) => void;
  setProviderStatus: (provider: string, status: string) => void;
}

export const useSettingsStore = create<SettingsState>((set) => ({
  modelOptions: {},
  availableAgents: [],
  providerStatus: {},

  setModelOptions: (options) => set({ modelOptions: options }),
  setAvailableAgents: (agents) => set({ availableAgents: agents }),
  setProviderStatus: (provider, status) =>
    set((state) => ({
      providerStatus: {
        ...state.providerStatus,
        [provider]: status as any,
      },
    })),
}));
```

#### Day 4: App.tsx with Resizable Panels

**Create root component** (`src/ui/webview-react/App.tsx`):

```tsx
import React, { useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { useMessageHandler } from "@hooks/useMessageHandler";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { useUiStore } from "@store/uiStore";

import Header from "@components/layout/Header";
import PromptsPanel from "@components/layout/PromptsPanel";
import OutputSection from "@components/layout/OutputSection";
import EditorSection from "@components/layout/EditorSection";
import SettingsDrawer from "@components/layout/SettingsDrawer";

function App() {
  const vscode = useVsCodeApi();
  const settingsDrawerOpen = useUiStore((state) => state.settingsDrawerOpen);

  // Message handlers
  useMessageHandler({
    INIT: handleInit,
    FILE_SELECTED: handleFileSelected,
    EXECUTION_STARTED: handleExecutionStarted,
    EXECUTION_STATE_CHANGED: handleExecutionStateChanged,
    STEP_STATUS_CHANGED: handleStepStatusChanged,
    CLI_OUTPUT: handleCliOutput,
    // Add all message types...
  });

  // Signal ready to extension
  useEffect(() => {
    vscode.postMessage({ type: "READY" });
  }, []);

  return (
    <div className="h-screen w-full flex flex-col bg-vscode-bg text-vscode-fg">
      <Header />

      <PanelGroup direction="horizontal" className="flex-1">
        {/* Prompts Panel (Left) */}
        <Panel defaultSize={20} minSize={10} maxSize={40} id="prompts-panel">
          <PromptsPanel />
        </Panel>

        <PanelResizeHandle className="resize-handle" />

        {/* Main Content (Center) */}
        <PanelGroup direction="vertical">
          <Panel defaultSize={50} minSize={20} id="output-panel">
            <OutputSection />
          </Panel>

          <PanelResizeHandle className="resize-handle" />

          <Panel defaultSize={50} minSize={20} id="editor-panel">
            <EditorSection />
          </Panel>
        </PanelGroup>

        {/* Settings Drawer (Right - Optional) */}
        {settingsDrawerOpen && (
          <>
            <PanelResizeHandle className="resize-handle" />
            <Panel
              defaultSize={30}
              minSize={20}
              maxSize={50}
              id="settings-panel"
            >
              <SettingsDrawer />
            </Panel>
          </>
        )}
      </PanelGroup>
    </div>
  );

  // Message handlers (implement based on current message-router.js)
  function handleInit(message: any) {
    /* TODO */
  }
  function handleFileSelected(message: any) {
    /* TODO */
  }
  function handleExecutionStarted(message: any) {
    /* TODO */
  }
  function handleExecutionStateChanged(message: any) {
    /* TODO */
  }
  function handleStepStatusChanged(message: any) {
    /* TODO */
  }
  function handleCliOutput(message: any) {
    /* TODO */
  }
}

export default App;
```

---

### Phase 2: Layout Components (Days 5-8)

#### Day 5: Header Component

**File:** `src/ui/webview-react/components/layout/Header.tsx`

```tsx
import React from "react";
import { useUiStore } from "@store/uiStore";

export default function Header() {
  const toggleSettings = useUiStore((state) => state.toggleSettingsDrawer);

  return (
    <header className="flex items-center justify-between px-4 py-2 border-b border-vscode-border flex-shrink-0">
      {/* Left: Workflow controls */}
      <div className="flex items-center gap-2">
        {/* TODO: WorkflowControls component */}
        <button className="btn-secondary">New Workflow</button>
      </div>

      {/* Center: Workflow status */}
      <div className="flex items-center gap-2">
        {/* TODO: WorkflowStatus component */}
        <span>Workflow Name</span>
      </div>

      {/* Right: Execution controls + settings */}
      <div className="flex items-center gap-2">
        {/* TODO: ExecutionControls component */}
        <button className="btn-primary">Run</button>

        <div className="w-px h-6 bg-vscode-border" />

        <button
          className="p-2 hover:bg-vscode-list-hover rounded"
          onClick={toggleSettings}
          title="Toggle Settings"
        >
          <i className="codicon codicon-settings-gear" />
        </button>
      </div>
    </header>
  );
}
```

**Note:** Do not port the legacy layout toggle buttons (vertical/horizontal/swap). The resizable panel layout replaces them.

#### Day 6: PromptsPanel Component

**File:** `src/ui/webview-react/components/layout/PromptsPanel.tsx`

```tsx
import React from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";

export default function PromptsPanel() {
  const prompts = useWorkflowStore((state) => state.prompts);
  const collapsed = useUiStore((state) => state.promptsCollapsed);
  const toggleCollapse = useUiStore((state) => state.togglePromptsCollapse);

  return (
    <div className="h-full flex flex-col bg-vscode-bg border-r border-vscode-border">
      {/* Header */}
      <div className="flex items-center justify-between p-2 border-b border-vscode-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={toggleCollapse}
            className="p-1 hover:bg-vscode-list-hover rounded"
          >
            <i
              className={`codicon codicon-chevron-${collapsed ? "right" : "down"}`}
            />
          </button>
          <i className="codicon codicon-tasklist" />
          <h3 className="font-semibold">Prompts</h3>
        </div>
        <span className="text-sm text-gray-500">0 / 0</span>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="flex-1 overflow-y-auto p-2">
          {prompts.length === 0 ? (
            <div className="text-center text-gray-500 mt-4 text-sm">
              Select a prompt file to begin
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {prompts.map((prompt, index) => (
                <div
                  key={index}
                  className="p-2 rounded hover:bg-vscode-list-hover cursor-pointer"
                >
                  <div className="flex items-center gap-2">
                    <i className="codicon codicon-circle-outline" />
                    <span className="truncate">
                      {prompt.name || `Prompt ${index + 1}`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**Prompts parity requirements:**

- Status icons and step status classes
- Retry count display and end-condition results
- Click-to-edit behavior

#### Day 7: OutputSection Component

**File:** `src/ui/webview-react/components/layout/OutputSection.tsx`

```tsx
import React, { useRef, useEffect } from "react";
import { useWorkflowStore } from "@store/workflowStore";
import { useUiStore } from "@store/uiStore";

export default function OutputSection() {
  const currentStep = useWorkflowStore((state) => state.currentStep);
  const cliOutputs = useWorkflowStore((state) => state.cliOutputs);
  const collapsed = useUiStore((state) => state.outputCollapsed);
  const toggleCollapse = useUiStore((state) => state.toggleOutputCollapse);
  const autoscrollEnabled = useUiStore((state) => state.autoscrollEnabled);
  const setAutoscroll = useUiStore((state) => state.setAutoscroll);

  const outputRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoscrollEnabled && outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [cliOutputs, autoscrollEnabled]);

  const outputs = cliOutputs[currentStep] || [];

  return (
    <div className="h-full flex flex-col bg-vscode-bg border-b border-vscode-border">
      {/* Header */}
      <div className="flex items-center justify-between p-2 border-b border-vscode-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={toggleCollapse}
            className="p-1 hover:bg-vscode-list-hover rounded"
          >
            <i
              className={`codicon codicon-chevron-${collapsed ? "right" : "down"}`}
            />
          </button>
          <i className="codicon codicon-terminal" />
          <h3 className="font-semibold">Output</h3>
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-sm">
            <input
              type="checkbox"
              checked={autoscrollEnabled}
              onChange={(e) => setAutoscroll(e.target.checked)}
            />
            <span>Autoscroll</span>
          </label>
          <button className="btn-secondary text-xs px-2 py-1">Export</button>
        </div>
      </div>

      {/* Content */}
      {!collapsed && (
        <div
          ref={outputRef}
          className="flex-1 overflow-y-auto p-4 font-mono text-sm"
        >
          {outputs.length === 0 ? (
            <div className="text-center text-gray-500 mt-4">No output yet</div>
          ) : (
            <div className="flex flex-col gap-2">
              {outputs.map((output, index) => (
                <div key={index} className="whitespace-pre-wrap">
                  {output}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**Output parity requirements:**

- Render structured CLI events (tool calls, file edits, diffs, bash output, errors)
- Support streaming chunks + streaming events
- Preserve autoscroll behavior and export output functionality

#### Day 8: EditorSection Component

**File:** `src/ui/webview-react/components/layout/EditorSection.tsx`

```tsx
import React from "react";
import { useUiStore } from "@store/uiStore";

export default function EditorSection() {
  const collapsed = useUiStore((state) => state.editorCollapsed);
  const toggleCollapse = useUiStore((state) => state.toggleEditorCollapse);
  const propertiesOpen = useUiStore((state) => state.propertiesDrawerOpen);
  const toggleProperties = useUiStore((state) => state.togglePropertiesDrawer);

  return (
    <div className="h-full flex flex-col bg-vscode-bg">
      {/* Header */}
      <div className="flex items-center justify-between p-2 border-b border-vscode-border flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={toggleCollapse}
            className="p-1 hover:bg-vscode-list-hover rounded"
          >
            <i
              className={`codicon codicon-chevron-${collapsed ? "right" : "down"}`}
            />
          </button>
          <i className="codicon codicon-edit" />
          <h3 className="font-semibold">Prompt Editor</h3>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-gray-500">New Prompt</span>
          <input
            type="text"
            className="input-field text-sm px-2 py-1"
            placeholder="Prompt name (optional)"
          />
        </div>
      </div>

      {/* Content */}
      {!collapsed && (
        <div className="flex-1 flex min-h-0">
          {/* Editor */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex-1 border border-vscode-input-border m-2">
              {/* TODO: CodeMirror editor */}
              <textarea className="w-full h-full p-2 bg-vscode-input-bg text-vscode-input-fg resize-none" />
            </div>

            {/* Footer */}
            <div className="flex items-center justify-between p-2 border-t border-vscode-border flex-shrink-0">
              <button
                onClick={toggleProperties}
                className="btn-secondary text-sm px-2 py-1"
              >
                <i className="codicon codicon-symbol-property mr-1" />
                Properties
              </button>

              <span className="text-sm text-gray-500">0 tokens</span>

              <div className="flex gap-2">
                <button className="btn-secondary">Queue</button>
                <button className="btn-primary">Run</button>
              </div>
            </div>
          </div>

          {/* Properties Drawer */}
          {propertiesOpen && (
            <div className="w-80 border-l border-vscode-border flex flex-col bg-vscode-bg flex-shrink-0">
              <div className="flex items-center justify-between p-3 border-b border-vscode-border">
                <h3 className="font-semibold">Prompt Properties</h3>
                <button
                  onClick={toggleProperties}
                  className="p-1 hover:bg-vscode-list-hover rounded"
                >
                  <i className="codicon codicon-close" />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto p-3">
                {/* TODO: Property controls */}
                <div className="space-y-3">
                  <div>
                    <label className="block text-sm mb-1">Provider:</label>
                    <select className="input-field w-full text-sm">
                      <option>Default</option>
                      <option>Copilot CLI</option>
                      <option>Claude CLI</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

**Editor parity requirements:**

- Run/Queue actions with RUN_NEXT/RUN_BEFORE_CURRENT logic
- Prompt CRUD: update, cancel edit, delete with confirm
- Properties drawer: provider/model/agent/resume/sessionId/dynamic/end condition
- Token counting via tokenizer, state persistence in new-prompt mode

---

### Phase 3: SettingsDrawer & Remaining Components (Days 9-12)

#### Day 9: SettingsDrawer Component (Merged Settings + Workflow Properties)

**File:** `src/ui/webview-react/components/layout/SettingsDrawer.tsx`

```tsx
import React from "react";
import { useUiStore } from "@store/uiStore";
import { useVsCodeApi } from "@hooks/useVsCodeApi";

export default function SettingsDrawer() {
  const vscode = useVsCodeApi();
  const toggleSettings = useUiStore((state) => state.toggleSettingsDrawer);

  return (
    <div className="h-full flex flex-col bg-vscode-bg border-l border-vscode-border">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-vscode-border flex-shrink-0">
        <h2 className="text-lg font-semibold">Settings</h2>
        <button
          onClick={toggleSettings}
          className="p-1 hover:bg-vscode-list-hover rounded"
          title="Close settings"
        >
          <i className="codicon codicon-close" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4">
        <div className="space-y-6">
          {/* Workflow Properties */}
          <section>
            <h3 className="text-base font-semibold mb-3">
              Workflow Properties
            </h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-1">Provider:</label>
                <select className="input-field w-full">
                  <option>Copilot CLI</option>
                  <option>Claude CLI</option>
                  <option>Codex CLI</option>
                </select>
              </div>

              <div>
                <label className="block text-sm mb-1">Model:</label>
                <select className="input-field w-full">
                  <option>Claude Sonnet 4.5</option>
                  <option>Claude Opus 4.5</option>
                  <option>Claude Haiku 4.5</option>
                </select>
              </div>

              <div>
                <label className="block text-sm mb-1">Agent:</label>
                <input
                  type="text"
                  className="input-field w-full"
                  placeholder="None"
                />
              </div>
            </div>
          </section>

          {/* Session Settings */}
          <section>
            <h3 className="text-base font-semibold mb-3">Session Settings</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-sm mb-2">Execution Mode:</label>
                <div className="space-y-1">
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="execution-mode"
                      value="interactive"
                      defaultChecked
                    />
                    <span className="text-sm">Interactive</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="execution-mode"
                      value="headless"
                    />
                    <span className="text-sm">Headless</span>
                  </label>
                </div>
              </div>

              <label className="flex items-center gap-2">
                <input type="checkbox" defaultChecked />
                <span className="text-sm">
                  Respect .gitignore for completions
                </span>
              </label>
            </div>
          </section>
        </div>
      </div>

      {/* Footer */}
      <div className="p-4 border-t border-vscode-border flex-shrink-0">
        <button
          onClick={() => vscode.postMessage({ type: "OPEN_SETTINGS" })}
          className="w-full btn-secondary flex items-center justify-center gap-2"
        >
          <i className="codicon codicon-settings-gear" />
          <span>More Settings...</span>
        </button>
      </div>
    </div>
  );
}
```

**Merged Settings Requirements (parity with settings.js):**

- Provider availability indicators (checking/available/unavailable) and messages
- Dynamic model options (ModelRegistry) + CLI model filtering
- Workflow properties editing (provider/model/agent/resume/sessionId/allowDynamic/endCondition)
- “Set as Default” behavior for workflow properties
- Execution mode radio (interactive/headless)
- Respect .gitignore toggle (config update)
- “More Settings…” button opens VS Code settings
- Workflow loaded/unloaded state updates the form
- Pending workflow properties stored before workflow creation
- Agent discovery list (with “None”) updates dynamically

**Remove separate settings webview:**

- The React SettingsDrawer replaces settings.html/settings.js/settings.scss
- Settings view registration should be removed or redirected to the unified dashboard view
- All settings messages are now handled by the unified provider

#### Days 10-12: Remaining Components

**Implement these components by referencing vanilla JS counterparts:**

1. **Prompts components:**
   - `PromptItem.tsx` - Individual prompt with status icon
   - `StatusIcon.tsx` - Status indicator icons
   - `PromptCounter.tsx` - "Completed X of Y"

2. **Output components:**
   - `CliOutput.tsx` - Parse and render CLI output
   - `ToolCallOutput.tsx` - Format tool calls
   - `BashOutput.tsx` - Bash output with expand/collapse
   - `StatusMessage.tsx` - Operation status display

3. **Workflow components:**
   - `WorkflowControls.tsx` - New/Load/Queue split button
   - `WorkflowStatus.tsx` - Workflow name + execution state
   - `TemplateModal.tsx` - Create from template modal
   - `RecentWorkflows.tsx` - Recent workflows dropdown

4. **Shared components:**
   - `Button.tsx` - Reusable button variants
   - `Modal.tsx` - Reusable modal
   - `SplitButton.tsx` - Split button component
   - `Collapsible.tsx` - Collapsible section

**Reference files:**

- Current logic: `src/ui/webview/*.js`
- Current styles: `src/ui/webview/*.scss`

---

### Phase 4: Integration & Testing (Days 13-16)

#### Day 13: Unified Provider (Dashboard + Settings merge)

**Create unified provider** (`src/ui/FlightPathWebviewProvider.ts`):

```typescript
import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";

export class FlightPathWebviewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "flightpath.dashboard";
  private _view?: vscode.WebviewView;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, "out")],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      this.handleWebviewMessage(message); // Routes both dashboard + settings actions
    });
  }

  public postMessage(message: any) {
    this._view?.webview.postMessage(message);
  }

  private _getHtmlForWebview(webview: vscode.Webview): string {
    const buildPath = vscode.Uri.joinPath(
      this._extensionUri,
      "out",
      "ui",
      "webview-react"
    );
    const htmlPath = vscode.Uri.joinPath(buildPath, "index.html");
    let html = fs.readFileSync(htmlPath.fsPath, "utf8");

    // Replace asset paths with webview URIs
    html = html.replace(
      /(<link[^>]*href="|<script[^>]*src=")([^"]+)"/g,
      (match, prefix, assetPath) => {
        const assetUri = webview.asWebviewUri(
          vscode.Uri.joinPath(buildPath, assetPath.replace(/^\//, ""))
        );
        return `${prefix}${assetUri}"`;
      }
    );

    // Add CSP
    const cspSource = webview.cspSource;
    html = html.replace(
      "<head>",
      `<head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource}; font-src ${cspSource}; img-src ${cspSource} data:;">`
    );

    return html;
  }

  private handleWebviewMessage(message: any) {
    // Merge handling from FlightPathDashboardProvider + FlightPathSettingsProvider
    // - Dashboard message types: RUN/PAUSE/STOP/EXECUTE_PROMPT/UPDATE_PROMPT/etc.
    // - Settings message types: CHANGE_PROVIDER/CHANGE_MODEL/UPDATE_WORKFLOW_PROPERTY/SET_AS_DEFAULT/etc.
    // - Shared: READY, OPEN_SETTINGS, MODEL_OPTIONS_UPDATE, PROVIDER_STATUS_UPDATE
  }
}
```

**Merge plan (FlightPathDashboardProvider + FlightPathSettingsProvider):**

- Single provider manages one webview and sends a combined INIT payload:
  - dashboard state: fileName, workflowName, prompts, executionState, currentStep, totalSteps
  - settings state: globalSettings, workflowProperties, modelOptions, providerStatus, availableAgents
- Subscribe to model registry updates (onModelsLoaded) to send MODEL_OPTIONS_UPDATE
- Run provider availability checks (CLI and Copilot Chat) and send PROVIDER_STATUS_UPDATE
- Discover agents and send AGENTS_UPDATE
- Listen for configuration changes and refresh settings state
- Preserve pending workflow properties workflow (store before workflow exists, apply on create/load)
- Preserve workflow property updates with ensureProviderAndModel, allowDeletes, onlyIfUndefined
- Keep export output implementation and output folder behavior
- Keep completion handling (REQUEST_COMPLETIONS) and OPEN_FILE handling
- Keep workflow status handlers (recent workflows, rename, clear history)
- Keep template modal flow (template list, variables, default template)
- Keep dynamic queue notifications and time/size limit notifications
- Keep READY behavior to trigger deferred auto-load

**Update extension.ts:**

```typescript
const webviewProvider = new FlightPathWebviewProvider(context.extensionUri);
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider(
    FlightPathWebviewProvider.viewType,
    webviewProvider
  )
);

// Pass to FlightPathManager
flightPathManager.setWebviewProvider(webviewProvider);
```

**Update package.json view contributions:**

- Remove or disable the standalone settings webview view when React mode is enabled
- Ensure only one view ID remains active (dashboard) to avoid duplicate providers

#### Day 14: Message Handling

**Complete all message handlers in App.tsx:**

- Map MESSAGE_TYPES from DashboardConstants
- Implement handlers for all 30+ message types
- Update stores based on messages
- Test bidirectional communication

#### Day 15: CodeMirror Integration

**Create CodeMirror React component** (`src/ui/webview-react/components/editor/CodeMirrorEditor.tsx`):

```tsx
import React, { useEffect, useRef } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { markdown } from "@codemirror/lang-markdown";
import { autocompletion } from "@codemirror/autocomplete";

interface CodeMirrorEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function CodeMirrorEditor({
  value,
  onChange,
  placeholder
}: CodeMirrorEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView>();

  useEffect(() => {
    if (!editorRef.current) return;

    // Create editor instance
    const startState = EditorState.create({
      doc: value,
      extensions: [
        basicSetup,
        markdown(),
        autocompletion(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newValue = update.state.doc.toString();
            onChange(newValue);
          }
        }),
        // VS Code theme integration
        EditorView.theme({
          "&": {
            backgroundColor: "var(--vscode-input-background)",
            color: "var(--vscode-input-foreground)",
          },
          ".cm-content": {
            fontFamily: "var(--vscode-editor-font-family)",
            fontSize: "var(--vscode-editor-font-size)",
          },
          ".cm-gutters": {
            backgroundColor: "var(--vscode-editorGutter-background)",
            color: "var(--vscode-editorLineNumber-foreground)",
          },
          ".cm-activeLineGutter": {
            backgroundColor: "var(--vscode-editor-lineHighlightBackground)",
          },
          "&.cm-focused .cm-cursor": {
            borderLeftColor: "var(--vscode-editorCursor-foreground)",
          },
          "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": {
            backgroundColor: "var(--vscode-editor-selectionBackground)",
          },
        }),
      ],
    });

    const view = new EditorView({
      state: startState,
      parent: editorRef.current,
    });

    viewRef.current = view;

    return () => {
      view.destroy();
      viewRef.current = undefined;
    };
  }, []); // Only create once

  // Update content when value prop changes externally
  useEffect(() => {
    if (viewRef.current) {
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
    }
  }, [value]);

  return <div ref={editorRef} className="codemirror-container" />;
}
```

**Use in PromptEditor component:**

```tsx
import { CodeMirrorEditor } from "@components/editor/CodeMirrorEditor";

function PromptEditorSection() {
  const [promptText, setPromptText] = useState("");

  return (
    <div className="flex-1 border border-vscode-input-border m-2">
      <CodeMirrorEditor
        value={promptText}
        onChange={setPromptText}
        placeholder="Enter your prompt here..."
      />
    </div>
  );
}
```

**Migration notes:**

- **Replaced CDN loader**: CodeMirror now installed via npm packages for SSR compatibility
- **Spell checking**: Port Typo.js integration from `codemirror-editor.js` (keep same dictionary loading approach)
- **Autocomplete**: Port `@file` and `#file:` completion logic from existing implementation
- **Token counting**: Import `gpt-tokenizer` npm package instead of global script

#### Day 16: Testing & Polish

**Manual testing checklist:**

- [ ] Load workflow file
- [ ] Run execution
- [ ] Pause/resume/stop
- [ ] Edit prompts
- [ ] Create new prompts
- [ ] Resize all panels
- [ ] Toggle settings drawer
- [ ] Properties drawer
- [ ] Export output
- [ ] Recent workflows
- [ ] Layout persistence (reload page)
- [ ] Structured output rendering (diffs, tool calls, bash output, errors)
- [ ] Streaming output (chunks + events) and autoscroll toggle
- [ ] Prompt list status icons, retries, end condition results
- [ ] Prompt properties (resume/sessionId/dynamic/end condition) round-trip
- [ ] Workflow name inline rename persists
- [ ] Template modal variable validation
- [ ] Provider availability badges and model lists update after registry load
- [ ] “Set as Default” workflow property button
- [ ] Config updates: execution mode + respect gitignore

**Bundle analysis:**

```bash
npm run build:webview
npx vite-bundle-visualizer out/ui/webview-react
```

**Expected bundle:**

- React 19 + ReactDOM: ~130-140KB (gzipped: ~45-50KB)
- react-resizable-panels: ~20KB (gzipped: ~7KB)
- App code: ~80KB (gzipped: ~25KB)
- Tailwind CSS: ~10KB (gzipped: ~3KB)
- **Total: ~240-250KB (~80-85KB gzipped)**

**Note:** Bundle sizes are estimates. React 19 may have slight size differences from React 18.

---

## Migration Strategy

### Feature Flag Approach

1. **Week 1 (Days 1-8):** Build React version alongside vanilla JS
2. **Week 2 (Days 9-16):** Complete implementation and test
3. **Week 3:** Add setting `flightpath.useReactWebview` (default: false)

- When false: keep existing dashboard + settings webviews/providers
- When true: use unified React webview provider and disable settings view registration

4. **Week 4:** Beta test with flag enabled
5. **Week 5:** Switch default to true, monitor
6. **Week 6:** Remove vanilla JS code

### Rollback Plan

If critical issues:

1. Switch `useReactWebview` default back to false
2. Fix React version issues
3. Re-test thoroughly
4. Retry cutover

---

## Implementation Checklist

### Foundation (Days 1-4)

**Dependency Migration:**
- [ ] Install React core dependencies
- [ ] Install build tool dependencies (Vite, Tailwind, TypeScript)
- [ ] Install CodeMirror npm packages (replace CDN loader)
- [ ] Install diff npm package (replace pre-bundled script)
- [ ] Install gpt-tokenizer npm package (replace pre-bundled script)
- [ ] Install vite-plugin-static-copy for asset copying
- [ ] Verify Typo.js script tag approach (keep legacy, no npm package)

**Build Configuration:**
- [ ] Create Vite config with static copy plugin
- [ ] Configure static copy targets (dictionaries, codicons, custom-icons.css)
- [ ] Create Tailwind config with VS Code theme variables
- [ ] Update package.json scripts (include custom icon generation)
- [ ] Test that `npm run generate-custom-icons` runs before Vite build

**Core Files:**
- [ ] Create main.tsx entry point
- [ ] Create index.html template (with Typo.js script tag placeholder)
- [ ] Create global styles (import codicons + custom-icons CSS)
- [ ] Create useVsCodeApi hook
- [ ] Create useMessageHandler hook
- [ ] Create utility wrappers (diff.ts, tokenizer.ts)
- [ ] Create all Zustand stores
- [ ] Create App.tsx with PanelGroup
- [ ] Test build and verify assets copied correctly

### Layout Components (Days 5-8)

- [ ] Header component
- [ ] PromptsPanel component
- [ ] OutputSection component
- [ ] EditorSection component
- [ ] Verify resize handles work
- [ ] Verify panel persistence
- [ ] Remove legacy layout toggle controls

### Settings & Details (Days 9-12)

- [ ] SettingsDrawer component
- [ ] Merge settings form into dashboard view
- [ ] Provider availability + model options UI
- [ ] Workflow properties + Set as Default
- [ ] Execution mode + respect gitignore toggles
- [ ] PromptItem component
- [ ] StatusIcon component
- [ ] CliOutput component
- [ ] Structured output rendering (tool calls/diffs/bash)
- [ ] Streaming output handling
- [ ] WorkflowControls component
- [ ] TemplateModal component
- [ ] All shared components

### Integration (Days 13-16)

- [ ] FlightPathWebviewProvider
- [ ] Update extension.ts
- [ ] Remove settings webview registration
- [ ] Merge settings + dashboard message handling
- [ ] Complete message handlers
- [ ] CodeMirror integration
- [ ] State persistence (vscode state + localStorage)
- [ ] Asset pipeline (codicons, typo, tokenizer, diff)
- [ ] Manual testing
- [ ] Bundle size check
- [ ] Fix bugs

### Deployment

- [ ] Add feature flag
- [ ] Beta test (1 week)
- [ ] Switch default
- [ ] Monitor (1-2 weeks)
- [ ] Remove vanilla JS
- [ ] Update docs

---

## Expected Outcomes

**Code Metrics:**

- 28% code reduction (11,241 → 8,000 lines)
- 82% CSS reduction (2,500 → 450 lines)
- Bundle: ~240KB total (~80KB gzipped)

**Quality Improvements:**

- Type safety with TypeScript strict mode
- Component isolation for easier testing
- Modern resizable panel UX
- Layout persistence
- HMR during development (<200ms)

**User Benefits:**

- Resizable workspace (like VS Code)
- Customizable layout
- Faster feature development (50% reduction)
- Fewer bugs (type checking)

---

## Notes for Implementation Agents

1. **Reference vanilla JS:** All logic exists in `src/ui/webview/*.js` - port to React components
2. **Message types:** Use DashboardConstants.ts MESSAGE_TYPES for consistency
3. **VS Code theme:** All colors via CSS variables (see globals.css)
4. **Panel persistence:** react-resizable-panels auto-saves to localStorage
5. **Dependencies:** Use latest stable versions (React 19+, Vite 6+) with compatible ranges (^)
6. **Migration:** Replace pre-bundled scripts with npm packages (diff, gpt-tokenizer, CodeMirror)
7. **Static assets:** Use vite-plugin-static-copy for dictionaries, codicons, custom-icons.css
8. **Typo.js:** Keep as script tag (no npm alternative), dictionaries copied by Vite plugin
9. **Custom icons:** Must run generation script before Vite build (automated in package.json)
10. **CodeMirror:** Use `@codemirror/*` npm packages, NOT CDN loader
11. **Testing:** Focus on message handling and panel interactions
12. **Bundle size:** Monitor with vite-bundle-visualizer, keep under 250KB

## Reference Files

**Current implementation:**

- `src/ui/webview/dashboard.js` - Main orchestrator
- `src/ui/webview/message-router.js` - Message handling
- `src/ui/webview/state-manager.js` - State management
- `src/ui/webview/editor-manager.js` - Editor logic
- `src/ui/webview/output-manager.js` - Output rendering
- `src/ui/webview/workflow-manager.js` - Workflow actions
- `src/ui/webview/prompts-manager.js` - Prompts list

**Styles:**

- `src/ui/webview/dashboard.scss` - Component styles (port to Tailwind)
- `src/ui/webview/shared.scss` - Variables and mixins

**Extension:**

- `src/ui/FlightPathDashboardProvider.ts` - Current provider (replace)
- `src/types/DashboardConstants.ts` - Message types (reuse)

---

## Dependency Migration Summary

**Before (Vanilla JS) → After (React):**

| Dependency | Vanilla Approach | React Approach | Files Affected |
|------------|------------------|----------------|----------------|
| **diff** | Pre-bundled `diff.js` script | npm package `diff` | output-manager.js → CliOutput.tsx |
| **gpt-tokenizer** | Pre-bundled script | npm package `gpt-tokenizer` | editor-manager.js → utils/tokenizer.ts |
| **CodeMirror** | CDN via codemirror-loader.js | `@codemirror/*` npm packages | codemirror-editor.js → CodeMirrorEditor.tsx |
| **Typo.js** | Script tag | Script tag (UNCHANGED) | dashboard.html → index.html |
| **Dictionaries** | Static files | Copied by vite-plugin-static-copy | src/ui/webview/dictionaries/ → out/ui/webview-react/dictionaries/ |
| **Codicons** | CSS file | Copied + imported in globals.css | src/ui/webview/codicons/ → out/ui/webview-react/codicons/ |
| **Custom icons** | Auto-generated CSS | Generated + copied by plugin | src/ui/webview/custom-icons.css → out/ui/webview-react/assets/custom-icons.css |

**Build process changes:**

1. **Before build:** Run `npm run generate-custom-icons` (automated in scripts)
2. **During build:** Vite copies static assets (dictionaries, codicons, custom-icons.css)
3. **After build:** All assets available at webview URIs (CSP-compliant)

**No breaking changes:**

- Typo.js spell checking still works (same dictionary files)
- Codicons still display (CSS copied, fonts included)
- Custom icons still work (SVG → CSS data URI generation unchanged)
- Diff rendering logic preserved (just using npm package API)
- Token counting logic preserved (same tokenizer, npm package API)
