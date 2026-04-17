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
- Zustand + zundo (state management + undo/redo)
- Tailwind CSS (styling)
- CodeMirror 6 (prompt editor)
- react-resizable-panels (layout)
- Vitest + React Testing Library (tests)

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
├── vite.config.ts           # Vite build configuration
├── tailwind.config.js       # Tailwind + VS Code token mapping
├── postcss.config.js        # PostCSS configuration
├── tsconfig.json            # TypeScript config for webview
├── tsconfig.node.json       # TypeScript config for Vite/Node tooling
├── vite-env.d.ts            # Vite environment type declarations
├── vitest.config.ts         # Vitest test configuration
├── static/                  # Static assets (custom-icons.css, dictionaries)
├── terminalRegistry.ts      # xterm.js instance owner (outside React lifecycle)
├── components/              # React components
│   ├── layout/              # Main layout sections
│   │   ├── CenterContentArea.tsx # Center panel container
│   │   ├── EditorSection.tsx     # Prompt editor container
│   │   ├── GlobalSettingsDrawer.tsx  # Full-screen global settings drawer
│   │   ├── GlobalSettingsVerticalTabBar.tsx # Vertical tab bar inside GlobalSettingsDrawer
│   │   ├── Header.tsx            # Workflow controls, execution badge
│   │   ├── OutputSection.tsx     # CLI output rendering
│   │   ├── StartupOverlay.tsx    # Full-screen overlay shown during extension startup
│   │   ├── WorkflowPropertiesPanel.tsx    # Harness/model settings
│   │   └── WorkflowStepsPanel.tsx # Workflow steps list with drag-and-drop
│   ├── editor/              # Editor components
│   │   ├── AgentQuickPicker.tsx  # Agent override in EditorFooter (left side)
│   │   ├── CodeMirrorEditor.tsx  # CodeMirror 6 instance
│   │   ├── ContextQuickPicker.tsx # Resume session / session ID override (right side)
│   │   ├── EditorFooter.tsx      # Status bar with quick pickers + action buttons
│   │   ├── FooterQuickPicker.tsx # Reusable popup button for footer pickers
│   │   ├── HarnessQuickPicker.tsx # Harness override in EditorFooter (left side)
│   │   ├── HooksEditor.tsx       # Lifecycle hooks editor (Default/None/Custom)
│   │   ├── ModelQuickPicker.tsx  # Model override in EditorFooter (left side)
│   │   ├── PermissionsQuickPicker.tsx # Tool permissions override (right side)
│   │   ├── PromptEditor.tsx      # Editor with toolbar
│   │   ├── PropertiesDrawer.tsx  # Prompt properties (6-tab drawer)
│   │   └── SkillsQuickPicker.tsx # Skills override in EditorFooter (left side)
│   ├── prompts/             # Prompt list components
│   │   ├── BoundaryBar.tsx       # Visual separator between queue and final prompt
│   │   ├── FinalStepFooter.tsx # Footer for the final prompt section
│   │   ├── PromptChipRail.tsx    # Compact chip navigation for collapsed/narrow step panel
│   │   ├── PromptCounter.tsx     # Step count badge
│   │   ├── PromptStepDetails.tsx # Expanded step detail view
│   │   ├── StatusIcon.tsx        # Execution status icon
│   │   └── WorkflowStep.tsx      # Single workflow step row (prompt or script)
│   ├── output/              # Output rendering components
│   │   ├── BashOutput.tsx        # Shell command output block
│   │   ├── CliOutput.tsx         # Main CLI output container
│   │   ├── DiffView.tsx          # Lazy collapsible diff renderer with HLJS
│   │   ├── FileOperationOutput.tsx # File read/write/edit/delete displays
│   │   ├── MarkdownText.tsx      # Markdown renderer
│   │   ├── OutputMinimap.tsx     # Right-rail step positions + diff regions
│   │   ├── outputStyles.ts       # Shared output style constants
│   │   ├── StatusMessage.tsx     # Status/info message block
│   │   ├── TerminalInstance.tsx  # Single xterm.js terminal (mount/resize)
│   │   ├── TerminalView.tsx      # Terminal panel (canvas + session rail)
│   │   ├── ToolCallOutput.tsx    # Tool invocation display
│   │   └── UndoChangesDialog.tsx # Confirm dialog for undoing file changes
│   ├── workflow/            # Workflow management
│   │   ├── RecentWorkflows.tsx   # Recent files dropdown
│   │   ├── RunningWorkflowItem.tsx # Single item in multi-workflow list
│   │   ├── SaveWorkflowButton.tsx # Save trigger button
│   │   ├── SaveWorkflowDialog.tsx # Save-as dialog with path/format
│   │   ├── TemplateModal.tsx     # New workflow from template
│   │   ├── WorkflowControls.tsx  # Run/Pause/Stop/Load buttons
│   │   ├── WorkflowFilePickerModal.tsx # File picker modal for workflow file selection
│   │   └── WorkflowStatus.tsx    # Execution state badge
│   ├── settings/            # Global settings tab sections (used in GlobalSettingsDrawer)
│   │   ├── ChatSection.tsx           # Chat / Copilot chat settings
│   │   ├── DeveloperSection.tsx      # Developer tools (only visible in dev builds)
│   │   ├── ExecutionSection.tsx      # Execution behavior settings
│   │   ├── GeneralSection.tsx        # General extension settings
│   │   ├── HarnessesSection.tsx      # Per-harness configuration
│   │   ├── HistorySection.tsx        # Run history / output retention settings
│   │   ├── McpHooksSection.tsx       # Global MCP servers + lifecycle hooks
│   │   ├── PermissionsSection.tsx    # Default tool permissions
│   │   ├── QueueSection.tsx          # Queue behavior settings
│   │   ├── ServerSection.tsx         # FlightPath server settings
│   │   └── WorkflowDefaultsSection.tsx # Workflow-level defaults
│   └── shared/              # Reusable UI components
│       ├── AnimatedSection.tsx   # Slide-down mount/unmount with CSS animation
│       ├── Button.tsx            # Base button component
│       ├── Collapsible.tsx       # Expand/collapse wrapper
│       ├── CustomSelect.tsx      # Styled select dropdown
│       ├── DeleteConfirmModal.tsx # Destructive action confirm (with "don't ask again")
│       ├── DrawerRow.tsx         # 2-column grid (wide) / fragment (narrow)
│       ├── DrawerTabBar.tsx      # Tab bar for PropertiesDrawer pages
│       ├── ErrorBoundary.tsx     # React error boundary with stack logging
│       ├── HarnessDropdown.tsx   # Grouped harness selector with status badges
│       ├── HarnessIcon.tsx       # SVG harness icons as data URIs
│       ├── IconToggleButton.tsx  # Icon-only toggle button
│       ├── McpServersEditor.tsx  # MCP server config + registry search
│       ├── Modal.tsx             # Base modal wrapper
│       ├── MultiCheckboxDropdown.tsx # Multi-select checkbox dropdown
│       ├── PanelBar.tsx          # Collapsible panel header bar
│       ├── PriorContextSelect.tsx # Prior context mode selector (6 keywords + custom)
│       ├── ResetConfirmModal.tsx # Recoverable action confirm (with "don't ask again")
│       ├── RunSelector.tsx       # Run history selector
│       ├── ScriptConditionEditor.tsx # Script step condition editor (compare source, returns)
│       ├── SkillsSelect.tsx      # Hybrid skills dropdown with portal popup
│       ├── SplitButton.tsx       # Button with dropdown arrow
│       ├── StepContextMenu.tsx   # Right-click context menu for workflow steps
│       ├── UndoRedoControl.tsx   # Undo/redo button control with zundo history
│       ├── permissionUtils.ts    # Tool permission mode logic per harness
│       └── tabBadgeUtils.ts      # Tab icon/color override helpers for DrawerTabBar
├── hooks/                   # React hooks
│   ├── terminalMessageHandlers.ts # Terminal PTY message routing
│   ├── useAttachmentTokenCount.ts # Token counting with attachment caching
│   ├── useContextPct.ts         # Context percentage (token usage vs window size)
│   ├── useDesktopLayout.ts      # Desktop 3-panel layout refs and resize logic
│   ├── useDrawerTabOverrides.ts # Computes tab icon/color overrides for DrawerTabBar
│   ├── useElementNarrow.ts      # ResizeObserver-based width threshold
│   ├── useFinalStepContextMenu.tsx # Context menu hook for the final step
│   ├── useMediaQuery.ts         # Responsive layout detection
│   ├── useMessageHandler.ts     # Message routing from extension
│   ├── useMobileLayout.ts       # Mobile single-column layout refs
│   ├── usePromptStatus.ts       # Step status derived state (icon, color, label)
│   ├── useStepClickHandler.ts   # Step click → editor navigation + selection
│   ├── useStepContextMenu.tsx   # Context menu hook for queue step rows
│   ├── useUndoRedoKeyHandler.ts # Ctrl+Z/Y undo/redo with running guard
│   └── useVsCodeApi.ts          # VS Code API singleton
├── store/                   # Zustand state stores
│   ├── workflowStore.ts     # Core workflow data + run history
│   ├── uiStore.ts           # Layout, modals, history browsing
│   ├── editorStore.ts       # Prompt editor state + properties
│   ├── settingsStore.ts     # Harness/model/skills/hooks configuration
│   └── terminalStore.ts     # Terminal session lifecycle
├── types/                   # TypeScript types
│   ├── cliEvents.ts         # CLI event type definitions
│   ├── drawerPages.ts       # Drawer page constants and tab definitions
│   ├── dropdownNamespaces.ts # Dropdown namespace constants per harness
│   ├── index.ts             # Re-exports for convenience
│   ├── messages.ts          # Re-exports from src/types/
│   └── vscode.ts            # VS Code API types
├── utils/                   # Utility functions
│   ├── diff.ts              # Diff/patch utilities
│   ├── diffUtils.ts         # Diff display helpers
│   ├── dictionaryUris.ts    # Dictionary URI constants for CodeMirror spellcheck
│   ├── endCondition.ts      # End condition helpers
│   ├── hljsUtils.ts         # Highlight.js integration (language detection, styles)
│   ├── logger.ts            # Webview logging utilities
│   ├── markdownExport.ts    # Markdown export generation
│   ├── outputProjection.ts  # Maps OrderedHistoryEntries → OutputMessages for rendering
│   ├── outputUtils.ts       # Output formatting helpers
│   ├── panelAnimation.ts    # Panel animation utilities
│   ├── prompt.ts            # Prompt text utilities
│   ├── promptUndo.ts        # Undo dialog logic and prompt undo actions
│   ├── status.ts            # Status/state helpers
│   ├── string.ts            # String utilities
│   ├── time.ts              # Time/duration formatting
│   ├── tokenizer.ts         # Token counting
│   └── tokenUtils.ts        # Context percentage helpers (calcContextPct)
└── styles/                  # CSS and Tailwind config
```

</architecture>

<stateManagement>

## Zustand Store Pattern

Five separate stores by domain (avoid mixing concerns):

### workflowStore - Core Workflow Data

```typescript
interface WorkflowState {
  fileName: string | null;
  workflowName: string | null;
  steps: WorkflowStep[]; // union: PromptStep | ScriptStep
  executionState: ExecutionState;
  currentStep: number;
  totalSteps: number;
  finalStep: WorkflowStep | null; // the final (repeating) step
  finalStepStatus: StepStatus | null;
  finalStepLoopCount: number;
  finalStepPhase: FinalStepPhase | null;
  // Live ordered output entries (queue + finalStep outputs and status messages)
  liveOrderedEntries: OrderedHistoryEntry[];
  liveSequence: number;
  retryStates: Record<number, RetryState>;
  // Streaming state (incremental text before full event arrives)
  streamingChunks: Record<number, string>;
  finalStepStreamingChunks: Record<number, string>;
  // Self-contained history snapshot for the currently-viewed historical run
  historyOutputs: {
    orderedEntries: OrderedHistoryEntry[];
    promptOutputs: Record<number, StepOutput>;
    finalStepOutputs?: Record<number, StepOutput>;
    runMetadata: Pick<
      WorkflowOutputHistory,
      "runId" | "startedAt" | "completedAt" | "executionState"
    >;
  } | null;
  workspaceSnapshots: Record<number, WorkspaceSnapshot>;
  finalStepWorkspaceSnapshots: Record<number, WorkspaceSnapshot>;
  undoResults: Record<string, UndoResult>;
  undoRecords: Record<string, UndoRecord>;
  undoWorkflowProperties: WorkflowProperties;
}
```

**Use cases**: Workflow execution, step list (queue + final step), ordered output entries, undo/snapshot tracking, run history browsing

**Run history**: When `uiStore.isViewingHistory=true`, `OutputSection` renders from `historyOutputs` instead of `liveOrderedEntries`. Live entries continue updating normally — history browsing has zero impact on live capture.

### uiStore - Layout and UI State

```typescript
interface UiState {
  // Dropdown hide feature (persisted)
  hiddenDropdownOptions: Record<string, string[]>;
  // Panel collapse
  stepsCollapsed: boolean;
  finalStepFooterExpanded: boolean;
  outputCollapsed: boolean;
  editorCollapsed: boolean;
  settingsCollapsed: boolean;
  propertiesDrawerOpen: boolean;
  // Diff display toggle
  diffsCollapsed: boolean;
  diffResetVersion: number; // bumped on expand/collapse all
  // Persisted panel sizes
  lastDesktopSizes: PanelSizes;
  lastMobileSizes: PanelSizes;
  // Output panel
  selectedOutputStep: number | null; // null = current step
  // Run history browsing
  isViewingHistory: boolean;
  viewingRunIndex: number; // 0 = most recent
  availableRuns: number;
  runTimestamps: (number | undefined)[];
  runStates: (string | undefined)[];
  // Save workflow dialog
  saveWorkflowDialogOpen: boolean;
  saveWorkflowDialogData: SaveWorkflowDialogData | null;
  // New workflow modal
  newWorkflowModalOpen: boolean;
  templates: TemplateInfo[];
  currentTemplate: TemplateInfo | null;
  workflowsDir: string;
  defaultTemplateId: string;
  templateFileSelection: { variable: string; path: string } | null;
  // Recent workflows
  recentWorkflows: RecentWorkflow[];
  recentWorkflowsDropdownOpen: boolean;
  // Multi-workflow support
  loadedWorkflows: WorkflowSummary[];
  activeWorkflowId: string | null;
  // Loading states
  isLoading: boolean;
  loadingMessage: string | null;
  // Font sizes (persisted)
  outputFontSize: number;
  terminalFontSize: number;
  // Terminal panel state
  activeOutputTabs: Record<string, "output" | "terminal">;
  terminalActiveWorkflows: Set<string>;
  terminalRailCollapsed: boolean;
  terminalRailSizePx: number;
  // Notification toast (transient)
  toast: {
    message: string;
    type: "info" | "success" | "warning" | "error";
    visible: boolean;
  } | null;
  // Footer quick picker (transient)
  footerOpenPicker:
    | "harness"
    | "model"
    | "agent"
    | "skills"
    | "permissions"
    | "context"
    | null;
  // MCP Discovery state
  mcpDiscoveryTab: "local" | "registry";
  mcpLocalServers: LocalMcpServerEntry[];
  mcpRegistryServers: RegistryMcpEntry[] | undefined;
  mcpRegistryQuery: string;
  mcpRegistryNextCursor: string | undefined;
  mcpWorkspaceServers: McpServerConfig[] | undefined;
  // Mobile drawer/sidebar state (transient)
  mobilePromptsOpen: boolean;
  mobilePromptsMode: "sidebar" | "fullwidth";
  mobileSettingsOpen: boolean;
  // Global settings drawer
  globalSettingsOpen: boolean;
  globalSettingsActiveTab: string;
}
```

**Use cases**: Panel collapse, modals, recent files, run history browsing, terminal state, MCP discovery, mobile layout, global settings drawer

**Persistence**: Synced to VS Code webview state API via Zustand `persist` middleware

### editorStore - Prompt Editor State

```typescript
interface EditorState {
  selectionTarget: EditorSelectionTarget; // NEW_PROMPT | QUEUE(index) | FINAL_STEP
  selectedPromptIndex: number | null; // null = new prompt mode
  originalPromptData: WorkflowStep | null; // for Cancel/revert
  savedNewPromptState: SavedNewStepState | null; // saved when switching to edit mode
  pendingEdits: Record<string, SavedNewStepState>; // unsaved edits cache by target
  hasActiveQueue: boolean;
  // Step type — determines editor mode (prompt vs script)
  stepType: "prompt" | "script";
  // Prompt step content
  promptText: string;
  promptName: string;
  // Script step content
  scriptCommand: string;
  scriptTimeout: number | undefined;
  scriptOnPass: string;
  scriptOnFail: string;
  scriptCompareSource: string;
  scriptReturns: string;
  // Shared properties
  properties: PropertyValues;
  isDirty: boolean;
  validationErrors: Record<string, string>;
}
```

**PropertyValues** includes: `harness`, `model`, `agent`, `skills`, `resumeSession`, `sessionId`, `mcpServers`, `hooks` (object[] | null | undefined), `endCondition`, `preCondition`, `priorContext`, `additionalArgs`, `toolPermissions`

**Inheritance convention**: `undefined` = inherit from workflow/global, `null` = explicitly none, value = override

**Mode determination**: `selectionTarget` drives the editor mode — `NEW_PROMPT` for new, `QUEUE(index)` or `FINAL_STEP` for editing existing

**endCondition** and **preCondition** are part of `PropertyValues` (not top-level fields)

**Use cases**: Editor content, prompt/script properties, save/revert operations

**Persistence**: Synced to VS Code webview state API via FlightPathDashboardProvider

### settingsStore - Harness and Model Configuration

```typescript
interface SettingsState {
  modelOptions: Record<HarnessId, ModelOption[]>;
  availableAgents: AgentOption[];
  availableSkills: SkillOption[]; // workspace + user skill options
  harnessStatus: Record<HarnessId, HarnessStatus>;
  globalSettings: GlobalSettings; // includes hooks, toolPermissions, confirmDeleteOperations, etc.
  workflowProperties: WorkflowProperties; // includes hooks, toolPermissions overrides
  workflowLoaded: boolean; // enables settings panel
  fullGlobalSettings: FullGlobalSettings | null; // loaded on demand from configService
  serverRunning: boolean; // FlightPath server running state
  serverUrl: string | null; // server URL when running
}
```

**Use cases**: Harness/model/skills selection, workflow properties, global defaults, hooks resolution, server control

**Hooks resolution**: `getEffectiveHooks()` resolves prompt → workflow → global inheritance. Returns workflow-level hooks if defined, otherwise global hooks.

### terminalStore - Terminal Session Lifecycle

```typescript
interface TerminalState {
  sessions: Record<string, TerminalSession[]>; // workflowId → ordered sessions
  activeSessionIds: Record<string, string | null>; // workflowId → active session
}

interface TerminalSession {
  id: string;
  workflowId: string;
  stepName: string;
  kind: SessionKind; // "ai-cli" | "shell"
  promptNumber?: number;
  status: TerminalSessionStatus;
  pendingOutput: string[]; // chunks buffered before xterm mount
}
```

**Use cases**: Terminal session tracking, active session switching, output buffering

**Lifecycle**: AI CLI sessions are cleared on each new run; shell sessions survive across runs. `pendingOutput` buffers PTY data before the xterm instance mounts.

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
- `opencode-cli` - OpenCode CLI
- `qwen-cli` - Qwen Code CLI
- `gemini-cli` - Google Gemini CLI

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
  <Panel ref={stepsRef} collapsible>
    <WorkflowStepsPanel />
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

### PropertiesDrawer Tab System

PropertiesDrawer uses a 6-tab layout with `DrawerTabBar` at the bottom:

| Tab         | Page ID       | Content                                           |
| ----------- | ------------- | ------------------------------------------------- |
| Harness     | `harness`     | Harness + Model selection                         |
| Context     | `context`     | Resume Session + Prior Context + Session ID       |
| Validation  | `validation`  | End Condition (script, returns, timeout, retries) |
| MCP         | `mcp`         | MCP Servers editor (McpServersEditor)             |
| Hooks       | `hooks`       | Lifecycle hooks editor (HooksEditor)              |
| Permissions | `permissions` | Tool permission mode + allow/deny lists           |

Tab definitions in `types/drawerPages.ts`. `DrawerTabBar` renders icons with optional per-tab icon/color overrides via the `tabOverrides` prop (`Partial<Record<DrawerPage, TabIconOverride>>`).

**`TabIconOverride`** (from `shared/tabBadgeUtils.ts`):

- `codicon?` — replace the tab's default icon
- `color?` — Tailwind text-color class when inactive
- `hoverColor?` — Tailwind hover class when inactive (defaults to `hover:text-foreground`)
- `activeColor?` — Tailwind text-color class when active (defaults to `text-foreground`)

**`tabBadgeUtils.ts`** exports helper functions that compute overrides from resolved property state:

- `getPermissionTabOverride(mode)` — color-codes the Permissions tab by severity (red = dangerously allow all, yellow = allow all, green = custom)
- `getHooksTabOverride(hooks)` — blue icon when hooks are configured
- `getMcpTabOverride(mcpServers)` — blue icon when MCP servers are configured
- `getValidationTabOverride(endCondition)` — blue icon when an end condition script is set
- `getContextTabOverride(resumeSession, priorContext)` — blue icon when session resumption or prior context is active

### 3-Tier Property Inheritance

Properties resolve: **Prompt** → **Workflow** → **Global settings**

- `undefined` = inherit from next tier
- `null` = explicitly none/disabled
- value = override

Each drawer control shows `"Default (X)"` label revealing the effective inherited value. Resolution for hooks: `settingsStore.getEffectiveHooks()`.

### Terminal Architecture

xterm.js instances live **outside React** in `terminalRegistry.ts`:

- `terminalStore` tracks sessions (ai-cli vs shell), active session, pending output
- `terminalRegistry` owns Terminal instances, handles create/attach/detach/freeze lifecycle
- `TerminalView` renders the terminal panel (canvas + session rail)
- `TerminalInstance` mounts a single xterm via registry attach

**Session types**: `ai-cli` sessions clear on each run; `shell` sessions persist across runs. Pending output buffers PTY data before mount.

### EditorSection Header

`EditorSection` header contains three zones:

- **Left** — collapse affordance (chevron + icon + "Editor" label)
- **Center** — mode indicator + token count; clicking the mode text starts **inline prompt name editing** (input replaces text, saves on Enter/blur, cancels on Escape); disabled when `isCLIManaged`
- **Right** — `IconToggleButton` for `flightpath.respectGitignoreForCompletions` (hidden when `isCLIManaged`); posts `UPDATE_CONFIG` message to extension on toggle

**Mode indicator text** format:

- New mode: `"New Prompt"` or `"New: <name>"`
- Edit mode: `"Editing: <name>"`, `"Editing: Final Prompt"`, or `"Editing: Prompt N of M"`
- CLI managed: `"Read-only — CLI run in progress"`

### OutputSection Header

`OutputSection` header right side shows an **execution mode toggle** (`IconToggleButton`) that switches between `EXECUTION_MODES.INTERACTIVE` and `EXECUTION_MODES.HEADLESS`. It posts a `CHANGE_EXECUTION_MODE` message to the extension and is always visible regardless of the active tab (Output vs Terminal).

The header left side shows Output/Terminal tab buttons (when a terminal session exists), and font size steppers for both output text and terminal.

### EditorFooter Quick Pickers

`FooterQuickPicker` provides a reusable popup button pattern for compact property overrides in `EditorFooter`. The footer is split into two sides (all pickers hidden when `propertiesOpen`):

**Left side** (Harness → Model → Agent → Skills):

- `HarnessQuickPicker` - Harness override (wraps HarnessDropdown)
- `ModelQuickPicker` - Model override (wraps CustomSelect)
- `AgentQuickPicker` - Agent selection
- `SkillsQuickPicker` - Skills multi-select

**Right side** (Permissions → Context → action buttons):

- `PermissionsQuickPicker` - Tool permissions mode override (shield icon, `footerOpenPicker === "permissions"`)
- `ContextQuickPicker` - Resume session + session ID override (book icon, `footerOpenPicker === "context"`)

Each picker receives `isNarrow` and `showLabel` props. Labels are shown when the footer is wide enough (`useElementNarrow(768)`). Override values show bold/colored styling. All pickers use `uiStore.footerOpenPicker` to ensure only one popup is open at a time.

### GlobalSettingsDrawer

Full-screen overlay opened via `uiStore.globalSettingsOpen`. Contains a `GlobalSettingsVerticalTabBar` on the left and renders the active settings section on the right. Tab sections live in `components/settings/` and receive `settings: GlobalSettings` + `onUpdate: (partial) => void` props. State is managed through `settingsStore.fullGlobalSettings` (loaded on demand).

### Mobile Layout

On narrow viewports, `PromptChipRail` provides compact chip-based navigation for collapsed/narrow step panel navigation. Controlled by `uiStore.mobilePromptsOpen` and `uiStore.mobilePromptsMode` (`"sidebar"` or `"fullwidth"`). The `useMediaQuery` hook detects mobile breakpoints; `App.tsx` switches between `useDesktopLayout` and `useMobileLayout` refs accordingly.

### ScriptConditionEditor

Used inside the editor for script steps. Renders compare-source selection, expected returns value, and validation. Exports `ScriptConditionValue` interface. Not to be confused with `EndConditionConfig` (for prompt retry logic).

### UndoRedoControl

Wraps zundo temporal store to expose undo/redo as clickable buttons with history depth badge. Mounted in the Header; uses portal for the history dropdown. Disabled when a workflow is running.

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

## Testing

**Framework**: Vitest + React Testing Library

**Test directory**: `src/ui/webview-react/test/`

```
test/
├── setup.ts                       # Test setup (jsdom, mocks)
├── hooks/
│   ├── useElementNarrow.test.ts   # ResizeObserver width threshold
│   ├── useMediaQuery.test.ts      # Responsive layout detection
│   ├── useMessageHandler.test.ts  # Message routing tests
│   └── useVsCodeApi.test.ts       # VS Code API singleton
├── utils/
│   ├── diff.test.ts               # Diff/patch logic
│   ├── endCondition.test.ts       # End condition helpers
│   ├── outputProjection.test.ts   # Output message mapping
│   ├── outputUtils.test.ts        # Output formatting
│   ├── prompt.test.ts             # Prompt utilities
│   ├── promptUndo.test.ts         # Undo action computation
│   ├── status.test.ts             # Status helpers
│   ├── string.test.ts             # String utilities
│   └── time.test.ts               # Time formatting
├── components/
│   ├── workflow/
│   │   ├── WorkflowControls.test.tsx
│   │   └── WorkflowStatus.test.tsx
│   ├── output/
│   │   ├── BashOutput.test.tsx
│   │   └── MarkdownText.test.tsx
│   └── shared/
│       ├── Button.test.tsx
│       ├── CustomSelect.test.tsx
│       └── Modal.test.tsx
└── store/
    ├── editorStore.test.ts
    ├── settingsStore.test.ts
    ├── uiStore.test.ts
    ├── workflowStore.test.ts
    └── workflowStore.temporal.test.ts
```

**Running tests**:

```bash
npm run test:webview         # Run webview tests
```

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
- VS Code webview state API used for UI layout persistence (via uiStore persist middleware)
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
   - Editor/properties → components/editor/
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
5. Consider persistence (VS Code webview state for both UI and editor; both use vsCodeRawStorage)

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
