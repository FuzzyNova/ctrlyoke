# FlightPath Component Inventory

## Core Components

### Orchestration Components

#### FlightPathManager

- **Location:** `src/flightpath/FlightPathManager.ts`
- **Type:** Main Controller
- **Purpose:** Central orchestration for all workflow operations
- **Dependencies:** PromptQueue, WorkflowExecutor, CopilotIntegration, EndConditionHandler, DashboardProvider
- **Key Methods:**
  - `initialize()` - Extension initialization
  - `executePromptFile()` - Execute a workflow
  - `takeOff()` - Interactive file selection and execution
  - `pause()`, `resume()`, `stop()` - Workflow control
  - `createPromptFile()` - Create new prompt files

#### WorkflowExecutor

- **Location:** `src/flightpath/WorkflowExecutor.ts`
- **Type:** Execution Engine
- **Purpose:** Main execution loop for workflows
- **Dependencies:** PromptQueue, PromptFileParser, EndConditionHandler, CopilotIntegration
- **Key Methods:**
  - `execute()` - Run the workflow execution loop
  - `waitForResponseComplete()` - Handle response waiting with pause awareness
  - `evaluateEndCondition()` - Coordinate end condition evaluation

### Execution Components

#### PromptQueue

- **Location:** `src/flightpath/PromptQueue.ts`
- **Type:** State Manager
- **Purpose:** Sequential execution state machine
- **Key Methods:**
  - `loadPrompts()` - Load prompts into queue
  - `start()`, `pause()`, `resume()`, `stop()` - State transitions
  - `markCurrentAsSent()`, `completeCurrentAndMoveNext()` - Progress tracking
  - `reloadAndMergeQueue()` - Dynamic queue extension
  - `canRetry()`, `incrementRetryCount()` - Retry management

#### EndConditionEvaluator

- **Location:** `src/flightpath/EndConditionEvaluator.ts`
- **Type:** Validation Engine
- **Purpose:** Script execution and result validation
- **Key Methods:**
  - `evaluateCondition()` - Execute script and check result
  - `resolveScriptPath()` - Find script in workspace
  - `getScriptCommand()` - Determine interpreter for script type
  - `executeScript()` - Spawn script process with timeout

#### EndConditionHandler

- **Location:** `src/flightpath/EndConditionHandler.ts`
- **Type:** Decision Handler
- **Purpose:** Handle validation results and orchestrate retries
- **Key Methods:**
  - `handleEndConditionResult()` - Process evaluation result
  - `handleExecutionError()` - Handle script failures
  - `handleValidationFailure()` - Handle mismatched output
  - `buildRetryPromptItem()` - Construct retry prompt with placeholders

### Integration Components

#### CopilotIntegration (Abstract Base)

- **Location:** `src/flightpath/base/CopilotIntegration.ts`
- **Type:** Abstract Class
- **Purpose:** Define integration contract and common functionality
- **Common Methods:**
  - `buildPromptText()` - Extract prompt with attachments
  - `buildPromptWithInstructions()` - Add dynamic queue instructions
  - `processPromptAttachments()` - Process `#file:` references
  - `setWorkflowProgress()` - Track execution progress
  - `cancel()` - Cancel current operation

#### CopilotCommandLineIntegration

- **Location:** `src/flightpath/cli/CopilotCommandLineIntegration.ts`
- **Type:** CLI Implementation
- **Purpose:** Execute prompts via Copilot CLI
- **Key Methods:**
  - `initialize()` - Check CLI availability
  - `sendPrompt()` - Execute prompt via CLI process
  - `buildCliArgs()` - Construct CLI command arguments
  - `validateAndGetModel()` - Validate model against CLI-supported list
  - `spawnProcess()` - Execute CLI with streaming output

#### CopilotChatIntegration

- **Location:** `src/flightpath/chat/CopilotChatIntegration.ts`
- **Type:** Chat Implementation
- **Purpose:** Execute prompts via UI automation
- **Key Methods:**
  - `initialize()` - Start background polling
  - `sendPrompt()` - Type and submit prompt in chat
  - `startNewChatSession()` - Create new chat session
  - `switchModelIfNeeded()` - Change chat model
  - `waitForLogCompletion()` - Detect response completion via log

#### ChatLogMonitor

- **Location:** `src/flightpath/chat/ChatLogMonitor.ts`
- **Type:** Response Detector
- **Purpose:** Monitor chat logs for completion markers
- **Key Methods:**
  - `waitForCompletion()` - Wait for `finish reason: [stop]` marker
  - `getLogFilePath()` - Find chat log file location

#### NativeAttachmentHandler

- **Location:** `src/flightpath/chat/NativeAttachmentHandler.ts`
- **Type:** Attachment Manager
- **Purpose:** Handle file/selection attachments via VS Code API
- **Key Methods:**
  - `attachFiles()` - Attach files using native commands
  - `attachSelection()` - Attach current editor selection

### Parser Components

#### PromptFileParser

- **Location:** `src/flightpath/PromptFileParser.ts`
- **Type:** File Parser
- **Purpose:** Parse and validate prompt files
- **Key Methods:**
  - `parsePromptFile()` - Parse JSON or Markdown prompt file
  - `parseMarkdownPromptFile()` - Parse `.prompt.md` files
  - `normalizePromptFile()` - Convert to standard format
  - `resolvePromptContent()` - Resolve external file references
  - `discoverPromptFiles()` - Find all prompt files in workspace

### UI Components

#### FlightPathDashboardProvider

- **Location:** `src/ui/FlightPathDashboardProvider.ts`
- **Type:** WebView Provider
- **Purpose:** Real-time workflow visualization
- **Key Methods:**
  - `resolveWebviewView()` - Initialize webview
  - `updateFileSelected()` - Notify file selection
  - `updateExecutionStarted()` - Notify execution start
  - `updateStepStatus()` - Update step status
  - `updateCliOutput()` - Display CLI output
  - `updateCliStreamingChunk()` - Stream CLI output in real-time

#### StatusBarManager

- **Location:** `src/ui/StatusBarManager.ts`
- **Type:** Status Bar Controller
- **Purpose:** Manage status bar items
- **Key Methods:**
  - `updateStatus()` - Update status bar text
  - `showProgress()` - Display step progress
  - `showReady()` - Show ready state

### IntelliSense Components

#### PromptCompletionProvider

- **Location:** `src/completions/PromptCompletionProvider.ts`
- **Type:** Completion Provider
- **Purpose:** Provide `#file:` and `#selection` completions
- **Key Methods:**
  - `provideCompletionItems()` - Generate completion items
  - `getAllSelectionCompletions()` - Get visible editor selections
  - `getFileCompletions()` - Get workspace files

### Utility Components

#### ConfigurationUtils

- **Location:** `src/utils/ConfigurationUtils.ts`
- **Type:** Configuration Helper
- **Purpose:** Centralize VS Code settings access
- **Key Methods:**
  - `getIntegrationMode()` - Get CLI/Chat preference
  - `getDynamicQueueConfig()` - Get dynamic queue settings
  - `getPromptsDirectory()` - Get prompts directory path

#### PromptIdentity

- **Location:** `src/utils/PromptIdentity.ts`
- **Type:** Identity Tracker
- **Purpose:** Track completed prompts for dynamic queue
- **Key Methods:**
  - `hashPromptContent()` - Generate SHA-256 hash of prompt
  - `isPromptCompleted()` - Check if prompt already executed
  - `shouldInjectExtensionInstructions()` - Determine if prompt gets instructions

#### LoggingUtils

- **Location:** `src/utils/LoggingUtils.ts`
- **Type:** Logging Helper
- **Purpose:** Consistent logging utilities

#### FileSystemUtils

- **Location:** `src/utils/FileSystemUtils.ts`
- **Type:** File Helper
- **Purpose:** File system operations

#### ValidationUtils

- **Location:** `src/utils/ValidationUtils.ts`
- **Type:** Validation Helper
- **Purpose:** Common validation functions

## Component Categories Summary

| Category          | Count | Components                                                                         |
| ----------------- | ----- | ---------------------------------------------------------------------------------- |
| **Orchestration** | 2     | FlightPathManager, WorkflowExecutor                                                |
| **Execution**     | 3     | PromptQueue, EndConditionEvaluator, EndConditionHandler                            |
| **Integration**   | 4     | CopilotIntegration, CLI, Chat, ChatLogMonitor                                      |
| **Parser**        | 1     | PromptFileParser                                                                   |
| **UI**            | 2     | FlightPathDashboardProvider, StatusBarManager                                      |
| **IntelliSense**  | 1     | PromptCompletionProvider                                                           |
| **Utilities**     | 5     | ConfigurationUtils, PromptIdentity, LoggingUtils, FileSystemUtils, ValidationUtils |

## Reusable Patterns

### Event Emitters

Used consistently across integrations for:

- Status changes (`onDidChangeStatus`)
- Response completion (`onResponseComplete`)
- Streaming chunks (`onStreamingChunk`)
- Prompt ready (`onPromptReady`)

### Factory Pattern

FlightPathManager uses factory pattern for integration selection based on user settings or command override.

### Strategy Pattern

CopilotIntegration base class with CLI and Chat implementations as strategies.

### Template Method

Base class implements common prompt building; subclasses provide execution specifics.

### State Machine

PromptQueue implements IDLE → RUNNING → PAUSED → COMPLETED/ERROR state transitions.
