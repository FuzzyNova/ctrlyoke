---
applyTo: "src/ui/webview-react/**"
---

<purpose>
React-based webview UI for FlightPath dashboard. Modern component architecture with Zustand state management, CodeMirror 6 editor, and Tailwind CSS styling.
</purpose>

<architecture>

## Tech Stack

- React 19 + TypeScript
- Vite (build system)
- Zustand (state management)
- Tailwind CSS (styling)
- CodeMirror 6 (prompt editor)
- react-resizable-panels (layout)

## Build System

Vite builds the webview as a separate bundle consumed by FlightPathDashboardProvider:

- Entry: main.tsx
- Output: out/webview-react/assets/
- Hot reload: Not supported (requires full extension reload)
- Build: npm run build:webview
- Watch: npm run watch:webview

## Directory Structure

```
src/ui/webview-react/
├── App.tsx                  # Main layout with resizable panels
├── main.tsx                 # React entry point
├── index.html               # Vite HTML template
├── constants.ts             # Panel sizing constants
├── components/              # React components
│   ├── layout/              # Main layout sections
│   │   ├── Header.tsx       # Workflow controls, execution badge
│   │   ├── PromptsPanel.tsx # Prompt list with drag-and-drop
│   │   ├── OutputSection.tsx # CLI output rendering
│   │   ├── EditorSection.tsx # Prompt editor container
│   │   └── SettingsDrawer.tsx # Harness/model settings
│   ├── editor/              # Editor components
│   │   ├── CodeMirrorEditor.tsx # CodeMirror 6 instance
│   │   ├── PromptEditor.tsx # Editor with toolbar
│   │   └── PropertiesDrawer.tsx # Prompt properties panel
│   ├── prompts/             # Prompt list components
│   ├── output/              # Output rendering components
│   ├── workflow/            # Workflow management (modals, buttons)
│   └── shared/              # Reusable UI components
├── hooks/                   # React hooks
│   ├── useVsCodeApi.ts      # VS Code API singleton
│   ├── useMessageHandler.ts # Message routing from extension
│   └── useMediaQuery.ts     # Responsive layout detection
├── store/                   # Zustand state stores
│   ├── workflowStore.ts     # Core workflow data
│   ├── uiStore.ts           # Layout and UI state
│   ├── editorStore.ts       # Prompt editor state
│   └── settingsStore.ts     # Harness/model configuration
├── types/                   # TypeScript types
│   ├── messages.ts          # Re-exports from src/types/
│   └── vscode.ts            # VS Code API types
├── utils/                   # Utility functions
└── styles/                  # CSS and Tailwind config
```

</architecture>

<stateManagement>

## Zustand Store Pattern

Four separate stores by domain (avoid mixing concerns):

### workflowStore - Core Workflow Data

```typescript
interface WorkflowState {
  fileName: string | null;
  workflowName: string | null;
  prompts: PromptItem[];
  executionState: ExecutionState;
  currentStep: number;
  totalSteps: number;
  cliOutputs: Record<number, CliOutput[]>;
  retryStates: Record<number, RetryState>;
  statusMessages: Record<number, StatusMessage[]>;
  streamingChunks: Record<number, string>;
}
```

**Use cases**: Workflow execution, prompt list, CLI outputs, step progress

### uiStore - Layout and UI State

```typescript
interface UiState {
  settingsCollapsed: boolean;
  promptsCollapsed: boolean;
  outputCollapsed: boolean;
  editorCollapsed: boolean;
  showNewWorkflowModal: boolean;
  recentWorkflows: RecentWorkflow[];
  templates: TemplateInfo[];
  savedPanelSizes: PanelSizes;
}
```

**Use cases**: Panel collapse state, modals, recent files, layout persistence

**Persistence**: Synced to localStorage via middleware

### editorStore - Prompt Editor State

```typescript
interface EditorState {
  selectedPromptIndex: number | null;
  mode: "view" | "edit" | "new";
  content: string;
  isDirty: boolean;
  propertyValues: PropertyValues;
  endCondition: EndConditionConfig | null;
  savedNewPromptState: SavedNewPromptState | null;
}
```

**Use cases**: Editor content, prompt properties, save/revert operations

**Persistence**: Synced to VS Code webview state API via FlightPathDashboardProvider

### settingsStore - Harness and Model Configuration

```typescript
interface SettingsState {
  modelOptions: Record<HarnessId, ModelOption[]>;
  availableAgents: AgentOption[];
  harnessStatus: Record<HarnessId, HarnessStatus>;
  globalSettings: GlobalSettings;
  workflowProperties: WorkflowProperties;
}
```

**Use cases**: Harness/model selection, workflow properties, global defaults

## Store Access Patterns

**Inside React components** (reactive):

```typescript
function MyComponent() {
  const prompts = useWorkflowStore((s) => s.prompts);
  const setPrompts = useWorkflowStore((s) => s.setPrompts);
  // Component re-renders when prompts change
}
```

**Inside message handlers** (non-reactive):

```typescript
handlers[MESSAGE_TYPES.FILE_SELECTED] = (message) => {
  const store = useWorkflowStore.getState();
  store.loadWorkflow(message.data);
  // No re-render, direct state update
};
```

**Outside React** (utility functions):

```typescript
import { useWorkflowStore } from "@store/workflowStore";

export function getCurrentStep(): number {
  return useWorkflowStore.getState().currentStep;
}
```

</stateManagement>

<messagePassing>

## Extension ↔ Webview Communication

**Single source of truth**: src/types/DashboardConstants.ts and src/types/WebviewMessageTypes.ts

React webview re-exports all types from extension-side definitions (no duplication).

### Message Flow

**Extension → Webview**:

1. Extension calls `panel.postMessage({ type: MESSAGE_TYPES.INIT, data: {...} })`
2. Webview receives via `useMessageHandler` hook
3. Handler routes to appropriate store update
4. Store triggers React re-render
5. Components display updated state

**Webview → Extension**:

1. Component calls `sendMessage(MESSAGE_TYPES.START_WORKFLOW)`
2. VS Code API posts message to extension
3. Extension processes command
4. Extension sends response message back (if needed)

### Message Handler Architecture

All message routing centralized in useMessageHandler hook:

```typescript
export function useMessageHandler() {
  useEffect(() => {
    const handlers = createMessageHandlers();

    const listener = (event: MessageEvent) => {
      const message = event.data;
      const handler = handlers[message.type];
      if (handler) {
        handler(message);
      }
    };

    window.addEventListener("message", listener);
    return () => window.removeEventListener("message", listener);
  }, []);
}
```

### Key Message Types

**Workflow Loading**:

- `init` - Initial state from extension
- `fileSelected` - New workflow loaded
- `sessionRestored` - Session resumed

**Execution Updates**:

- `executionStateChanged` - State transitions (idle → running → paused)
- `progressUpdate` - Step completion
- `stepStatusChanged` - Individual step status
- `retryAttemptChanged` - Retry counter updates

**Output Rendering**:

- `cliOutput` - Batch output (array of events)
- `cliStreamingChunk` - Real-time text streaming
- `cliStreamingEvents` - Structured events (tool calls, diffs)

**Settings Sync**:

- `globalSettingsUpdate` - VS Code settings changed
- `workflowPropertiesUpdate` - Working file properties changed
- `modelOptionsUpdate` - Model discovery results
- `harnessStatusUpdate` - CLI availability status

**Dynamic Queue**:

- `promptsExtended` - New prompts added to queue
- `promptDeleted` - Prompt removed from queue

</messagePassing>

<terminology>

## Provider → Harness Rename

Throughout the React webview, "provider" was renamed to "harness" for consistency:

**Old (Vanilla JS)**:

- `provider` property
- `providerStatus`
- `PROVIDER_IDS`

**New (React)**:

- `harness` property
- `harnessStatus`
- `HARNESS_IDS`

**Harness types** (from DashboardConstants.ts):

- `copilot-cli` - GitHub Copilot CLI
- `copilot-chat` - Copilot Chat window
- `claude-cli` - Anthropic Claude CLI
- `codex-cli` - OpenAI Codex CLI

**Affected areas**:

- Settings panel (harness selection dropdown)
- Workflow properties (runtime metadata)
- Status indicators (harness availability)
- Message types (harnessStatusUpdate)

</terminology>

<componentPatterns>

## Component Design Patterns

### Layout Components

Use react-resizable-panels for flexible layout:

```typescript
<PanelGroup direction="horizontal">
  <Panel ref={promptsRef} collapsible>
    <PromptsPanel />
  </Panel>
  <Panel ref={outputRef} collapsible>
    <OutputSection />
  </Panel>
</PanelGroup>
```

**Panel state management**:

- Collapse state stored in uiStore (source of truth)
- Imperative refs for programmatic collapse/expand
- Saved sizes restored on expand
- Mobile vs desktop layout switching

### Event Handlers

Use store actions, not direct state mutation:

```typescript
// ❌ Wrong
function handleClick() {
  useWorkflowStore.setState({ currentStep: 5 });
}

// ✅ Correct
function handleClick() {
  const setCurrentStep = useWorkflowStore((s) => s.setCurrentStep);
  setCurrentStep(5);
}
```

### Message Sending

Use sendMessage helper from useMessageHandler:

```typescript
import { sendMessage } from "@hooks/useMessageHandler";

function handleRun() {
  sendMessage(MESSAGE_TYPES.START_WORKFLOW, { promptIndex: 0 });
}
```

### Conditional Rendering

Use early returns and guard clauses:

```typescript
// ✅ Preferred
function PromptEditor() {
  const mode = useEditorStore((s) => s.mode);

  if (mode === "view") {
    return <PromptViewer />;
  }

  return <CodeMirrorEditor />;
}

// ❌ Avoid deep nesting
function PromptEditor() {
  const mode = useEditorStore((s) => s.mode);

  return (
    <div>
      {mode === "view" ? (
        <PromptViewer />
      ) : (
        <CodeMirrorEditor />
      )}
    </div>
  );
}
```

</componentPatterns>

<stylingConventions>

## Tailwind CSS Usage

All styling via Tailwind utility classes (no custom CSS except globals.css).

### Token Naming Convention

All VS Code CSS variables are mapped to semantic Tailwind color tokens in `tailwind.config.js`. **Never** use `[var(--vscode-*)]` arbitrary values in className strings — use the token name instead.

```tsx
// ✅ Correct — uses Tailwind token
<div className="bg-editor-bg text-foreground border-panel-border" />

// ❌ Wrong — inline vscode var
<div className="bg-[var(--vscode-editor-background)] text-[var(--vscode-foreground)]" />
```

**Exceptions** (use inline vars directly — cannot be Tailwind):

- `style={{...}}` props (boxShadow, outline, etc.)
- `EditorView.theme({...})` in CodeMirrorEditor.tsx (CodeMirror CSS-in-JS)
- `globals.css` `:root` rules and base element styles

### Complete Token Table

| Token                  | VS Code Variable                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| `editor-bg`            | `--vscode-editor-background`                                                                                    |
| `editor-fg`            | `--vscode-editor-foreground`                                                                                    |
| `foreground`           | `--vscode-foreground`                                                                                           |
| `panel-border`         | `--vscode-panel-border`                                                                                         |
| `sidebar-bg`           | `--vscode-sideBar-background`                                                                                   |
| `sidebar-drop-bg`      | `--vscode-sideBar-dropBackground`                                                                               |
| `focus-border`         | `--vscode-focusBorder`                                                                                          |
| `widget-border`        | `--vscode-widget-border`                                                                                        |
| `btn-bg`               | `--vscode-button-background`                                                                                    |
| `btn-hover`            | `--vscode-button-hoverBackground`                                                                               |
| `btn-fg`               | `--vscode-button-foreground`                                                                                    |
| `btn-border`           | `--vscode-button-border` (fallback: `rgba(255,255,255,0.1)` — ensures split-button dividers are always visible) |
| `btn-secondary-bg`     | `--vscode-button-secondaryBackground`                                                                           |
| `btn-secondary-hover`  | `--vscode-button-secondaryHoverBackground`                                                                      |
| `btn-secondary-fg`     | `--vscode-button-secondaryForeground`                                                                           |
| `input-bg`             | `--vscode-input-background`                                                                                     |
| `input-fg`             | `--vscode-input-foreground`                                                                                     |
| `input-border`         | `--vscode-input-border`                                                                                         |
| `input-placeholder`    | `--vscode-input-placeholderForeground`                                                                          |
| `input-error-bg`       | `--vscode-inputValidation-errorBackground`                                                                      |
| `input-error-fg`       | `--vscode-inputValidation-errorForeground`                                                                      |
| `input-error-border`   | `--vscode-inputValidation-errorBorder`                                                                          |
| `list-hover-bg`        | `--vscode-list-hoverBackground`                                                                                 |
| `list-hover-fg`        | `--vscode-list-hoverForeground`                                                                                 |
| `list-active-bg`       | `--vscode-list-activeSelectionBackground`                                                                       |
| `list-active-fg`       | `--vscode-list-activeSelectionForeground`                                                                       |
| `list-inactive-bg`     | `--vscode-list-inactiveSelectionBackground`                                                                     |
| `list-focus-bg`        | `--vscode-list-focusBackground`                                                                                 |
| `dropdown-bg`          | `--vscode-dropdown-background`                                                                                  |
| `dropdown-fg`          | `--vscode-dropdown-foreground`                                                                                  |
| `dropdown-border`      | `--vscode-dropdown-border`                                                                                      |
| `dropdown-selected-bg` | `--vscode-dropdown-selectedBackground`                                                                          |
| `description-fg`       | `--vscode-descriptionForeground`                                                                                |
| `error-fg`             | `--vscode-errorForeground`                                                                                      |
| `warning-fg`           | `--vscode-editorWarning-foreground`                                                                             |
| `info-fg`              | `--vscode-editorInfo-foreground`                                                                                |
| `link-fg`              | `--vscode-textLink-foreground`                                                                                  |
| `link-active-fg`       | `--vscode-textLink-activeForeground`                                                                            |
| `disabled-fg`          | `--vscode-disabledForeground`                                                                                   |
| `badge-bg`             | `--vscode-badge-background`                                                                                     |
| `badge-fg`             | `--vscode-badge-foreground`                                                                                     |
| `toolbar-hover-bg`     | `--vscode-toolbar-hoverBackground`                                                                              |
| `keybinding-bg`        | `--vscode-keybindingLabel-background`                                                                           |
| `notification-info-fg` | `--vscode-notificationsInfoIcon-foreground`                                                                     |
| `bash-status-success`  | `--vscode-charts-green`                                                                                         |
| `bash-status-error`    | `--vscode-charts-red`                                                                                           |
| `bash-status-running`  | `--vscode-charts-yellow`                                                                                        |

### Codicon integration

```tsx
<i className="codicon codicon-play" />
```

### Custom icon system (SVG sprites)

- Source: src/ui/icons/ (NOT copied to output)
- Generated: custom-icons.css (build-time)
- Usage: `<i className="flightpath-icon flightpath-icon-append" />`

</stylingConventions>

<codeQuality>

## TypeScript Strict Mode

All files must pass strict type checking:

```typescript
// ✅ Explicit types
interface Props {
  promptIndex: number;
  onSelect: (index: number) => void;
}

function PromptItem({ promptIndex, onSelect }: Props) {
  // ...
}

// ❌ Implicit any
function PromptItem(props) {
  // Type error: Parameter 'props' implicitly has 'any' type
}
```

## Imports

Use path aliases (configured in tsconfig.json and vite.config.ts):

```typescript
// ✅ Preferred
import { useWorkflowStore } from "@store/workflowStore";
import { MESSAGE_TYPES } from "@/types/messages";
import { sendMessage } from "@hooks/useMessageHandler";

// ❌ Avoid relative paths
import { useWorkflowStore } from "../../store/workflowStore";
```

**Path alias mapping**:

- `@/` → src/ui/webview-react/
- `@components/` → src/ui/webview-react/components/
- `@store/` → src/ui/webview-react/store/
- `@hooks/` → src/ui/webview-react/hooks/
- `@utils/` → src/ui/webview-react/utils/
- `@root/` → src/ (extension root, for type re-exports)

## Error Handling

Use try-catch for async operations:

```typescript
async function loadWorkflow(filePath: string) {
  try {
    sendMessage(MESSAGE_TYPES.LOAD_WORKFLOW, { filePath });
  } catch (error) {
    console.error("Failed to load workflow:", error);
    // Show error in UI if needed
  }
}
```

</codeQuality>

<testing>

## Testing Status

**Current**: No unit tests for React components (manual testing only)

**Planned**:

- Vitest for component tests
- React Testing Library for integration tests
- Store tests with mock state updates

**Manual testing**:

1. Run extension (F5)
2. Open FlightPath dashboard
3. Test workflow loading, execution, output rendering
4. Test panel collapse/expand
5. Test settings changes

</testing>

<migrations>

## Migration from Vanilla JS

Complete migration map in MIGRATION_MAP.md and MIGRATION_STATUS.md.

**Key differences**:

| Vanilla JS                 | React                   |
| -------------------------- | ----------------------- |
| Imperative DOM updates     | Declarative rendering   |
| Global state object        | Zustand stores          |
| Event listeners everywhere | Message handler hook    |
| Manual re-renders          | Automatic React updates |
| provider terminology       | harness terminology     |

**Breaking changes**:

- VS Code webview state API now stores editorStore only (not full state)
- localStorage used for UI layout persistence (new in React)
- Message types unchanged (backward compatible with extension)

</migrations>

<developmentWorkflow>

## Local Development

**Build webview**:

```bash
npm run build:webview        # Production build
npm run watch:webview        # Watch mode (rebuild on change)
```

**Build extension**:

```bash
npm run compile              # Development build
npm run watch                # Watch mode
```

**Debug**:

1. F5 to launch Extension Development Host
2. Open FlightPath dashboard
3. Use VS Code DevTools (Help → Toggle Developer Tools)
4. Check Console for webview logs

**Hot reload**: Not supported - requires full extension reload after webview changes

## Adding New Components

1. Create component in appropriate subdirectory:
   - Layout sections → components/layout/
   - Reusable UI → components/shared/
   - Domain-specific → components/prompts/, components/output/, etc.

2. Export from components/index.ts for easy imports

3. Use TypeScript interfaces for props

4. Follow naming: PascalCase for components, camelCase for utilities

## Adding New Message Types

1. Define type in src/types/DashboardConstants.ts (extension side)
2. Add to WebviewMessageTypes.ts if payload structure needed
3. React webview automatically gets type via re-export
4. Add handler in useMessageHandler.ts
5. Update appropriate store with handler logic

## Adding New Store State

1. Define interface in store file
2. Add to store state interface
3. Create action methods (set*, update*, add\*, etc.)
4. Use immutable updates via Zustand `set()`
5. Consider persistence (localStorage for UI, VS Code state for editor)

</developmentWorkflow>

<performanceConsiderations>

## Optimization Strategies

**Store selectors**: Use granular selectors to minimize re-renders

```typescript
// ✅ Selective - only re-renders when currentStep changes
const currentStep = useWorkflowStore((s) => s.currentStep);

// ❌ Over-subscribing - re-renders on any workflow change
const workflow = useWorkflowStore();
const currentStep = workflow.currentStep;
```

**Memoization**: Use useMemo for expensive computations

```typescript
const filteredPrompts = useMemo(
  () => prompts.filter((p) => p.status === "completed"),
  [prompts]
);
```

**Event handlers**: Use useCallback to prevent recreation

```typescript
const handleClick = useCallback(() => {
  sendMessage(MESSAGE_TYPES.START_WORKFLOW);
}, []);
```

**Large lists**: Consider virtualization for 100+ items (not currently implemented)

</performanceConsiderations>
