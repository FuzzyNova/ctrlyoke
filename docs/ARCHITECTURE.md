# FlightPath Architecture Diagram

## System Architecture with Copilot Integration

```
┌─────────────────────────────────────────────────────────────────────┐
│                         VS Code Extension Host                      │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │                    FlightPathManager                         │   │
│  │                  (Orchestration Layer)                       │   │
│  │                                                              │   │
│  │  • Lifecycle management                                      │   │
│  │  • Command coordination                                      │   │
│  │  • Workflow execution                                        │   │
│  │  • Status tracking                                           │   │
│  └──┬─────────────────────────────────────────────────────────┬─┘   │
│     │                                                         │     │
│     ▼                                                         ▼     │
│  ┌───────────────────────────────┐    ┌──────────────────────────┐  │
│  │      PromptQueue              │    │   CopilotIntegration     │  │
│  │   (Execution Engine)          │    │  (Automation Layer)      │  │
│  │                               │    │                          │  │
│  │  • Sequential execution       │◄──►│  • Strategy detection    │  │
│  │  • State management           │    │  • Multi-strategy exec   │  │
│  │  • Progress tracking          │    │  • Context formatting    │  │
│  │  • Pause/Resume/Stop          │    │  • Copilot Chat syntax   │  │
│  └───────────────────────────────┘    └──┬───────────────────────┘  │
│                                          │                          │
│                                          ▼                          │
│                       ┌──────────────────────────────────┐          │
│                       │   Automation Strategy            │          │
│                       ├──────────────────────────────────┤          │
│                       │                                  │          │
│                       │  ✅ Direct Text Insertion        │          │
│                       │     (Zero-interaction)           │          │
│                       │     • Focus chat (1000ms)        │          │
│                       │     • Clear input (300ms)        │          │
│                       │     • Type prompt (500ms)        │          │
│                       │     • Submit automatically       │          │
│                       │                                  │          │
│                       │  ❌ No Fallback Strategies       │          │
│                       │     If automation unavailable,   │          │
│                       │     clear error is displayed     │          │
│                       │     with requirements and        │          │
│                       │     troubleshooting steps        │          │
│                       └──────────────────────────────────┘          │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      GitHub Copilot Chat Panel                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  Receives formatted prompts:                                         │
│  • @workspace - Workspace context                                    │
│  • #file:path - File references                                      │
│  • #selection - Current selection                                    │
│  • /fix, /explain, /new, /tests - Slash commands                    │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

## Data Flow: Workflow Execution

```
User Action                FlightPath Processing              Copilot Chat
────────────              ─────────────────────             ─────────────

   [Take Off]
       │
       ▼
Select .flightpath.json
       │
       ▼                    Parse & Validate
                                  │
                                  ▼
                           Load into Queue
                                  │
                                  ▼
                           Detect Strategy ◄─────── Check Commands
                                  │                  Check Extensions
                                  ▼
                          Strategy Selected
                                  │
                                  │
                                  ▼
                        Direct Text Insertion
                        (PROVEN zero-interaction)
                                  │
                                  ▼
                         Execute Commands:
                         1. Focus chat
                         2. Clear input
                         3. Type prompt
                         4. Submit
                                  │
                                  ▼
                           Format Prompt
                           • Add @workspace
                           • Add #file refs
                           • Add slash cmd
                                  │
                                  ▼
                           Send to Copilot ─────────► [Chat Input]
                                  │                        │
                                  ▼                        ▼
                           Update Progress            [Submit]
                                  │                        │
                                  ▼                        ▼
                           Wait/End Condition         [AI Response]
                                  │                        │
                                  ▼                        │
                           Next Prompt? ◄─────────────────┘
                                  │
                     ┌────────────┴────────────┐
                     │                         │
                     ▼                         ▼
                   [Yes]                     [No]
                     │                         │
                     │                         ▼
                     │                   [Complete!]
                     └─────► [Loop to next prompt]
```

## Component Interaction Diagram

```
┌──────────────────┐
│    extension.ts  │  Extension Entry Point
└────────┬─────────┘
         │
         │ activate()
         ▼
┌──────────────────┐
│ FlightPathManager│  Main Controller
└────────┬─────────┘
         │
         │ initialize()
         ▼
    ┌────────────────────────────────┐
    │                                │
    ▼                                ▼
┌────────────┐              ┌─────────────────┐
│PromptQueue │              │CopilotIntegration│
└─────┬──────┘              └────────┬────────┘
      │                              │
      │ loadPrompts()                │ refresh()
      │ start()                      │ detectStrategy()
      │                              │
      │                              │
      │ getCurrentPrompt()           │
      ├──────────────────────────────►
      │                              │
      │                              │ sendPrompt()
      │◄─────────────────────────────┤
      │                              │
      │ markCurrentAsSent()          │
      │                              │
      │                              ▼
      │                        ┌──────────────┐
      │                        │ VS Code API  │
      │                        │  Commands    │
      │                        └──────────────┘
      │                              │
      │                              │ type
      │                              │ submit
      │                              │ focus
      │                              ▼
      │                        ┌──────────────┐
      │                        │Copilot Chat  │
      │                        │    Panel     │
      │                        └──────────────┘
      │
      ▼
┌───────────────┐
│StatusBarItem  │  UI Updates
└───────────────┘
```

## Strategy Selection Flow

```
Start (Background Polling)
  │
  ▼
Check: Copilot extensions installed?
  │
  ├─No──► [Status: unavailable] ❌
  │
  ├─Yes──► Attempt activation if needed
  │          │
  │          ▼
  │      Check: All commands available?
  │      • type
  │      • workbench.action.chat.submit
  │      • workbench.panel.chat.view.copilot.focus
  │      • editor.action.selectAll
  │          │
  │          ├─Yes──► [Status: ready] ✅
  │          │        Direct automation available
  │          │
  │          └─No───► [Status: unavailable] ❌
  │                   Show clear error with:
  │                   • Requirements list
  │                   • Troubleshooting steps
  │                   • Manual retry option
  │
  ▼
Poll up to 6 times (30 seconds total)
  │
  ├─Ready──► Status bar: "$(rocket) FlightPath - Ready"
  │
  ├─Timeout──► Status bar: "$(warning) FlightPath - Setup Required"
  │
  └─Initializing──► Status bar: "$(loading~spin) FlightPath - Initializing..."
```

## Context Building Process

```
PromptItem
    │
    ▼
buildCopilotChatPrompt()
    │
    ├─► Check: includeWorkspaceFiles?
    │       │
    │       └─Yes──► Add: @workspace
    │                Add: #file:path for each match
    │
    ├─► Check: includeCurrentFile?
    │       │
    │       └─Yes──► Add: #file:currentfile.ts
    │
    ├─► Check: includeSelection?
    │       │
    │       └─Yes──► Add: #selection
    │
    ├─► Analyze: prompt text
    │       │
    │       ├─Contains "fix"? ──► Add: /fix
    │       ├─Contains "explain"? ──► Add: /explain
    │       ├─Contains "create"? ──► Add: /new
    │       └─Contains "test"? ──► Add: /tests
    │
    ▼
[Formatted Copilot Chat Prompt]
    │
    Example:
    "/fix @workspace #file:src/extension.ts #selection Fix error handling"
```

## Error Handling - No Fallback Chain

```
Background Polling (initialization)
    │
    ├─Success──► Status: 'ready'
    │            Allow workflow execution
    │
    └─Timeout (30s)
        │
        ▼
    Status: 'unavailable'
    Block workflow execution
    Show requirements & troubleshooting

During Workflow Execution:
    │
    ▼
Try: Direct Text Insertion
    │
    ├─Success──► Return: true
    │
    └─Error──► Show: Error Dialog
               Return: false
               (No clipboard fallback)
```

## State Management

```
Queue State:
┌────────────────────────────────┐
│ currentIndex: 0                │
│ status: "idle"                 │ ──► "running" ──► "completed"
│ prompts: [...]                 │        │               │
│ results: [...]                 │        ▼               │
└────────────────────────────────┘    "paused"          │
                                          │             │
                                          └───► "error" │
                                                   │    │
                                                   └────┘

Workflow Progress:
┌────────────────────────────────┐
│ workflowStep: 1                │
│ totalSteps: 5                  │  Displayed as:
│                                │  "Step 1/5"
└────────────────────────────────┘  "Step 2/5"
                                    "Step 3/5"
                                    ...
```

---

## Key Design Decisions

### 1. Single Proven Strategy (No Fallbacks)

- **Why**: One validated approach is better than multiple untested fallbacks
- **Benefit**: Clear error messages when automation unavailable
- **Trade-off**: No silent degradation - user must have Copilot Chat working

### 2. Background Polling for Availability

- **Why**: Extensions activate lazily in VS Code
- **Benefit**: Handles slow activation gracefully, transparent state for users
- **Trade-off**: 30-second initialization period on first load

### 3. Command-Based Automation

- **Why**: Proven approach from POC validation
- **Benefit**: Zero-interaction capability
- **Trade-off**: Dependent on VS Code internal commands (requires VS Code 1.85.0+)

### 4. Proven Timing Delays

- **Why**: UI stability and reliability (validated in POC)
- **Benefit**: Consistent automation success
- **Trade-off**: Slight delay in execution (1.8s per prompt)

### 5. Separation of Concerns

- **Why**: SOLID principles and maintainability
- **Benefit**: Easy to test, extend, and modify
- **Trade-off**: More files and abstractions

### 6. Native Copilot Syntax

- **Why**: Preserve all Copilot Chat features
- **Benefit**: Full compatibility with agents, tools, and commands
- **Trade-off**: Dependent on Copilot Chat syntax stability

---

## Chat Mode Completion Detection

Chat mode uses **log file monitoring** to detect when Copilot finishes responding.

### Log File Location

```
Windows: %APPDATA%\Code\logs\{timestamp}\window{N}\exthost\GitHub.copilot-chat\GitHub Copilot Chat.log
macOS:   ~/Library/Application Support/Code/logs/{timestamp}/window{N}/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log
Linux:   ~/.config/Code/logs/{timestamp}/window{N}/exthost/GitHub.copilot-chat/GitHub Copilot Chat.log
```

### Detection Markers

| Marker                  | Meaning                      |
| ----------------------- | ---------------------------- |
| `finish reason: [stop]` | Copilot response complete ✅ |
| `\| cancelled \|`       | User cancelled in chat UI    |

### Detection Algorithm

1. Store log file size before sending prompt
2. Monitor log for new content (poll interval)
3. Check new lines for completion/cancellation markers
4. Timeout after 5 minutes of inactivity

**Key Assumption**: One chat workflow per VS Code window (log file doesn't include session IDs).

See `CHAT_MODE_LIMITATIONS.md` for implications of this limitation.

---

_Architecture designed for: simplicity, reliability, and transparent user experience_
