# Per-Prompt Session Management Architecture

**Status:** Planning Phase - Updated January 2026
**Created:** 2026-01-13
**Last Updated:** 2026-01-16
**Author:** FlightPath Team

## Overview

Enable per-prompt session tracking so different prompts in a workflow can resume different CLI sessions. Currently, all prompts share one global session ID per provider instance stored in `CliIntegration.sessionId`, which is lost on VS Code restart.

**Changes required:**

1. Add `sessionId` field to prompt schema (string or number reference)
2. Add `_runtime` metadata to prompt schema for tracking execution state
3. Store session IDs and execution metadata in working files
4. Implement session resolution logic (numeric references, auto-resume, validation)
5. Update `CliIntegration` to use resolved session IDs instead of instance-level `sessionId`
6. Provider-agnostic implementation (works with Copilot, Claude, Codex, and future providers)

---

## 1. Current State Analysis

### Current Architecture (January 2026)

**Composition-based CLI Integration:**

FlightPath now uses a composition-based architecture where:
- **CliIntegration** is a generic class that works with ANY CLI provider
- Each provider (Copilot, Claude, Codex) lives in its own directory: `src/flightpath/cli/{provider}/`
- Provider-specific logic is encapsulated in implementations of **ICliProvider** interface
- Session management is handled at the `CliIntegration` level (provider-agnostic)

**Current Session Management Flow:**

```typescript
// CliIntegration.ts:72
protected sessionId?: string; // Single session ID per integration instance

// In sendPrompt() method (lines 1157-1168):
if (parsed.sessionId) {
  this.sessionId = parsed.sessionId;
  Log.debug(`📝 Session ID from output: ${this.sessionId}`);
} else if (this.provider.extractSessionIdFromLogs) {
  const logSessionId = await this.provider.extractSessionIdFromLogs();
  if (logSessionId) {
    this.sessionId = logSessionId;
    Log.debug(`📝 Session ID from logs: ${this.sessionId}`);
  }
}

// Session passed to provider during buildCliArgs():
const baseArgs = await this.provider.buildCliArgs(
  prompt,
  isInteractive,
  this.context,
  workspaceRoot,
  this.sessionId,  // <-- Instance-level session ID
  workflowContext
);
```

**How it currently works:**

1. After prompt completes, extract `sessionId` from CLI output or logs
2. Store in `this.sessionId` (memory only, lost on restart)
3. Next prompt: provider uses `this.sessionId` in `buildCliArgs()` to add resume flags
4. Each provider decides how to format resume args (--resume, -r, resume subcommand, etc.)

**Problems:**

- Session IDs lost on extension reload
- Can't resume different sessions for different prompts
- No tracking of which session belongs to which prompt
- No persistence across VS Code restarts

### Current Schema Structure

```typescript
// FlightPathTypes.ts:49-58
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

// FlightPathTypes.ts:31-36
export interface WorkingFileRuntime {
  currentIndex: number;
  completedPrompts: string[]; // Only tracks IDs/hashes, no session info
  executionState: ExecutionState;
}
```

**Missing:**

- No `sessionId` field in `PromptItem`
- No per-prompt execution metadata (provider, model, sessionId used)
- No way to reference another prompt's session

---

## 2. Proposed Schema Changes

### 2.1 Schema Architecture Recommendation

**Problem:** Both `PromptItem` and `_runtime` need to store the same properties (provider, model, agent), but with different semantics:

- **PromptItem properties:** User-specified overrides for execution ("what I want to run")
- **_runtime properties:** Actual execution metadata ("what actually ran")

**Recommendation: Use `$ref` pattern for shared properties**

This approach:
- ✅ Eliminates duplication in schema definition
- ✅ Makes it clear which properties are shared between prompt and runtime
- ✅ Ensures consistency when adding new properties
- ✅ Simplifies schema maintenance

**Example schema structure:**

```json
{
  "definitions": {
    "executionProperties": {
      "type": "object",
      "properties": {
        "provider": { ... },
        "model": { ... },
        "agent": { ... }
      }
    },
    "promptItem": {
      "allOf": [
        { "$ref": "#/definitions/executionProperties" },
        {
          "properties": {
            "id": { ... },
            "prompt": { ... },
            "sessionId": { ... },
            "newChatSession": { ... },
            "endCondition": { ... },
            "_runtime": { "$ref": "#/definitions/promptRuntimeMetadata" }
          }
        }
      ]
    },
    "promptRuntimeMetadata": {
      "allOf": [
        { "$ref": "#/definitions/executionProperties" },
        {
          "properties": {
            "sessionId": { ... },
            "startedAt": { ... },
            "completedAt": { ... },
            "retryCount": { ... }
          },
          "required": ["provider", "model", "startedAt"]
        }
      ]
    }
  }
}
```

### 2.2 Add `sessionId` Field to PromptItem

**Location:** `schemas/prompt-schema.json` → `definitions/promptItem/properties`

```json
{
  "sessionId": {
    "type": ["string", "number"],
    "description": "Session ID for resuming conversations. Two formats supported: (1) Exact session ID string to pass to --resume flag, (2) Prompt number (integer) to reuse that prompt's session ID (e.g., 1 means 'use session from prompt 1'). When omitted and newChatSession=false, automatically uses previous prompt's session in same workflow.",
    "examples": ["ses_abc123xyz", "550e8400-e29b-41d4-a716-446655440000", 1, 3]
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
  _runtime?: PromptRuntimeMetadata; // NEW: Runtime metadata
}
```

### 2.3 Add Per-Prompt Runtime Metadata

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

  /** Agent used (if any) */
  agent?: string;

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
```

**Benefits:**

- Session IDs persist in working files
- Can inspect which sessions were used for each prompt
- Enables cross-prompt session references
- Survives VS Code restarts
- Provider/model/agent tracking for debugging

---

## 3. Session ID Resolution Logic

### 3.1 User Input Formats

Users can specify `sessionId` in three ways:

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
    sessionId: "550e8400-e29b-41d4-a716-446655440000" # Direct session ID
```

**Resolution:** Pass exact string directly to provider's resume mechanism

#### Format 3: Auto-Resume (Implicit)

```yaml
prompts:
  - id: step1
    prompt: "First step"
    # Starts new session

  - id: step2
    prompt: "Second step"
    newChatSession: false
    # No sessionId specified - auto-resumes previous prompt's session
```

**Resolution:** Automatically uses most recent prompt's session with same provider

### 3.2 Resolution Algorithm

**New file:** `src/utils/SessionResolver.ts`

```typescript
import { PromptItem, Provider } from "../types/FlightPathTypes";
import { Log } from "./Log";

/**
 * Validation result for session references
 */
export interface SessionValidationResult {
  valid: boolean;
  error?: string;
  warning?: string;
}

/**
 * Session resolution and validation utilities
 */
export class SessionResolver {
  /**
   * Resolve session ID for a prompt.
   *
   * Resolution order:
   * 1. If newChatSession=true → undefined (new session)
   * 2. If sessionId is number → resolve from referenced prompt
   * 3. If sessionId is string → use directly
   * 4. Otherwise → auto-resume from previous prompt (same provider)
   *
   * @param prompt The prompt to resolve session for
   * @param promptIndex Current prompt's index in queue
   * @param allPrompts All prompts in queue (with runtime metadata)
   * @returns Resolved session ID or undefined
   */
  static resolve(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[]
  ): string | undefined {
    // 1. Check if new session is explicitly requested
    if (this.shouldStartNewSession(prompt)) {
      return undefined;
    }

    // 2. If sessionId is specified
    if (prompt.sessionId !== undefined) {
      // 2a. Numeric reference (prompt number)
      if (typeof prompt.sessionId === "number") {
        return this.resolveNumericReference(
          prompt,
          prompt.sessionId,
          promptIndex,
          allPrompts
        );
      }

      // 2b. Exact session ID string
      return prompt.sessionId;
    }

    // 3. Auto-resume previous prompt in same workflow
    return this.autoResumeFromPrevious(prompt, promptIndex, allPrompts);
  }

  /**
   * Resolve numeric session reference (e.g., sessionId: 1)
   */
  private static resolveNumericReference(
    prompt: PromptItem,
    refNumber: number,
    promptIndex: number,
    allPrompts: PromptItem[]
  ): string | undefined {
    const refIndex = refNumber - 1; // 1-based to 0-based

    // Validate reference is within bounds
    if (refIndex < 0 || refIndex >= promptIndex) {
      Log.warn(
        `⚠️ Invalid sessionId reference: ${refNumber}. ` +
          `Must reference a completed prompt (1-${promptIndex}). ` +
          `Starting new session.`
      );
      return undefined;
    }

    const referencedPrompt = allPrompts[refIndex];
    const sessionId = referencedPrompt._runtime?.sessionId;

    if (!sessionId) {
      Log.warn(
        `⚠️ Prompt ${refNumber} has no session ID. Starting new session.`
      );
      return undefined;
    }

    // Validate provider compatibility
    const refProvider = referencedPrompt._runtime?.provider;
    const currentProvider = prompt.provider;

    if (refProvider && currentProvider && refProvider !== currentProvider) {
      Log.warn(
        `⚠️ Session ID from prompt ${refNumber} uses different provider ` +
          `(${refProvider} vs ${currentProvider}). Starting new session.`
      );
      return undefined;
    }

    Log.debug(`✅ Resolved sessionId from prompt ${refNumber}: ${sessionId}`);
    return sessionId;
  }

  /**
   * Auto-resume from previous prompt in same workflow
   */
  private static autoResumeFromPrevious(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[]
  ): string | undefined {
    if (promptIndex === 0) {
      return undefined; // First prompt, no previous
    }

    // Find most recent completed prompt with same provider
    for (let i = promptIndex - 1; i >= 0; i--) {
      const prevPrompt = allPrompts[i];
      const prevProvider = prevPrompt._runtime?.provider;
      const prevSessionId = prevPrompt._runtime?.sessionId;
      const currentProvider = prompt.provider;

      // Match provider if specified, otherwise any previous session
      const providersMatch =
        !currentProvider || !prevProvider || prevProvider === currentProvider;

      if (providersMatch && prevSessionId) {
        Log.debug(
          `✅ Auto-resuming session from prompt ${i + 1}: ${prevSessionId}`
        );
        return prevSessionId;
      }
    }

    return undefined;
  }

  /**
   * Check if prompt should start new session.
   *
   * Priority order:
   * 1. Prompt-level newChatSession setting
   * 2. Global flightpath.newChatSessionPerPrompt setting
   */
  static shouldStartNewSession(prompt: PromptItem): boolean {
    // Explicit prompt setting takes precedence
    if (prompt.newChatSession !== undefined) {
      return prompt.newChatSession;
    }

    // Fall back to global setting
    // Note: ConfigurationUtils import will be added when implementing
    // return ConfigurationUtils.shouldStartNewChatSessionPerPrompt();

    // Default to true (start new session) if no setting specified
    return true;
  }

  /**
   * Validate session reference before execution.
   * Checks for invalid references, cross-provider issues, etc.
   *
   * @param prompt The prompt to validate
   * @param promptIndex Current prompt's index
   * @param allPrompts All prompts in queue
   * @returns Validation result
   */
  static validate(
    prompt: PromptItem,
    promptIndex: number,
    allPrompts: PromptItem[]
  ): SessionValidationResult {
    // Check for conflicting settings
    if (
      this.shouldStartNewSession(prompt) &&
      prompt.sessionId !== undefined
    ) {
      return {
        valid: true,
        warning:
          "Prompt has sessionId set but newChatSession=true. " +
          "Session ID will be ignored.",
      };
    }

    // Validate numeric reference
    if (typeof prompt.sessionId === "number") {
      const refIndex = prompt.sessionId - 1;

      if (refIndex < 0 || refIndex >= allPrompts.length) {
        return {
          valid: false,
          error:
            `Invalid sessionId reference: ${prompt.sessionId}. ` +
            `Must reference a prompt between 1-${allPrompts.length}.`,
        };
      }

      if (refIndex >= promptIndex) {
        return {
          valid: false,
          error:
            `Invalid sessionId reference: ${prompt.sessionId}. ` +
            `Cannot reference future prompt (current: ${promptIndex + 1}).`,
        };
      }
    }

    return { valid: true };
  }
}
```

### 3.3 Provider-Agnostic Integration

**Update:** `src/flightpath/cli/CliIntegration.ts`

```typescript
// REMOVE instance-level sessionId (line 72):
// protected sessionId?: string;  // DELETE THIS

// ADD to sendPrompt() method (before buildCliArgs call):
/**
 * Resolve session ID for current prompt using SessionResolver.
 * Returns undefined if new session should start, or resolved session ID.
 */
const resolvedSessionId = SessionResolver.resolve(
  prompt,
  workflowContext?.promptIndex ?? 0,
  workflowContext?.allPrompts ?? [prompt]
);

// Pass resolved session to provider
const baseArgs = await this.provider.buildCliArgs(
  prompt,
  isInteractive,
  this.context,
  workspaceRoot,
  resolvedSessionId,  // <-- Use resolved session instead of this.sessionId
  workflowContext
);

// AFTER execution completes (both interactive and headless):
// Store session ID in prompt's _runtime metadata
if (extractedSessionId) {
  if (!prompt._runtime) {
    prompt._runtime = {
      provider: prompt.provider || this.getDefaultProvider(),
      model: prompt.model || this.getDefaultModel(),
      agent: prompt.agent,
      startedAt: Date.now(),
    };
  }
  prompt._runtime.sessionId = extractedSessionId;
  prompt._runtime.completedAt = Date.now();

  // Save working file to persist runtime metadata
  await this.saveWorkingFile(workflowContext);
}
```

**Key changes:**

1. **Remove `this.sessionId`** - No longer store session at instance level
2. **Use `SessionResolver.resolve()`** - Resolve session per prompt dynamically
3. **Store in `_runtime`** - Session ID persisted in prompt's runtime metadata
4. **Provider-agnostic** - Works with all providers (Copilot, Claude, Codex, future)

---

## 4. Session ID Formats by Provider

Different providers use different session ID formats:

### Copilot CLI

```
Format: UUID v4
Example: "550e8400-e29b-41d4-a716-446655440000"
Extracted from: Process logs (debug level)
Resume flag: --resume <uuid>
```

### Claude CLI

```
Format: UUID v4
Example: "550e8400-e29b-41d4-a716-446655440000"
Extracted from: JSON streaming output (sessionId field) or notification data
Resume flag: -r <uuid>
Validation: Strict UUID format required, rejects invalid format with error
```

### Codex CLI

```
Format: Thread ID string
Example: "thread_abc123xyz"
Extracted from: JSONL events or notify hook data
Resume command: resume <thread-id>
```

### Storage

All formats stored as strings in `_runtime.sessionId`. Provider-specific formatting handled in each provider's `buildCliArgs()` method.

---

## 5. Error Handling & Validation

### Invalid Session ID Format

**Detection:** Pre-validate session ID format before passing to CLI

```typescript
// In CliIntegration or SessionResolver
function validateSessionFormat(
  sessionId: string,
  provider: Provider
): boolean {
  switch (provider) {
    case Provider.CopilotCli:
    case Provider.ClaudeCli:
      // Both require UUID format
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!uuidRegex.test(sessionId)) {
        Log.warn(
          `⚠️ Session ID "${sessionId}" is not a valid UUID for ${provider}. ` +
            `Starting new session instead.`
        );
        return false;
      }
      return true;

    case Provider.CodexCli:
      // Codex uses thread_xxx format
      // Allow any non-empty string for now
      return sessionId.trim().length > 0;

    default:
      return true;
  }
}
```

### Claude CLI Error Recovery

Claude CLI validates UUIDs strictly and exits with error if invalid:

```typescript
// In ClaudeCliProvider.ts (or CliIntegration if shared)
protected async executeWithErrorRecovery(
  args: string[],
  promptText: string,
  workflowContext?: any
): Promise<boolean> {
  try {
    return await this.executeHeadlessWithPromptFile(
      args,
      promptText,
      workflowContext,
      this.handleResult
    );
  } catch (error) {
    // Check for invalid session error
    if (this.isInvalidSessionError(error)) {
      const sessionId = this.extractSessionIdFromArgs(args);
      Log.warn(
        `⚠️ Claude CLI rejected session ID "${sessionId}". ` +
          `Retrying without resume flag.`
      );

      // Remove resume flags and retry
      const argsWithoutResume = this.removeResumeFlags(args);
      return await this.executeHeadlessWithPromptFile(
        argsWithoutResume,
        promptText,
        workflowContext,
        this.handleResult
      );
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
```

### Cross-Provider Session References

When user references a session from different provider:

```yaml
prompts:
  - id: copilot-analyze
    prompt: "Analyze code"
    provider: copilot-cli
    # Completes with sessionId: "uuid-123"

  - id: claude-implement
    prompt: "Implement changes"
    provider: claude-cli
    sessionId: 1 # References copilot session
```

**Handling:**

```typescript
// In SessionResolver.resolveNumericReference()
if (refProvider && currentProvider && refProvider !== currentProvider) {
  Log.warn(
    `⚠️ Session ID from prompt ${refNumber} uses different provider ` +
      `(${refProvider} vs ${currentProvider}). Starting new session.`
  );
  return undefined;
}
```

---

## 6. Implementation Plan

### Phase 1: Schema & Type Updates

**Files to modify:**

1. `schemas/prompt-schema.json`
   - Add `sessionId` field to `promptItem` definition
   - Define `executionProperties` for shared properties
   - Define `promptRuntimeMetadata` using `$ref` to `executionProperties`
   - Update `promptItem` to include `_runtime` field

2. `src/types/FlightPathTypes.ts`
   - Add `PromptRuntimeMetadata` interface
   - Add `sessionId?: string | number` to `PromptItem`
   - Add `_runtime?: PromptRuntimeMetadata` to `PromptItem`

3. Run `npm run generate-schema` to regenerate YAML schema

**Testing:**

- Validate schema accepts `sessionId` as string or number
- Validate `_runtime` metadata structure
- Test $ref resolution works correctly

### Phase 2: Session Resolution Logic

**New file:** `src/utils/SessionResolver.ts`

Implement:
- `resolve()` - Main resolution logic
- `resolveNumericReference()` - Handle prompt number references
- `autoResumeFromPrevious()` - Auto-resume logic
- `shouldStartNewSession()` - Check newChatSession setting
- `validate()` - Pre-execution validation

**Testing:**

- Unit tests for all resolution paths
- Test numeric references (1-based indexing)
- Test auto-resume logic
- Test validation edge cases
- Test cross-provider validation

### Phase 3: CliIntegration Updates

**File:** `src/flightpath/cli/CliIntegration.ts`

Changes:
1. Remove `protected sessionId?: string` instance variable
2. Add `SessionResolver.resolve()` call in `sendPrompt()`
3. Pass resolved session to `provider.buildCliArgs()`
4. After execution, store session in `prompt._runtime.sessionId`
5. Call `saveWorkingFile()` to persist runtime metadata

**Provider updates (if needed):**

Each provider's `buildCliArgs()` already receives `sessionId` parameter.
Verify they handle `undefined` (new session) and `string` (resume) correctly.

- `src/flightpath/cli/copilot/CopilotCliProvider.ts` - Check --resume handling
- `src/flightpath/cli/claude/ClaudeCliProvider.ts` - Check -r handling
- `src/flightpath/cli/codex/CodexCliProvider.ts` - Check resume subcommand

**Testing:**

- Test session resolution in sendPrompt()
- Test runtime metadata population
- Test working file persistence
- Test session resumption with each provider

### Phase 4: Working File Persistence

**Files to modify:**

1. `src/flightpath/PromptQueue.ts`
   - Ensure `_runtime` metadata is saved to working file
   - Load `_runtime` metadata when reloading queue
   - Preserve runtime data during queue reload/merge

2. `src/flightpath/orchestration/WorkspaceSessionManager.ts`
   - Update session loading to include runtime metadata
   - Handle backward compatibility (old files without `_runtime`)

**Working file format example:**

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
        "sessionId": "550e8400-e29b-41d4-a716-446655440000",
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
        "sessionId": "550e8400-e29b-41d4-a716-446655440000",
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

**Testing:**

- Test working file save/load with `_runtime`
- Test backward compatibility (files without `_runtime`)
- Test runtime metadata persistence across restarts

### Phase 5: Error Handling & Validation

**Updates:**

1. Add session format validation (UUID for Copilot/Claude)
2. Add Claude CLI error recovery (retry without resume on invalid session)
3. Add cross-provider validation warnings
4. Add conflicting setting warnings (newChatSession=true + sessionId)

**Testing:**

- Test invalid session ID format (non-UUID)
- Test non-existent session ID
- Test Claude CLI error recovery
- Test cross-provider reference warnings
- Test conflicting settings warnings

### Phase 6: Documentation & Examples

**Files to create/update:**

1. `docs/SESSION_MANAGEMENT.md` - Complete session management guide
2. `manual-test/session-examples/` - Example workflows
   - `multi-session.flightpath.yaml` - Different sessions for different prompts
   - `session-reuse.flightpath.yaml` - Multiple prompts sharing one session
   - `cross-provider.flightpath.yaml` - Mixed providers (validation examples)

3. Update existing docs:
   - `README.md` - Add session management section
   - `.github/copilot-instructions.md` - Update session handling docs

---

## 7. Backward Compatibility

### Breaking Changes

**None.** This is an additive feature:

1. **New `sessionId` field** - Optional, existing files work without it
2. **New `_runtime` metadata** - Optional, added automatically during execution
3. **Session resolution** - Falls back gracefully (auto-resume or new session)

### Migration Strategy

**For users:** No action required. Existing workflows continue working:

- Without `sessionId` field → Auto-resume behavior (like current)
- With `sessionId` field → Explicit session control (new capability)

**Gradual adoption:**

1. Users can start adding `sessionId` to prompts as needed
2. Runtime metadata automatically populated during execution
3. Session IDs persist in working files for resume capability

---

## 8. Open Questions & Decisions

### Q: Should we remove the global session fallback?

**Current behavior:** If no session ID available, some code might fall back to `-c` flag (provider's global session)

**Decision:** Yes, remove `-c` fallback for FlightPath-managed workflows. Reasons:

1. Provider may have sessions from outside FlightPath
2. Resuming non-FlightPath sessions could cause unexpected behavior
3. Better to explicitly track all sessions FlightPath uses
4. Cleaner architecture - session management is explicit

**Implementation:** Remove any `-c` fallback logic from provider implementations.

### Q: Should we track sessions for Chat mode?

**Current:** Chat mode doesn't have session IDs (UI-based, uses existing chat panel)

**Decision:** Not in initial implementation. Chat mode session management is fundamentally different (UI-based). Consider in future if Chat mode gains session APIs.

---

## 9. Success Metrics

- ✅ Session IDs persist across VS Code restarts (working file storage)
- ✅ Session resolution completes in <10ms per prompt
- ✅ Working files correctly save/load `_runtime` metadata
- ✅ Cross-provider validation prevents invalid resumes
- ✅ Provider-agnostic implementation works with Copilot, Claude, Codex
- ✅ Numeric references resolve correctly (1-based user input → 0-based array)
- ✅ Auto-resume works when no `sessionId` specified
- ✅ Error recovery works for invalid sessions (especially Claude CLI)

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
    sessionId: 3 # Continue implementation session (prompt 3)
```

---

## Appendix B: Schema Pattern Comparison

### Option 1: Duplicate Properties (Current)

```json
{
  "promptItem": {
    "properties": {
      "provider": { ... },
      "model": { ... },
      "agent": { ... },
      "_runtime": {
        "properties": {
          "provider": { ... },  // DUPLICATE
          "model": { ... },     // DUPLICATE
          "agent": { ... },     // DUPLICATE
          "sessionId": { ... }
        }
      }
    }
  }
}
```

**Problems:**

- ❌ Schema duplication
- ❌ Maintenance burden (update in 2 places)
- ❌ Risk of inconsistency

### Option 2: Shared Properties with $ref (Recommended)

```json
{
  "definitions": {
    "executionProperties": {
      "properties": {
        "provider": { ... },
        "model": { ... },
        "agent": { ... }
      }
    },
    "promptItem": {
      "allOf": [
        { "$ref": "#/definitions/executionProperties" },
        { "properties": { "id": { ... }, ... } }
      ]
    },
    "promptRuntimeMetadata": {
      "allOf": [
        { "$ref": "#/definitions/executionProperties" },
        { "properties": { "sessionId": { ... }, ... } }
      ]
    }
  }
}
```

**Benefits:**

- ✅ Single source of truth
- ✅ Easy to maintain
- ✅ Guaranteed consistency
- ✅ Clear semantic separation (prompt overrides vs runtime actuals)

---

**End of Updated Implementation Plan**
