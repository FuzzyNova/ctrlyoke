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
│                       │   Automation Strategy Chain      │          │
│                       ├──────────────────────────────────┤          │
│                       │                                  │          │
│                       │      Direct Text Insertion       │          │
│                       │     (Zero-interaction)           │          │
│                       │     • Focus chat                 │          │
│                       │     • Clear input                │          │
│                       │     • Type prompt                │          │
│                       │     • Submit auto                │          │
│                       │                                  │          │
│                       │  2️⃣ Command Sequence            │          │
│                       │     (Minimal interaction)        │          │
│                       │     • Clipboard copy             │          │
│                       │     • Auto paste                 │          │
│                       │     • Auto submit                │          │
│                       │                                  │          │
│                       │  3️⃣ Enhanced Clipboard          │          │
│                       │     (Manual paste)               │          │
│                       │     • Copy to clipboard          │          │
│                       │     • User notification          │          │
│                       │     • Preview option             │          │
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
         ┌────────────────────────┼────────────────────────┐
         │                        │                        │
         ▼                        ▼                        ▼
    Direct Text             Command Seq.              Clipboard
    Insertion               Automation                Fallback
         │                        │                        │
         │                        │                        │
         ▼                        ▼                        ▼
   Execute Commands         Execute Commands         Copy + Notify
         │                        │                        │
         └────────────────────────┼────────────────────────┘
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
Start
  │
  ▼
Check: 'type' command available?
  │
  ├─Yes──► Check: 'chat.submit' available?
  │          │
  │          ├─Yes──► Check: 'chat.focus' available?
  │          │          │
  │          │          ├─Yes──► [Direct Text Insertion] ✅ BEST
  │          │          │
  │          │          └─No───┐
  │          │                 │
  │          └─No──────────────┤
  │                            │
  └─No────────────────────────►│
                               │
                               ▼
           Check: 'paste' command available?
                               │
                               ├─Yes──► [Command Sequence] ✅ GOOD
                               │
                               └─No───┐
                                      │
                                      ▼
                    Check: 'chat.focus' available?
                                      │
                                      ├─Yes──► [Enhanced Clipboard] ⚠️ OK
                                      │
                                      └─No───► [Unavailable] ❌ ERROR
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

## Error Handling & Fallback Chain

```
Try: Direct Text Insertion
    │
    ├─Success──► Return: true
    │
    └─Error
        │
        ▼
    Try: Command Sequence
        │
        ├─Success──► Return: true
        │
        └─Error
            │
            ▼
        Try: Enhanced Clipboard
            │
            ├─Success──► Return: true
            │
            └─Error
                │
                ▼
            Show: Error Dialog
            Return: false
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

### 1. Multi-Strategy Pattern
- **Why**: Maximum compatibility across VS Code versions
- **Benefit**: Graceful degradation ensures workflows always complete
- **Trade-off**: Increased code complexity

### 2. Command-Based Automation
- **Why**: Proven approach from POC validation
- **Benefit**: Zero-interaction capability
- **Trade-off**: Dependent on VS Code internal commands

### 3. Timing Delays
- **Why**: UI stability and reliability
- **Benefit**: Consistent automation success
- **Trade-off**: Slight delay in execution (1.8s per prompt)

### 4. Separation of Concerns
- **Why**: SOLID principles and maintainability
- **Benefit**: Easy to test, extend, and modify
- **Trade-off**: More files and abstractions

### 5. Native Copilot Syntax
- **Why**: Preserve all Copilot Chat features
- **Benefit**: Full compatibility with agents, tools, and commands
- **Trade-off**: Dependent on Copilot Chat syntax stability

---

*Architecture designed for: extensibility, reliability, and user experience*  
*Implementation date: September 30, 2025*
