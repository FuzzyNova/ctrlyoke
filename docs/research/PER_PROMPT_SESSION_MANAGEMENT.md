# Per-Prompt Session Management Architecture

**Status:** Planning Phase
**Created:** 2026-01-13
**Author:** FlightPath Team

## Overview

Enable per-prompt session tracking so different prompts in a workflow can resume different CLI sessions. Currently, all prompts share one global session ID per provider, which is lost on VS Code restart.

**Changes required:**

1. Add `sessionId` field to prompt schema (string or number reference)
2. Store session IDs in `_runtime` metadata within working files
3. Implement session resolution logic (numeric references, auto-resume, validation)
4. Update CLI integrations to populate/use per-prompt session IDs
5. Remove `-c` fallback to provider's global session

---

## 1. Current State Analysis

### Current Session Management Flow

```typescript
// BaseCliIntegration.ts
protected sessionId?: string; // Single session ID per integration instance

// Session resumption logic (CopilotCommandLineIntegration.ts:423-424)
if (!shouldStartNewSession && this.sessionId) {
  args.push("--resume", this.sessionId);
}
```

**How it works:**

1. After prompt completes, extract `sessionId` from CLI output
2. Store in `this.sessionId` (memory only)
3. Next prompt checks `newChatSession` setting
4. If `newChatSession=false`, pass `--resume` with `this.sessionId`

**Problems:**

- Session IDs lost on extension reload
- Can't resume different sessions for different prompts
- Falls back to `-c` when no `sessionId` exists (uses provider's global session)
- No tracking of which session belongs to which workflow

### Current Configuration System

```typescript
// ConfigurationUtils.ts:331-351
shouldStartNewSessionForPrompt(promptNewChatSession: boolean | undefined): boolean {
  if (promptNewChatSession !== undefined) {
    return promptNewChatSession;
  }
  return ConfigurationUtils.shouldStartNewChatSessionPerPrompt();
}
```

**Behavior:**

- `newChatSession: true` → Always start new session
- `newChatSession: false` → Try to resume (use `this.sessionId` or fall back to `-c`)
- `newChatSession: undefined` → Check global `newChatSessionPerPrompt` setting

### Current Schema Structure

```typescript
// FlightPathTypes.ts:60-69
export interface PromptItem {
  id?: string;
  prompt: string;
  provider?: Provider;
  model?: string;
  agent?: string;
  newChatSession?: boolean; // Boolean only - no session reference
  allowDynamicExtension?: boolean;
  endCondition?: EndCondition;
}

// FlightPathTypes.ts:30-36
export interface WorkingFileRuntime {
  currentIndex: number;
  completedPrompts: string[]; // Only tracks IDs/hashes, no session info
  executionState: ExecutionState;
  appendSegments?: AppendSegment[];
}
```

**Missing:**

- No `sessionId` field in `PromptItem`
- No per-prompt execution metadata (provider, model, sessionId used)
- No way to reference another prompt's session

---

## 2. Proposed Schema Changes

### 2.1 Add `sessionId` Field to PromptItem

**Location:** `schemas/prompt-schema.json` → `definitions/promptItem/properties`

```json
{
  "sessionId": {
    "type": ["string", "number"],
    "description": "Session ID for resuming conversations. Two formats supported: (1) Exact session ID string to pass to --resume flag, (2) Prompt number (integer) to reuse that prompt's session ID (e.g., 1 means 'use session from prompt 1'). When omitted and newChatSession=false, automatically uses previous prompt's session in same workflow.",
    "examples": ["ses_abc123xyz", "1", "3"]
  }
}
```

**TypeScript Type Update:**

```typescript
// src/types/FlightPathTypes.ts
export interface PromptItem {
  id?: string;
  prompt: string;
  provider?: Provider;
  model?: string;
  agent?: string;
  newChatSession?: boolean;
  sessionId?: string | number; // NEW: Session reference
  allowDynamicExtension?: boolean;
  endCondition?: EndCondition;
}
```

### 2.2 Add Per-Prompt Runtime Metadata

**Concept:** Track execution metadata per prompt, not just globally

```typescript
// src/types/FlightPathTypes.ts

/**
 * Per-prompt execution metadata tracked in working files
 * Enables session continuity and debugging
 */
export interface PromptRuntimeMetadata {
  /** Provider used for this prompt's execution */
  provider: Provider;

  /** Model used for this prompt's execution */
  model: string;

  /** Session ID returned by CLI after completion */
  sessionId?: string;

  /** Timestamp when prompt started */
  startedAt: number;

  /** Timestamp when prompt completed */
  completedAt?: number;

  /** Whether this was a retry attempt */
  isRetry?: boolean;

  /** Retry count if applicable */
  retryCount?: number;
}

export interface PromptItem {
  // ... existing fields ...

  /** Runtime execution metadata (added by FlightPath during execution) */
  _runtime?: PromptRuntimeMetadata;
}
```

**Benefits:**

- Session IDs persist in working files
- Can inspect which sessions were used for each prompt
- Enables cross-prompt session references
- Survives VS Code restarts

---

## 3. Session ID Resolution Logic

### 3.1 User Input Formats

Users can specify `sessionId` in two ways:

#### Format 1: Prompt Number Reference

```yaml
prompts:
  - id: analyze
    prompt: "Analyze the codebase"
    # No sessionId - starts new session

  - id: implement
    prompt: "Implement the changes"
    newChatSession: false
    sessionId: 1 # Use session from prompt 1 (analyze)

  - id: test
    prompt: "Run the tests"
    newChatSession: false
    sessionId: 1 # Also use session from prompt 1
```

**Resolution:** `sessionId: 1` → Look up `prompts[0]._runtime.sessionId`

#### Format 2: Exact Session ID

```yaml
prompts:
  - id: resume-old
    prompt: "Continue previous work"
    newChatSession: false
    sessionId: "ses_abc123xyz" # Direct session ID
```

**Resolution:** Pass `"ses_abc123xyz"` directly to `--resume`

### 3.2 Resolution Algorithm

```typescript
/**
 * Resolve session ID for a prompt
 * @param prompt The prompt to resolve session for
 * @param promptIndex Current prompt's index in queue
 * @param allPrompts All prompts in queue (with runtime metadata)
 * @returns Resolved session ID or undefined
 */
function resolveSessionId(
  prompt: PromptItem,
  promptIndex: number,
  allPrompts: PromptItem[]
): string | undefined {
  // 1. Check if new session is explicitly requested
  if (shouldStartNewSession(prompt)) {
    return undefined; // New session, no resume
  }

  // 2. If sessionId is specified
  if (prompt.sessionId !== undefined) {
    // 2a. Numeric reference (prompt number)
    if (typeof prompt.sessionId === "number") {
      const refIndex = prompt.sessionId - 1; // 1-based to 0-based

      // Validate reference
      if (refIndex < 0 || refIndex >= promptIndex) {
        throw new Error(
          `Invalid sessionId reference: ${prompt.sessionId}. ` +
            `Must reference a completed prompt (1-${promptIndex}).`
        );
      }

      const referencedPrompt = allPrompts[refIndex];
      const sessionId = referencedPrompt._runtime?.sessionId;

      // Validate provider compatibility
      if (
        sessionId &&
        referencedPrompt._runtime?.provider !== prompt.provider
      ) {
        Log.warn(
          `Session ID from prompt ${prompt.sessionId} uses different provider ` +
            `(${referencedPrompt._runtime?.provider}). Falling back to no resume.`
        );
        return undefined;
      }

      return sessionId;
    }

    // 2b. Exact session ID string
    return prompt.sessionId;
  }

  // 3. Auto-resume previous prompt in same workflow (if enabled)
  if (promptIndex > 0) {
    // Find most recent completed prompt with same provider
    for (let i = promptIndex - 1; i >= 0; i--) {
      const prevPrompt = allPrompts[i];
      const prevProvider = prevPrompt._runtime?.provider;
      const prevSessionId = prevPrompt._runtime?.sessionId;

      if (prevProvider === prompt.provider && prevSessionId) {
        Log.debug(
          `Auto-resuming session from prompt ${i + 1}: ${prevSessionId}`
        );
        return prevSessionId;
      }
    }
  }

  // 4. No session to resume
  return undefined;
}

/**
 * Check if prompt should start new session
 */
function shouldStartNewSession(prompt: PromptItem): boolean {
  // Explicit prompt setting takes precedence
  if (prompt.newChatSession !== undefined) {
    return prompt.newChatSession;
  }

  // Fall back to global setting
  return ConfigurationUtils.shouldStartNewChatSessionPerPrompt();
}
```

### 3.3 Edge Cases & Validation

#### Case 1: Reference to Uncompleted Prompt

```yaml
prompts:
  - id: step1
    prompt: "First step"
  - id: step2
    prompt: "Second step"
    sessionId: 3 # ERROR: Prompt 3 hasn't run yet
```

**Handling:** Throw error with clear message before execution

#### Case 2: Cross-Provider Reference

```yaml
prompts:
  - id: copilot-analyze
    prompt: "Analyze code"
    provider: copilot-cli
    # Completes with sessionId: "cop_123"

  - id: claude-implement
    prompt: "Implement changes"
    provider: claude-cli
    sessionId: 1 # References copilot session
```

**Handling:** Log warning, fall back to no resume (start new session)

```
⚠️ Warning: Prompt 2 references session from prompt 1, but providers differ
(copilot-cli vs claude-cli). Starting new session.
```

#### Case 3: Referenced Prompt Has No Session

```yaml
prompts:
  - id: step1
    prompt: "First step"
    newChatSession: true # Forces new session, sessionId not saved

  - id: step2
    prompt: "Second step"
    sessionId: 1 # References prompt with no sessionId
```

**Handling:** Log warning, fall back to no resume

```
⚠️ Warning: Prompt 1 has no session ID. Starting new session for prompt 2.
```

#### Case 4: Invalid Session ID (Provider Rejects)

```yaml
prompts:
  - id: resume
    prompt: "Resume old work"
    sessionId: "invalid_session_xyz"
```

**Behavior by provider:**

1. **Copilot CLI:** Silently ignores invalid session IDs and starts a new session. No error thrown, but session continuity is lost.
2. **Claude CLI:** Two-stage validation:
   - **Format validation:** Rejects non-UUID formats immediately:
     ```
     Error: --resume requires a valid session ID when used with --print
     Session IDs must be in UUID format (e.g., 550e8400-e29b-41d4-a716-446655440000)
     ```
   - **Existence validation:** Rejects valid UUIDs that don't exist in Claude's system:
     ```
     No conversation found with session ID: 550e8400-e29b-41d4-a716-446655440000
     ```
   - Both cases exit with code 1 (error)

3. **Codex CLI:** Silently ignores invalid session IDs and starts a new session (creates new thread_id). No error thrown.

**Handling strategy:**

- **Detection:** Claude CLI errors can be caught via exit code + stderr parsing
- **Fallback:** On invalid session error, retry without `--resume` flag (automatic recovery)
- **Logging:** Warn user when session ID is invalid but execution continues
- **Copilot/Codex:** No way to detect silently invalid sessions - they just start fresh
  - Risk: User thinks session is resumed but it's actually a new conversation
  - Mitigation: Validate session ID format before passing to CLI (UUID check)

**Implementation approach:**

```typescript
// Pre-validation before CLI execution
function validateSessionIdFormat(
  sessionId: string,
  provider: Provider
): boolean {
  if (provider === Provider.ClaudeCli) {
    // Claude requires UUID format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(sessionId);
  }
  // Copilot/Codex: No strict format validation available
  // (they silently ignore invalid IDs)
  return true;
}

// Error recovery during execution
async function executeWithSessionRecovery(args: string[], sessionId: string) {
  try {
    return await execute(args);
  } catch (error) {
    if (isInvalidSessionError(error)) {
      Log.warn(`Session ${sessionId} invalid. Starting new session.`);
      const argsWithoutResume = removeResumeFlags(args);
      return await execute(argsWithoutResume);
    }
    throw error;
  }
}
```

---

## 4. New Chat Session Per Prompt Behavior

### 4.1 Current Behavior

**Global Setting:** `flightpath.newChatSessionPerPrompt` (default: `true`)

**Prompt Override:** `newChatSession: boolean` in prompt schema

**Resolution:** Prompt setting takes precedence over global

### 4.2 Updated Behavior Matrix

| Global Setting | Prompt Setting | `sessionId` Set? | Behavior                             |
| -------------- | -------------- | ---------------- | ------------------------------------ |
| `true`         | `undefined`    | Any              | New session, warn if `sessionId` set |
| `true`         | `true`         | Any              | New session, warn if `sessionId` set |
| `true`         | `false`        | Yes              | Resume specified session             |
| `true`         | `false`        | No               | Auto-resume workflow session         |
| `false`        | `undefined`    | Yes              | Resume specified session             |
| `false`        | `undefined`    | No               | Auto-resume workflow session         |
| `false`        | `true`         | Any              | New session, warn if `sessionId` set |
| `false`        | `false`        | Yes              | Resume specified session             |
| `false`        | `false`        | No               | Auto-resume workflow session         |

### 4.3 Warning Messages

**When `newChatSession=true` and `sessionId` is set:**

```
⚠️ Warning: Prompt 3 has sessionId set but newChatSession=true.
Session ID will be ignored. Starting new session.
```

**Rationale:** Explicit session request should override everything, but warn about conflicting configuration.

---

## 5. Implementation Plan

### Phase 1: Schema & Type Updates

**Files to modify:**

- `schemas/prompt-schema.json` - Add `sessionId` field to `promptItem`
- `src/types/FlightPathTypes.ts` - Add `PromptRuntimeMetadata` interface
- Run `npm run generate-schema` to regenerate YAML schema

**Testing:**

- Validate schema accepts `sessionId` as string or number
- Validate `_runtime` metadata structure

### Phase 2: Session Resolution Logic

**New file:** `src/utils/SessionResolver.ts`

```typescript
export class SessionResolver {
  /**
   * Resolve session ID for a prompt
   */
  static resolve(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[]
  ): string | undefined {
    // Implementation from section 3.2
  }

  /**
   * Validate session reference before execution
   */
  static validate(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[]
  ): ValidationResult {
    // Check for invalid references, cross-provider issues
  }

  /**
   * Check if prompt should start new session
   */
  static shouldStartNewSession(prompt: PromptItem): boolean {
    // Implementation from section 3.2
  }
}
```

**Testing:**

- Unit tests for all edge cases in section 3.3
- Test prompt number references (1-based indexing)
- Test cross-provider validation
- Test auto-resume logic

### Phase 3: Integration Updates

**Files to modify:**

- `src/flightpath/cli/BaseCliIntegration.ts`
  - Replace `this.sessionId` with dynamic resolution
  - Call `SessionResolver.resolve()` before building CLI args
  - Add pre-validation for session ID format (provider-specific)
  - Add error recovery for invalid session errors (Claude CLI)

- `src/flightpath/cli/CopilotCommandLineIntegration.ts`
  - Update session extraction to populate `prompt._runtime.sessionId`
  - Remove fallback to `-c` flag
  - Add UUID format validation before passing `--resume`

- `src/flightpath/cli/ClaudeCommandLineIntegration.ts`
  - Update session extraction to populate `prompt._runtime.sessionId`
  - Remove fallback to `-c` flag
  - Add error recovery for "invalid session ID" errors (exit code + stderr)
  - Pre-validate UUID format before passing `-r`

- `src/flightpath/cli/CodexCommandLineIntegration.ts`
  - Update session extraction to populate `prompt._runtime.sessionId`
  - Add UUID format validation before passing `resume` subcommand

**Key changes:**

```typescript
// OLD: BaseCliIntegration.ts
protected sessionId?: string; // Single global session
if (!shouldStartNewSession && this.sessionId) {
  args.push("--resume", this.sessionId);
}

// NEW: BaseCliIntegration.ts
protected resolveAndApplySession(
  prompt: PromptItem,
  promptIndex: number,
  args: string[]
): void {
  const sessionId = SessionResolver.resolve(
    prompt,
    promptIndex,
    this.getCurrentQueuePrompts() // Get all prompts with _runtime
  );

  if (sessionId) {
    // Validate session ID format before using it
    if (!this.validateSessionIdFormat(sessionId)) {
      Log.warn(
        `⚠️ Session ID "${sessionId}" has invalid format for ${this.getCliName()}. ` +
        `Starting new session instead.`
      );
      return; // Don't add resume flags
    }

    // Provider-specific resume flag
    this.applyResumeFlag(args, sessionId);
    Log.debug(`✅ Resuming session: ${sessionId}`);
  } else if (!SessionResolver.shouldStartNewSession(prompt)) {
    Log.debug(`ℹ️ Resume requested but no session available. Starting new.`);
  }
}

/**
 * Validate session ID format for this provider
 * Override in subclasses for provider-specific validation
 */
protected validateSessionIdFormat(sessionId: string): boolean {
  // Base implementation: accept any non-empty string
  return sessionId.trim().length > 0;
}

// CopilotCommandLineIntegration.ts override
protected validateSessionIdFormat(sessionId: string): boolean {
  // Copilot CLI session IDs should be UUIDs
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(sessionId);
}

// ClaudeCommandLineIntegration.ts override
protected validateSessionIdFormat(sessionId: string): boolean {
  // Claude CLI requires strict UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(sessionId);
}

// ClaudeCommandLineIntegration.ts error recovery
protected async executeHeadless(...) {
  try {
    return await super.executeHeadless(...);
  } catch (error) {
    // Check for invalid session ID error from Claude CLI
    if (this.isInvalidSessionError(error)) {
      const sessionId = this.sessionId;
      Log.warn(
        `⚠️ Claude CLI rejected session ID "${sessionId}". ` +
        `Retrying without resume flag.`
      );

      // Clear session and retry
      this.sessionId = undefined;
      return await super.executeHeadless(...);
    }
    throw error;
  }
}

private isInvalidSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("--resume requires a valid session ID") ||
    message.includes("Session IDs must be in UUID format") ||
    message.includes("No conversation found with session ID")
  );
}

// After completion:
protected async onPromptComplete(
  prompt: PromptItem,
  cliResult: CopilotCliResult
): Promise<void> {
  // Populate runtime metadata
  prompt._runtime = {
    provider: this.getProviderType(),
    model: prompt.model || this.getDefaultModel(),
    sessionId: cliResult.sessionId,
    startedAt: this.promptStartTime!,
    completedAt: Date.now(),
  };

  // Save to working file
  await this.saveWorkingFile();
}
```

### Phase 4: Working File Persistence

**Files to modify:**

- `src/flightpath/PromptQueue.ts`
  - Ensure `_runtime` metadata is saved to working file
  - Load `_runtime` metadata when reloading queue

- `src/flightpath/orchestration/WorkspaceSessionManager.ts`
  - Update session loading to include runtime metadata

**Working file format:**

```json
{
  "originalFile": "analyze-and-fix.flightpath.yaml",
  "workflowName": "analyze-and-fix",
  "startedAt": 1705170000000,
  "prompts": [
    {
      "id": "analyze",
      "prompt": "Analyze the codebase",
      "model": "claude-sonnet-4.5",
      "_runtime": {
        "provider": "copilot-cli",
        "model": "claude-sonnet-4.5",
        "sessionId": "ses_abc123",
        "startedAt": 1705170000000,
        "completedAt": 1705170123000
      }
    },
    {
      "id": "implement",
      "prompt": "Implement fixes",
      "newChatSession": false,
      "sessionId": 1,
      "_runtime": {
        "provider": "copilot-cli",
        "model": "claude-sonnet-4.5",
        "sessionId": "ses_abc123",
        "startedAt": 1705170130000,
        "completedAt": 1705170250000
      }
    }
  ],
  "_runtime": {
    "currentIndex": 2,
    "completedPrompts": ["analyze", "implement"],
    "executionState": "completed"
  }
}
```

### Phase 5: Remove Global Session Fallback

**Current behavior:**

```typescript
if (!shouldStartNewSession && this.sessionId) {
  args.push("--resume", this.sessionId);
} else if (!shouldStartNewSession) {
  args.push("-c"); // Fallback to provider's global session
}
```

**New behavior:**

```typescript
const sessionId = SessionResolver.resolve(prompt, index, allPrompts);
if (sessionId) {
  args.push("--resume", sessionId);
  Log.debug(`✅ Resuming FlightPath-tracked session: ${sessionId}`);
} else if (!SessionResolver.shouldStartNewSession(prompt)) {
  Log.debug(
    `ℹ️ No FlightPath session available. Starting new session ` +
      `(not using -c to avoid resuming non-FlightPath sessions).`
  );
}
```

**Rationale:**

- `-c` flag uses provider's built-in session tracking
- Provider may have sessions from outside FlightPath
- Resuming non-FlightPath sessions could cause unexpected behavior
- Better to explicitly track all sessions FlightPath uses

**Migration path:**

- Add setting: `flightpath.allowProviderSessionFallback` (default: `false`)
- When `true`, keeps old `-c` fallback behavior
- Warn in logs when using fallback
- Deprecate in future version

### Phase 6: Documentation & Examples

**Files to create/update:**

- `docs/SESSION_MANAGEMENT.md` - Complete session management guide
- `manual-test/session-examples/` - Example workflows
  - `multi-session.flightpath.yaml` - Different sessions for different prompts
  - `session-reuse.flightpath.yaml` - Multiple prompts sharing one session
  - `cross-provider.flightpath.yaml` - Mixed providers (demonstrates validation)

**Update existing docs:**

- `README.md` - Add session management section
- `docs/COPILOT_CLI_DESIGN.md` - Update session handling docs

---

## 6. Backward Compatibility

### Breaking Changes

1. **`-c` flag removal:** Workflows relying on provider's global session tracking will need explicit `sessionId` references
2. **Schema addition:** New `sessionId` field (but optional, so existing files work)
3. **`_runtime` metadata:** New field in working files (but existing files load fine)

### Migration Strategy

**For users:** No action required unless using `-c` fallback behavior

**Gradual rollout:**

1. Phase 1-4: Add new features, keep `-c` fallback with warning
2. Phase 5: Add `allowProviderSessionFallback` setting (default: `false`)
3. Future: Remove `-c` fallback entirely

---

## 8. Error Handling & Recovery Strategy

### Summary of Provider Behaviors

| Provider        | Invalid Format                | Valid Format, Non-Existent ID | Recovery Strategy                          |
| --------------- | ----------------------------- | ----------------------------- | ------------------------------------------ |
| **Copilot CLI** | Silent fallback (new session) | Silent fallback (new session) | Pre-validate UUID format, warn on mismatch |
| **Claude CLI**  | Error exit code 1 + stderr    | Error exit code 1 + stderr    | Catch error, retry without `-r`            |
| **Codex CLI**   | Silent fallback (new session) | Silent fallback (new session) | Pre-validate UUID format, warn on mismatch |

### Implementation Strategy

**1. Pre-Validation (Proactive)**

Validate session ID format before passing to CLI to catch obvious errors early:

```typescript
// BaseCliIntegration.ts
protected validateSessionIdFormat(sessionId: string): boolean {
  // Default: accept any non-empty string
  return sessionId.trim().length > 0;
}

// CopilotCommandLineIntegration.ts & CodexCommandLineIntegration.ts
protected validateSessionIdFormat(sessionId: string): boolean {
  // UUID format expected (though silently ignored if invalid)
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sessionId)) {
    Log.warn(
      `⚠️ Session ID "${sessionId}" is not a valid UUID. ` +
      `${this.getCliName()} may silently ignore this and start a new session.`
    );
    // Still return true to allow execution (CLI will handle it)
    return true;
  }
  return true;
}

// ClaudeCommandLineIntegration.ts
protected validateSessionIdFormat(sessionId: string): boolean {
  // Claude CLI requires strict UUID format
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(sessionId)) {
    Log.error(
      `❌ Session ID "${sessionId}" is not a valid UUID. ` +
      `Claude CLI requires UUID format.`
    );
    return false; // Block execution - Claude will definitely fail
  }
  return true;
}
```

**2. Error Recovery (Reactive)**

Catch runtime errors from Claude CLI and retry without session resume:

```typescript
// ClaudeCommandLineIntegration.ts
protected async executeHeadless(
  args: string[],
  promptText: string,
  workflowContext?: any
): Promise<boolean> {
  try {
    return await super.executeHeadless(args, promptText, workflowContext);
  } catch (error) {
    // Check for invalid session ID errors from Claude CLI
    if (this.isInvalidSessionError(error)) {
      const sessionId = this.getAttemptedSessionId(args);
      Log.warn(
        `⚠️ Claude CLI rejected session ID "${sessionId}". ` +
        `Retrying without resume flag.`
      );

      // Remove resume flags and retry
      const argsWithoutResume = this.removeResumeFlags(args);
      return await super.executeHeadless(argsWithoutResume, promptText, workflowContext);
    }
    throw error; // Re-throw other errors
  }
}

private isInvalidSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("--resume requires a valid session ID") ||
    message.includes("Session IDs must be in UUID format") ||
    message.includes("No conversation found with session ID")
  );
}

private removeResumeFlags(args: string[]): string[] {
  // Remove -r <session-id> and -c flags
  return args.filter((arg, i, arr) => {
    if (arg === "-r" && i + 1 < arr.length) {
      return false; // Remove -r flag
    }
    if (i > 0 && arr[i - 1] === "-r") {
      return false; // Remove session ID argument
    }
    if (arg === "-c") {
      return false; // Remove -c flag
    }
    return true;
  });
}
```

**3. User Communication**

Provide clear feedback about session handling:

```typescript
// When pre-validation fails
Log.warn(`⚠️ Invalid session ID format. Starting new session instead.`);
vscode.window.showWarningMessage(
  `FlightPath: Session ID "${sessionId}" has invalid format. Starting new session.`
);

// When Claude CLI rejects session
Log.warn(`⚠️ Session not found in Claude CLI. Starting new session.`);
// No user notification needed - automatic recovery

// When Copilot/Codex silently falls back
Log.info(
  `ℹ️ Session ID may be invalid. If ${this.getCliName()} doesn't resume the ` +
    `expected conversation, the session ID may not exist.`
);
```

**4. Testing Strategy**

Create manual test workflows to verify error handling:

```yaml
# manual-test/invalid-session-recovery.flightpath.yaml
prompts:
  - id: test-invalid-format
    prompt: "Test with invalid format"
    sessionId: "not-a-uuid-12345"
    # Should warn and start new session

  - id: test-nonexistent-uuid
    prompt: "Test with non-existent UUID"
    sessionId: "550e8400-e29b-41d4-a716-446655440000"
    # Claude: Should error and retry
    # Copilot/Codex: Should silently start new

  - id: test-cross-provider
    prompt: "Test cross-provider reference"
    provider: claude-cli
    sessionId: 1 # References Copilot session
    # Should warn about provider mismatch and start new
```

### Expected Outcomes

1. **Claude CLI:** Robust with automatic retry on invalid session
2. **Copilot/Codex CLI:** Graceful degradation with user warnings
3. **All providers:** Clear logging for debugging session issues
4. **User experience:** Workflow continues even when session IDs are invalid

---

## 9. Testing Strategy

### Unit Tests

**SessionResolver.ts:**

- `resolve()` with prompt number references
- `resolve()` with exact session IDs
- `resolve()` with auto-resume
- `validate()` edge cases (invalid references, cross-provider, etc.)
- `shouldStartNewSession()` logic matrix

**Integration tests:**

- Copilot CLI session extraction and persistence
- Claude CLI session extraction and persistence
- Codex CLI session extraction and persistence
- Cross-provider validation
- Working file save/load with `_runtime` metadata

### Manual Tests

**Test workflows:**

1. Multi-session workflow (prompts 1-3 use session A, prompts 4-6 use session B)
2. Session reuse (all prompts use session from prompt 1)
3. Mixed providers (validate warnings and fallback)
4. VS Code restart (verify sessions persist)
5. Invalid references (verify error messages)

---

## 8. Implementation Checklist

### Schema & Types

- [ ] Update `prompt-schema.json` with `sessionId` field
- [ ] Add `PromptRuntimeMetadata` interface to `FlightPathTypes.ts`
- [ ] Generate YAML schema
- [ ] Update JSON schema documentation

### Core Logic

- [ ] Create `SessionResolver.ts` with resolution logic
- [ ] Add validation for prompt number references
- [ ] Add cross-provider validation
- [ ] Add auto-resume logic
- [ ] Unit tests for `SessionResolver`

### Integration Updates

- [ ] Update `BaseCliIntegration` to use `SessionResolver`
- [ ] Add `validateSessionIdFormat()` method to base class
- [ ] Update `CopilotCommandLineIntegration` session extraction
- [ ] Add UUID validation for Copilot CLI
- [ ] Update `ClaudeCommandLineIntegration` session extraction
- [ ] Add UUID validation and error recovery for Claude CLI
- [ ] Add `isInvalidSessionError()` and `removeResumeFlags()` helpers
- [ ] Update `CodexCommandLineIntegration` session extraction
- [ ] Add UUID validation for Codex CLI
- [ ] Remove `-c` fallback (or add setting to control it)

### Persistence

- [ ] Update `PromptQueue` to save `_runtime` metadata
- [ ] Update `WorkspaceSessionManager` to load `_runtime` metadata
- [ ] Test working file format with new fields
- [ ] Ensure backward compatibility with old working files

### Configuration

- [ ] Add warning when `newChatSession=true` and `sessionId` set
- [ ] Update `ConfigurationUtils` if needed
- [ ] Consider adding `allowProviderSessionFallback` setting

### Testing

- [ ] Unit tests for session resolution
- [ ] Integration tests for CLI session tracking
- [ ] Manual test: Multi-session workflow
- [ ] Manual test: VS Code restart persistence
- [ ] Manual test: Cross-provider validation
- [ ] Manual test: Invalid references
- [ ] Manual test: Invalid session ID format (non-UUID)
- [ ] Manual test: Non-existent session ID (valid UUID)
- [ ] Manual test: Claude CLI error recovery
- [ ] Verify Copilot/Codex silent fallback behavior

### Documentation

- [ ] Create `docs/SESSION_MANAGEMENT.md`
- [ ] Add example workflows to `manual-test/session-examples/`
- [ ] Update `README.md` with session management overview
- [ ] Update `docs/COPILOT_CLI_DESIGN.md`
- [ ] Add inline code comments for session resolution

---

## 9. Open Questions

### Should we track session IDs for Chat mode?

**Current:** Chat mode doesn't have session IDs (UI-based, uses existing chat panel)

**Decision:** Not in initial implementation. Chat mode session management is fundamentally different (UI-based). Defer until Chat mode limitations are addressed.

---

## 10. Success Metrics

- Session IDs persist across VS Code restarts (working file storage)
- Session resolution completes in <10ms per prompt
- Working files correctly save/load `_runtime` metadata
- Cross-provider validation prevents invalid resumes
- Claude CLI automatic error recovery functions correctly

---

## Appendix A: Example Multi-Session Workflow

```yaml
# Different sessions for analysis vs implementation

prompts:
  # Session 1: Initial analysis
  - id: analyze-code
    prompt: "Analyze the codebase for security issues"
    model: claude-sonnet-4.5
    # Starts new session (default)

  - id: analyze-tests
    prompt: "Analyze test coverage"
    newChatSession: false
    sessionId: 1 # Continue analysis session

  # Session 2: Implementation
  - id: implement-fixes
    prompt: "Implement security fixes based on analysis"
    newChatSession: true # Start fresh implementation session

  - id: add-tests
    prompt: "Add tests for the security fixes"
    newChatSession: false
    sessionId: 3 # Continue implementation session
```

---

## Appendix B: Session ID Formats

Different providers use different session ID formats:

### Copilot CLI

```
Format: UUID v4
Example: "550e8400-e29b-41d4-a716-446655440000"
Extracted from: Process logs (debug level)
```

### Claude CLI

```
Format: Custom string (varies)
Example: "proj_abc123_session_xyz789"
Extracted from: JSON streaming output (sessionId field)
```

### Codex CLI

```
Format: Thread ID
Example: "thread_123456789"
Extracted from: JSONL events or notify hook data
```

### Storage

All formats stored as strings in `_runtime.sessionId`. Provider-specific parsing handled by integration classes.

---

**End of Implementation Plan**
