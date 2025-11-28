# FlightPath Architecture

## System Overview

FlightPath is a VS Code extension implementing a layered architecture with clear separation between UI, orchestration, execution, integration, and validation layers.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         VS Code Extension Host                           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────────────────────────────────────────────────────────┐   │
│  │                          extension.ts                             │   │
│  │                      (Entry Point + Commands)                     │   │
│  └──────────────────────────────────┬───────────────────────────────┘   │
│                                     │                                    │
│  ┌──────────────────────────────────▼───────────────────────────────┐   │
│  │                     FlightPathManager                             │   │
│  │                   (Orchestration Layer)                           │   │
│  │                                                                   │   │
│  │  • Lifecycle management & command coordination                    │   │
│  │  • Factory pattern for CLI/Chat integration selection             │   │
│  │  • Pause/Resume/Stop workflow control                             │   │
│  │  • Dashboard provider coordination                                │   │
│  └──┬───────────────────┬───────────────────┬───────────────────────┘   │
│     │                   │                   │                           │
│     ▼                   ▼                   ▼                           │
│  ┌────────────────┐ ┌──────────────────┐ ┌──────────────────────────┐   │
│  │  PromptQueue   │ │ WorkflowExecutor │ │ FlightPathDashboardProvider│ │
│  │                │ │                  │ │                          │   │
│  │ • State machine│ │ • Execution loop │ │ • WebView UI             │   │
│  │ • Progress     │ │ • Response wait  │ │ • Real-time updates      │   │
│  │ • Retry counts │ │ • End conditions │ │ • CLI output streaming   │   │
│  └───────┬────────┘ └────────┬─────────┘ └──────────────────────────┘   │
│          │                   │                                           │
│          └─────────┬─────────┘                                           │
│                    │                                                     │
│  ┌─────────────────▼─────────────────────────────────────────────────┐  │
│  │              CopilotIntegration (Abstract Base)                    │  │
│  │                                                                    │  │
│  │  • Common attachment processing                                    │  │
│  │  • Dynamic queue instruction injection                             │  │
│  │  • Progress tracking                                               │  │
│  │  • Event emitters (status, response, streaming)                    │  │
│  └──────────────────────────┬────────────────────────────────────────┘  │
│                             │                                            │
│         ┌───────────────────┴───────────────────┐                       │
│         │                                       │                       │
│         ▼                                       ▼                       │
│  ┌──────────────────────────┐        ┌──────────────────────────────┐   │
│  │ CopilotCommandLineIntegr │        │   CopilotChatIntegration     │   │
│  │      (CLI Mode)           │        │       (Chat Mode)            │   │
│  │                           │        │                              │   │
│  │ • Spawns 'copilot' CLI   │        │ • UI automation              │   │
│  │ • Deterministic complete │        │ • Log-based detection        │   │
│  │ • 4 supported models     │        │ • 22 supported models        │   │
│  │ • Session ID tracking    │        │ • Native file attachments    │   │
│  │ • Structured output      │        │                              │   │
│  └──────────────────────────┘        └──────────────────────────────┘   │
│                                                                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │                      Validation Layer                              │  │
│  │                                                                    │  │
│  │  ┌─────────────────┐  ┌───────────────────┐  ┌─────────────────┐  │  │
│  │  │ PromptFileParser│  │EndConditionEvaluator│ │EndConditionHandler│ │  │
│  │  │                 │  │                   │  │                 │  │  │
│  │  │ • JSON/MD parse │  │ • Script execution│  │ • Retry logic   │  │  │
│  │  │ • AJV validation│  │ • Timeout mgmt    │  │ • Failure dialog│  │  │
│  │  │ • File path res.│  │ • Process spawn   │  │ • User decisions│  │  │
│  │  └─────────────────┘  └───────────────────┘  └─────────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

## Component Details

### Entry Point: extension.ts

**Responsibilities:**

- VS Code extension activation and deactivation
- Command registration (22 commands)
- Test command implementations
- DashboardProvider instantiation
- FlightPathManager lifecycle

**Key Functions:**

- `activate()`: Extension initialization
- `testFileAttachment()`: File attachment testing
- `testChatModelSelection()`: Model switching tests
- `testChatAgentSelection()`: Agent switching tests

### Orchestration: FlightPathManager

**Location:** `src/flightpath/FlightPathManager.ts`

**Responsibilities:**

- Central coordinator for all workflow operations
- Factory pattern for CLI/Chat integration selection
- Workflow lifecycle: start, pause, resume, stop
- Dashboard state synchronization
- End condition evaluation coordination

**Key Methods:**

```typescript
async initialize(): Promise<void>
async executePromptFile(filePath: string, modeOverride?: CopilotIntegrationMode): Promise<void>
async takeOff(): Promise<void>
pause(): void
async resume(): Promise<void>
async stop(): Promise<void>
```

**Integration Selection:**

```typescript
private createIntegrationForMode(modeOverride?: CopilotIntegrationMode): CopilotIntegration {
  if (modeOverride) {
    return modeOverride === CopilotIntegrationMode.Chat
      ? this.chatIntegration
      : this.cliIntegration;
  }
  return this.getDefaultIntegration();
}
```

### Execution Layer

#### PromptQueue

**Location:** `src/flightpath/PromptQueue.ts`

**Responsibilities:**

- Sequential prompt execution state machine
- Pause/resume state management
- Progress tracking and retry count management
- Dynamic queue reload and merge
- Completed prompt identity tracking

**State Machine:**

```
IDLE → RUNNING → PAUSED → RUNNING → COMPLETED
         ↓                              ↓
       ERROR ←─────────────────────────┘
```

**Key State:**

```typescript
interface QueueState {
  currentIndex: number;
  status: ExecutionState;
  prompts: PromptItem[];
  results: PromptResult[];
  stopped: boolean;
  completedIds: Set<string>;
  totalExecutionTime: number;
  queueExtensions: number;
}
```

#### WorkflowExecutor

**Location:** `src/flightpath/WorkflowExecutor.ts`

**Responsibilities:**

- Main execution loop for workflows
- Response waiting with pause awareness
- End condition evaluation coordination
- Dynamic queue reload after prompt completion
- Dashboard progress updates

**Execution Flow:**

1. Set queue to running state
2. For each prompt in queue:
   - Check pause/stop status
   - Check execution time limits
   - Update dashboard (step running)
   - Send prompt to integration
   - Wait for response completion
   - Evaluate end condition (if present)
   - Handle retries if validation fails
   - Mark prompt completed
   - Reload queue for dynamic extension
3. Mark workflow complete

### Integration Layer

#### CopilotIntegration (Abstract Base)

**Location:** `src/flightpath/base/CopilotIntegration.ts`

**Common Functionality:**

- File attachment XML building (`#file:` reference processing)
- Dynamic queue instruction injection
- Progress tracking and status bar updates
- Event emitters for status changes, streaming, and completion

**Abstract Methods (Subclass Implementation Required):**

```typescript
abstract initialize(): Promise<void>
abstract sendPrompt(prompt: PromptItem, needsCompletionDetection?: boolean, workflowContext?: {...}): Promise<boolean>
abstract getStatus(): { available: boolean; message: string; strategy: string }
abstract isIntegrationAvailable(): boolean
abstract getInitializationStatus(): CopilotStatus
abstract isReady(): boolean
protected abstract cancelImplementation(): Promise<void>
```

#### CopilotCommandLineIntegration (CLI Mode)

**Location:** `src/flightpath/cli/CopilotCommandLineIntegration.ts`

**Features:**

- Spawns `copilot` CLI process
- Deterministic completion detection (process exit)
- Model selection via `--model` flag
- Session management via `--resume` flag
- Tool permissions configuration
- Structured output parsing

**CLI Command Construction:**

```
copilot --model claude-sonnet-4.5 \
        --add-dir /workspace \
        --allow-all-tools \
        --allow-all-paths \
        --log-dir /tmp/flightpath-logs \
        -p "prompt text"
```

**Supported Models:** `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`, `gpt-5`

#### CopilotChatIntegration (Chat Mode)

**Location:** `src/flightpath/chat/CopilotChatIntegration.ts`

**Features:**

- UI automation via VS Code commands
- Log-based response detection (`ChatLogMonitor`)
- Native file attachments via `attachFile`/`attachSelection`
- Model switching via `workbench.action.chat.changeModel`
- Background polling for Copilot availability

**Response Detection:**
Monitors `GitHub Copilot Chat.log` for `finish reason: [stop]` markers.

**Supported Models:** All 22 Chat models (superset of CLI)

### Validation Layer

#### PromptFileParser

**Location:** `src/flightpath/PromptFileParser.ts`

**Responsibilities:**

- JSON schema validation using AJV
- Support for `.prompt.json`, `.flightpath.json`, `.prompt.md`
- File path resolution for external prompt references
- Normalization of single/multiple prompt formats

**File Resolution Order:**

1. Absolute paths (used as-is)
2. Relative to prompt file's directory
3. Relative to workspace root
4. Relative to `.flightpath` directory

#### EndConditionEvaluator

**Location:** `src/flightpath/EndConditionEvaluator.ts`

**Responsibilities:**

- Script execution with timeout protection
- Process isolation for security
- Multi-language support (Python, JS, TS, Bash, PowerShell, Batch)
- Result comparison against expected values

**Supported Scripts:**
| Extension | Interpreter |
|-----------|-------------|
| `.py` | `python` |
| `.js` | `node` |
| `.ts` | `npx ts-node` |
| `.sh` | `sh` / `bash` |
| `.bat/.cmd` | `cmd /c` |
| `.ps1` | `powershell -ExecutionPolicy Bypass` |

#### EndConditionHandler

**Location:** `src/flightpath/EndConditionHandler.ts`

**Responsibilities:**

- Handle evaluation results (success/failure)
- Orchestrate retry attempts with template placeholders
- User interaction for error recovery decisions
- Distinguish execution errors from validation failures

### UI Layer

#### FlightPathDashboardProvider

**Location:** `src/ui/FlightPathDashboardProvider.ts`

**Responsibilities:**

- WebView panel implementation
- Message passing between extension and webview
- Real-time workflow visualization updates
- CLI output streaming display
- Export functionality

**Message Types:**

- `FILE_SELECTED`, `EXECUTION_STARTED`, `PROGRESS_UPDATE`
- `STEP_STATUS_CHANGED`, `CLI_OUTPUT`, `CLI_STREAMING_CHUNK`
- `EXECUTION_COMPLETED`, `QUEUE_EXTENDED`, `PROMPTS_EXTENDED`

#### StatusBarManager

**Location:** `src/ui/StatusBarManager.ts`

**Responsibilities:**

- Status bar item management
- Workflow progress display (e.g., "Step 2/5")
- Copilot availability indicator
- Quick action buttons

## Data Flow

### Prompt Execution Flow

```
User: Take Off
       │
       ▼
FlightPathManager.takeOff()
       │
       ├─► Show file picker
       │
       ▼
FlightPathManager.executePromptFile()
       │
       ├─► PromptFileParser.parsePromptFile()
       │   └─► Validate JSON Schema (AJV)
       │   └─► Resolve external prompts
       │
       ├─► PromptQueue.loadPrompts()
       │
       ├─► createIntegrationForMode()
       │   └─► CLI or Chat based on settings/override
       │
       ▼
WorkflowExecutor.execute()
       │
       ├─► For each prompt:
       │   │
       │   ├─► Check pause/stop status
       │   ├─► Check execution time limits
       │   │
       │   ├─► integration.sendPrompt()
       │   │   ├─► buildPromptText() (file attachments)
       │   │   ├─► buildPromptWithInstructions() (dynamic queue)
       │   │   └─► Execute (CLI spawn / Chat UI automation)
       │   │
       │   ├─► Wait for response
       │   │
       │   ├─► If endCondition:
       │   │   ├─► EndConditionEvaluator.evaluateCondition()
       │   │   └─► EndConditionHandler.handleEndConditionResult()
       │   │       └─► Retry loop if validation fails
       │   │
       │   ├─► PromptQueue.completeCurrentAndMoveNext()
       │   │
       │   └─► If dynamicQueue enabled:
       │       └─► PromptQueue.reloadAndMergeQueue()
       │
       ▼
Workflow Complete
```

## Design Patterns

### Factory Pattern (Integration Selection)

FlightPathManager uses factory pattern to create the appropriate Copilot integration based on user settings or command override.

### Strategy Pattern (CLI vs Chat)

CopilotIntegration base class defines the interface, with CLI and Chat implementations providing different execution strategies.

### Template Method (Prompt Building)

Base class implements common prompt building logic (attachments, instructions), subclasses provide execution specifics.

### Observer Pattern (Event Emitters)

Status changes, streaming output, and response completion are communicated via EventEmitter pattern.

### State Machine (Queue Management)

PromptQueue implements a state machine for workflow execution states (IDLE → RUNNING → PAUSED → COMPLETED/ERROR).

## Security Considerations

1. **Script Isolation**: End condition scripts run in separate processes
2. **Workspace Scoping**: File operations limited to workspace folders
3. **Path Validation**: Script paths validated before execution
4. **Timeout Protection**: Configurable timeouts prevent runaway scripts
5. **Tool Permissions**: CLI mode supports allow/deny tool patterns

## Extension Points

1. **Custom Integrations**: Implement `CopilotIntegration` abstract class
2. **Script Languages**: Add cases to `getScriptCommand()` in EndConditionEvaluator
3. **Validation Rules**: Extend JSON schema and parser
4. **Dashboard UI**: Modify webview HTML/CSS/JS in `src/ui/webview/`
