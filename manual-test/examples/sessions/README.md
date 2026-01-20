# Session Management Examples

This directory contains example workflows demonstrating FlightPath's session management capabilities.

## Overview

Session management allows you to control conversation continuity across prompts:

- **Resume conversations** - Continue where you left off after VS Code restarts
- **Share context** - Multiple prompts build on the same conversation
- **Isolate phases** - Separate analysis from implementation for clearer context
- **Reference past work** - Use session from prompt 1 in prompts 2, 3, 4, etc.

## Example Workflows

### 1. multi-session.flightpath.yaml

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
Command Palette → FlightPath: Take Off
Select: manual-test/session-examples/multi-session.flightpath.yaml
```

---

### 2. session-reuse.flightpath.yaml

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
Command Palette → FlightPath: Take Off
Select: manual-test/session-examples/session-reuse.flightpath.yaml
```

---

### 3. cross-provider.flightpath.yaml

**Purpose:** Demonstrates validation warnings with mixed providers

**Pattern:** Shows incompatible session references and proper mixed-provider workflows

**Key Concepts:**

- Cross-provider session validation
- Provider-specific session formats (UUID vs thread_xxx)
- Graceful degradation on incompatible references
- Best practices for mixed providers

**Use When:**

- Learning about provider compatibility
- Troubleshooting session-related issues
- Understanding validation behavior

**Run This Example:**

```
Command Palette → FlightPath: Take Off
Select: manual-test/session-examples/cross-provider.flightpath.yaml
```

**Expected Warnings:**

- Cross-provider session references generate warnings
- Invalid session formats trigger errors
- FlightPath falls back gracefully (no fatal errors)

---

## Session ID Formats

### Numeric Reference (Recommended)

```yaml
prompts:
  - id: analyze
    prompt: "Analyze code"
    # Starts new session

  - id: implement
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
  - id: resume-work
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
  - id: step1
    prompt: "First step"

  - id: step2
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
cat .flightpath/.working/multi-session.working.yaml
```

**Expected Structure:**

```yaml
prompts:
  - id: analyze
    _runtime:
      sessionId: "abc-123" # Session 1

  - id: implement
    sessionId: 1
    _runtime:
      sessionId: "abc-123" # ✅ Same as analyze

  - id: verify
    newChatSession: true
    _runtime:
      sessionId: "xyz-789" # Session 2 (different)
```

---

## Provider-Specific Session Formats

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

1. Working file exists: `.flightpath/.working/<workflow>.working.yaml`
2. Previous prompt has `_runtime.sessionId`
3. Providers match (Copilot → Copilot, not Copilot → Claude)
4. Session ID format valid for provider

**Debug:**

```
View → Output → Select "FlightPath" channel
Look for: "Session resolved: ..." messages
```

### Cross-Provider Warnings

**Expected:** FlightPath warns when session reference crosses providers

**Behavior:** Gracefully falls back to new session (workflow continues)

**Fix:** Use same provider for session chain, or use `newChatSession: true` when switching

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
   - id: security-review
   - id: performance-review
     sessionId: 1

   # Phase 2: Implementation (new session)
   - id: implement
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
- **[CLI Design](../../docs/COPILOT_CLI_DESIGN.md)** - Provider implementation details

---

**Next Steps:**

1. Run each example workflow
2. Check working files to see session IDs
3. Try modifying examples to experiment
4. Create your own multi-session workflows

📚 **For complete documentation, see [docs/SESSION_MANAGEMENT.md](../../docs/SESSION_MANAGEMENT.md)**
