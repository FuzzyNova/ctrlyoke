# Claude CLI Findings & Recommendations

**Date:** 2025-11-30
**Context:** FlightPath automation - evaluating Claude CLI options for improved automation capabilities

---

## Executive Summary

### ❌ **Thinking Mode NOT Available**

**Critical Finding:** Claude CLI does **NOT** provide any command-line option to control thinking mode or thinking level. Thinking behavior appears to be controlled at the model level and cannot be specified per-request.

**Implication:** No changes needed to `prompt-schema.json` for thinking mode.

---

## 🎯 High-Priority Options for FlightPath

### 1. `--json-schema` ⭐ **CRITICAL**

**Priority:** **HIGHEST**

**Purpose:** Enforce structured responses from Claude for reliable parsing in automation workflows.

**Use Cases:**
- End condition validation with predictable response format
- Multi-step workflows with structured intermediate outputs
- Parsing tool usage results consistently
- Extracting specific data from responses (file paths, test results)

**Example:**
```bash
claude --print --json-schema '{"type":"object","properties":{"success":{"type":"boolean"},"errors":{"type":"array"}},"required":["success"]}'
```

**Recommended Integration:**
```json
{
  "prompt": "Run tests and report results",
  "responseSchema": {
    "type": "object",
    "properties": {
      "success": {"type": "boolean"},
      "errors": {"type": "array", "items": {"type": "string"}}
    },
    "required": ["success"]
  }
}
```

**Note:** Only works with `--print` mode (non-interactive).

---

### 2. `--permission-mode` ⭐ **HIGH**

**Priority:** **HIGH**

**Purpose:** More granular permission control than current `skipAll`/`custom` modes.

**Available Modes:**

| Mode                | Behavior                                      |
| ------------------- | --------------------------------------------- |
| `default`           | Prompt for all permissions (interactive only) |
| `acceptEdits`       | Auto-accept file edits, prompt for others     |
| `bypassPermissions` | Skip all prompts (current FlightPath default) |
| `dontAsk`           | Similar to bypass with different semantics    |
| `plan`              | Planning mode (may restrict operations)       |

**Why This Matters:**
- `acceptEdits` - Safer for workflows that only modify existing files (no shell commands)
- `plan` - For multi-step planning before execution (exploratory workflows)

**Recommended Integration:**
- Add `flightpath.claudeCliPermissionMode` setting
- Update `flightpath.claudeCliToolPermissions` enum to include new modes

---

### 3. `--fallback-model` ⭐ **MEDIUM**

**Priority:** MEDIUM

**Purpose:** Automatically fallback to specified model when primary model is overloaded.

**Example:**
```bash
claude --print --model opus --fallback-model sonnet
```

**Use Cases:**
- Start with Opus for complex tasks, fallback to Sonnet if unavailable
- Ensure workflows continue during high-demand periods
- Cost optimization (prefer cheaper model when available)

**Recommended Integration:**
```json
{
  "prompt": "Complex analysis task",
  "model": "opus",
  "fallbackModel": "sonnet"
}
```

**Note:** Only works with `--print` mode.

---

## 📋 Other Notable Options

### 4. `--print` Mode

**Current Status:** FlightPath uses stdin-based approach without `--print` flag.

**Why This Matters:** Many advanced flags **only work with `--print` mode**:
- `--json-schema`
- `--tools`
- `--fallback-model`
- `--output-format stream-json`

**Recommendation:** Consider migrating to `--print` mode for better compatibility with advanced features.

---

### 5. `--append-system-prompt`

**Priority:** MEDIUM

**Purpose:** Add workflow-specific instructions to Claude's default system prompt.

**Use Cases:**
- Workflow-specific instructions: "Always include git commands in responses"
- Domain context: "You are helping with a React TypeScript project"
- Output preferences: "Always provide code with file paths"
- Behavioral constraints: "Never suggest breaking changes"

**Recommended Integration:**
```json
{
  "prompt": "Refactor this component",
  "systemPromptAppend": "You are working on a React TypeScript project. Always include type definitions."
}
```

---

### 6. `--tools` (Tool Specification)

**Priority:** LOW

**Purpose:** Specify which built-in tools are available (instead of allow/deny patterns).

**Example:**
```bash
claude --print --tools "Bash,Edit,Read"
claude --print --tools ""  # Disable all tools
```

**Use Cases:**
- Simpler than allowedTools/disallowedTools for common scenarios
- "Read-only" mode: `--tools "Read,Glob,Grep"`
- "No shell access": `--tools "Read,Write,Edit"`

**Note:** Only works with `--print` mode. Different from `--allowedTools`.

---

### 7. `--output-format stream-json`

**Current Status:** Only `json` and `text` documented. `stream-json` exists but not implemented.

**Purpose:** Real-time streaming JSON chunks for live progress updates.

**Use Case:** Could enable real-time progress UI in FlightPath dashboard.

---

### 8. Other Options (Low Priority)

| Option                    | Purpose                                |
| ------------------------- | -------------------------------------- |
| `--fork-session`          | Branch conversation trees              |
| `--session-id <uuid>`     | Reproducible sessions for testing      |
| `--agents <json>`         | Custom agent definitions               |
| `--mcp-config`            | Custom MCP server configuration        |
| `--settings <json>`       | Load additional settings from file     |
| `-d, --debug [filter]`    | Debug mode with category filtering     |
| `--input-format`          | Stream input (for live data)           |
| `--include-partial-messages` | Partial chunks in streaming output  |

---

## 🔧 Documentation Corrections

### Fixed Errors

1. **`--max-turns` does NOT exist** - Removed from documentation (was in "not implemented" list)
2. **`--mcp-server` → `--mcp-config`** - Corrected flag name and supports multiple configs
3. **`-p` clarification** - It's `--print` (non-interactive mode), not a prompt input flag
4. **Output format** - Added `stream-json` as third option (was only showing `json` and `text`)

### Added Content

1. **Thinking Mode** - Explicitly documented as NOT AVAILABLE via CLI
2. **Print Mode Section** - Comprehensive explanation of `--print` and its implications
3. **JSON Schema Section** - Detailed use cases and integration recommendations
4. **Permission Modes Section** - All 5 modes with explanations
5. **System Prompt Section** - Both `--system-prompt` and `--append-system-prompt`
6. **Advanced Session Options** - Fork and fixed session IDs
7. **Fallback Model Section** - Auto-retry with different model

---

## 📝 Recommended Schema Changes

### Option 1: High-Priority Only (Minimal)

Add to `prompt-schema.json`:

```json
{
  "responseSchema": {
    "type": "object",
    "description": "JSON Schema for validating Claude's response structure (Claude CLI only, requires --print mode)"
  },
  "fallbackModel": {
    "type": "string",
    "description": "Fallback model if primary model is overloaded (Claude CLI only, requires --print mode)"
  }
}
```

### Option 2: Comprehensive (All Useful Options)

```json
{
  "responseSchema": {
    "type": "object",
    "description": "JSON Schema for validating Claude's response structure (Claude CLI only)"
  },
  "fallbackModel": {
    "type": "string",
    "description": "Fallback model if primary model is overloaded (Claude CLI only)"
  },
  "systemPromptAppend": {
    "type": "string",
    "description": "Additional instructions to append to system prompt (Claude CLI only)"
  },
  "permissionMode": {
    "type": "string",
    "enum": ["default", "acceptEdits", "bypassPermissions", "dontAsk", "plan"],
    "description": "Permission mode for tool execution (Claude CLI only)"
  }
}
```

---

## 🎬 Next Steps

### Immediate Actions

1. ✅ **Update CLAUDE_CLI_DESIGN.md** - Complete with all findings (DONE)
2. ⏳ **Decide on schema changes** - Which options to add to `prompt-schema.json`?
3. ⏳ **Evaluate `--print` mode migration** - Required for `--json-schema` support

### Future Considerations

1. **Structured Output** - Implement `--json-schema` support (high value for automation)
2. **Permission Modes** - Add `--permission-mode` setting (better security granularity)
3. **Model Fallback** - Implement `--fallback-model` (better reliability during high demand)
4. **System Prompt Customization** - Add `--append-system-prompt` (workflow-specific behavior)

---

## 📚 References

- **Updated Documentation:** `docs/CLAUDE_CLI_DESIGN.md`
- **Schema File:** `schemas/prompt-schema.json`
- **Implementation:** `src/flightpath/cli/ClaudeCommandLineIntegration.ts`
- **Official Docs:** https://code.claude.com/docs (redirects from docs.anthropic.com)
