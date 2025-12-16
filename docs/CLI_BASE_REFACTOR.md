# BaseCliIntegration Refactoring Plan

**Status:** Planning Phase  
**Created:** December 15, 2025  
**Goal:** Reduce BaseCliIntegration from ~1400 lines to ~600 lines through strategic extraction of cohesive utilities

## 🎯 Problem Statement

BaseCliIntegration.ts has grown to ~1400 lines with multiple responsibilities mixed together:

- Process spawning and lifecycle management (spawn, kill, timeout handling)
- Terminal creation and shell integration waiting
- TUI output streaming and completion detection (~400 lines of complex parsing logic)
- Workspace/configuration access helpers
- Logging utilities
- Abstract method definitions for subclass customization

**Additional Issues:**

- Verbose comments (64-line header, extensive inline documentation)
- Code duplication with EndConditionEvaluator (both spawn processes with timeouts)
- Difficult to test in isolation (tightly coupled concerns)
- High cognitive load when working on specific features

## 🔍 Codebase Analysis

### Current spawn Usage

1. **BaseCliIntegration** - 3 methods:
   - `spawnProcess()` - Full CLI execution with streaming
   - `spawnSimpleCommand()` - Simple commands like `--version`
   - `killProcessGracefully()` - SIGTERM → SIGKILL escalation

2. **EndConditionEvaluator** - Direct spawn with:
   - Timeout handling
   - VS Code environment variable cleanup
   - stdout/stderr collection
   - Process tracking for cancellation

3. **Templates** (check_condition.js) - Example code, not production

### Terminal Operations

All within BaseCliIntegration:

- `createFreshTerminal()` - Creates VS Code terminal
- `waitForShellIntegration()` - Waits for shell integration API
- `disposeTerminalIfExists()` - Cleanup
- Terminal state management for interactive TUI execution

## 🏗️ Proposed Architecture

### Decision: Combined CliProcessManager

**Rationale for combining process + terminal management:**

✅ **Naturally Coupled in CLI Domain:**

- Interactive mode workflow: create terminal → spawn process → dispose terminal
- Process cancellation needs terminal access (send Ctrl+C to terminal)
- Coordinated cleanup of both resources

✅ **Avoids Design Problems:**

- Separate classes create circular dependencies
- TerminalManager needs ProcessManager for terminal-based execution
- ProcessManager needs Terminal reference for interactive mode
- Combined approach = single coordination point

✅ **Maintains Single Responsibility:**

- The responsibility: "Manage CLI process execution lifecycle"
- Terminal and process are implementation details of that responsibility
- Analogous to "Car" class managing engine + wheels (they work together)

❌ **Alternative Rejected: Separate Classes**

- Creates awkward delegation chains
- Requires extra coordination logic
- Over-engineering for this domain

### Three New Utilities

1. **CliProcessManager** (~300 lines) - Process spawning + terminal management
2. **TuiStreamProcessor** (~400 lines) - TUI output parsing and completion detection
3. **CliOutputLogger** (~50 lines) - Formatted logging utilities (optional)

## 📦 Component Details

### 1. CliProcessManager

**Location:** `src/utils/CliProcessManager.ts`

**Responsibilities:**

- Spawn CLI processes (headless and interactive)
- Create and manage VS Code terminals
- Graceful process shutdown (SIGTERM → SIGKILL escalation)
- Terminal shell integration handling
- Coordinated cancellation (both process and terminal)

**Interface:**

```typescript
export class CliProcessManager {
  // Process state
  private currentProcess?: ChildProcess;
  private killTimeoutId?: NodeJS.Timeout;

  // Terminal state
  private terminal?: vscode.Terminal;
  private shellIntegration?: vscode.TerminalShellIntegration;

  constructor(
    private workspaceRoot: string,
    private logger?: (msg: string) => void
  ) {}

  // === Process Spawning ===

  /**
   * Spawn a CLI process with full control over stdin/stdout/stderr.
   * Supports streaming output via onStdout callback.
   */
  async spawn(
    command: string,
    args: string[],
    options: SpawnOptions
  ): Promise<SpawnResult>;

  /**
   * Spawn a simple command (e.g., --version checks) with timeout.
   */
  async spawnSimple(
    command: string,
    args: string[],
    timeoutMs?: number
  ): Promise<SpawnResult>;

  // === Terminal Management ===

  /**
   * Create a fresh VS Code terminal with specified name.
   * Disposes existing terminal if present.
   */
  async createTerminal(name: string, cwd?: string): Promise<vscode.Terminal>;

  /**
   * Wait for shell integration to become available on terminal.
   * Required for using executeCommand() and read() APIs.
   */
  async waitForShellIntegration(
    terminal: vscode.Terminal,
    timeoutMs?: number
  ): Promise<vscode.TerminalShellIntegration>;

  /**
   * Dispose the current terminal if it exists.
   */
  disposeTerminal(): void;

  /**
   * Get the current terminal reference (if any).
   */
  getTerminal(): vscode.Terminal | undefined;

  /**
   * Get the current shell integration (if any).
   */
  getShellIntegration(): vscode.TerminalShellIntegration | undefined;

  // === Lifecycle Management ===

  /**
   * Cancel current execution (process or terminal).
   * For terminal: Sends Ctrl+C twice, then disposes
   * For process: SIGTERM with 3s timeout, then SIGKILL
   */
  async cancel(): Promise<void>;

  /**
   * Check if there's an active process or terminal.
   */
  isActive(): boolean;

  /**
   * Clean up all resources (terminal and process).
   */
  dispose(): void;

  // === Private Helpers ===

  private killGracefully(child: ChildProcess): void;
  private clearKillTimeout(): void;
}

export interface SpawnOptions {
  cwd?: string;
  timeout?: number;
  onStdout?: (chunk: string) => void;
  shell?: boolean;
  stdio?: [string, string, string];
  env?: NodeJS.ProcessEnv;
}

export interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

**Key Features:**

- **Single source of truth** for process spawning (eliminates duplication)
- **Consistent timeout/kill logic** across all spawn usage
- **Coordinated cleanup** - handles both terminal and process disposal
- **Shell integration abstraction** - encapsulates VS Code terminal API complexity

**Used By:**

- BaseCliIntegration (interactive and headless execution)
- EndConditionEvaluator (script execution)

---

### 2. TuiStreamProcessor

**Location:** `src/utils/TuiStreamProcessor.ts`

**Responsibilities:**

- Stream TUI output from TerminalShellExecution.read()
- Detect TUI readiness (first complete screen)
- Send prompt via file reference when ready
- Parse TUI screens from buffer
- Extract new content deltas (deduplication)
- Detect completion (escape indicator disappearing)
- Handle CLI errors in output

**Interface:**

```typescript
export class TuiStreamProcessor {
  constructor(
    private config: TuiStreamConfig,
    private logger?: (msg: string) => void
  ) {}

  /**
   * Process TUI stream from terminal execution.
   *
   * Flow:
   * 1. Wait for TUI ready (screen end pattern appears)
   * 2. Send prompt via @file reference
   * 3. Wait for file echo (prompt has been read)
   * 4. Submit prompt (send \r)
   * 5. Stream output and detect completion
   *
   * Completion detection:
   * - Escape indicator appears (CLI generating)
   * - Escape indicator disappears for 2+ screens (complete)
   *
   * @returns true if completed successfully, false on timeout/error
   */
  async processStream(
    execution: vscode.TerminalShellExecution,
    terminal: vscode.Terminal,
    promptText: string,
    timeoutMs: number,
    workflowContext?: WorkflowContext
  ): Promise<boolean>;

  /**
   * Extract complete TUI screens from accumulated buffer.
   * Uses CLI-specific screen end pattern to detect boundaries.
   *
   * @returns Object with complete screens array and remaining buffer
   */
  extractScreensFromBuffer(buffer: string): {
    screens: string[];
    remainder: string;
  };

  /**
   * Extract new content from a screen that hasn't been emitted yet.
   *
   * Features:
   * - Filters TUI chrome (borders, status bars, prompts)
   * - Deduplicates content lines (tracks by trimmed content)
   * - Preserves formatting (indentation, empty lines)
   * - Filters prompt echo
   * - Collapses consecutive blank lines (max 2)
   *
   * @param screen The current screen content
   * @param emittedContent Set of content already emitted (for dedup)
   * @param promptToFilter Optional prompt text to filter from response
   * @returns New content to emit (modifies emittedContent set)
   */
  extractNewContent(
    screen: string,
    emittedContent: Set<string>,
    promptToFilter?: string
  ): string;

  /**
   * Check if a line is TUI chrome that should be filtered.
   * Matches specific TUI patterns without catching content.
   */
  isTuiChromeLine(line: string): boolean;

  /**
   * Strip ANSI escape codes and terminal control sequences.
   * Preserves all printable characters including markdown.
   */
  stripAnsiCodes(text: string): string;

  /**
   * Detect CLI errors in raw TUI output.
   * Distinguishes real errors from pasted prompt content.
   *
   * Strategy:
   * - Real errors: TUI chrome BEFORE, no chrome AFTER
   * - False positives: TUI chrome BEFORE and AFTER (pasted content)
   */
  private detectCliError(rawBuffer: string): boolean;
}

export interface TuiStreamConfig {
  // CLI-specific patterns (from abstract methods)
  escapeIndicator: string; // e.g., "(esc to cancel)"
  screenEndPattern: RegExp; // e.g., /Ctrl\+c Exit/
  tuiChromePattern: RegExp; // e.g., /Ctrl\+c Exit/

  // Event emitters for communication
  streamingEmitter: vscode.EventEmitter<string>;
  responseCompleteEmitter: vscode.EventEmitter<string>;

  // Optional configuration
  fileSilenceMs?: number; // Default: 1000ms
  maxConsecutiveBlankLines?: number; // Default: 2
}

export interface WorkflowContext {
  promptIndex: number;
  allPrompts: PromptItem[];
  filePath?: string;
}
```

**Key Features:**

- **Complete TUI abstraction** - All parsing logic in one place
- **Robust completion detection** - Handles all edge cases
- **Error detection** - Distinguishes real errors from pasted content
- **Smart filtering** - Removes chrome but preserves content structure
- **Streaming architecture** - Emits deltas in real-time

**Benefits:**

- ~400 line reduction in BaseCliIntegration
- Testable in isolation (mock TerminalShellExecution)
- Can unit test screen parsing with fixtures
- Easier to debug TUI issues

---

### 3. CliOutputLogger (Optional)

**Location:** `src/utils/CliOutputLogger.ts`

**Responsibilities:**

- Formatted logging to VS Code Output panel
- Structured prompt/response/statistics logging
- Configurable show/hide based on settings

**Interface:**

```typescript
export class CliOutputLogger {
  constructor(
    private outputChannel: vscode.OutputChannel,
    private showOutput: () => boolean
  ) {}

  log(message: string): void;
  logPrompt(promptText: string): void;
  logResponse(response: string, statistics?: string): void;
  logCommand(command: string): void;
}
```

**Benefits:**

- DRY - Removes 5+ similar logging methods from BaseCliIntegration
- Consistent formatting across all CLI output
- Easy to extend (e.g., add timestamps, colors)

**Note:** Lower priority than CliProcessManager and TuiStreamProcessor.

---

## 📝 Comment Cleanup Strategy

### 1. Condense Header Comment (Lines 6-70)

**Current:** 64 lines of detailed architecture explanation

**Target:** ~15 lines covering essentials

**Before:**

```typescript
/**
 * Base class for CLI integrations (Copilot CLI and Claude CLI)
 *
 * **Architecture:**
 * Two execution modes with distinct prompt passing mechanisms:
 *
 * **Headless Mode (background process):**
 * - Uses spawn + stdin.write() for prompt passing
 * - No shell escaping issues, works for any prompt size
 * - Process exit = completion signal
 * - Copilot: No -p flag (reads from stdin when not a TTY)
 * - Claude: Requires -p flag (Ink TUI crashes without it)
 *
 * **Interactive Mode (file-based prompt passing):**
 * - Starts CLI in interactive TUI mode (no prompt flags)
 * - Writes fully-expanded prompt to .flightpath/temp/prompt-{uuid}.txt
 * - Sends @file reference via terminal.sendText() (instant, no chunking!)
 * - Detects completion by watching for escape indicator to disappear
 * - Copilot: "(esc to cancel)" disappears when response complete
 * - Claude: "(esc to interrupt)" disappears when response complete
 * - Benefits: No React error #185, works for any prompt size, instant
 *
 * **Context Expansion:**
 * All prompts are pre-processed to expand context references:
 * - @path/to/file → Full file content
 * - #file:path:line-line → Line range with header
 * - #sym:path:symbol → Symbol context
 * This ensures CLI @file references work correctly and fixes Copilot CLI bug
 * where @ references weren't expanded in paste mode.
 *
 * Subclasses implement CLI-specific logic:
 * - Command and argument building
 * - Output parsing (different formats)
 * - Model validation (different supported models)
 * - Tool permissions (different flag syntax)
 * - Escape indicator patterns
 */
```

**After:**

```typescript
/**
 * Base class for CLI integrations (Copilot CLI and Claude CLI).
 *
 * Supports two execution modes:
 * - **Interactive:** TUI in VS Code terminal with file-based prompt passing
 * - **Headless:** Background process with temp file reference and streaming output
 *
 * All prompts are pre-expanded (context references resolved) before sending to CLI.
 * Delegates to CliProcessManager (spawning/terminal) and TuiStreamProcessor (output parsing).
 *
 * Subclasses provide CLI-specific: command building, output parsing, model validation,
 * tool permissions, and TUI patterns (escape indicator, screen boundaries).
 *
 * See docs/COPILOT_CLI_DESIGN.md and docs/CLAUDE_CLI_DESIGN.md for details.
 */
```

### 2. Reduce Inline Comments

**Targets:**

- Multi-line explanatory comments → single-line summaries
- Comments that restate the code → remove
- Debug/trace log statements → reduce verbosity
- Keep only non-obvious rationale

**Examples:**

**Before:**

```typescript
// File processing silence threshold - wait this long with no terminal activity
// before checking if the file has been read. We use a short timeout (1s) for
// responsiveness, but verify the file reference was echoed before submitting.
const FILE_PROCESSING_SILENCE_MS = 1000;
```

**After:**

```typescript
const FILE_PROCESSING_SILENCE_MS = 1000; // Silence threshold before submitting prompt
```

**Before:**

```typescript
// TUI screen buffer - chunks can contain multiple screens or partial screens
// We accumulate into a buffer and extract complete screens by detecting boundaries
let screenBuffer = "";
```

**After:**

```typescript
let screenBuffer = ""; // Accumulate TUI output until screen boundary detected
```

**Before:**

```typescript
// Spawn WITH shell for PATH resolution (needed on Windows especially)
// tree-kill library handles process tree killing on all platforms
const child = spawn(command, args, {
  shell: true,
  // ...
});
```

**After:**

```typescript
const child = spawn(command, args, {
  shell: true, // Required for PATH resolution (Windows)
  // ...
});
```

### 3. Simplify Method Doc Comments

**Remove obvious documentation:**

**Before:**

```typescript
/**
 * Log message to both console and output channel (if enabled)
 */
protected log(message: string): void
```

**After:**

```typescript
// (Remove entirely - signature is self-documenting)
protected log(message: string): void
```

**Keep non-obvious documentation:**

```typescript
/**
 * Gracefully kill a process: SIGTERM first, escalate to SIGKILL after 3 seconds.
 * Uses tree-kill for cross-platform process tree handling.
 */
private killProcessGracefully(child: ChildProcess): void
```

### 4. Extract Magic Numbers to Named Constants

**Add to top of file or config section:**

```typescript
// === Configuration Constants ===
const SHELL_INTEGRATION_TIMEOUT_MS = 5000;
const FILE_PROCESSING_SILENCE_MS = 1000;
const KILL_ESCALATION_DELAY_MS = 3000;
const MAX_CONSECUTIVE_BLANK_LINES = 2;
const TUI_READY_DELAY_MS = 500;
const TERMINAL_CTRL_C_DELAY_MS = 100;
const TERMINAL_DISPOSE_DELAY_MS = 800;
```

---

## 🔄 Migration Strategy

### Phase 1: Extract CliProcessManager (Highest Value)

**Steps:**

1. Create `src/utils/CliProcessManager.ts`
2. Move process spawning methods from BaseCliIntegration
3. Move terminal management methods from BaseCliIntegration
4. Add cancel() method that handles both process and terminal
5. Update BaseCliIntegration to use CliProcessManager
6. Update EndConditionEvaluator to use CliProcessManager
7. Test both interactive and headless modes

**Files Modified:**

- NEW: `src/utils/CliProcessManager.ts` (~300 lines)
- `src/flightpath/cli/BaseCliIntegration.ts` (refactor, -150 lines)
- `src/flightpath/EndConditionEvaluator.ts` (refactor, -50 lines)

**Testing:**

- Manual: Run workflow in Copilot CLI interactive mode
- Manual: Run workflow in Copilot CLI headless mode
- Manual: Run workflow with end condition script
- Manual: Test cancellation in all modes

### Phase 2: Extract TuiStreamProcessor (Largest Reduction)

**Steps:**

1. Create `src/utils/TuiStreamProcessor.ts`
2. Move waitForTuiAndExecute() logic
3. Move screen parsing methods (extractScreensFromBuffer, extractNewContent)
4. Move filtering methods (isTuiChromeLine, stripAnsiCodes)
5. Move error detection logic
6. Update BaseCliIntegration to delegate to TuiStreamProcessor
7. Test TUI completion detection thoroughly

**Files Modified:**

- NEW: `src/utils/TuiStreamProcessor.ts` (~400 lines)
- `src/flightpath/cli/BaseCliIntegration.ts` (refactor, -400 lines)

**Testing:**

- Manual: Run multi-prompt workflow in interactive mode
- Manual: Test completion detection (wait for response to finish)
- Manual: Test prompt echo filtering
- Manual: Test CLI error detection
- Manual: Test cancellation during TUI streaming

### Phase 3: Comment Cleanup (Quick Wins)

**Steps:**

1. Condense header comment to ~15 lines
2. Remove verbose inline comments
3. Simplify method doc comments
4. Extract magic numbers to constants
5. Remove debug/trace logs (or make them conditional)

**Files Modified:**

- `src/flightpath/cli/BaseCliIntegration.ts` (cleanup, -100 lines comments)

**Testing:**

- Visual review - ensure code is still clear
- No functional changes, so existing tests cover it

### Phase 4: Extract CliOutputLogger (Optional Polish)

**Steps:**

1. Create `src/utils/CliOutputLogger.ts`
2. Move logging methods from BaseCliIntegration
3. Update BaseCliIntegration to use CliOutputLogger

**Files Modified:**

- NEW: `src/utils/CliOutputLogger.ts` (~50 lines)
- `src/flightpath/cli/BaseCliIntegration.ts` (refactor, -30 lines)

**Testing:**

- Manual: Verify Output panel formatting is unchanged

---

## 📊 Impact Summary

| Component             | Before      | After      | Change         |
| --------------------- | ----------- | ---------- | -------------- |
| BaseCliIntegration    | ~1400 lines | ~600 lines | **-800 lines** |
| CliProcessManager     | N/A         | ~300 lines | +300 (new)     |
| TuiStreamProcessor    | N/A         | ~400 lines | +400 (new)     |
| CliOutputLogger       | N/A         | ~50 lines  | +50 (new)      |
| EndConditionEvaluator | ~550 lines  | ~500 lines | -50 lines      |
| **Net Change**        |             |            | **-700 lines** |

**Key Metrics:**

- **Cognitive Load:** High → Low (focused single-purpose classes)
- **Testability:** Hard → Easy (can mock CliProcessManager, test TuiStreamProcessor with fixtures)
- **Duplication:** Yes → No (single source for spawn logic)
- **Maintainability:** Difficult → Simple (clear separation of concerns)

---

## 🧪 Testing Strategy

### Unit Tests (New Utilities)

**CliProcessManager:**

```typescript
describe("CliProcessManager", () => {
  it("should spawn process with timeout");
  it("should kill process gracefully (SIGTERM → SIGKILL)");
  it("should create terminal and wait for shell integration");
  it("should dispose terminal on cancel");
  it("should handle spawn errors");
});
```

**TuiStreamProcessor:**

```typescript
describe("TuiStreamProcessor", () => {
  it("should extract complete screens from buffer");
  it("should filter TUI chrome lines");
  it("should strip ANSI codes");
  it("should detect completion (no indicator for 2+ screens)");
  it("should detect CLI errors in output");
  it("should deduplicate content across screens");
});
```

### Integration Tests (Existing Functionality)

**BaseCliIntegration:**

- ✅ Interactive mode workflow (existing tests should pass)
- ✅ Headless mode workflow (existing tests should pass)
- ✅ Cancellation in both modes (existing tests should pass)

**EndConditionEvaluator:**

- ✅ Script execution with timeout (existing tests should pass)
- ✅ Script cancellation (existing tests should pass)

### Manual Testing Checklist

**Interactive Mode (Copilot CLI):**

- [ ] Single prompt execution
- [ ] Multi-prompt workflow
- [ ] Completion detection (wait for full response)
- [ ] Cancellation (Ctrl+C handling)
- [ ] Error detection (CLI crash)
- [ ] Prompt echo filtering

**Headless Mode (Copilot CLI):**

- [ ] Single prompt execution
- [ ] Streaming output to dashboard
- [ ] Cancellation (SIGTERM/SIGKILL)
- [ ] Timeout handling

**Interactive Mode (Claude CLI):**

- [ ] Single prompt execution
- [ ] Completion detection
- [ ] Cancellation

**End Condition Scripts:**

- [ ] Python script execution
- [ ] JavaScript script execution
- [ ] Timeout handling
- [ ] Cancellation

---

## 🚀 Implementation Checklist

### Phase 1: CliProcessManager

- [ ] Create `src/utils/CliProcessManager.ts`
- [ ] Implement spawn() method
- [ ] Implement spawnSimple() method
- [ ] Implement createTerminal() method
- [ ] Implement waitForShellIntegration() method
- [ ] Implement cancel() method (both process and terminal)
- [ ] Implement dispose() method
- [ ] Update BaseCliIntegration to use CliProcessManager
- [ ] Update EndConditionEvaluator to use CliProcessManager
- [ ] Test interactive mode (Copilot + Claude)
- [ ] Test headless mode
- [ ] Test end condition scripts

### Phase 2: TuiStreamProcessor

- [ ] Create `src/utils/TuiStreamProcessor.ts`
- [ ] Implement processStream() method
- [ ] Implement extractScreensFromBuffer() method
- [ ] Implement extractNewContent() method
- [ ] Implement isTuiChromeLine() method
- [ ] Implement stripAnsiCodes() method
- [ ] Implement detectCliError() method
- [ ] Update BaseCliIntegration to use TuiStreamProcessor
- [ ] Test TUI completion detection
- [ ] Test prompt echo filtering
- [ ] Test CLI error detection
- [ ] Test cancellation during streaming

### Phase 3: Comment Cleanup

- [ ] Condense header comment (64 → 15 lines)
- [ ] Remove verbose inline comments
- [ ] Simplify method doc comments
- [ ] Extract magic numbers to constants
- [ ] Review code clarity

### Phase 4: Optional CliOutputLogger

- [ ] Create `src/utils/CliOutputLogger.ts`
- [ ] Move logging methods
- [ ] Update BaseCliIntegration to use logger
- [ ] Verify Output panel formatting

---

## 🎯 Success Criteria

✅ **Code Quality:**

- BaseCliIntegration reduced to ~600 lines
- Each utility has a single, clear responsibility
- No code duplication between BaseCliIntegration and EndConditionEvaluator

✅ **Testability:**

- Can unit test TuiStreamProcessor with fixtures (no need to spawn actual CLIs)
- Can mock CliProcessManager in BaseCliIntegration tests
- Clear interfaces make mocking straightforward

✅ **Maintainability:**

- Changes to process spawning logic only require updating CliProcessManager
- Changes to TUI parsing only require updating TuiStreamProcessor
- Comments are concise and focus on non-obvious rationale

✅ **Functionality:**

- All existing workflows continue to work (interactive + headless)
- Both Copilot CLI and Claude CLI function correctly
- End condition scripts execute reliably
- Cancellation works in all modes

✅ **Performance:**

- No regression in execution speed
- Memory usage remains stable
- Terminal responsiveness unchanged

---

## 📚 Related Documentation

After refactoring, update:

- `.github/instructions/flightpath-cli.instructions.md` - Reference new utilities
- `docs/COPILOT_CLI_DESIGN.md` - Update architecture diagrams
- `docs/CLAUDE_CLI_DESIGN.md` - Update architecture diagrams
- `docs/INTERACTIVE_TERMINAL_DESIGN.md` - Update implementation details

---

## 🔮 Future Enhancements

After this refactor, consider:

1. **TUI Unit Tests** - Add fixtures with captured TUI output for regression testing
2. **Process Pool** - Reuse CLI processes for better performance (if CLIs support it)
3. **Metrics Collection** - Track spawn times, completion detection accuracy
4. **Advanced Error Recovery** - Automatic retry with fallback strategies
5. **CLI Health Checks** - Proactive detection of CLI issues

---

## 📝 Notes

- **Breaking Changes:** None - this is an internal refactor with no API changes
- **Backward Compatibility:** Full compatibility maintained
- **Risk Level:** Medium - extensive testing required but changes are localized
- **Time Estimate:** 8-12 hours total (all phases)

---

**Status Legend:**

- 🔴 Not Started
- 🟡 In Progress
- 🟢 Complete
- ✅ Tested and Verified
