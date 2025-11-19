# FlightPath Tracking UI - Bottom Panel Design

**Status**: 🎨 Design Phase  
**Last Updated**: November 14, 2025  
**Purpose**: Track prompt execution, display progress, show CLI output, and provide execution controls

---

## 🎯 Design Goals

Create a bottom panel UI (alongside Terminal, Output, etc.) that provides:

1. **Prompt File Selection**: Browse and select `.prompt.json`, `.flightpath.json`, or `.prompt.md` files
2. **Execution Control**: Run, pause, resume, and stop workflow execution
3. **Progress Tracking**: Real-time status of multi-step workflows with visual progress indicators
4. **Result Visibility**: Display prompt results, end condition status, retry attempts
5. **CLI Output Integration**: Show Copilot CLI prompts/responses/stats (eliminating need to switch to Output panel)
6. **State Persistence**: Resume workflows where they left off after VS Code restarts

**Key Principle**: We do NOT need a prompt editor in this UI - users edit prompt files directly in the main VS Code editor with our enhanced `#file:` completions.

---

## 📐 UI Design Options

### Design A: TreeView-Based Execution Tracker

**Implementation**: TreeDataProvider with custom tree items

```
┌─────────────────────────────────────────────────────────────────┐
│ FlightPath                                           [▶][⏸][⏹] │
├─────────────────────────────────────────────────────────────────┤
│ 📂 .flightpath/                                                 │
│   📄 test-workflow.flightpath.json                      [▶]     │
│   📄 code-review.prompt.json                            [▶]     │
│   📄 refactor-plan.prompt.md                            [▶]     │
│                                                                 │
│ ▶ Recent Executions                                             │
│ ▼ Currently Running: test-workflow.flightpath.json             │
│   ├─ ✅ Prompt 1: Analyze codebase                              │
│   │   └─ 📊 End condition passed (check_analysis.py)           │
│   │   └─ ⏱️ Completed: 2:34pm                                   │
│   ├─ ▶️ Prompt 2: Generate improvements (In Progress...)        │
│   │   └─ ⏳ Waiting for Copilot response...                     │
│   └─ ⏸️ Prompt 3: Apply fixes (Pending)                         │
│                                                                 │
│ ▶ Completed Workflows (3)                                       │
└─────────────────────────────────────────────────────────────────┘
```

**Pros**:

- Native VS Code TreeView with full theming support
- Familiar UI pattern (like Test Explorer, GitLens)
- Excellent for hierarchical workflow visualization
- Easy to implement with existing VS Code APIs
- Supports inline action buttons per item
- Collapsible sections for clean organization

**Cons**:

- Limited space for detailed output/logs
- Must open separate Output panel to see CLI responses (initially)
- Tree structure might be overkill for single-prompt files

**Implementation Details**:

```typescript
// Register tree view
const treeView = vscode.window.createTreeView("flightpath.tracker", {
  treeDataProvider: new FlightPathTreeDataProvider(),
  showCollapseAll: true,
});

// Tree item types:
// - PromptFileItem (root level - files in workspace)
// - ExecutionItem (active/recent executions)
// - PromptStepItem (individual prompts in workflow)
// - ResultItem (end condition results, errors, metadata)
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
          "icon": "resources/compass.svg"
        }
      ]
    },
    "views": {
      "flightpath": [
        {
          "id": "flightpath.tracker",
          "name": "Execution Tracker",
          "type": "tree"
        }
      ]
    }
  }
}
```

---

### Design B: WebView Panel with Rich Execution Dashboard

**Implementation**: WebviewViewProvider with custom HTML/CSS/JS

```
┌─────────────────────────────────────────────────────────────────┐
│ FlightPath                                    [CLI ▼] [▶][⏸][⏹] │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │ 🚀 test-workflow.flightpath.json                   [Change] │ │
│ │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 2/5 (40%)                 │ │
│ └─────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─ Prompts ──────────────────────────────────────────────────┐ │
│ │ ✅ 1. Analyze codebase structure                           │ │
│ │    End condition: ✓ Passed (check_analysis.py)            │ │
│ │    Duration: 12.3s                                         │ │
│ │                                                            │ │
│ │ ▶️ 2. Generate improvement suggestions [In Progress]       │ │
│ │    Status: Waiting for Copilot response...                │ │
│ │    Elapsed: 5.8s                                           │ │
│ │    [Show in Output]                                        │ │
│ │                                                            │ │
│ │ ⏸️ 3. Review generated code                                │ │
│ │    Status: Pending                                         │ │
│ │                                                            │ │
│ │ ⏸️ 4. Apply fixes                                          │ │
│ │    End condition: run_tests.py → all_passed               │ │
│ │                                                            │ │
│ │ ⏸️ 5. Generate documentation                               │ │
│ └────────────────────────────────────────────────────────────┘ │
│                                                                 │
│ ┌─ CLI Output (Live) ────────────────────────────────────────┐ │
│ │ [Prompt 2] Generate improvement suggestions                │ │
│ │                                                            │ │
│ │ Based on the analysis, here are key improvements:         │ │
│ │ 1. Refactor FlightPathManager to reduce coupling...       │ │
│ │ 2. Extract validation logic to separate module...         │ │
│ │                                                            │ │
│ │ ⏱️ Response time: 5.8s                                      │ │
│ │ 📊 Tokens: 1,234 prompt / 2,456 completion                 │ │
│ └────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Pros**:

- Fully customizable layout and styling
- Rich visual progress indicators (progress bars, status icons)
- Integrated CLI output viewer (no need to switch to Output panel!)
- Can embed Monaco editor for inline editing (future enhancement)
- Live updates with real-time streaming
- Beautiful, branded UI experience

**Cons**:

- More complex to implement and maintain
- Must handle all theming manually
- Requires HTML/CSS/JS alongside TypeScript
- Webview performance overhead for very large outputs

**Implementation Details**:

```typescript
// Register webview view
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider(
    "flightpath.dashboard",
    new FlightPathDashboardProvider(context),
    { webviewOptions: { retainContextWhenHidden: true } }
  )
);

// Features:
// - Real-time updates via postMessage from extension to webview
// - Click "Show in Output" opens full Output panel
// - Embedded Monaco editor for CLI output (syntax highlighting)
// - Responsive layout for different panel heights
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
          "icon": "resources/compass.svg"
        }
      ]
    },
    "views": {
      "flightpath": [
        {
          "type": "webview",
          "id": "flightpath.dashboard",
          "name": "Dashboard"
        }
      ]
    }
  }
}
```

---

### Design C: Hybrid TreeView + WebView Details

**Implementation**: TreeView for navigation + WebView for detailed output

```
┌───────────────────────────┬─────────────────────────────────────┐
│ FlightPath       [▶][⏸][⏹] │ Details                            │
├───────────────────────────┼─────────────────────────────────────┤
│ ▼ Active Execution        │ Prompt 2: Generate improvements    │
│   ├─ ✅ Prompt 1           │ ━━━━━━━━━━━━━━━━ In Progress       │
│   ├─ ▶️ Prompt 2 (current) │                                    │
│   ├─ ⏸️ Prompt 3           │ 📝 Prompt Text:                     │
│   ├─ ⏸️ Prompt 4           │ Based on the analysis, suggest     │
│   └─ ⏸️ Prompt 5           │ architectural improvements for...  │
│                           │                                    │
│ ▶ Recent Executions (3)   │ 💬 Copilot Response:                │
│                           │ Here are key improvements:        │
│ 📂 Available Prompts      │ 1. Extract validation logic...     │
│   └─ .flightpath/         │ 2. Reduce coupling between...      │
│       ├─ 📄 test.json     │                                    │
│       └─ 📄 review.json   │ 📊 Statistics:                      │
│                           │ Duration: 5.8s                     │
│                           │ Tokens: 1,234 → 2,456              │
│                           │                                    │
│                           │ [Copy Response] [Open in Editor]   │
└───────────────────────────┴─────────────────────────────────────┘
```

**Pros**:

- Best of both worlds: native tree navigation + rich details view
- Tree for quick overview and selection
- WebView for detailed output and formatted responses
- Maintains context while showing details
- Flexible split layout

**Cons**:

- More complex implementation (two separate views)
- Requires coordination between tree selection and webview updates
- Takes more horizontal space in bottom panel
- Two separate contribution points to maintain

**Implementation Details**:

```typescript
// Register both views
const treeView = vscode.window.createTreeView("flightpath.tracker", {
  treeDataProvider: new FlightPathTreeDataProvider(),
});

const detailsView = vscode.window.registerWebviewViewProvider(
  "flightpath.details",
  new FlightPathDetailsProvider(context)
);

// Listen to tree selection changes
treeView.onDidChangeSelection((selection) => {
  // Update details webview with selected item
  detailsViewProvider.showDetails(selection);
});
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
          "icon": "resources/compass.svg"
        }
      ]
    },
    "views": {
      "flightpath": [
        {
          "id": "flightpath.tracker",
          "name": "Tracker",
          "type": "tree"
        },
        {
          "type": "webview",
          "id": "flightpath.details",
          "name": "Details"
        }
      ]
    }
  }
}
```

---

### Design D: Output Channel with Enhanced Controls

**Implementation**: Enhanced Output Channel with custom toolbar

```
┌─────────────────────────────────────────────────────────────────┐
│ FlightPath Output         [Select File ▼] [▶ Run] [⏸] [⏹] [📋] │
├─────────────────────────────────────────────────────────────────┤
│ ═══════════════════════════════════════════════════════════════ │
│ 🚀 Executing: test-workflow.flightpath.json                     │
│ Started: 2:34:12 PM                                             │
│ Mode: CLI                                                       │
│ Total Prompts: 5                                                │
│ ═══════════════════════════════════════════════════════════════ │
│                                                                 │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ Progress: 2/5 (40%)           │
│                                                                 │
│ ✅ Prompt 1: Analyze codebase structure                         │
│    Duration: 12.3s | Tokens: 856 → 1,234                       │
│    End Condition: ✓ Passed (check_analysis.py returned "true") │
│                                                                 │
│ ▶️ Prompt 2: Generate improvement suggestions [IN PROGRESS]     │
│    ┌────────────────────────────────────────────────────────┐  │
│    │ [SENT TO COPILOT]                                      │  │
│    │ Based on the analysis above, suggest architectural     │  │
│    │ improvements for the FlightPath extension...           │  │
│    └────────────────────────────────────────────────────────┘  │
│                                                                 │
│    ┌────────────────────────────────────────────────────────┐  │
│    │ [COPILOT RESPONSE]                                     │  │
│    │ Here are key architectural improvements:               │  │
│    │                                                        │  │
│    │ 1. **Separation of Concerns**:                         │  │
│    │    - Extract validation logic from FlightPathManager   │  │
│    │    - Create dedicated ValidationService               │  │
│    │                                                        │  │
│    │ 2. **Reduced Coupling**:                               │  │
│    │    - Implement event-driven communication...           │  │
│    │                                                        │  │
│    │ [Response continuing... 5.8s elapsed]                  │  │
│    └────────────────────────────────────────────────────────┘  │
│                                                                 │
│ ⏸️ Prompt 3: Review generated code (Pending)                    │
│ ⏸️ Prompt 4: Apply fixes (Pending)                              │
│ ⏸️ Prompt 5: Generate documentation (Pending)                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**Pros**:

- Simplest implementation - enhanced version of existing Output Channel
- Already familiar to users (Output, Terminal paradigm)
- Text-based so easy to copy/paste
- Minimal performance overhead
- Can leverage existing OutputChannel with custom decorations

**Cons**:

- Limited interactivity (no clickable elements in output text)
- Cannot show progress bars or rich UI components
- Toolbar actions limited to VS Code's output channel capabilities
- Less visual polish than webview options

**Implementation Details**:

```typescript
// Enhanced output channel with structured logging
class FlightPathOutputChannel {
  private channel: vscode.OutputChannel;

  constructor() {
    this.channel = vscode.window.createOutputChannel("FlightPath");
  }

  showWorkflowHeader(fileName: string, promptCount: number) {
    this.channel.appendLine("═".repeat(60));
    this.channel.appendLine(`🚀 Executing: ${fileName}`);
    this.channel.appendLine(`Started: ${new Date().toLocaleTimeString()}`);
    this.channel.appendLine(`Total Prompts: ${promptCount}`);
    this.channel.appendLine("═".repeat(60));
    this.channel.appendLine("");
  }

  showProgress(current: number, total: number) {
    const percentage = Math.round((current / total) * 100);
    const progressBar = "━".repeat(30);
    this.channel.appendLine(
      `${progressBar} Progress: ${current}/${total} (${percentage}%)`
    );
    this.channel.appendLine("");
  }

  // More structured output methods...
}
```

---

## 🎨 Visual Design Elements

### Status Icons

```
✅ Completed successfully
❌ Failed
⏸️ Pending (not started)
▶️ In progress
🔄 Retrying (with retry count badge)
⏱️ Timeout
⏳ Waiting for end condition
📊 End condition result
💬 Copilot response
📝 User prompt
```

### Progress Indicators

**Text-based** (for Output Channel):

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ 2/5 (40%)
```

**Visual** (for WebView):

```html
<div class="progress-bar">
  <div class="progress-fill" style="width: 40%">2/5</div>
</div>
```

### Color Coding (Themeable)

```css
.status-success {
  color: var(--vscode-testing-iconPassed);
}
.status-error {
  color: var(--vscode-testing-iconFailed);
}
.status-pending {
  color: var(--vscode-descriptionForeground);
}
.status-running {
  color: var(--vscode-progressBar-background);
}
.prompt-text {
  background: var(--vscode-editor-background);
}
.response-text {
  background: var(--vscode-textCodeBlock-background);
}
```

---

## 🔧 Feature Breakdown

### Core Features (MVP)

1. **Prompt File Selection**
   - Dropdown or tree showing available `.prompt.json`, `.flightpath.json`, `.prompt.md` files
   - Recently executed files at top
   - Quick file picker command

2. **Execution Controls**
   - ▶️ Run/Resume button
   - ⏸️ Pause button (appears when running)
   - ⏹ Stop button
   - Status text showing current state

3. **Progress Display**
   - Current prompt index (e.g., "2/5")
   - Percentage complete
   - Visual progress bar (if webview)
   - Time elapsed for current prompt

4. **Prompt Status List**
   - Show all prompts in workflow
   - Status icon per prompt (✅❌⏸️▶️)
   - Expandable details (end condition, duration, retry count)

5. **CLI Output Integration** (Phase 2)
   - Show prompts sent to Copilot
   - Show Copilot responses
   - Token usage statistics
   - Timestamps and durations

### Advanced Features (Future)

6. **State Persistence**
   - Resume interrupted workflows after VS Code restart
   - Save execution history
   - Workspace state storage

7. **Interactive Elements**
   - Click prompt to jump to source in `.flightpath.json`
   - Click file reference to open file
   - Copy response to clipboard
   - Retry failed prompts manually

8. **Analytics Dashboard**
   - Execution time trends
   - Success/failure rates
   - Most-used prompt files
   - Token usage over time

---

## 💡 Recommended Implementation Path

### Phase 1: Enhanced Output Channel (Quickest MVP)

**Why**: Simplest to implement, reuses existing Output Channel infrastructure

**Implementation**:

1. Create structured output methods in `FlightPathManager`
2. Add toolbar buttons via commands (Select File, Run, Pause, Stop)
3. Format output with unicode symbols and ANSI colors
4. Show real-time progress during execution

**Effort**: ~2-4 hours  
**Value**: Immediate visibility without major refactoring

### Phase 2: TreeView Execution Tracker

**Why**: Native UI with better organization and interactivity

**Implementation**:

1. Create `FlightPathTreeDataProvider`
2. Define tree item hierarchy (Files → Executions → Prompts → Results)
3. Add inline action buttons (Run, Pause, etc.)
4. Implement refresh on queue state changes
5. Add context menu actions

**Effort**: ~6-8 hours  
**Value**: Professional UI with VS Code conventions

### Phase 3: WebView Details Panel (Polish)

**Why**: Rich output display for CLI responses

**Implementation**:

1. Create `FlightPathDetailsProvider` webview
2. Design HTML/CSS layout with VS Code theme variables
3. Implement bidirectional messaging (extension ↔ webview)
4. Add syntax highlighting for code blocks in responses
5. Integrate with tree selection for details-on-demand

**Effort**: ~8-12 hours  
**Value**: Beautiful UX, eliminates need to switch to Output panel

### Phase 4: Full Dashboard (Future)

**Why**: Complete tracking, analytics, and management experience

**Implementation**:

1. Replace tree with full webview dashboard
2. Add file browser, execution history, analytics charts
3. Implement inline Monaco editor for CLI output (syntax highlighting)
4. Add export/share functionality for execution results
5. Create onboarding tour and help documentation

**Effort**: ~20-30 hours  
**Value**: Premium extension experience

---

## 📊 Comparison Matrix

| Feature                    | Design A (TreeView) | Design B (WebView) | Design C (Hybrid) | Design D (Output) |
| -------------------------- | ------------------- | ------------------ | ----------------- | ----------------- |
| **Implementation Time**    | Medium              | High               | Very High         | Low               |
| **Maintenance Complexity** | Low                 | Medium             | High              | Very Low          |
| **Visual Polish**          | Good                | Excellent          | Excellent         | Basic             |
| **Interactivity**          | Good                | Excellent          | Excellent         | Limited           |
| **CLI Output Display**     | Limited             | Excellent          | Excellent         | Good              |
| **Performance**            | Excellent           | Good               | Good              | Excellent         |
| **Themeable**              | Automatic           | Manual             | Manual            | Automatic         |
| **Familiar to Users**      | Yes                 | No                 | Partial           | Yes               |
| **Future Extensibility**   | Medium              | High               | High              | Low               |

---

## 🎯 Final Recommendation

**Start with Design A (TreeView) + Enhanced Output Channel**

**Rationale**:

1. TreeView provides excellent navigation and status overview
2. Enhanced Output Channel already exists for CLI output
3. Low implementation complexity with high value
4. Can iterate to Design C (Hybrid) by adding Details webview later
5. Maintains VS Code conventions and familiarity

**Migration Path**:

- **Phase 1**: Enhanced Output Channel (immediate value)
- **Phase 2**: Add TreeView for better organization
- **Phase 3**: Add WebView details panel when we need richer output display
- **Phase 4**: Optional full dashboard if user feedback warrants

This approach balances **quick wins** with **long-term flexibility** while maintaining clean architecture and VS Code best practices.

---

## 📝 Open Questions for Nathan

1. **CLI Output Priority**: How important is showing CLI output directly in the panel vs. users switching to Output panel? This determines if we need webview sooner.

2. **State Persistence**: Should workflows automatically resume after VS Code restart? Or require manual "Resume" action?

3. **File Selection UX**: Prefer dropdown in toolbar, tree view, or quick pick command for selecting prompt files?

4. **Progress Detail Level**: Show just current prompt index (2/5) or also time elapsed, token usage, end condition status?

5. **History Depth**: How many recent executions should we track and display? All in current session, last N, or workspace-scoped history?

6. **Mobile/Remote**: Do we need to consider VS Code remote development scenarios (SSH, Containers, WSL)?

---

**Next Steps**: Review designs, answer questions above, and I'll create a detailed implementation plan for the chosen approach.
