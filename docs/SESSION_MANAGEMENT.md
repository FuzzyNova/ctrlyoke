# Session Management Guide

**Status:** Feature Documentation  
**Version:** FlightPath 1.0  
**Last Updated:** January 17, 2026

## Overview

Session management enables you to control conversation continuity across prompts in a workflow. Instead of starting fresh every time, you can resume previous conversations, share context between related prompts, or strategically separate different phases of work into distinct sessions.

### Why Session Management Matters

**Without session management:**

- Each prompt starts fresh with no memory of previous interactions
- Copilot can't reference earlier analysis or decisions
- You lose context when VS Code restarts

**With session management:**

- ✅ **Resume conversations** - Continue where you left off after VS Code restarts
- ✅ **Share context** - Multiple prompts can build on the same conversation
- ✅ **Isolate phases** - Separate analysis from implementation for clearer context
- ✅ **Reference past work** - Use session from prompt 1 in prompts 2, 3, 4, etc.
- ✅ **Automatic tracking** - Session IDs persist in working files

---

## How It Works

### The Big Picture

When FlightPath executes a prompt with a CLI provider (Copilot CLI, Claude CLI, or Codex CLI):

1. **Session resolution** - FlightPath determines which session to use
2. **Execution** - CLI receives `--resume <session-id>` flag (or equivalent)
3. **Capture** - New session ID extracted from response
4. **Persistence** - Session ID saved to `_runtime` metadata in working file
5. **Reuse** - Later prompts can reference this session

**Working file example:**

```yaml
prompts:
  - id: analyze
    prompt: "Analyze security issues"
    _runtime:
      provider: copilot-cli
      model: claude-sonnet-4.5
      sessionId: 550e8400-e29b-41d4-a716-446655440000 # ← Persisted!
      startedAt: 1705170000000
      completedAt: 1705170123000

  - id: implement
    prompt: "Implement fixes"
    sessionId: 1 # ← Use session from prompt 1 (analyze)
    _runtime:
      provider: copilot-cli
      model: claude-sonnet-4.5
      sessionId: 550e8400-e29b-41d4-a716-446655440000 # ← Same session!
      startedAt: 1705170130000
```

---

## Three Session ID Formats

FlightPath supports three ways to specify session IDs:

### Format 1: Numeric Reference (Recommended)

**Syntax:** `sessionId: <number>`

Reference another prompt's session by its position in the workflow (1-based indexing).

```yaml
prompts:
  - id: analyze
    prompt: "Analyze the codebase for bugs"
    # No sessionId - starts new session

  - id: implement
    prompt: "Fix the bugs found"
    sessionId: 1 # Use session from prompt 1 (analyze)

  - id: verify
    prompt: "Verify all bugs are fixed"
    sessionId: 1 # Also use session from prompt 1
```

**How it works:**

1. `sessionId: 1` → Look up `prompts[0]._runtime.sessionId`
2. Extract the actual session ID (e.g., `550e8400-e29b-41d4-a716-446655440000`)
3. Pass to CLI: `--resume 550e8400-e29b-41d4-a716-446655440000`

**Benefits:**

- ✅ Simple and readable
- ✅ Self-documenting intent ("continue from step 1")
- ✅ Survives session ID changes (references by position, not ID)

**When to use:**

- Continuing a conversation from an earlier prompt
- Multiple prompts building on the same analysis
- Clear workflow phases (analyze → implement → verify)

---

### Format 2: Exact Session ID

**Syntax:** `sessionId: "<exact-uuid>"`

Provide the exact session ID string to resume.

```yaml
prompts:
  - id: resume-work
    prompt: "Continue the feature implementation"
    sessionId: "550e8400-e29b-41d4-a716-446655440000"
```

**How it works:**

- Session ID passed directly to CLI without modification
- FlightPath validates format (UUID for Copilot/Claude, thread_xxx for Codex)

**Benefits:**

- ✅ Resume sessions from outside FlightPath
- ✅ Manually copy session IDs between workflows
- ✅ Maximum control

**When to use:**

- Resuming work from a previous run
- Testing with specific known sessions
- Debugging session-related issues

**Finding session IDs:**

1. Check working files: `.flightpath/.working/<workflow>.working.yaml`
2. Look in CLI session logs (in `~/.copilot/session-state/` for Copilot)
3. Use `_runtime.sessionId` from previous executions

---

### Format 3: Auto-Resume (Implicit)

**Syntax:** `resumeSession: true` (no `sessionId` field)

Automatically continue from the previous prompt's session.

```yaml
prompts:
  - id: step1
    prompt: "First step"
    # Starts new session

  - id: step2
    prompt: "Second step"
    resumeSession: true
    # Auto-resumes session from step1

  - id: step3
    prompt: "Third step"
    resumeSession: true
    # Auto-resumes session from step2 (same as step1)
```

**How it works:**

1. No `sessionId` specified + `resumeSession: true`
2. FlightPath looks at previous prompt's `_runtime.sessionId`
3. Automatically uses that session ID

**Benefits:**

- ✅ Minimal configuration
- ✅ Natural conversation flow
- ✅ Works like current behavior (backward compatible)

**When to use:**

- Sequential prompts that should share context
- Simple workflows without complex session logic
- Default behavior for multi-step tasks

---

## Cross-Provider Workflows

### Provider-Aware Session Resumption

FlightPath **automatically validates provider compatibility** when resuming sessions. Sessions cannot be shared across different providers (Copilot ↔ Claude ↔ Codex) because each provider has different session formats and APIs.

**How It Works:**

1. **Explicit numeric reference** (`sessionId: 1`) - Validates providers match, warns and starts new session if mismatch
2. **Auto-resume** (`resumeSession: true`, no `sessionId`) - **Searches backward for last prompt with matching provider** (strict equality check)
3. **Exact session ID** (`sessionId: "uuid"`) - No provider validation (you control the session ID)

**Strict Provider Matching:** Auto-resume uses strict equality to prevent cross-provider session references. Providers must BOTH be defined and match exactly (e.g., `"claude-cli" === "claude-cli"`) for session reuse. This prevents errors like "Copilot trying to resume Claude's session".

### Example: Mixed Provider Workflow

```yaml
prompts:
  - id: claude-analyze
    provider: claude-cli
    prompt: "Analyze codebase architecture"
    # Creates Claude session: abc-123

  - id: copilot-review
    provider: copilot-cli
    prompt: "Review code quality"
    # Creates Copilot session: xyz-789

  - id: claude-implement
    provider: claude-cli
    prompt: "Implement improvements"
    resumeSession: true  # No sessionId specified
    # ✅ Auto-resumes Claude session abc-123 (skips Copilot session)

  - id: copilot-test
    provider: copilot-cli
    prompt: "Add tests"
    resumeSession: true  # No sessionId specified
    # ✅ Auto-resumes Copilot session xyz-789 (skips Claude session)
```

**Result:** Each provider maintains its own session chain, automatically!

### Example: Cross-Provider Reference (Error Case)

```yaml
prompts:
  - id: step1
    provider: claude-cli
    prompt: "Analyze code"
    # Creates Claude session: abc-123

  - id: step2
    provider: copilot-cli
    prompt: "Review analysis"
    sessionId: 1  # ⚠️ Trying to use Claude session with Copilot!
```

**What Happens:**

```
⚠️ Cross-provider session reference detected!
   Prompt 1 used claude-cli, but current prompt uses copilot-cli.
   Sessions cannot be shared across different providers (Copilot ↔ Claude ↔ Codex).
   Starting new copilot-cli session instead.
   To fix: Either:
     1. Use same provider for all prompts that share a session, OR
     2. Remove sessionId to auto-resume from last prompt with matching provider
```

**Result:** Starts a **new Copilot session** instead of erroring.

### When to Use Each Approach

| Scenario | Configuration | Behavior |
|----------|---------------|----------|
| **All prompts same provider** | `sessionId: 1` on all prompts | ✅ All share session from prompt 1 |
| **Mixed providers, auto-resume** | `resumeSession: true` (no `sessionId`) | ✅ Each provider resumes its own last session |
| **Mixed providers, explicit ref** | `sessionId: 1` across providers | ⚠️ Warns and starts new session on provider change |
| **Force new session** | `resumeSession: false` | ✅ Always starts new session |

### Best Practice: Use Auto-Resume for Mixed Providers

**Recommended:**

```yaml
# Workflow default: Auto-resume
resumeSession: true

prompts:
  - provider: claude-cli
    prompt: "Step 1"
    # New Claude session

  - provider: claude-cli
    prompt: "Step 2"
    # Auto-resumes previous Claude session

  - provider: copilot-cli
    prompt: "Step 3"
    # New Copilot session (no Claude sessions to resume)

  - provider: copilot-cli
    prompt: "Step 4"
    # Auto-resumes previous Copilot session
```

**Why:** No manual session tracking needed, provider-aware auto-resume handles everything!

---

## Session Resolution Algorithm

FlightPath follows a strict precedence order when determining which session to use:

```
┌─────────────────────────────────────────────┐
│ 1. Check prompt.sessionId (Highest)        │
│    - Numeric reference? → Resolve to UUID  │
│    - Exact UUID? → Use directly            │
└─────────────────────────────────────────────┘
                  ↓ (if not set)
┌─────────────────────────────────────────────┐
│ 2. Check prompt.resumeSession              │
│    - true → Auto-resume from previous      │
│    - false → Start new session             │
└─────────────────────────────────────────────┘
                  ↓ (if not set)
┌─────────────────────────────────────────────┐
│ 3. Check workflow.resumeSession            │
│    - Workflow-level default                 │
└─────────────────────────────────────────────┘
                  ↓ (if not set)
┌─────────────────────────────────────────────┐
│ 4. Check global setting                     │
│    - flightpath.resumeExistingSession       │
└─────────────────────────────────────────────┘
```

### Resolution Examples

**Example 1: Explicit numeric reference**

```yaml
prompts:
  - id: analyze
    prompt: "Analyze code"
    # Starts new session (default)

  - id: implement
    sessionId: 1 # ← Explicit reference wins
    resumeSession: false # ← Ignored (sessionId takes precedence)
```

**Result:** Uses session from prompt 1 (analyze)

---

**Example 2: Auto-resume**

```yaml
prompts:
  - id: step1
    prompt: "First step"

  - id: step2
    resumeSession: true # ← No sessionId, so check resumeSession
```

**Result:** Auto-resumes from step1's session

---

**Example 3: Workflow-level default**

```yaml
resumeSession: true # Workflow default

prompts:
  - id: step1
    prompt: "First step"
    # No prompt-level override → Uses workflow default

  - id: step2
    prompt: "Second step"
    # Also uses workflow default (auto-resume)
```

**Result:** All prompts continue from previous session (workflow-wide setting)

---

## Working with \_runtime Metadata

### What is \_runtime?

`_runtime` is **execution metadata** automatically added to each prompt after it runs. It tracks:

- Which provider/model was actually used
- Session ID returned by the CLI
- Execution timestamps
- Retry information

**Example:**

```yaml
prompts:
  - id: analyze
    prompt: "Analyze security issues"
    model: claude-sonnet-4.5
    _runtime:
      provider: copilot-cli
      model: claude-sonnet-4.5
      sessionId: 550e8400-e29b-41d4-a716-446655440000
      startedAt: 1705170000000
      completedAt: 1705170123000
      retryCount: 0
```

### When is \_runtime populated?

- **After prompt completes** - Session ID, timestamps, provider/model written
- **During retries** - Retry count incremented
- **On resume** - Existing `_runtime` preserved, new prompts get their own

### Using \_runtime for debugging

**Check which session was used:**

```yaml
_runtime:
  sessionId: 550e8400-e29b-41d4-a716-446655440000 # ← Actual session used
```

**Verify session continuity:**

```yaml
prompts:
  - id: step1
    _runtime:
      sessionId: abc-123 # ← First session

  - id: step2
    sessionId: 1
    _runtime:
      sessionId: abc-123 # ← Should match step1
```

**Troubleshoot retries:**

```yaml
_runtime:
  retryCount: 2 # ← This prompt was retried twice
```

---

## Provider-Specific Details

### Copilot CLI

**Session format:** UUID v4  
**Example:** `550e8400-e29b-41d4-a716-446655440000`

**Resume mechanism:**

```bash
gh copilot --resume 550e8400-e29b-41d4-a716-446655440000
```

**Session tracking:**

- Session IDs extracted from session event logs in `~/.copilot/session-state/`
- Session discovery uses prompt content matching in JSONL event logs
- FlightPath monitors these logs for completion detection and session resumption

**Notes:**

- Session IDs persist until Copilot CLI session expires
- No explicit session invalidation API

---

### Claude CLI

**Session format:** UUID v4  
**Example:** `a1b2c3d4-e5f6-7890-abcd-ef1234567890`

**Resume mechanism:**

```bash
claude-code -r a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

**Session tracking:**

- Extracted from JSON streaming output (`stream-json` format)
- Session metadata included in response objects

**Error recovery:**

If invalid session ID provided:

1. Claude CLI returns error
2. FlightPath detects error
3. Automatically retries **without** resume flag (starts new session)
4. Workflow continues with new session

**Notes:**

- Sessions expire after period of inactivity
- Invalid sessions trigger automatic fallback to new session

---

### Codex CLI

**Session format:** Thread ID  
**Example:** `thread_abc123xyz789`

**Resume mechanism:**

```bash
codex resume thread_abc123xyz789
```

**Session tracking:**

- Extracted from JSONL events (`{"type": "session.created", "session_id": "thread_..."}`)
- Interactive mode: Notify hook provides session ID
- Headless mode: JSONL events parsed for session info

**Notes:**

- Thread-based sessions (persistent across executions)
- Each thread maintains full conversation history

---

## Error Handling & Validation

### Session Validation

FlightPath validates session IDs before execution:

**Format validation:**

- Copilot/Claude: Must be valid UUID v4
- Codex: Must start with `thread_`

**Cross-provider validation:**

```yaml
prompts:
  - id: step1
    provider: copilot-cli
    # Creates Copilot session

  - id: step2
    provider: claude-cli # ⚠️ Different provider!
    sessionId: 1 # References Copilot session
```

**Result:** ⚠️ Warning logged, session reference ignored (incompatible providers)

### Common Validation Errors

#### Error: Numeric reference out of range

```
Session reference '5' is out of range (workflow has 3 prompts)
```

**Cause:** `sessionId: 5` but workflow only has 3 prompts

**Fix:** Use valid prompt number (1, 2, or 3)

---

#### Error: Referenced prompt has no session

```
Prompt 1 has not been executed yet (no session available)
```

**Cause:** Trying to use `sessionId: 1` before prompt 1 has run

**Fix:** Ensure prompts run in order, or use exact session ID

---

#### Error: Invalid session ID format

```
Invalid session ID format for copilot-cli: 'invalid-uuid'
```

**Cause:** Session ID doesn't match provider's expected format

**Fix:** Use valid UUID for Copilot/Claude, or `thread_xxx` for Codex

---

#### Warning: Cross-provider session reference

```
Warning: sessionId references prompt using different provider (copilot-cli vs claude-cli)
```

**Cause:** Trying to resume a Copilot session with Claude CLI

**Fix:** Only reference sessions from same provider

---

#### Error: Conflicting settings

```
Warning: Both resumeSession=false and sessionId specified. sessionId takes precedence.
```

**Cause:** `resumeSession: false` and `sessionId: 1` both set

**Fix:** Remove `resumeSession: false` (it's ignored when `sessionId` is set)

---

## Troubleshooting

### Problem: Session not resuming

**Symptoms:**

- Prompt starts fresh conversation despite `sessionId` or `resumeSession: true`
- CLI doesn't use `--resume` flag

**Possible causes:**

1. **Previous prompt hasn't run yet**
   - `sessionId: 1` but prompt 1 not executed
   - **Fix:** Run prompts in order

2. **Session ID not captured**
   - Previous prompt's `_runtime.sessionId` is missing
   - **Fix:** Check CLI logs for session extraction errors

3. **Working file not saved**
   - Runtime metadata not persisted
   - **Fix:** Check for file system errors, ensure `.flightpath/.working/` is writable

4. **Provider mismatch**
   - Trying to resume Copilot session with Claude
   - **Fix:** Use same provider for all prompts in session chain

5. **resumeSession not set correctly**
   - May be explicitly set to `false` when you want to resume
   - **Fix:** Set `resumeSession: true` or use numeric `sessionId` reference

**Debugging:**

1. Check working file: `.flightpath/.working/<workflow>.working.yaml`
2. Verify `_runtime.sessionId` exists for referenced prompt
3. Check Output panel (FlightPath channel) for session resolution logs
4. Enable CLI logging (`flightpath.showCliOutput: true`)

---

### Problem: Session IDs not persisting across restarts

**Symptoms:**

- Session IDs work during execution
- After VS Code restart, sessions lost

**Possible causes:**

1. **Working file not saved**
   - Runtime metadata not written to disk
   - **Fix:** Ensure workflows complete successfully before restarting

2. **Working file deleted**
   - `.flightpath/.working/` directory cleared
   - **Fix:** Don't delete working files (they store runtime state)

**Verification:**

```bash
# Check if working file exists
ls .flightpath/.working/

# Inspect working file
cat .flightpath/.working/my-workflow.working.yaml
```

---

### Problem: Invalid session ID error

**Symptoms:**

- Error: "Invalid session ID format"
- Execution fails immediately

**Possible causes:**

1. **Wrong provider format**
   - UUID for Codex (should be `thread_xxx`)
   - `thread_xxx` for Copilot (should be UUID)
   - **Fix:** Use correct format for provider

2. **Corrupted session ID**
   - Partial UUID or malformed string
   - **Fix:** Use exact session ID from working file or logs

**Examples:**

```yaml
# ❌ Wrong: UUID for Codex
provider: codex-cli
sessionId: "550e8400-e29b-41d4-a716-446655440000"

# ✅ Correct: Thread ID for Codex
provider: codex-cli
sessionId: "thread_abc123xyz789"
```

---

## Best Practices

### 1. Use numeric references for clarity

**Good:**

```yaml
prompts:
  - id: analyze
    prompt: "Analyze security issues"

  - id: implement
    prompt: "Fix security issues"
    sessionId: 1 # Clear: Continue from analysis
```

**Why:** Self-documenting, survives session ID changes

---

### 2. Separate phases with new sessions

**Good:**

```yaml
prompts:
  - id: analyze
    prompt: "Analyze codebase"
    # New session (default)

  - id: plan
    prompt: "Create implementation plan"
    sessionId: 1 # Continue analysis

  - id: implement
    prompt: "Implement the plan"
    resumeSession: false # Fresh session for implementation

  - id: test
    prompt: "Add tests"
    sessionId: 3 # Continue implementation session
```

**Why:** Keeps analysis context separate from implementation, clearer AI focus

---

### 3. Document session strategy in comments

**Good:**

```yaml
prompts:
  # Phase 1: Code review (shared session)
  - id: security-review
    prompt: "Review security"

  - id: performance-review
    prompt: "Review performance"
    sessionId: 1 # Share context with security review

  # Phase 2: Implementation (new session)
  - id: implement-fixes
    prompt: "Implement all fixes"
    resumeSession: false # Start fresh for implementation
```

**Why:** Makes workflow intent clear for future maintainers

---

### 4. Use workflow-level defaults for consistency

**Good:**

```yaml
# Default: Continue sessions throughout workflow
resumeSession: true

prompts:
  - id: step1
    prompt: "First step"

  - id: step2
    prompt: "Second step"
    # Auto-resumes from step1

  - id: step3
    prompt: "Third step"
    resumeSession: false # Override: Start fresh here
```

**Why:** Reduces repetition, clear exceptions stand out

---

### 5. Verify session continuity in working files

**After execution:**

```yaml
prompts:
  - id: step1
    _runtime:
      sessionId: abc-123

  - id: step2
    sessionId: 1
    _runtime:
      sessionId: abc-123 # ✅ Should match step1

  - id: step3
    sessionId: 1
    _runtime:
      sessionId: abc-123 # ✅ Should match step1
```

**Why:** Confirms session resolution worked correctly

---

## Example Workflows

### Multi-Phase Development

Different sessions for analysis, implementation, and review:

```yaml
provider: copilot-cli
model: claude-sonnet-4.5

prompts:
  # Phase 1: Analysis (Session A)
  - id: analyze-security
    prompt: "Analyze codebase for security vulnerabilities"

  - id: analyze-performance
    prompt: "Analyze performance bottlenecks"
    sessionId: 1 # Continue from security analysis

  # Phase 2: Implementation (Session B - fresh context)
  - id: implement-security
    prompt: "Implement security fixes"
    resumeSession: false

  - id: implement-performance
    prompt: "Implement performance improvements"
    sessionId: 3 # Continue from security implementation

  # Phase 3: Verification (Session C - independent review)
  - id: verify-all
    prompt: "Verify all changes meet requirements"
    resumeSession: false
```

---

### Test-Driven Development

Shared session for related work:

```yaml
provider: copilot-cli
model: claude-sonnet-4.5
resumeSession: true # Workflow default: Share sessions

prompts:
  - id: write-tests
    prompt: "Write comprehensive tests for authentication module"

  - id: implement-feature
    prompt: "Implement authentication to pass the tests"
    # Auto-resumes from write-tests

  - id: refactor
    prompt: "Refactor implementation for better maintainability"
    # Auto-resumes (continues same session)
```

---

### Resume After Restart

Using exact session IDs to continue work:

```yaml
provider: copilot-cli
model: claude-sonnet-4.5

prompts:
  - id: continue-work
    prompt: "Continue implementing the user dashboard feature"
    sessionId: "550e8400-e29b-41d4-a716-446655440000" # From previous run

  - id: add-tests
    prompt: "Add tests for the dashboard"
    sessionId: 1 # Continue from resumed session
```

---

## Related Documentation

- **[Workflow Properties Guide](WORKFLOW_PROPERTIES.md)** - Workflow-level configuration
- **[End Conditions Guide](END_CONDITIONS.md)** - Validation and retry logic
- **[CLI Design](COPILOT_CLI_DESIGN.md)** - Provider implementation details
- **[Quick Start Guide](../QUICK_START.md)** - Getting started with FlightPath
- **[Prompt Syntax](PROMPT_SYNTAX.md)** - Writing effective prompts

---

## Appendix: Full Schema Reference

### Prompt-Level Properties

```yaml
prompts:
  - id: string # Optional identifier
    prompt: string # Prompt text (required)

    # Session management
    sessionId: string | number # Session reference (numeric or exact UUID)
    resumeSession: boolean # Continue from previous session vs start new

    # Other properties
    provider: string
    model: string
    agent: string
    allowDynamicExtension: boolean
    endCondition: object

    # Runtime metadata (auto-populated)
    _runtime:
      provider: string # Actual provider used
      model: string # Actual model used
      sessionId: string # Actual session ID
      startedAt: number # Timestamp (milliseconds)
      completedAt: number # Timestamp (milliseconds)
      retryCount: number # Number of retries
      isRetry: boolean # Was this a retry?
```

### Workflow-Level Properties

```yaml
# Workflow defaults (apply to all prompts)
provider: string
model: string
agent: string
resumeSession: boolean
allowDynamicExtension: boolean
endCondition: object

prompts:
  -  # ... prompts inherit defaults
```

---

**End of Guide**
