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
- Sequential execution state machine (idle → running → paused/completed/error)
- Progress tracking and result storage
- Does NOT handle response detection (delegated to FlightPathManager)

**State management:**

- `loadPrompts()` resets state, creates pending results array
- `start()` begins execution, `pause()` stops advancement
- `resume()` continues from `currentIndex`
- `markCompleted()` and `markFailed()` update result status
- `emitStateChange()` fires event for status bar updates

**Why queue doesn't detect responses:**

- Queue is integration-agnostic (doesn't know CLI vs Chat)
- FlightPathManager subscribes to integration's `onResponseComplete`
- Manager calls `queue.markCompleted()` and `advanceQueue()` when response fires
- Clean separation: Queue manages state, Manager coordinates
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
- `../types/FlightPathTypes.ts` - Core type definitions
</relatedFiles>
