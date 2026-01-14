# Per-Prompt Session Management Architecture

**Status:** Planning Phase
**Created:** 2026-01-13
**Author:** FlightPath Team

## Executive Summary

Refine FlightPath's session management to support per-prompt session tracking, enabling workflows where different prompts can resume different conversation sessions. This eliminates the current limitation of one global session per provider and enables true multi-session workflow orchestration.

### Current Limitations

1. **Single session per provider:** All prompts in a workflow use the same `this.sessionId` stored in the integration instance
2. **Lost on restart:** Session IDs are stored in memory and lost when VS Code closes
3. **No workflow-aware resumption:** New prompts can't intelligently resume previous prompts' sessions within the same workflow
4. **Global session fallback:** Falls back to `-c` flag (provider's built-in session tracking) which may reference sessions outside FlightPath

### Proposed Improvements

1. **Per-prompt session tracking:** Each prompt gets its own `sessionId` field in schema
2. **Persistent storage:** Session IDs saved in working files survive VS Code restarts
3. **Smart session resolution:** Prompts can reference other prompts' sessions by number
4. **Workflow-scoped sessions:** Automatic session continuity within workflows
5. **Remove global session fallback:** Only use sessions FlightPath explicitly tracks

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

**Handling:** CLI will fail with error. FlightPath logs the failure and continues with next prompt (or retries if end condition configured).

**Future improvement:** Could catch specific error patterns and automatically retry without `--resume`.

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

- `src/flightpath/cli/CopilotCommandLineIntegration.ts`
  - Update session extraction to populate `prompt._runtime.sessionId`
  - Remove fallback to `-c` flag

- `src/flightpath/cli/ClaudeCommandLineIntegration.ts`
  - Update session extraction to populate `prompt._runtime.sessionId`
  - Remove fallback to `-c` flag

- `src/flightpath/cli/CodexCommandLineIntegration.ts`
  - Update session extraction to populate `prompt._runtime.sessionId`

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
    // Provider-specific resume flag
    this.applyResumeFlag(args, sessionId);
    Log.debug(`✅ Resuming session: ${sessionId}`);
  } else if (!SessionResolver.shouldStartNewSession(prompt)) {
    Log.debug(`ℹ️ Resume requested but no session available. Starting new.`);
  }
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

## 7. Testing Strategy

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

## 8. Future Enhancements

### 8.1 Session Management UI

**Dashboard enhancements:**

- Show session IDs for completed prompts
- Visual indicators for session continuity (e.g., line connecting prompts in same session)
- Session selector dropdown when adding prompts
- "Resume session" button to quickly add prompt with `sessionId: N`

### 8.2 Intelligent Session Recovery

**When provider rejects session ID:**

```typescript
try {
  await executeWithSession(sessionId);
} catch (error) {
  if (isInvalidSessionError(error)) {
    Log.warn(`Session ${sessionId} no longer valid. Starting new session.`);
    await executeWithoutSession();
  }
}
```

### 8.3 Session Metadata Export

**Export session history:**

```typescript
// Generate session report
{
  "workflow": "analyze-and-fix",
  "sessions": [
    {
      "sessionId": "ses_abc123",
      "provider": "copilot-cli",
      "model": "claude-sonnet-4.5",
      "prompts": [1, 2, 3],
      "duration": 450000,
      "created": 1705170000000
    }
  ]
}
```

### 8.4 Session Cleanup

**Auto-cleanup old sessions:**

- Track session age in `_runtime` metadata
- Offer command to clear old sessions from working files
- Warn when referencing sessions older than X days

---

## 9. Implementation Checklist

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
- [ ] Update `CopilotCommandLineIntegration` session extraction
- [ ] Update `ClaudeCommandLineIntegration` session extraction
- [ ] Update `CodexCommandLineIntegration` session extraction
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

### Documentation

- [ ] Create `docs/SESSION_MANAGEMENT.md`
- [ ] Add example workflows to `manual-test/session-examples/`
- [ ] Update `README.md` with session management overview
- [ ] Update `docs/COPILOT_CLI_DESIGN.md`
- [ ] Add inline code comments for session resolution

---

## 10. Open Questions

### Q1: Should we support session ID wildcards?

**Example:**

```yaml
sessionId: "last"  # Use most recent session
sessionId: "last:copilot-cli"  # Use most recent copilot-cli session
```

**Decision:** Not in initial implementation. Can add later if users request it.

### Q2: Should we track session IDs for Chat mode?

**Current:** Chat mode doesn't have session IDs (UI-based, uses existing chat panel)

**Options:**

1. Track chat panel instance ID (if VS Code API exposes it)
2. Don't track (mark as N/A in `_runtime`)

**Decision:** Start with option 2. Chat mode session management is fundamentally different (UI-based). Defer until Chat mode limitations are addressed.

### Q3: Should we validate session IDs before execution?

**Problem:** Can't validate exact session IDs without calling CLI

**Options:**

1. Pre-validate by calling `copilot list-sessions` (if such command exists)
2. Let CLI fail and handle error
3. Cache known valid sessions and warn if not in cache

**Decision:** Option 2 for initial implementation. Option 3 could be added later for better UX.

### Q4: Should `sessionId` accept arrays for "try these sessions in order"?

**Example:**

```yaml
sessionId: [3, 1, "ses_backup"] # Try prompt 3's session, then prompt 1's, then exact ID
```

**Decision:** Not in initial implementation. Complex and edge-case. Re-evaluate if users request it.

---

## 11. Success Metrics

### User Experience

- [ ] Users can create workflows with multiple sessions
- [ ] Sessions persist across VS Code restarts
- [ ] Clear error messages for invalid session references
- [ ] Auto-resume works intuitively for common workflows

### Technical

- [ ] Zero session IDs lost during normal operation
- [ ] Working files correctly save/load `_runtime` metadata
- [ ] Cross-provider validation prevents invalid resumes
- [ ] Session resolution completes in <10ms per prompt

### Code Quality

- [ ] 90%+ test coverage for `SessionResolver`
- [ ] Clear separation of concerns (resolution vs extraction vs persistence)
- [ ] No hardcoded session logic in CLI integrations
- [ ] Comprehensive inline documentation

---

## Appendix A: Example Workflows

### Example 1: Multi-Session Workflow

```yaml
# Use different sessions for analysis vs implementation

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

  # Session 3: Review
  - id: review-changes
    prompt: "Review all changes and suggest improvements"
    newChatSession: true # Fresh review session
```

### Example 2: Parallel Investigation Streams

```yaml
# Two parallel investigation threads, later merged

prompts:
  # Thread A: Performance
  - id: perf-analyze
    prompt: "Analyze performance bottlenecks"

  - id: perf-profile
    prompt: "Profile the hot paths identified"
    sessionId: 1

  - id: perf-optimize
    prompt: "Optimize the bottlenecks"
    sessionId: 1

  # Thread B: Memory
  - id: mem-analyze
    prompt: "Analyze memory usage patterns"

  - id: mem-profile
    prompt: "Profile memory allocations"
    sessionId: 4

  - id: mem-optimize
    prompt: "Optimize memory usage"
    sessionId: 4

  # Merge
  - id: verify-all
    prompt: "Verify both performance and memory improvements"
    newChatSession: true # Fresh verification session
```

### Example 3: Auto-Resume Workflow

```yaml
# Simplest case: all prompts share one session automatically

prompts:
  - prompt: "Step 1: Setup"
    newChatSession: false # Will start new (no previous session)

  - prompt: "Step 2: Implement"
    newChatSession: false # Auto-resumes step 1's session

  - prompt: "Step 3: Test"
    newChatSession: false # Auto-resumes step 2's session

  - prompt: "Step 4: Deploy"
    newChatSession: false # Auto-resumes step 3's session
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

## Appendix C: Migration from Current System

### Step 1: Identify Current Behavior

If you currently rely on `-c` flag behavior:

```yaml
# OLD: Implicitly uses -c for session continuity
prompts:
  - prompt: "Step 1"
    newChatSession: false # Uses -c
  - prompt: "Step 2"
    newChatSession: false # Uses -c
```

### Step 2: Explicit Session References

```yaml
# NEW: Explicitly reference session
prompts:
  - prompt: "Step 1"
    newChatSession: false # Starts new, saves sessionId
  - prompt: "Step 2"
    newChatSession: false
    sessionId: 1 # Explicit reference (or omit for auto-resume)
```

### Step 3: Enable Fallback (Temporary)

```json
// settings.json (temporary migration aid)
{
  "flightpath.allowProviderSessionFallback": true
}
```

This keeps old behavior while you update workflows.

---

**End of Planning Document**
