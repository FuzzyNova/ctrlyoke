# Session Management Examples

This directory contains example workflows demonstrating ctrlyoke's session management capabilities.

## Overview

Session management allows you to control conversation continuity across prompts:

- **Resume conversations** - Continue where you left off after VS Code restarts
- **Share context** - Multiple prompts build on the same conversation
- **Isolate phases** - Separate analysis from implementation for clearer context
- **Reference past work** - Use session from prompt 1 in prompts 2, 3, 4, etc.

## Example Workflows

### 1. multi-session.ctrlyoke.yaml

**Purpose:** Demonstrates using different sessions for different workflow phases

**Pattern:** Analysis → Implementation → Verification (3 separate sessions)

**Key Concepts:**

- Session isolation between phases
- Numeric session references (`sessionId: 1`)
- Strategic use of `newChatSession: true`

**Use When:**

- You want different phases to have independent context
- Analysis shouldn't bias implementation
- Independent verification needed

**Run This Example:**

```
Command Palette → ctrlyoke: Take Off
Select: manual-test/session-examples/multi-session.ctrlyoke.yaml
```

---

### 2. session-reuse.ctrlyoke.yaml

**Purpose:** Demonstrates multiple prompts sharing a single continuous session

**Pattern:** Test-Driven Development workflow (1 shared session)

**Key Concepts:**

- Workflow-level `newChatSession: false` default
- Auto-resume from previous prompt
- Continuous context throughout workflow

**Use When:**

- Each step builds directly on previous work
- You want cumulative conversation context
- Iterative development process

**Run This Example:**

```
Command Palette → ctrlyoke: Take Off
Select: manual-test/session-examples/session-reuse.ctrlyoke.yaml
```

---

### 3. cross-harness.ctrlyoke.yaml

**Purpose:** Demonstrates validation warnings with mixed harnesss

**Pattern:** Shows incompatible session references and proper mixed-harness workflows

**Key Concepts:**

- Cross-harness session validation
- Harness-specific session formats (UUID vs thread_xxx)
- Graceful degradation on incompatible references
- Best practices for mixed harnesss

**Use When:**

- Learning about harness compatibility
- Troubleshooting session-related issues
- Understanding validation behavior

**Run This Example:**

```
Command Palette → ctrlyoke: Take Off
Select: manual-test/session-examples/cross-harness.ctrlyoke.yaml
```

**Expected Warnings:**

- Cross-harness session references generate warnings
- Invalid session formats trigger errors
- ctrlyoke falls back gracefully (no fatal errors)

---

## Session ID Formats

### Numeric Reference (Recommended)

```yaml
prompts:
  - name: analyze
    prompt: "Analyze code"
    # Starts new session

  - name: implement
    prompt: "Fix issues"
    sessionId: 1 # Use session from prompt 1
```

**Benefits:**

- Simple and readable
- Self-documenting
- Survives session ID changes

---

### Exact Session ID

```yaml
prompts:
  - name: resume-work
    prompt: "Continue previous work"
    sessionId: "550e8400-e29b-41d4-a716-446655440000"
```

**Benefits:**

- Resume sessions from previous runs
- Cross-workflow session sharing
- Maximum control

---

### Auto-Resume (Implicit)

```yaml
prompts:
  - name: step1
    prompt: "First step"

  - name: step2
    prompt: "Second step"
    newChatSession: false # Auto-resume from step1
```

**Benefits:**

- Minimal configuration
- Natural conversation flow
- Default behavior

---

## Checking Session Continuity

After running a workflow, check the working file to verify session continuity:

```bash
# View working file
cat <run-storage>/<workflowKey>/run-<timestamp>/workflow.ctrlyoke.json
```

**Expected Structure:**

```yaml
prompts:
  - name: analyze
    _runtime:
      sessionId: "abc-123" # Session 1

  - name: implement
    sessionId: 1
    _runtime:
      sessionId: "abc-123" # ✅ Same as analyze

  - name: verify
    newChatSession: true
    _runtime:
      sessionId: "xyz-789" # Session 2 (different)
```

---

## Harness-Specific Session Formats

### Copilot CLI

**Format:** UUID v4  
**Example:** `550e8400-e29b-41d4-a716-446655440000`

### Claude CLI

**Format:** UUID v4  
**Example:** `a1b2c3d4-e5f6-7890-abcd-ef1234567890`

### Codex CLI

**Format:** Thread ID  
**Example:** `thread_abc123xyz789`

---

## Troubleshooting

### Session Not Resuming

**Check:**

1. Run definition exists in run storage: `<workflowKey>/run-<timestamp>/workflow.ctrlyoke.json`
2. Previous prompt has `_runtime.sessionId`
3. Harnesss match (Copilot → Copilot, not Copilot → Claude)
4. Session ID format valid for harness

**Debug:**

```
View → Output → Select "ctrlyoke" channel
Look for: "Session resolved: ..." messages
```

### Cross-Harness Warnings

**Expected:** ctrlyoke warns when session reference crosses harnesss

**Behavior:** Gracefully falls back to new session (workflow continues)

**Fix:** Use same harness for session chain, or use `newChatSession: true` when switching

---

## Best Practices

1. **Use numeric references for clarity**

   ```yaml
   sessionId: 1 # Clear: Continue from step 1
   ```

2. **Separate phases with new sessions**

   ```yaml
   # Analysis session
   - prompt: "Analyze code"

   # Implementation session (fresh)
   - prompt: "Implement fixes"
     newChatSession: true
   ```

3. **Document session strategy**

   ```yaml
   # Phase 1: Analysis (shared session)
   - name: security-review
   - name: performance-review
     sessionId: 1

   # Phase 2: Implementation (new session)
   - name: implement
     newChatSession: true
   ```

4. **Use workflow defaults**

   ```yaml
   newChatSession: false # Workflow default

   prompts:
     - prompt: "Step 1"
     - prompt: "Step 2" # Auto-resumes
   ```

---

## Related Documentation

- **[Session Management Guide](../../docs/SESSION_MANAGEMENT.md)** - Complete user guide
- **[Workflow Properties Guide](../../docs/WORKFLOW_PROPERTIES.md)** - Workflow-level configuration
- **[CLI Design](../../docs/COPILOT_CLI_DESIGN.md)** - Harness implementation details

---

**Next Steps:**

1. Run each example workflow
2. Check working files to see session IDs
3. Try modifying examples to experiment
4. Create your own multi-session workflows

📚 **For complete documentation, see [docs/SESSION_MANAGEMENT.md](../../docs/SESSION_MANAGEMENT.md)**
