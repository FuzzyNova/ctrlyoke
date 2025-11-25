---
applyTo: "src/flightpath/*.ts"
---

<purpose>
Orchestration, parsing, queue, and validation. Top-level `src/flightpath/` files only.
</purpose>

<flightPathManager>
**Responsibilities:**
- Command registration and lifecycle management
- Factory pattern for CLI vs Chat integration (both initialized)
- Orchestrates PromptQueue and CopilotIntegration coordination
- Subscribes to response completion events, triggers next queue item
- Status bar updates based on queue state and Copilot availability
- Manages prompt file loading vs execution separation (dashboard UX flow)

**Critical patterns:**

- Both integrations initialized in constructor (always ready)
- `getDefaultIntegration()` respects `flightpath.copilotIntegrationMode`
- Context menu commands override integration mode per-execution
- Response complete event triggers `advanceQueue()`
- Loop detection: Cancels chat if response fires without advancement

**Prompt file workflow:**

- `loadPromptFile(filePath)` - Loads file into dashboard WITHOUT executing (validates, parses, notifies dashboard)
- `executeLoadedPromptFile(mode?)` - Executes the currently loaded file (checks Copilot readiness, starts workflow)
- `executePromptFile(filePath, mode?)` - Legacy method (loads then immediately executes for backwards compatibility)
- Dashboard "Change" button → calls `loadPromptFile()` → user can review prompts before clicking "Run"
- Dashboard "Run" button → calls `executeLoadedPromptFile()` → starts execution immediately (no confirmation dialog)
- Context menu "Send to CLI/Chat" → calls `executePromptFile()` → loads and executes immediately

**Mode override:**

- Context menu "Send to CLI" / "Send to Chat" use mode override mechanism
- Single-prompt files execute directly; multi-prompt use queue
  </flightPathManager>

<promptQueue>
**Responsibilities:**
- State container for workflow execution (NOT event-driven execution)
- Sequential state management (idle → running → paused/completed/error)
- Progress tracking, retry counting, and result storage
- State change events for UI updates

**Architecture decision: Direct execution, not event-driven**

- FlightPathManager executes prompts directly in a for loop (deterministic control flow)
- PromptQueue is a state container that emits change events
- This design supports complex retry logic where execution "stays" on a step during retries
- Event-driven model would require complex state machines to handle retry pauses

**State management methods:**

- `loadPrompts()` - Resets state, creates pending results array
- `start()` - Sets status to "running" (doesn't execute, just state change)
- `pause()` - Sets status to "paused", FlightPathManager checks this in loop
- `resume()` - Sets status to "running", FlightPathManager continues loop
- `stop()` - Sets status to "idle", marks sent prompts as cancelled
- `markCompleted()` / `markErrored()` - Manual completion called by FlightPathManager
- `emitStateChange()` - Fires event for status bar and dashboard updates

**Retry tracking:**

- `canRetry(prompt)` - Checks if retry is possible based on maxRetries
- `incrementRetryCount()` / `resetRetryCount()` / `getCurrentRetryCount()`
- `getEffectiveMaxRetries(prompt)` / `getEffectiveRetryPrompt(prompt)` - Smart defaults

**Why NOT event-driven:**

- Retry logic requires staying on same prompt index while retrying
- For loop gives deterministic flow: stay at index `i` until success or max retries
- Event-driven would need complex state to "pause" advancement during retries
- Try-catch around loop is simpler than event-driven error propagation
  </promptQueue>

<promptFileParser>
**Responsibilities:**
- JSON schema validation using AJV
- Normalizes single/multi-prompt formats to consistent structure
- Loads schema from bundled location (`out/schemas/prompt-schema.json`)

**Critical patterns:**

- Schema loaded asynchronously from `__dirname/../schemas/`
- Same schema validates both `.prompt.json` and `.flightpath.json`
- `normalizePromptFile()` converts single to multi-prompt internally
- Detailed error reporting: maps AJV errors to human-readable messages

**Schema source of truth:**

- Single file: `/schemas/prompt-schema.json`
- Copied to `out/schemas/` during build
- VS Code IntelliSense and runtime use same schema
- Never edit schema in `out/` directory (source is `/schemas/`)
  </promptFileParser>

<endConditionHandler>
**Responsibilities:**
- Orchestrates end condition evaluation results and retry decisions
- Handles execution errors (script failures, timeouts)
- Handles validation failures (output doesn't match expected)
- Manages retry attempts with dashboard updates
- Provides user interaction for error recovery

**Architecture:**

- Extracted from FlightPathManager for single responsibility
- Uses callback pattern for sending retry prompts (avoids tight coupling)
- Delegates script execution to EndConditionEvaluator
- Delegates retry state tracking to PromptQueue

**Key methods:**

- `handleEndConditionResult()` - Entry point, routes to success/error/validation
- `handleExecutionError()` - Handles script failures with user prompts
- `handleValidationFailure()` - Orchestrates retry logic
- `handleMaxRetriesExhausted()` - Final failure with user options
- `buildRetryPrompt()` - Template placeholder replacement

**RetryContext pattern:**

- Bundles integration, totalPrompts, workspaceFolderPath, currentPromptFilePath
- Reduces parameter count in recursive calls
- Simplifies testing by allowing mock context injection

**Callback pattern for retry prompts:**

- `SendRetryPromptCallback` type defined in EndConditionHandler
- WorkflowExecutor creates callback via `createSendRetryPromptCallback()`
- Callback handles: sending prompt, waiting for response, updating dashboard
- Returns response text on success, null on failure
  </endConditionHandler>

<workflowExecutor>
**Responsibilities:**
- Execute prompts sequentially with pause/resume support
- Wait for Copilot responses with duplicate event protection
- Manage pause/resume state for response handling
- Coordinate with EndConditionHandler for validation
- Update dashboard with execution progress
- Handle dynamic queue reload after prompt completion
- CLI streaming output setup

**Architecture:**

- Extracted from FlightPathManager for single responsibility
- Uses `WorkflowContext` interface to receive all dependencies
- Exposes pause/resume state methods for FlightPathManager coordination
- Owns the response waiting and streaming logic

**Key methods:**

- `execute()` - Main execution loop, delegates from FlightPathManager
- `waitForResponseComplete()` - Response promise with pause awareness
- `evaluateEndCondition()` - End condition evaluation with retry callback
- `createSendRetryPromptCallback()` - Retry prompt callback factory
- `hasPendingResponse()` / `isAwaitingResponse()` - State inspection for pause/resume
- `resumePendingResponse()` / `clearPendingState()` - State management

**WorkflowContext pattern:**

- Bundles: workspaceFolderPath, currentPromptFilePath, dashboardProvider
- Also: outputChannel, shouldShowCliCommand, showCliOutput, dynamicQueueConfig
- FlightPathManager builds context before each execution
- Reduces parameter count and improves testability
  </workflowExecutor>

<endConditionEvaluator>
**Responsibilities:**
- Executes validation scripts (.py, .js, .ts, .sh, .bat, .ps1)
- Path validation and security (workspace-only)
- Process isolation with configurable timeouts
- Compares script output to expected value

**Security patterns:**

- Scripts must be in workspace (no system-wide execution)
- Runs in separate child process (isolation)
- Timeout kills process (default 30s, configurable)
- No direct file system access (must use CLI tools)

**Script execution flow:**

1. Resolve script path (absolute or workspace-relative)
2. Determine script type by extension
3. Spawn child process with timeout
4. Capture stdout/stderr
5. Compare output to `endCondition.returns` value
6. Return success/failure with timing

**Template system:**

- Templates in `src/templates/` copied to `out/templates/` during build
- `createSampleScript()` copies template to `.flightpath/` directory
- Uses `context.extensionPath` to find bundled templates
- Templates show basic structure, user must customize

**Future enhancement:**

- Pass Copilot response text to scripts (CLI only)
- Enable response content validation (not yet implemented)
  </endConditionEvaluator>

<relatedFiles>
- `./base/CopilotIntegration.ts` - Integration contract
- `./cli/CopilotCommandLineIntegration.ts` - CLI implementation
- `./chat/CopilotChatIntegration.ts` - Chat implementation
- `./WorkflowExecutor.ts` - Workflow execution loop
- `./EndConditionHandler.ts` - Retry and validation failure handling
- `../types/FlightPathTypes.ts` - Core type definitions
</relatedFiles>
