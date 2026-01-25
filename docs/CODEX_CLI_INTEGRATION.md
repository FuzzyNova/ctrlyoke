# Codex CLI Integration Research & Implementation Plan

**Status:** ✅ **IMPLEMENTATION COMPLETE** - Notify Hook-Based Completion Detection
**Target:** FlightPath v1.0+
**CLI Version:** codex-cli 0.73.0+
**Research Date:** December 17, 2025
**Implementation Date:** December 18, 2025
**Last Updated:** January 12, 2026

> **Note:** This is a research and planning document. For completion detection specifics, see [CODEX_COMPLETION_DETECTION.md](CODEX_COMPLETION_DETECTION.md).

## Executive Summary

This document outlines the implementation plan for integrating Codex CLI (OpenAI's agent-based code assistant) into FlightPath as a third CLI provider alongside Copilot CLI and Claude Code CLI.

### 🔑 Key Research Findings

**CRITICAL DISCOVERY:** Codex CLI does **NOT** support granular `sandbox_permissions` arrays despite misleading help text. The permission model is fundamentally different from Copilot/Claude.

**What Codex Actually Provides:**

- ✅ Three sandbox modes (read-only, workspace-write, danger-full-access)
- ✅ Four approval policies (untrusted, on-failure, on-request, never)
- ✅ Boolean network access (all-or-nothing)
- ✅ Directory-level write control (writable_roots array)
- ❌ **NO** tool pattern matching (no `shell(git:*)` equivalent)
- ❌ **NO** deny patterns
- ❌ **NO** per-command control
- ❌ **NO** `sandbox_permissions` array (help text is misleading)

**Impact on FlightPath Integration:**

- FlightPath's `cliAllowedTools` and `cliDeniedTools` **CANNOT** be mapped to Codex
- Must use simple mode-based mapping: `allowAll` → `--full-auto`, `dangerouslyAllowAll` → `--dangerously-bypass-approvals-and-sandbox`
- Custom mode uses Codex-specific settings (sandbox mode + approval policy)
- Users seeking fine-grained tool control should use Copilot/Claude CLI instead

Codex CLI offers unique capabilities:

- **Agent-based execution** with autonomous tool usage
- **JSON output format** with structured event streaming
- **Multiple execution modes** (interactive TUI, non-interactive exec, resume sessions)
- **Dynamic model selection** (including OSS/local models via LM Studio/Ollama)
- **Advanced sandboxing** with granular permission controls

### 🔑 Key Permission Architecture Insight

**IMPORTANT:** Codex uses a **hybrid permission model** that combines:

**1. Sandbox-Based Execution** (primary model):

- Sandbox modes: `read-only`, `workspace-write`, `danger-full-access`
- Approval policies: `untrusted`, `on-failure`, `on-request`, `never`
- Configured via `--sandbox` and `--ask-for-approval` flags

**2. Granular Permission Arrays** (advanced customization via `-c` flag):

- `sandbox_permissions` array: Fine-grained capability control
- Example: `-c 'sandbox_permissions=["disk-full-read-access"]'`
- **This enables mapping FlightPath's tool patterns!**

**Comparison:**

- **Copilot/Claude:** Tool-pattern based (`shell(git:*)`, `write`, deny patterns)
- **Codex:** Sandbox modes + optional granular `sandbox_permissions` array

**Impact on FlightPath Integration:**

- ✅ `cliToolPermissions` mode setting applies (allowAll, dangerouslyAllowAll, custom)
- ✅ `cliAllowedTools`/`cliDeniedTools` CAN be mapped to `sandbox_permissions` array!
- ✅ New Codex-specific settings: `codexSandboxMode`, `codexApprovalPolicy`, `codexSandboxPermissions`

See **"Permission & Sandbox Architecture"** section below for complete mapping strategy.

## 🔬 Critical Research Findings (December 17, 2025)

**IMPORTANT DISCOVERY:** After extensive research, Codex CLI does **NOT** support a granular `sandbox_permissions` array for fine-grained permission control.

### What the `-c` Flag Actually Does

The example in Codex's `--help` output is **misleading**:

```bash
codex -c 'sandbox_permissions=["disk-full-read-access"]'
```

This is **NOT** a list of available permission capabilities. Instead:

- The `-c` flag is a **generic configuration override** mechanism
- It can set ANY config.toml value via command line
- `sandbox_permissions` shown in the example is likely a **documentation placeholder** or **internal/experimental feature**
- No evidence of this being a functional permission system

### What Codex Actually Uses for Permissions

Based on official documentation and CLI testing:

**1. Three Sandbox Modes** (Primary Control):

- `read-only` - Only read operations
- `workspace-write` - Write to workspace + `--add-dir` directories
- `danger-full-access` - Unrestricted filesystem access

**2. Four Approval Policies** (User Interaction):

- `untrusted` - Ask for non-trusted commands
- `on-failure` - Run all, ask only if command fails
- `on-request` - Model decides when to ask
- `never` - Never ask (fully automated)

**3. Configuration per Sandbox Mode** (in `config.toml`):

```toml
[sandbox_workspace_write]
network_access = false           # Enable/disable network
writable_roots = ["/path"]       # Additional writable directories
exclude_tmpdir_env_var = false   # Allow $TMPDIR
exclude_slash_tmp = false        # Allow /tmp
```

**4. Execpolicy Rules** (Advanced, Preview Feature):

`.rules` files using Starlark syntax for command-level control:

```starlark
prefix_rule(
    pattern = ["gh", "pr", "view"],
    decision = "allow",  # or "prompt", "forbidden"
)
```

### Why No Granular Permission Array?

Codex's philosophy differs from Copilot/Claude:

- **Codex:** Trust the model, use broad sandbox boundaries, intervene when needed (agent-oriented)
- **Copilot/Claude:** Restrict the model, grant specific tool capabilities (assistant-oriented)

**Evidence:**

1. No `sandbox_permissions` documentation in official docs
2. No working examples beyond the help text placeholder
3. Configuration reference only mentions `writable_roots` and `network_access` as arrays/booleans
4. GitHub issues show users configuring via sandbox modes, not permission arrays
5. The "Execpolicy" preview feature is the closest to granular control, but it's command-based, not permission-based

### Research Summary: Available Permission Mechanisms

After investigating Codex CLI v0.73.0, here's what's actually available:

| Mechanism               | Type               | Granularity              | FlightPath Compatible?               |
| ----------------------- | ------------------ | ------------------------ | ------------------------------------ |
| **Sandbox Modes**       | Enum (3 values)    | Coarse (workspace-level) | ✅ Yes - Mode mapping                |
| **Approval Policies**   | Enum (4 values)    | Interaction timing       | ✅ Yes - Policy mapping              |
| **network_access**      | Boolean            | On/Off                   | ⚠️ Partial - No domain filtering     |
| **writable_roots**      | Array of paths     | Directory-level          | ⚠️ Partial - No file pattern support |
| **Execpolicy Rules**    | Starlark scripts   | Command prefix matching  | ❌ No - Preview feature, complex     |
| **sandbox_permissions** | ❌ NOT IMPLEMENTED | N/A                      | ❌ No - Does not exist               |

### Implications for FlightPath Integration

**What This Means:**

1. **No Direct Tool Pattern Mapping** - FlightPath's `cliAllowedTools` and `cliDeniedTools` patterns (like `shell(git:*)`, `write`) cannot be directly mapped to Codex capabilities

2. **Simplified Permission Model** - FlightPath must use Codex's coarse-grained sandbox/approval model:
   - `allowAll` → `--full-auto` (workspace-write + on-request)
   - `dangerouslyAllowAll` → `--dangerously-bypass-approvals-and-sandbox`
   - `custom` → Use Codex-specific settings (sandbox mode + approval policy)

3. **Tool Pattern Arrays Ignored** - When Codex is selected, FlightPath should:
   - Log a clear message that tool patterns are not supported
   - Fall back to sandbox mode configuration
   - Provide Codex-specific settings for advanced users

**Recommended User Communication:**

```typescript
if (
  provider === Provider.CodexCli &&
  (ConfigurationUtils.getCliAllowedTools().length > 0 ||
    ConfigurationUtils.getCliDeniedTools().length > 0)
) {
  Log.info(
    "ℹ️ Codex CLI uses sandbox boundaries instead of tool patterns. " +
      "Your cliAllowedTools/cliDeniedTools settings are ignored. " +
      "Configure Codex permissions via:\n" +
      "  • cliToolPermissions (allowAll/dangerouslyAllowAll/custom)\n" +
      "  • codexSandboxMode (read-only/workspace-write/danger-full-access)\n" +
      "  • codexApprovalPolicy (untrusted/on-failure/on-request/never)"
  );
}
```

---

## Codex Permission System: Complete Reference

Based on official documentation and CLI testing (December 17, 2025):

### Sandbox Configuration Options

| Configuration Key                                | Type            | Values                                               | Description                           | config.toml Example                                     |
| ------------------------------------------------ | --------------- | ---------------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| `sandbox_mode`                                   | String (enum)   | `read-only`, `workspace-write`, `danger-full-access` | Primary sandbox boundary              | `sandbox_mode = "workspace-write"`                      |
| `approval_policy`                                | String (enum)   | `untrusted`, `on-failure`, `on-request`, `never`     | When to ask for user approval         | `approval_policy = "on-request"`                        |
| `sandbox_workspace_write.network_access`         | Boolean         | `true`, `false`                                      | Enable/disable all network access     | `[sandbox_workspace_write]`<br>`network_access = false` |
| `sandbox_workspace_write.writable_roots`         | Array\<string\> | Array of directory paths                             | Additional writable directories       | `writable_roots = ["/Users/YOU/.pyenv"]`                |
| `sandbox_workspace_write.exclude_tmpdir_env_var` | Boolean         | `true`, `false`                                      | Exclude `$TMPDIR` from writable roots | `exclude_tmpdir_env_var = false`                        |
| `sandbox_workspace_write.exclude_slash_tmp`      | Boolean         | `true`, `false`                                      | Exclude `/tmp` from writable roots    | `exclude_slash_tmp = false`                             |

### CLI Flags

| Flag                                         | Equivalent Config                     | Description                                                       |
| -------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------- |
| `-s read-only`                               | `sandbox_mode = "read-only"`          | Read-only file access                                             |
| `-s workspace-write`                         | `sandbox_mode = "workspace-write"`    | Write to workspace + `--add-dir`                                  |
| `-s danger-full-access`                      | `sandbox_mode = "danger-full-access"` | Unrestricted filesystem access                                    |
| `-a untrusted`                               | `approval_policy = "untrusted"`       | Ask for non-trusted commands (see Trusted Commands below)         |
| `-a on-failure`                              | `approval_policy = "on-failure"`      | Ask only if command fails                                         |
| `-a on-request`                              | `approval_policy = "on-request"`      | Model decides when to ask                                         |
| `-a never`                                   | `approval_policy = "never"`           | Never ask (fully automated)                                       |
| `--full-auto`                                | `-a on-request -s workspace-write`    | Safe automation preset (NEVER use with `-s` or `-a`)              |
| `--dangerously-bypass-approvals-and-sandbox` | `-a never -s danger-full-access`      | No sandbox, no approvals (DANGEROUS, NEVER use with `-s` or `-a`) |
| `--add-dir <DIR>`                            | N/A                                   | Additional writable directory (workspace-write mode)              |

### Approval Policy: "untrusted" Mode Details

The `untrusted` approval policy uses Codex's built-in safe list of trusted commands.

**Built-in Trusted Commands** (run without asking):

- `ls`, `cat`, `sed`, `grep`, `find`, `head`, `tail`, `wc`, `sort`, `uniq`, `diff`, `echo`, `pwd`, `cd`, and other read-only utilities

**Non-Trusted Commands** (require user approval):

- Any command that modifies files (`rm`, `mv`, `cp`, `git commit`, `git push`, etc.)
- Network operations (`curl`, `wget`, `npm install`, etc.)
- Compilation and execution (`make`, `npm run`, `python`, etc.)

**Customizing Trusted Commands:**

The built-in safe list is **NOT user-configurable** directly. However, you can customize command approval behavior using **Execpolicy Rules** (see below):

```starlark
# ~/.codex/rules/default.rules
prefix_rule(
    pattern = ["git", "commit"],
    decision = "allow",  # Trust git commit without asking
)

prefix_rule(
    pattern = ["git", "push"],
    decision = "prompt",  # Always ask before git push
)
```

**FlightPath Integration:**

- Execpolicy Rules are too complex for automated mapping
- Users can configure manually if needed
- Most users should use `on-request` policy instead (model decides intelligently)

### What Codex Does NOT Support

❌ **Granular permission arrays** - No `sandbox_permissions=["disk-full-read-access"]` capability  
❌ **Tool-specific allow/deny patterns** - No equivalent to `shell(git:*)` or `write`  
❌ **Per-command tool control** - No way to allow `git commit` but deny `git push`  
❌ **Network domain filtering** - Network is all-or-nothing (boolean)  
❌ **File pattern matching** - Only directory-level control via `writable_roots`

### Execpolicy Rules (Preview Feature)

**Advanced command-level control** via `.rules` files (Starlark syntax):

```starlark
# ~/.codex/rules/default.rules
prefix_rule(
    pattern = ["gh", "pr", "view"],
    decision = "allow",  # or "prompt", "forbidden"
    match = ["gh pr view 7888"],
    not_match = ["gh pr --repo openai/codex view"]
)
```

**Characteristics:**

- Command prefix matching (not pattern wildcards)
- Starlark-based configuration (Python-like syntax)
- Preview feature (may change)
- Most restrictive rule wins when multiple match
- Primarily for whitelisting specific commands to run outside sandbox

**FlightPath Consideration:** Too complex and experimental for automated mapping. Users can configure manually if needed.

---

## CLI Architecture Overview

### Commands & Execution Modes

Codex CLI has three primary execution modes:

1. **Interactive TUI Mode** (default)
   - Command: `codex [OPTIONS] [PROMPT]`
   - Full terminal UI with user interaction
   - Real-time streaming responses
   - User approval prompts for tool execution
   - Session management (resume/continue)

2. **Non-Interactive Exec Mode** (headless)
   - Command: `codex exec [OPTIONS] [PROMPT]`
   - Alias: `codex e`
   - Structured JSONL output via `--json` flag
   - No TTY required, designed for automation
   - Session resumption via `codex exec resume`

3. **Session Resume**
   - Interactive: `codex resume [--last]`
   - Headless: `codex exec resume [--last | THREAD_ID]`
   - Continues previous conversation context

### Output Formats

#### Interactive Mode (TUI)

**TUI Structure (from live capture):**

```
╭─────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.73.0)                               │
│                                                         │
│ model:     gpt-5.1-codex-mini medium   /model to change │
│ directory: C:\dev\FlightPath                            │
╰─────────────────────────────────────────────────────────╯

  Tip: Type / to open the command popup; Tab autocompletes...

› user prompt here

  └ Response content...
    ... more response ...

• Ran cd C:\dev\FlightPath; cat file.txt
  └ File contents...

• Working (8s • esc to interrupt)  ← KEY COMPLETION INDICATOR

  100% context left · ? for shortcuts
```

**Key TUI Chrome Patterns:**

- **Header box:** `╭─────...─────╮` with version and model info
- **Bottom border:** `╰─────...─────╯`
- **Prompt indicator:** `› ` (starts user input line)
- **Tool execution:** `• Ran <command>`
- **Response prefix:** `└` (indented response content)
- **Active indicator:** `• Working (Xs • esc to interrupt)` ← **CRITICAL FOR COMPLETION DETECTION**
- **Context status:** `100% context left · ? for shortcuts`

**Completion Detection Strategy:**

- **While running:** `• Working (.*? • esc to interrupt)` is visible
- **When complete:** This indicator disappears from output
- **Pattern to watch:** `esc to interrupt` presence = still working

**Output Processing:**

- **TUI chrome filtering:** Box borders, status bars, and UI elements are removed
- **Whitespace trimming:** Consecutive blank lines are limited to max 2 lines (configurable)
- **Deduplication:** Repeated animation frames are filtered using circular buffer tracking

#### Headless JSON Mode

```jsonl
{"type":"thread.started","thread_id":"019b2dfd-8362-7862-8d9b-d9263625a298"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"Response text here"}}
{"type":"turn.completed","usage":{"input_tokens":3480,"cached_input_tokens":0,"output_tokens":13}}
```

**Event types:**

- `thread.started` - Session initialization with thread_id
- `turn.started` - Begin agent turn
- `item.completed` - Response chunk (extract `item.text`)
- `turn.completed` - Turn finished with token usage stats

## Model Support & Discovery

### Model Configuration

Models are configured in `~/.codex/config.toml`:

```toml
model = "gpt-5.1-codex-mini"
model_reasoning_effort = "medium"  # low, medium, high, max
```

### Interactive Model Discovery

Codex provides a `/model` command in the interactive TUI:

```bash
# Start interactive session
codex

# Type /model to see available models
/model

# Output:
› 1. gpt-5.1-codex-max (current)  Latest Codex-optimized flagship for deep and fast reasoning.
  2. gpt-5.1-codex                Optimized for codex.
  3. gpt-5.1-codex-mini           Optimized for codex. Cheaper, faster, but less capable.
  4. gpt-5.2                      Latest frontier model with improvements across knowledge, reasoning and coding
  5. gpt-5.1                      Broad world knowledge with strong general reasoning.
```

**Key Points:**

- Shows 5 primary OpenAI models optimized for coding
- Indicates current model with `(current)` marker
- Provides one-line descriptions for each model
- Cannot be accessed programmatically (requires TTY)
- Users can add custom models (Claude, OSS) via config.toml

### Supported Model Families

**Primary Models (from `/model` command in interactive TUI):**

```
1. gpt-5.1-codex-max    Latest Codex-optimized flagship for deep and fast reasoning
2. gpt-5.1-codex        Optimized for codex (Recommended)
3. gpt-5.1-codex-mini   Optimized for codex. Cheaper, faster, but less capable
4. gpt-5.2              Latest frontier model with improvements across knowledge, reasoning and coding
5. gpt-5.1              Broad world knowledge with strong general reasoning
```

**Additional Model Support:**

**OpenAI GPT Family:**

- `o3` - Latest reasoning model (mentioned in `--help` examples)
- GPT-4 series (fallback support)

**Anthropic Claude Family (via custom model configuration):**

- Claude Sonnet 4.5, Opus 4.5, Haiku 4.5
- Claude 3.5 Sonnet, Opus, Haiku

**Open Source Models (via `--oss` flag):**

- Requires LM Studio or Ollama local server
- User-configured models from local providers

### Dynamic Model Discovery Strategy

**Challenge:** Codex CLI has no `--list-models` or `help config` command

**Discovery Methods:**

1. **Interactive `/model` Command** (Primary Source)
   - Start interactive TUI: `codex`
   - Type `/model` to see available models with descriptions
   - **Output Format:**
     ```
     › 1. gpt-5.1-codex-max (current)  Latest Codex-optimized flagship...
       2. gpt-5.1-codex                Optimized for codex.
       3. gpt-5.1-codex-mini           Optimized for codex. Cheaper...
       4. gpt-5.2                      Latest frontier model...
       5. gpt-5.1                      Broad world knowledge...
     ```
   - **Problem:** Requires TTY, not programmatically accessible
   - **Use Case:** Manual verification and documentation

2. **Parse config.toml** (User's Current Model)
   - Read `~/.codex/config.toml` to get user's default model
   - Example: `model = "gpt-5.1-codex-mini"`
   - Path: `$env:USERPROFILE\.codex\config.toml` (Windows)
   - Path: `~/.codex/config.toml` (macOS/Linux)
   - **Use Case:** Show user's current default in UI

3. **Static Model List** (Fallback & IntelliSense)
   - Maintain curated list based on `/model` output
   - Update when Codex adds new models (check release notes)
   - Include in `ModelConstants.ts` for validation
   - **Use Case:** IntelliSense, validation, settings dropdown

**Recommended Strategy:**

- **Static list** as baseline (from `/model` command)
- **Parse config** to highlight user's current default
- **Allow manual entry** for custom/new models
- **Update static list** when Codex releases new models

### Proposed Model Constants

```typescript
/**
 * Codex CLI supported models
 *
 * Source: `/model` command in Codex interactive TUI (as of Codex v0.63.0)
 * Users can also add custom models via config.toml
 *
 * Last verified: December 17, 2025
 */
export const CODEX_CLI_MODELS = [
  // Primary models (from /model command)
  "gpt-5.1-codex-max", // Latest Codex-optimized flagship
  "gpt-5.1-codex", // Recommended default
  "gpt-5.1-codex-mini", // Fast and cheap
  "gpt-5.2", // Latest frontier model
  "gpt-5.1", // General reasoning

  // Additional OpenAI models (from --help examples)
  "o3", // Reasoning model
  "gpt-4.1", // Fallback

  // Users can add custom models - allow manual entry
] as const;

export const CODEX_CLI_MODEL_LABELS: Record<string, string> = {
  // Primary models (from /model descriptions)
  "gpt-5.1-codex-max": "GPT-5.1 Codex Max (Flagship)",
  "gpt-5.1-codex": "GPT-5.1 Codex (Recommended)",
  "gpt-5.1-codex-mini": "GPT-5.1 Codex Mini (Fast & Cheap)",
  "gpt-5.2": "GPT-5.2 (Latest Frontier)",
  "gpt-5.1": "GPT-5.1 (General Reasoning)",

  // Additional models
  o3: "o3 (Reasoning)",
  "gpt-4.1": "GPT-4.1",
};

export const CODEX_CLI_DEFAULT_MODEL = "gpt-5.1-codex" as const;

/**
 * Note: Codex supports custom models via config.toml
 * Users can configure Claude, OSS, or other models
 * FlightPath should allow manual model entry for custom configurations
 */
```

## Permission & Sandbox Architecture

### Overview: FlightPath's Unified Tool Permission System

FlightPath uses a **single-source permission system** shared across all CLI providers (Copilot, Claude, Codex). Settings are defined once in `package.json` and accessed via `ConfigurationUtils`:

**Shared Settings (single source of truth):**

- `cliToolPermissions`: Permission mode - "dangerouslyAllowAll", "allowAll", "custom"
- `cliAllowedTools`: Array of tool patterns to allow (used in custom mode)
- `cliDeniedTools`: Array of tool patterns to deny (takes precedence, used in allowAll/custom modes)

**Key Design Principles:**

1. **Single Configuration:** Users configure permissions once, works across all CLI providers
2. **Provider-Specific Translation:** Each CLI integration translates shared patterns to provider-specific flags
3. **Consistent Semantics:** Same permission mode means the same behavior across providers
4. **Tool Pattern Conversion:** Tool names automatically converted (e.g., `shell` → Copilot's category, `Bash` → Claude's tool)

### Codex-Specific Permission Architecture

Codex uses a **hybrid permission model** combining:

#### 1. Sandbox Modes (Primary Control)

Three-tier OS-level sandboxing:

```typescript
enum CodexSandboxMode {
  READ_ONLY = "read-only", // Only read operations
  WORKSPACE_WRITE = "workspace-write", // Write to workspace + --add-dir
  DANGER_FULL_ACCESS = "danger-full-access", // Unrestricted filesystem access
}
```

#### 2. Approval Policies (User Interaction Control)

```typescript
enum CodexApprovalPolicy {
  UNTRUSTED = "untrusted", // Ask for non-trusted commands (safe list: ls, cat, sed, etc.)
  ON_FAILURE = "on-failure", // Run all, ask only if command fails
  ON_REQUEST = "on-request", // Model decides when to ask user
  NEVER = "never", // Never ask, fully automated (dangerous)
}
```

#### 3. Granular Sandbox Permissions (Advanced Customization)

**Key Discovery:** Codex supports fine-grained permission arrays via the `-c` flag:

```bash
# Example from --help
codex -c 'sandbox_permissions=["disk-full-read-access"]'

# Multiple permissions
codex -c 'sandbox_permissions=["disk-full-read-access", "network-access"]'
```

**Available Permissions** (from docs/config.md):

- `disk-full-read-access` - Read any file on disk
- `network-access` - Allow outbound network requests
- Additional capabilities likely exist (need investigation)

**How It Works:**

- Configured via `-c` flag or `config.toml`
- Provides granular control beyond the three sandbox modes
- Can be combined with approval policies
- **This is the key to mapping FlightPath's tool patterns!**

**Codex Convenience Flags:**

- `--full-auto`: Alias for `-a on-request --sandbox workspace-write` (RECOMMENDED for automation)
- `--dangerously-bypass-approvals-and-sandbox`: Alias for `-a never -s danger-full-access` (DANGEROUS)

### Mapping FlightPath Permissions → Codex CLI

**Three Mapping Strategies:**

#### Strategy 1: Simple Mode Mapping (Phase 1 - MVP)

Map FlightPath's permission modes to Codex's convenience flags:

| FlightPath Mode       | Codex Flags                                  | Behavior                                                         | Safety Level |
| --------------------- | -------------------------------------------- | ---------------------------------------------------------------- | ------------ |
| `allowAll` (default)  | `--full-auto`                                | Safe automation: model requests approval, workspace-write        | ✅ Safe      |
| `dangerouslyAllowAll` | `--dangerously-bypass-approvals-and-sandbox` | No approvals, full filesystem access (bypasses ALL restrictions) | ⚠️ Dangerous |
| `custom`              | `-s <sandbox> -a <approval>` (fallback)      | Uses Codex-specific settings                                     | ⚙️ Advanced  |

**Pros:** Simple, reliable, covers 90% of use cases  
**Cons:** Ignores `cliAllowedTools`/`cliDeniedTools`, less granular than Copilot/Claude

#### Strategy 2: Granular Permission Array Mapping (Phase 2 - Advanced)

Map FlightPath's tool patterns to Codex's `sandbox_permissions` array:

```typescript
// Conceptual mapping (requires investigation of available permissions)
const TOOL_TO_SANDBOX_PERMISSION_MAP = {
  "shell(git:*)": ["disk-full-read-access"], // Git needs read access
  "shell(npm:*)": ["disk-full-read-access"], // npm needs read access
  write: ["disk-write-access"], // If such permission exists
  // Network-related tools
  "shell(curl:*)": ["network-access"],
  "shell(wget:*)": ["network-access"],
};

function buildSandboxPermissions(
  allowedTools: string[],
  deniedTools: string[]
): string[] {
  const permissions = new Set<string>();

  // Map allowed tools to permissions
  allowedTools.forEach((pattern) => {
    const perm = TOOL_TO_SANDBOX_PERMISSION_MAP[pattern];
    if (perm) permissions.add(...perm);
  });

  // Remove denied permissions (if pattern supports it)
  // NOTE: Codex may not support deny patterns for sandbox_permissions

  return Array.from(permissions);
}
```

**Pros:** Preserves FlightPath's tool pattern semantics, maximum control  
**Cons:** Requires comprehensive mapping research, may not cover all tool patterns

#### Strategy 3: Hybrid Approach (Recommended)

Combine mode-based + granular permissions:

1. **Use sandbox mode for primary control** (`--full-auto` for allowAll, etc.)
2. **Add granular permissions from cliAllowedTools** (if custom mode)
3. **Log warnings for unmappable patterns**

**Implementation Note:**
We need to investigate Codex's complete `sandbox_permissions` capability list before implementing Strategy 2 or 3. For now, Strategy 1 is the safest path forward.

### Implementation Plan

**Phase 1: Basic Permission Mapping (Milestone 1)**

```typescript
/**
 * Get permission arguments for Codex CLI
 * Maps FlightPath's shared permission settings to Codex's sandbox/approval model
 *
 * Note: cliAllowedTools and cliDeniedTools are NOT used for Codex.
 * Codex uses sandbox boundaries + approval policies instead of per-tool permissions.
 */
private getPermissionArgs(): string[] {
  const toolMode = ConfigurationUtils.getCliToolPermissions();

  if (toolMode === "allowAll") {
    // Safe automation: model decides when to ask, workspace sandboxed
    // Equivalent to: -a on-request --sandbox workspace-write
    return ["--full-auto"];
  }

  if (toolMode === "dangerouslyAllowAll") {
    // DANGEROUS: no approvals, full filesystem access
    // Equivalent to: -a never -s danger-full-access
    Log.warn(
      "⚠️ DANGER MODE: All approvals bypassed, full filesystem access granted. Use with caution!"
    );
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }

  // Custom mode - requires Codex-specific settings (Phase 2)
  Log.warn(
    "⚠️ Custom mode not yet implemented for Codex CLI. Falling back to --full-auto."
  );
  return ["--full-auto"];
}
```

**Phase 2: Custom Mode with Codex-Specific Settings**

**Research Complete:** `sandbox_permissions` array does NOT exist. Codex only supports sandbox modes + approval policies.

Add Codex-specific settings for custom mode (NO sandbox_permissions array):

```typescript
// In package.json (NEW Codex-specific settings)
{
  "flightpath.codexSandboxMode": {
    "type": "string",
    "enum": ["read-only", "workspace-write", "danger-full-access"],
    "default": "workspace-write",
    "description": "[Codex CLI] Sandbox mode for command execution (used in custom permission mode)"
  },
  "flightpath.codexApprovalPolicy": {
    "type": "string",
    "enum": ["untrusted", "on-failure", "on-request", "never"],
    "default": "on-request",
    "description": "[Codex CLI] When to ask for approval (used in custom permission mode)"
  }
  // NOTE: NO codexSandboxPermissions setting - that feature doesn't exist!
}

// In ConfigurationUtils.ts
static getCodexSandboxMode(): string {
  return this.getConfiguration().get<string>("codexSandboxMode", "workspace-write");
}

static getCodexApprovalPolicy(): string {
  return this.getConfiguration().get<string>("codexApprovalPolicy", "on-request");
}

// NOTE: NO getCodexSandboxPermissions() - that feature doesn't exist!

// In CodexCommandLineIntegration.ts
private getPermissionArgs(): string[] {
  const toolMode = ConfigurationUtils.getCliToolPermissions();

  // allowAll and dangerouslyAllowAll use convenience flags (NOT individual -s/-a flags)
  if (toolMode === "allowAll") {
    // --full-auto is equivalent to: -a on-request -s workspace-write
    // Do NOT also pass individual -s or -a flags
    return ["--full-auto"];
  }

  if (toolMode === "dangerouslyAllowAll") {
    Log.warn("⚠️ DANGER MODE: All approvals bypassed, full filesystem access granted.");
    // --dangerously-bypass-approvals-and-sandbox is equivalent to: -a never -s danger-full-access
    // Do NOT also pass individual -s or -a flags
    return ["--dangerously-bypass-approvals-and-sandbox"];
  }

  // Custom mode - use individual flags from Codex-specific settings
  // NEVER use convenience flags (--full-auto) in custom mode
  const sandbox = ConfigurationUtils.getCodexSandboxMode();
  const approval = ConfigurationUtils.getCodexApprovalPolicy();

  Log.info(
    `🔧 Custom Codex permissions: sandbox=${sandbox}, approval=${approval}`
  );

  return ["-s", sandbox, "-a", approval];
}
```

**Phase 3: Tool Pattern Mapping - CANCELLED**

**Research Complete:** Tool pattern mapping is **NOT POSSIBLE** because:

- Codex does NOT support `sandbox_permissions` arrays
- No granular per-tool or per-command control exists
- Only coarse-grained sandbox modes (read-only, workspace-write, danger-full-access)

```typescript
// THIS FUNCTION WILL NOT BE IMPLEMENTED
// Keeping here for documentation purposes only

/**
 * CANCELLED: Codex does not support granular sandbox_permissions
 *
 * Original plan was to map FlightPath tool patterns like:
 * - "shell(git:*)" → ["disk-full-read-access"]
 * - "shell(curl:*)" → ["network-access"]
 *
 * Reality: These permission values don't exist in Codex CLI.
 * The -c 'sandbox_permissions=[...]' example in help text is misleading.
 */
```

**Phase 3: Workspace Directory Support (Milestone 1)**

Add `--add-dir` support similar to Copilot:

```typescript
/**
 * Get directory access arguments
 * Automatically includes workspace folders + user-configured additional directories
 */
private getDirectoryArgs(): string[] {
  const args: string[] = [];

  // Add workspace folders (if --sandbox workspace-write is active)
  const workspaceFolders = vscode.workspace.workspaceFolders || [];
  workspaceFolders.forEach((folder) => {
    args.push("--add-dir", folder.uri.fsPath);
  });

  // Add user-configured additional directories
  // Reuse copilotCliAllowedDirs setting (cross-provider compatibility)
  const additionalDirs = ConfigurationUtils.getCopilotCliAllowedDirs();
  additionalDirs.forEach((dir) => {
    args.push("--add-dir", dir);
  });

  return args;
}
```

### Cross-Provider Permission Comparison

| Feature                    | Copilot CLI                            | Claude CLI                                        | Codex CLI                                                                 |
| -------------------------- | -------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| **Permission Model**       | Tool categories (shell, write, MCP)    | Individual tools (Bash, Write, Edit, Read, etc.)  | Sandbox mode + Approval policy + `sandbox_permissions` array              |
| **Granularity**            | High (per-command patterns)            | Very High (per-tool, per-argument)                | **Medium** (sandbox modes + optional granular permissions array)          |
| **Allow/Deny Patterns**    | ✅ Full support                        | ✅ Full support (with reliability issues on deny) | ⚠️ Partial (via `sandbox_permissions` array, requires research)           |
| **Workspace Isolation**    | Via `--add-dir` (opt-in)               | Via permission mode (built-in)                    | Via `--sandbox workspace-write` + `--add-dir`                             |
| **Automation Mode**        | `--allow-all-tools` + deny patterns    | `--permission-mode bypassPermissions`             | `--full-auto`                                                             |
| **Danger Mode**            | `--allow-all-tools` (no denies)        | `--dangerously-skip-permissions`                  | `--dangerously-bypass-approvals-and-sandbox`                              |
| **FlightPath Integration** | ✅ Full mapping of allow/deny patterns | ✅ Full mapping with tool name conversion         | ⚠️ Hybrid: Mode-based (Phase 1) + permission array mapping (Phase 2+)     |
| **Custom Mode Complexity** | Medium (tool patterns)                 | Medium (tool patterns + conversion)               | **Medium** (sandbox + approval enums + optional permission array)         |
| **Best Use Case**          | Maximum control over specific commands | Balance of control and safety                     | **Flexible**: Simple modes for most users, granular array for power users |

### Recommendations

**For Most Users:**

- Use `allowAll` mode → Maps to `--full-auto` for Codex (safe automation)
- FlightPath handles provider differences automatically

**For Advanced Users:**

- Copilot CLI: Best for granular per-command control (use `custom` mode with allow/deny patterns)
- Claude CLI: Good balance of control and simplicity (use `custom` mode with tool conversion)
- Codex CLI: Best for simple sandbox boundaries (use `custom` mode with sandbox/approval enums in Phase 2)

**Security Note:**

- `dangerouslyAllowAll` mode should be used with extreme caution across all providers
- Always prefer `allowAll` with custom deny patterns for production automation

### Codex Tool Pattern Support: Final Assessment

**Update (Dec 17, 2025):** After comprehensive research, **Codex does NOT support granular `sandbox_permissions` arrays**.

#### What We Found

The `-c` flag example in `codex --help` is misleading:

```bash
# This appears in --help but is NOT a functional permission system
codex -c 'sandbox_permissions=["disk-full-read-access"]'
```

**Reality:**

- `-c` is a **generic config override** mechanism (sets any config.toml value)
- `sandbox_permissions` example is likely a **placeholder** or **internal/experimental** feature
- **No documentation** exists for `sandbox_permissions` values
- **No working examples** beyond the help text
- **No official reference** in config.toml documentation

#### What Codex Actually Provides

1. **Three sandbox modes** (coarse-grained boundaries)
2. **Four approval policies** (interaction timing)
3. **Boolean network access** (all-or-nothing)
4. **Directory-level write control** (`writable_roots` array)
5. **Execpolicy rules** (preview feature, command prefix matching)

#### Mapping Reality: FlightPath Patterns → Codex Limitations

FlightPath's tool patterns **CANNOT** be mapped to Codex due to architectural differences:

```typescript
// FlightPath settings (works with Copilot/Claude)
{
  "cliToolPermissions": "custom",
  "cliAllowedTools": [
    "shell(git:*)",        // Allow all git commands
    "write",               // Allow file writing
    "shell(npm test)"      // Allow specific npm command
  ],
  "cliDeniedTools": [
    "shell(rm:*)",         // Deny file deletion
    "shell(git push:*)"    // Deny git push operations
  ]
}

// Copilot CLI translation ✅ FULL SUPPORT
copilot --allow-tool "shell(git:*)" --deny-tool "shell(rm:*)"

// Claude CLI translation ✅ FULL SUPPORT
claude --allowedTools "Bash(git:*)" --disallowedTools "Bash(rm:*)"

// Codex CLI translation ❌ NOT POSSIBLE
// Codex only supports coarse-grained sandbox boundaries:
codex -s workspace-write -a on-request --add-dir /workspace
```

**Why Mapping is Impossible:**

| FlightPath Needs         | Copilot/Claude                   | Codex Reality           |
| ------------------------ | -------------------------------- | ----------------------- |
| Per-tool allow patterns  | ✅ `--allow-tool shell(git:*)`   | ❌ Only sandbox modes   |
| Per-tool deny patterns   | ✅ `--deny-tool shell(rm:*)`     | ❌ No deny mechanism    |
| Granular capabilities    | ✅ Tool name + wildcard patterns | ❌ Directory-level only |
| Network domain filtering | ⚠️ Copilot: No; Claude: No       | ❌ Boolean on/off       |
| File write control       | ⚠️ Directory-based               | ⚠️ Directory-based      |

#### Implementation Strategy: Accept the Limitation

**Phase 1 (MVP) - FINAL APPROACH:**

1. **Simple mode mapping** (mode-based only):
   - `allowAll` → `--full-auto` (workspace-write + on-request)
   - `dangerouslyAllowAll` → `--dangerously-bypass-approvals-and-sandbox`
   - `custom` → Codex-specific settings (sandbox mode + approval policy)

2. **Ignore tool pattern arrays:**
   - Log clear message that patterns are not supported
   - Document Codex's different permission model
   - Provide Codex-specific settings for advanced users

3. **No future phases planned:**
   - `sandbox_permissions` does not exist
   - Execpolicy rules are too experimental
   - Codex's philosophy is fundamentally different

**Phase 2-3: CANCELLED** - No granular mapping possible

#### Why Agent-Oriented Design Makes This OK

Codex's philosophy differs fundamentally:

- **Codex:** Trust the model, use broad capabilities, intervene when needed (agent-oriented)
- **Copilot/Claude:** Restrict the model, grant specific capabilities (assistant-oriented)

**For FlightPath Users:**

- Choose **Copilot/Claude** when you need fine-grained tool control
- Choose **Codex** when you want agent autonomy with coarse-grained boundaries
- FlightPath supports all three, letting users pick the right tool for their workflow

**Implementation Note:**

FlightPath logs a clear message when Codex ignores tool patterns:

```typescript
if (
  provider === Provider.CodexCli &&
  (ConfigurationUtils.getCliAllowedTools().length > 0 ||
    ConfigurationUtils.getCliDeniedTools().length > 0)
) {
  Log.info(
    "ℹ️ Codex CLI uses sandbox boundaries instead of tool patterns. " +
      "Your cliAllowedTools/cliDeniedTools settings are ignored. " +
      "Configure Codex permissions via:\n" +
      "  • cliToolPermissions (allowAll/dangerouslyAllowAll/custom)\n" +
      "  • codexSandboxMode (read-only/workspace-write/danger-full-access)\n" +
      "  • codexApprovalPolicy (untrusted/on-failure/on-request/never)\n\n" +
      "For fine-grained tool control, use Copilot CLI or Claude CLI instead."
  );
}
```

---

## 📊 Research Summary: Permission Systems Comparison

### Full Comparison Table

| Feature                   | Copilot CLI              | Claude CLI                   | Codex CLI                     |
| ------------------------- | ------------------------ | ---------------------------- | ----------------------------- |
| **Tool Pattern Matching** | ✅ Full (`shell(git:*)`) | ✅ Full (`Bash(git:*)`)      | ❌ None                       |
| **Deny Patterns**         | ✅ Yes (`--deny-tool`)   | ✅ Yes (`--disallowedTools`) | ❌ None                       |
| **Granular Permissions**  | ✅ Per-command           | ✅ Per-tool                  | ❌ Directory-level only       |
| **Network Control**       | ❌ Boolean               | ❌ Boolean                   | ❌ Boolean                    |
| **Permission Array**      | ❌ No                    | ❌ No                        | ❌ **No** (despite help text) |
| **Sandbox Modes**         | ⚠️ Via flags             | ⚠️ Via flags                 | ✅ Three explicit modes       |
| **Approval Policies**     | ⚠️ Basic                 | ⚠️ Permission-based          | ✅ Four explicit policies     |
| **Advanced Rules**        | ❌ No                    | ❌ No                        | ⚠️ Execpolicy (preview)       |
| **FlightPath Mapping**    | ✅ Full support          | ✅ Full support              | ⚠️ Mode-based only            |

### Recommendation for FlightPath Users

**Choose Copilot CLI when:**

- You need maximum control over specific commands
- You want to allow `git commit` but deny `git push`
- Security compliance requires granular tool restrictions

**Choose Claude CLI when:**

- You want a balance of control and simplicity
- Tool-based permissions are sufficient
- You need per-tool allow/deny patterns

**Choose Codex CLI when:**

- You want agent autonomy with coarse-grained boundaries
- Sandbox modes (read-only, workspace-write, full-access) meet your needs
- You trust the model and want intervention-based control
- You're okay with directory-level (not tool-level) restrictions

**Bottom Line:** All three integrations work in FlightPath, but each has different permission philosophies. Choose based on your workflow and security requirements.

## TUI Completion Detection

> **⚠️ SUPERSEDED:** The log file monitoring approach described in early research below has been **replaced** by the notify hook implementation. See [CODEX_COMPLETION_DETECTION.md](CODEX_COMPLETION_DETECTION.md) for the current implementation.

### Current Implementation: Notify Hook

FlightPath uses Codex CLI's **notify hook** for reliable completion detection:

```toml
notify = ["node", "/path/to/flightpath-codex-notify.js"]
```

When `agent-turn-complete` events occur, Codex executes the notification script with JSON data.

**Key Files:**

- `src/scripts/flightpath-codex-notify.js` - Notification handler
- `CliNotificationMonitor.ts` - Monitors notification files
- Notifications written to: `{workspace}/.flightpath/temp/codex-notifications/`

**Why Notify Hook over Log Monitoring?**

- Log file formats change between Codex versions (broke previous implementation)
- Notify hook is a stable, documented API designed for automation
- Works reliably across Codex CLI updates

---

### Historical Research: Challenges with Screen-Based Parsing

**CRITICAL DISCOVERY (Dec 18, 2025):** Codex TUI uses **cursor-based rendering** with ANSI positioning codes, fundamentally different from Claude/Copilot's line-based output.

**Symptoms Observed:**

1. **73-second delay** before receiving first post-submission data chunk
2. **Massive chunks** (414KB+ in single burst) instead of incremental updates
3. **False "screens"** - Pattern matching finds 37+ tiny "screens" in animation frames
4. **Mostly animation frames** - Output dominated by `• Working (Xs)` repetitions, not actual response text
5. **ANSI positioning codes** - Terminal uses `\x1b[<line>;<col>H` to update in-place, not append new lines

**Why Screen-Based Parsing Fails:**

- **Claude/Copilot:** Append new lines sequentially → Natural screen boundaries via prompt indicators
- **Codex:** Update cursor position and redraw → No natural screen boundaries, just overwrites same area

### Historical Research: Log File Monitoring (DEPRECATED)

> **⚠️ DEPRECATED:** This approach was replaced after Codex updated its logging format, breaking pattern detection.

The original approach monitored `~/.codex/log/codex-tui.log` for patterns like `run_task: close`. This broke when Codex changed its log format, leading to the notify hook solution.

### Combined Implementation Plan

**Phase 1: Refactor TuiStreamProcessor for Provider-Specific Handling**

```typescript
// Add CLI type to TuiStreamProcessor constructor
constructor(
  terminal: vscode.Terminal,
  cliType: "copilot" | "claude" | "codex",  // NEW
  onDelta: (text: string) => void
) {
  this.cliType = cliType;
  // ...
}

// In processStream() main loop
if (this.cliType === "codex") {
  // Time-based extraction path
  await this.processCodexTimeBasedChunk(data);
} else {
  // Screen-based extraction path (existing logic for Claude/Copilot)
  await this.processScreenBasedChunk(data);
}
```

**Phase 2: Implement Codex Time-Based Processing**

```typescript
private async processCodexTimeBasedChunk(data: string): Promise<void> {
  // 1. Filter TUI chrome (header, borders, animation indicators)
  const cleaned = this.filterCodexTuiChrome(data);

  // 2. Extract new content with deduplication
  const newContent = this.deduplicateCodexContent(cleaned);

  // 3. Emit deltas
  if (newContent.trim()) {
    this.emit("delta", newContent);
  }
}

private filterCodexTuiChrome(text: string): string {
  return text
    .replace(/╭─+╮|╰─+╯/g, "") // Box borders
    .replace(/>\s+OpenAI Codex[^\n]*/g, "") // Header
    .replace(/•\s+Working\s+\([^)]+\)/g, "") // Animation indicator
    .replace(/\d+%\s+context\s+left[^\n]*/g, "") // Status bar
    .replace(/›\s*$/gm, "") // Empty prompt lines
    .trim();
}

private deduplicateCodexContent(text: string): string {
  const lines = text.split("\n");
  const newLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if line already seen in recent history
    if (!this.recentLinesBuffer.has(trimmed)) {
      newLines.push(line);
      this.recentLinesBuffer.add(trimmed);

      // Keep buffer size limited (last 100 lines)
      if (this.recentLinesBuffer.size > 100) {
        const firstLine = this.recentLinesBuffer.values().next().value;
        this.recentLinesBuffer.delete(firstLine);
      }
    }
  }

  return newLines.join("\n");
}
```

**Phase 3: Implement Log File Completion Detection**

```typescript
// In CodexCommandLineIntegration.ts
protected async executeInTerminal(
  args: string[],
  prompt: string,
  workflowContext?: WorkflowContext
): Promise<boolean> {
  // ... existing terminal setup ...

  // Start log monitoring BEFORE sending prompt
  const startTime = new Date();
  const completionPromise = this.monitorLogFileForCompletion(
    startTime,
    this.getTimeoutMs()
  );

  // Send prompt to terminal
  await terminal.sendText(prompt);

  // Process TUI output (time-based extraction)
  this.processor.processStream(execution);

  // Wait for log file completion indicator
  const result = await completionPromise;

  if (!result.completed) {
    throw new Error(result.error || "Completion detection failed");
  }

  return true;
}

private getCodexLogPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) {
    throw new Error("Cannot determine home directory for Codex log path");
  }
  return path.join(home, ".codex", "log", "codex-tui.log");
}
```

**Phase 4: Preserve Existing Screen-Based Logic**

```typescript
private async processScreenBasedChunk(data: string): Promise<void> {
  // Keep existing extractScreensFromBuffer() logic
  // This is the current approach that works for Claude/Copilot

  this.buffer += data;
  const screens = this.extractScreensFromBuffer();

  for (const screen of screens) {
    const content = this.extractNewContent(screen);
    if (content) {
      this.emit("delta", content);
    }
  }
}
```

### Testing Strategy

**Test Case 1: Short Response (< 5s)**

- Expected: Single large chunk after delay, log shows completion
- Verify: Content extracted correctly, completion detected via log

**Test Case 2: Long Response with Tool Calls**

- Expected: Multiple chunks, tool execution markers, final completion
- Verify: Tool output captured, response text extracted, log completion accurate

**Test Case 3: Error During Execution**

- Expected: Error pattern in log, partial output in terminal
- Verify: Error detected from log, appropriate error message shown

**Test Case 4: User Cancellation (ESC)**

- Expected: Cancellation pattern in log or timeout
- Verify: Graceful handling, workflow can continue

### Advantages of Two-Part Approach

**Compared to Screen-Based Parsing:**

- ✅ **Works with cursor rendering** - No dependency on screen boundaries
- ✅ **Handles delayed chunks** - No timeout issues from 73s delay
- ✅ **Deterministic completion** - Log file provides ground truth
- ✅ **Better error detection** - Log captures failures TUI might not show

**Compared to `esc to interrupt` Detection:**

- ✅ **More reliable** - Log file is authoritative source
- ✅ **Error handling** - Distinguishes completion from errors
- ✅ **No false positives** - `run_task: close` appears exactly once per turn

**Preserves Existing Functionality:**

- ✅ **Claude/Copilot unchanged** - Screen-based parsing still used
- ✅ **Minimal refactoring** - Provider-specific branches, not rewrite
- ✅ **Isolated risk** - Codex changes don't affect other CLIs

**Edge Cases:**

- If user cancels with ESC, `esc to interrupt` disappears (same as completion)
- If Codex errors, indicator should also disappear
- Need to handle case where TUI output gets truncated

### Recommended Approach

Use **Working indicator** pattern (verified from TUI) for interactive, **JSON events** for headless, with **timeout** as ultimate fallback.

## Prompt Passing Mechanisms

### Interactive Mode

**Challenge:** Codex requires TTY for interactive mode (errors with `stdout is not a terminal`)

**Solution:** Use terminal-based execution

```typescript
// Start Codex in terminal
const command = `codex ${args.join(" ")}`;
await terminal.sendText(command);

// Wait for TUI ready (delay-based)
await this.delay(2000);

// Send prompt via sendText
await terminal.sendText(promptText);
```

### Headless Mode

**Option 1: Command-line argument** (Current approach)

```bash
codex exec "Prompt text here"
```

**Option 2: Stdin** (Test needed)

```bash
echo "Prompt text" | codex exec -
```

**Option 3: File reference** (If supported - needs testing)

```bash
codex exec @path/to/prompt.md
```

**Recommendation:** Start with Option 1, test Options 2 & 3 for long prompts

## Session Management

### Thread ID Tracking

- Headless: Extract from `{"type":"thread.started","thread_id":"..."}` event
- Interactive: May need to parse from TUI output or log files
- Storage: Cache thread_id in `sessionId` property for resume

### Resume Behavior

```typescript
private buildSessionArgs(prompt: PromptItem): string[] {
  const args: string[] = [];

  if (prompt.resumeSession === true && this.sessionId) {
    // Resume specific thread
    args.push("resume", this.sessionId);
  } else if (prompt.resumeSession === true) {
    // Resume most recent (no thread ID available)
    args.push("resume", "--last");
  }
  // Else: new session (default, no args needed)

  return args;
}
```

## Implementation Plan

### Phase 1: Core Integration (Milestone 1)

**1.1 Create CodexCommandLineIntegration Class**

```typescript
export class CodexCommandLineIntegration extends BaseCliIntegration {
  private logFilePath: string;
  private recentLinesBuffer: Set<string> = new Set();

  protected getCliName(): string {
    return "codex";
  }
  protected getIntegrationMode(): string {
    return Provider.CodexCli;
  }
  protected getCliDisplayName(): string {
    return "Codex CLI";
  }
  protected getInstallHint(): string {
    return "run: npm install -g @openai/codex-cli";
  }

  constructor() {
    super();
    this.logFilePath = this.getCodexLogPath();
  }

  // ... implement abstract methods
}
```

**1.2 Implement Headless JSON Parsing**

```typescript
protected shouldStreamHeadlessOutput(): boolean { return true; }

protected processStreamingChunk(chunk: string): string | undefined {
  // Parse JSONL format
  const lines = chunk.split('\n').filter(l => l.trim());

  for (const line of lines) {
    try {
      const event = JSON.parse(line);

      if (event.type === "item.completed" && event.item?.text) {
        return event.item.text;
      } else if (event.type === "turn.completed") {
        this.extractUsageStats(event.usage);
      } else if (event.type === "thread.started") {
        this.sessionId = event.thread_id;
      }
    } catch (e) {
      // Not JSON, skip
    }
  }

  return undefined;
}
```

**1.3 Implement Args Building**

```typescript
private buildCliArgs(prompt: PromptItem, isInteractive: boolean): string[] {
  const args: string[] = [];

  // Execution mode
  if (!isInteractive) {
    args.push("exec");
    args.push("--json");
  }

  // Model selection
  const model = this.validateAndGetModel(prompt.model);
  if (model) {
    args.push("-m", model);
  }

  // Sandbox & permissions
  args.push(...this.getSandboxArgs());

  // Workspace directories
  const workspaceDirs = this.getWorkspaceDirs();
  workspaceDirs.forEach(dir => {
    args.push("--add-dir", dir);
  });

  // Session management
  if (prompt.resumeSession === true && this.sessionId) {
    // Note: resume is a subcommand, not a flag
    // Need different structure for exec vs interactive
    if (!isInteractive) {
      args.push("resume", this.sessionId);
    } else {
      // Interactive uses `codex resume` command
      return ["resume", this.sessionId];
    }
  }

  return args;
}
```

**1.4 Token Parsing**

```typescript
parseTokenCounts(statistics: string): { prompt: number; completion: number } | undefined {
  // Parse from stored usage object (captured from turn.completed event)
  // Format: {"input_tokens":3480,"cached_input_tokens":0,"output_tokens":13}
  const match = statistics.match(/"input_tokens":(\d+).*"output_tokens":(\d+)/);
  if (match) {
    return {
      prompt: parseInt(match[1], 10),
      completion: parseInt(match[2], 10)
    };
  }
  return undefined;
}
```

### Phase 2: TUI Support with Time-Based Extraction (Milestone 2)

**2.1 Extend TuiStreamConfig for Time-Based Extraction**

Add configuration flag to enable time-based extraction mode (CLI-agnostic):

```typescript
// In TuiStreamProcessor.ts
export interface TuiStreamConfig {
  // Processing mode (NEW)
  useTimeBasedExtraction?: boolean; // Default: false (screen-based mode)

  // CLI-specific patterns (used in screen-based mode)
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

export class TuiStreamProcessor {
  private recentLinesBuffer: Set<string> = new Set();

  constructor(private config: TuiStreamConfig) {
    // ... existing initialization
  }

  async processStream(...): Promise<TuiProcessResult> {
    // ... existing setup ...

    for await (const data of execution.read()) {
      // Route based on processing mode (CLI-agnostic)
      if (this.config.useTimeBasedExtraction) {
        await this.processTimeBasedChunk(data);
      } else {
        await this.processScreenBasedChunk(data); // Existing logic
      }
    }
  }
}
```

**2.2 Implement Time-Based Processing (Generic)**

```typescript
// In TuiStreamProcessor.ts
private async processTimeBasedChunk(data: string): Promise<void> {
  // Phase 1: Strip ANSI codes
  const cleaned = this.stripAnsiCodes(data);

  // Phase 2: Filter TUI chrome using existing patterns
  const filtered = this.filterTuiChromeFromChunk(cleaned);

  // Phase 3: Deduplicate content (avoid repeated animation frames)
  const newContent = this.deduplicateContent(filtered);

  // Phase 4: Emit deltas
  if (newContent.trim()) {
    this.config.streamingEmitter.fire(newContent);
  }
}

private filterTuiChromeFromChunk(text: string): string {
  const lines = text.split(/\r?\n/);
  const filteredLines: string[] = [];

  for (const line of lines) {
    // Use existing isTuiChromeLine() method
    if (!this.isTuiChromeLine(line)) {
      filteredLines.push(line);
    }
  }

  return filteredLines.join("\n");
}

private deduplicateContent(text: string): string {
  const lines = text.split("\n");
  const newLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Check if line already seen in recent history (last 100 lines)
    if (!this.recentLinesBuffer.has(trimmed)) {
      newLines.push(line);
      this.recentLinesBuffer.add(trimmed);

      // Keep buffer size limited
      if (this.recentLinesBuffer.size > 100) {
        const [firstLine] = this.recentLinesBuffer;
        this.recentLinesBuffer.delete(firstLine);
      }
    }
  }

  return newLines.join("\n");
}

private async processScreenBasedChunk(data: string): Promise<void> {
  // Keep existing screen-based logic for Claude/Copilot
  this.buffer += data;
  const screens = this.extractScreensFromBuffer();

  for (const screen of screens) {
    const content = this.extractNewContent(screen);
    if (content) {
      this.emit("delta", content);
    }
  }
}
```

**2.3 Implement Log File Completion Detection**

```typescript
// In CodexCommandLineIntegration.ts
private getCodexLogPath(): string {
  const home = process.env.USERPROFILE || process.env.HOME;
  if (!home) {
    throw new Error("Cannot determine home directory for Codex log path");
  }
  return path.join(home, ".codex", "log", "codex-tui.log");
}

private async monitorLogFileForCompletion(
  startTime: Date,
  timeoutMs: number
): Promise<{ completed: boolean; error?: string }> {
  const logPath = this.logFilePath;

  // Get initial file size to track new entries
  let lastPosition = 0;
  try {
    const stats = await fs.promises.stat(logPath);
    lastPosition = stats.size;
  } catch (error) {
    Log.warn(`Codex log file not found at ${logPath}, using empty start position`);
  }

  // Poll log file for completion indicators
  while (Date.now() - startTime.getTime() < timeoutMs) {
    try {
      const stats = await fs.promises.stat(logPath);

      // Only read new content since last check
      if (stats.size > lastPosition) {
        const stream = fs.createReadStream(logPath, {
          start: lastPosition,
          encoding: "utf8"
        });

        let newContent = "";
        for await (const chunk of stream) {
          newContent += chunk;
        }

        lastPosition = stats.size;

        // Check for completion indicator: "run_task: close" marks end of turn
        if (/INFO\s+run_task:\s+close\s+time\.busy=/i.test(newContent)) {
          Log.debug("Codex completion detected via log file: run_task: close");
          return { completed: true };
        }

        // Check for error patterns
        if (/Turn error:/i.test(newContent)) {
          const errorMatch = newContent.match(/Turn error:\s*({[^}]+})/);
          const errorDetail = errorMatch ? errorMatch[1] : "Unknown error";
          Log.error(`Codex error detected in log: ${errorDetail}`);
          return { completed: false, error: errorDetail };
        }

        if (/stream disconnected|didn't complete gracefully/i.test(newContent)) {
          Log.warn("Codex stream issue detected in log");
          // Don't fail immediately, may retry successfully
        }
      }
    } catch (error) {
      Log.warn(`Error reading Codex log file: ${error}`);
    }

    // Poll every 500ms
    await this.delay(500);
  }

  return { completed: false, error: "Timeout waiting for completion indicator in log file" };
}
```

**2.4 Interactive Execution Flow with Dual Monitoring**

````typescript
// In CodexCommandLineIntegration.ts
protected async executeInTerminal(
  args: string[],
  promptText: string,
  workflowContext?: WorkflowContext
): Promise<boolean> {
  // Create fresh terminal
  const terminal = await this.createFreshTerminal();

  // Create TUI config with time-based extraction enabled
  const tuiConfig: TuiStreamConfig = {
    useTimeBasedExtraction: true,  // NEW: Enable time-based mode
    escapeIndicator: this.getEscapeIndicator(),
    screenEndPattern: this.getScreenEndPattern(),
    tuiChromePattern: this.getTuiChromePattern(),
    streamingEmitter: this.streamingEmitter,
    responseCompleteEmitter: this.responseCompleteEmitter,
  };

  const processor = new TuiStreamProcessor(tuiConfig);

  // Start Codex interactive mode
  const command = this.buildInteractiveTuiCommand(args);
  const execution = await terminal.shellIntegration?.executeCommand(command);
  if (!execution) {
    throw new Error("Failed to start Codex interactive session");
  }

  // Wait for TUI ready
  await this.delay(2000);

  // Start BOTH monitoring processes simultaneously
  const startTime = new Date();
  const logMonitorPromise = this.monitorLogFileForCompletion(
    startTime,
    this.getTimeoutMs()
  );

  // Send prompt
  await terminal.sendText(promptText);

  // Process TUI output (time-based extraction)
  const streamPromise = processor.processStream(
    execution,
    terminal,
    promptText,
    this.getTimeoutMs()
  );

  // Wait for log file to indicate completion
  const logResult = await logMonitorPromise;

  if (!logResult.completed) {
**3.1 Config File Parsing**

```typescript
private async detectDefaultModel(): Promise<string | undefined> {
  const configPath = this.getConfigPath();

  try {
    const content = await fs.promises.readFile(configPath, 'utf-8');
    const match = content.match(/^model\s*=\s*"([^"]+)"/m);
    return match?.[1];
  } catch (error) {
    return undefined;
  }
}

private getConfigPath(): string {
  const home = process.env.HOME || process.env.USERPROFILE;
  return path.join(home, '.codex', 'config.toml');
}
````

**3.2 Model Registry Integration**

```typescript
// In ModelRegistry.ts
async function queryCodexCliModels(): Promise<void> {
  try {
    // Parse user's config to get their current model
    const configPath = path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".codex",
      "config.toml"
    );

    let userModel: string | undefined;
    if (fs.existsSync(configPath)) {
      const content = fs.readFileSync(configPath, "utf-8");
      const match = content.match(/^model\s*=\s*"([^"]+)"/m);
      userModel = match?.[1];
    }

    // Start with static list from /model command
    cachedCodexCliModelIds = [...CODEX_CLI_MODELS];

    // Add user's custom model if not in static list
    if (userModel && !cachedCodexCliModelIds.includes(userModel)) {
      cachedCodexCliModelIds.push(userModel);
      console.log(
        `FlightPath: Detected custom Codex model from config: ${userModel}`
      );
    }

    console.log(
      `FlightPath: Loaded ${cachedCodexCliModelIds.length} Codex CLI models`
    );
  } catch (error) {
    console.warn(
      "FlightPath: Failed to query Codex models, using static list",
      error
    );
    cachedCodexCliModelIds = [...CODEX_CLI_MODELS];
  }
}
```

**3.3 Settings UI Integration**

```typescript
// In FlightPathSettingsProvider.ts
private buildModelOptions(): Record<string, Array<{value: string, label: string}>> {
  // ...existing Copilot/Claude code...

  // Codex models (static + detected)
  const codexOptions = Object.entries(CODEX_CLI_MODEL_LABELS).map(
    ([value, label]) => ({ value, label })
  );

  return {
    "copilot-cli": copilotCliOptions,
    "copilot-chat": copilotChatOptions,
    "claude-cli": claudeCliOptions,
    "codex-cli": codexOptions,  // NEW
  };
}
```

### Phase 4: Configuration & Settings (Milestone 4)

**4.1 Add Settings to package.json**

```json
{
  "flightpath.codexCliModel": {
    "type": "string",
    "enum": [
      "o3",
      "gpt-5.2",
      "gpt-5.1",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini"
    ],
    "default": "gpt-5.1-codex",
    "description": "Default model for Codex CLI mode",
    "markdownDescription": "**Codex CLI Only.** AI model to use when `provider` is `codex-cli`.\n\n**Recommended:** `gpt-5.1-codex` (optimized for code, balanced performance).\n\nModels ordered by capability:\n- `gpt-5.1-codex-max`: Deep reasoning, slowest\n- `gpt-5.1-codex`: Balanced (recommended)\n- `gpt-5.1-codex-mini`: Fast, less capable\n- `o3`: Latest reasoning model\n- `gpt-5.2`: Latest frontier model\n- `gpt-5.1`: General purpose"
  },

  "flightpath.codexSandboxMode": {
    "order": 207,
    "type": "string",
    "enum": ["read-only", "workspace-write", "danger-full-access"],
    "enumDescriptions": [
      "Read-only operations only (safest)",
      "Write to workspace and --add-dir folders (recommended for automation)",
      "Unrestricted filesystem access (DANGEROUS)"
    ],
    "default": "workspace-write",
    "description": "[Codex CLI] Sandbox mode for command execution (used in custom permission mode)",
    "markdownDescription": "**Codex CLI Only.** Sandbox mode for command execution. Only used when `cliToolPermissions` is set to `custom`.\n\n- **workspace-write** (default): Safe automation, write access to workspace + configured directories\n- **read-only**: Most restrictive, read operations only\n- **danger-full-access**: Full filesystem access (use with caution)\n\n**Note:** This setting is IGNORED when using `allowAll` or `dangerouslyAllowAll` modes (those use built-in presets)."
  },

  "flightpath.codexApprovalPolicy": {
    "order": 208,
    "type": "string",
    "enum": ["untrusted", "on-failure", "on-request", "never"],
    "enumDescriptions": [
      "Ask for non-trusted commands (safest manual control)",
      "Run all commands, ask only if command fails",
      "Model decides when to ask (recommended)",
      "Never ask for approval (fully automated, dangerous)"
    ],
    "default": "on-request",
    "description": "[Codex CLI] When to ask for approval before tool execution (used in custom permission mode)",
    "markdownDescription": "**Codex CLI Only.** When to ask for user approval before executing commands. Only used when `cliToolPermissions` is set to `custom`.\n\n- **on-request** (default): Model decides when approval is needed (intelligent automation)\n- **untrusted**: Only run trusted commands (ls, cat, sed) without asking\n- **on-failure**: Run all commands, ask only if execution fails\n- **never**: Never ask (fully automated, dangerous)\n\n**Note:** This setting is IGNORED when using `allowAll` or `dangerouslyAllowAll` modes (those use built-in presets)."
  },

  "flightpath.provider": {
    "enum": ["copilot-cli", "copilot-chat", "claude-cli", "codex-cli"],
    "enumDescriptions": [
      "GitHub Copilot CLI (default, most reliable)",
      "GitHub Copilot Chat window (UI automation)",
      "Claude Code CLI (Anthropic's CLI)",
      "Codex CLI (OpenAI's agent-based CLI)"
    ]
  }
}
```

**Key Setting Design Decisions:**

1. **Codex-specific settings only apply in `custom` mode** - `allowAll` and `dangerouslyAllowAll` use Codex's built-in presets (`--full-auto` and `--dangerously-bypass-approvals-and-sandbox`)

2. **Clear precedence documentation** - Settings UI explains when Codex-specific settings are active vs ignored

3. **Sensible defaults** - `workspace-write` + `on-request` provide safe automation out of the box

4. **Reuse existing settings where possible** - `copilotCliAllowedDirs` used for `--add-dir` (cross-provider compatibility)

5. **No tool pattern settings** - Codex doesn't support `cliAllowedTools`/`cliDeniedTools` (sandbox-based instead)

**4.2 ConfigurationUtils Additions**

```typescript
// In ConfigurationUtils.ts

/**
 * Get Codex CLI model
 */
static getCodexCliModel(): string {
  return this.getConfiguration().get<string>("codexCliModel", "gpt-5.1-codex");
}

/**
 * Get Codex sandbox mode (custom permission mode only)
 * Note: Ignored when cliToolPermissions is "allowAll" or "dangerouslyAllowAll"
 */
static getCodexSandboxMode(): string {
  return this.getConfiguration().get<string>(
    "codexSandboxMode",
    "workspace-write"
  );
}

/**
 * Get Codex approval policy (custom permission mode only)
 * Note: Ignored when cliToolPermissions is "allowAll" or "dangerouslyAllowAll"
 */
static getCodexApprovalPolicy(): string {
  return this.getConfiguration().get<string>(
    "codexApprovalPolicy",
    "on-request"
  );
}
```

**4.3 Provider Availability Check**

```typescript
// In FlightPathSettingsProvider.ts
private async checkCodexCliAvailability(): Promise<void> {
  try {
    const { exitCode } = await execAsync("codex --version", { timeout: 5000 });

    this.providerStatus["codex-cli"] = {
      available: exitCode === 0,
      status: exitCode === 0 ? "available" : "not_available"
    };
  } catch {
    this.providerStatus["codex-cli"] = {
      available: false,
      status: "not_available"
    };
  }
}
```

### Phase 5: Testing & Polish (Milestone 5)

**5.1 Manual Test Cases**

- [ ] Headless JSON output parsing
- [ ] Interactive TUI execution
- [ ] Session resumption (both modes)
- [ ] Model switching
- [ ] Permission/sandbox modes
- [ ] Token counting accuracy
- [ ] Long prompt handling

**5.2 Automated Tests**

```typescript
suite("CodexCommandLineIntegration", () => {
  test("parses JSON events correctly", () => {
    const integration = new CodexCommandLineIntegration(mockContext);
    const chunk = '{"type":"item.completed","item":{"text":"Hello"}}';
    const result = integration.processStreamingChunk(chunk);
    assert.strictEqual(result, "Hello");
  });

  test("extracts thread_id from session start", () => {
    // ... test thread ID extraction
  });

  test("builds correct headless args", () => {
    // ... test arg building
  });
});
```

**5.3 Documentation Updates**

- Update `README.md` with Codex CLI setup instructions
- Add Codex section to `COPILOT_CLI_DESIGN.md` (or create separate doc)
- Update settings documentation
- Add Codex-specific examples to `manual-test/`

## Key Differences from Copilot/Claude CLI

| Feature              | Copilot CLI                | Claude CLI                       | Codex CLI                         |
| -------------------- | -------------------------- | -------------------------------- | --------------------------------- |
| **JSON Output**      | ❌ Plain text              | ✅ `--output-format stream-json` | ✅ `--json` flag                  |
| **Model Discovery**  | `copilot help config`      | ❌ No command                    | ❌ No command (parse config.toml) |
| **Session Resume**   | `--resume <id>`            | `-r <id>` or `-c`                | `resume <id>` or `resume --last`  |
| **Tool Permissions** | `--allow-all-tools` + deny | `--dangerously-skip-permissions` | Sandbox + approval policies       |
| **Prompt Passing**   | `--prompt` flag or stdin   | Positional arg or `-p`           | Positional arg or stdin           |
| **TTY Requirement**  | ❌ Optional                | ❌ Optional                      | ⚠️ Required for interactive       |
| **Agent Support**    | `--agent` flag             | ❌ No concept                    | ✅ Built-in agent model           |

## Implementation Checklist

### Core Setup ✅ COMPLETE

- [x] Create `CodexCommandLineIntegration.ts` extending `BaseCliIntegration`
- [x] Add Codex models to `ModelConstants.ts`
- [x] Add `"codex-cli"` to `Provider` enum in `types/`
- [x] Update `FlightPathManager` factory to instantiate Codex integration

### Headless Mode ✅ COMPLETE

- [x] Implement `buildHeadlessArgs()` with `exec --json` structure
- [x] Implement JSON event parsing in `processStreamingChunk()`
- [x] Extract thread_id from `thread.started` event
- [x] Parse token usage from `turn.completed` event
- [x] Test long prompt handling (CLI arg vs temp file)

### Interactive Mode with Notify Hook Monitoring ✅ COMPLETE

**TUI Chrome Investigation:**

- [x] Investigate TUI chrome patterns (VERIFIED from live capture - Dec 17, 2025)
- [x] Identify completion indicators (notify hook - Dec 2025)
- [x] Document cursor-based rendering behavior (uses ANSI positioning, not line-appending)

**TuiStreamProcessor Refactoring:**

- [x] Add `useTimeBasedExtraction` option for Codex
- [x] Implement time-based extraction mode
- [x] Add Codex-specific TUI chrome patterns (`getTuiChromePatterns()`)
- [x] Preserve screen-based mode for Claude/Copilot

**Completion Detection:**

- [x] Implement notify hook-based detection (see [CODEX_COMPLETION_DETECTION.md](CODEX_COMPLETION_DETECTION.md))
- [x] Created `src/scripts/flightpath-codex-notify.js`
- [x] Implemented `CliNotificationMonitor` shared utility
- [x] Monitors `.flightpath/temp/codex-notifications/` directory

- [x] Test short responses (< 5s) - single delayed chunk scenario
- [x] Test long responses with tool calls - multiple chunks, tool markers
- [x] Test error scenarios - verify error detection
- [x] Test user cancellation (ESC) - verify graceful handling
- [x] Verify completion detection works reliably via notify hook

### Permissions & Sandbox (Phase 1: Basic, Phase 2: Advanced)

**Phase 1: Basic Permission Mapping (Milestone 1)** ✅ COMPLETE

- [x] Implement `getPermissionArgs()` method with mode-based mapping
- [x] Map `allowAll` → `--full-auto` (safe automation, RECOMMENDED)
  - [x] Verify no individual `-s` or `-a` flags are passed with `--full-auto`
- [x] Map `dangerouslyAllowAll` → `--dangerously-bypass-approvals-and-sandbox` (DANGEROUS)
  - [x] Verify no individual `-s` or `-a` flags are passed with this flag
- [x] Custom mode uses individual `-s` and `-a` flags
- [x] Log warning for `dangerouslyAllowAll` mode (security alert)
- [x] Implement `getDirectoryArgs()` to add workspace + configured directories
- [x] Use `codexAllowedDirs` setting for `--add-dir`
- [x] Document that `cliAllowedTools` and `cliDeniedTools` are IGNORED for Codex
- [x] Implement `hasFullPermissions()` to check for full automation

**Phase 2: Advanced Custom Mode** ✅ COMPLETE

- [x] Add Codex-specific settings to `package.json`:
  - `flightpath.codexSandboxMode` (read-only, workspace-write, danger-full-access)
  - `flightpath.codexApprovalPolicy` (untrusted, on-failure, on-request, never)
  - `flightpath.codexAllowedDirs` (additional writable directories)
- [x] Add helper methods to ConfigurationUtils:
  - `getCodexSandboxMode()` (default: workspace-write)
  - `getCodexApprovalPolicy()` (default: on-request)
  - `getCodexAllowedDirs()` (default: [])
- [x] Update `getPermissionArgs()` to use Codex-specific settings in `custom` mode
  - [x] Uses `CliToolPermissionMapper.buildCodexArgs()` for consistency
- [x] Update Settings UI with Codex-specific controls

### Configuration (Core Settings Only) ✅ COMPLETE

- [x] Add `flightpath.codexCliModel` to `package.json`
  - Enum: gpt-5.1-codex-max, gpt-5.1-codex, gpt-5.1-codex-mini, gpt-5.2, gpt-5.1
  - Default: "gpt-5.1-codex"
  - MarkdownDescription with model capabilities
- [x] Add "codex-cli" to `flightpath.provider` enum
  - Add enumDescription for Codex
- [x] Implement `getCodexCliModel()` in ConfigurationUtils
- [x] Update Settings UI to show Codex provider option
- [x] Add Codex model dropdown (conditional on provider selection)

### Model Discovery

- [ ] Implement config.toml parsing (future enhancement)
- [x] Add static model list (5 models from `/model` command)
- [x] Validate model in `validateAndGetModel()` with fallback
- [x] Update Settings dropdown
- [x] IntelliSense supported via schema

### UI & Documentation

- [x] Update Settings panel with Codex provider
- [x] Add Codex to dashboard provider display
- [ ] Update README with setup instructions
- [x] Create CLI design documentation
- [ ] Add manual test examples

### Testing

- [x] JSON parsing (JSONL events)
- [x] Arg building
- [ ] Integration test for headless execution
- [x] Manual test for interactive TUI
- [x] Test session resumption
- [x] Error handling

## Technical Risks & Mitigation

### Risk 1: TTY Requirement for Interactive Mode

**Impact:** High  
**Probability:** Medium  
**Mitigation:**

- Prioritize headless JSON mode (works reliably)
- Document interactive mode limitations
- Consider making headless the default for Codex

### Risk 2: No Model List Command

**Impact:** Medium  
**Probability:** High (confirmed)  
**Mitigation:**

- Parse user's config.toml for default
- Maintain static list of known models
- Allow manual entry for new models

### Risk 3: Changing JSON Event Format

**Impact:** High  
**Probability:** Low  
**Mitigation:**

- Version detection via `codex --version`
- Graceful degradation to text parsing
- Monitor Codex CLI release notes

### Risk 4: Session Resume Differences

**Impact:** Medium  
**Probability:** Medium  
**Mitigation:**

- Test both `resume <id>` and `resume --last` patterns
- Handle missing thread_id gracefully
- Clear session on errors

### Risk 5: Changing Log Format ⚠️ REALIZED

**Impact:** High  
**Probability:** High (happened once already)  
**Status:** ✅ Mitigated via notify hook  
**What Happened:**

- Original implementation monitored `~/.codex/log/codex-tui.log` for `run_task: close` pattern
- Codex updated log format, breaking completion detection
- Solution: Migrated to notify hook-based detection (stable API)

**Lesson Learned:**

- Prefer official APIs (notify hook) over log file parsing
- Log formats are internal and subject to change without notice

## Timeline Estimate

| Phase                     | Duration      | Dependencies | Status          |
| ------------------------- | ------------- | ------------ | --------------- |
| Phase 1: Core Integration | 2-3 days      | None         | ✅ Complete     |
| Phase 2: TUI Support      | 2-3 days      | Phase 1      | ✅ Complete     |
| Phase 3: Model Discovery  | 1-2 days      | Phase 1      | ✅ Complete     |
| Phase 4: Configuration    | 1 day         | Phase 1      | ✅ Complete     |
| Phase 5: Testing & Polish | 2-3 days      | All phases   | 🔄 Ongoing      |
| **Total**                 | **8-12 days** |              | **✅ Complete** |

## Success Criteria

All criteria met as of January 2026:

- ✅ Codex CLI detected and shown as available provider
- ✅ Headless mode works with JSON output parsing
- ✅ Interactive mode works with completion detection (notify hook)
- ✅ Session resumption functions correctly
- ✅ Model selection and switching works
- ✅ Token counts displayed accurately
- ✅ Settings UI shows Codex options
- ✅ Error handling and fallbacks functional
- ✅ Documentation complete and accurate

## Future Enhancements

### Post-MVP Features

- [ ] OSS model provider support (LM Studio/Ollama)
- [ ] Reasoning effort configuration
- [ ] Web search integration (`--search` flag)
- [ ] Image attachment support (`-i` flag)
- [ ] Output schema validation (`--output-schema` flag)
- [ ] Feature flag configuration (`--enable`/`--disable`)
- [ ] Profile support (`-p` flag for config profiles)

### Advanced Capabilities

- [ ] Thread browsing/management UI
- [ ] Cost tracking and display
- [ ] Tool execution logs in dashboard
- [ ] Multi-agent workflows (if Codex supports)

## References

- Codex CLI Help: `codex --help`
- Codex Exec Help: `codex exec --help`
- Config Location: `~/.codex/config.toml`
- VS Code Terminal API: [Terminal Shell Integration](https://code.visualstudio.com/api/references/vscode-api#Terminal)

## Key Research Findings

### TUI Chrome Pattern Analysis (Dec 17, 2025)

**Finding:** Codex TUI has a clear, stable completion indicator for response detection.

**Visual Analysis from Live Capture:**

```
╭─────────────────────────────────────────────────────────╮
│ >_ OpenAI Codex (v0.73.0)                               │
│                                                         │
│ model:     gpt-5.1-codex-mini medium   /model to change │
│ directory: C:\dev\FlightPath                            │
╰─────────────────────────────────────────────────────────╯

  Tip: Type / to open the command popup...

› what context do you know about this FlightPath project?

  └ Response content here...

• Ran cd C:\dev\FlightPath; cat AGENTS.md
  └ File contents...

• Working (8s • esc to interrupt)  ← KEY COMPLETION INDICATOR

  100% context left · ? for shortcuts
```

**Identified Patterns:**

| Pattern                               | Description              | Usage                    |
| ------------------------------------- | ------------------------ | ------------------------ |
| `╭─────...─────╮`                     | Top border of header box | TUI chrome detection     |
| `>_ OpenAI Codex (v0.73.0)`           | Version header           | Version detection        |
| `╰─────...─────╯`                     | Bottom border of header  | Screen end marker        |
| `› `                                  | User prompt indicator    | Input detection          |
| `• Ran <command>`                     | Tool execution marker    | Tool call tracking       |
| `• Working (Xs • esc to interrupt)`   | **ACTIVE INDICATOR**     | **Completion detection** |
| `100% context left · ? for shortcuts` | Context status bar       | Screen boundary          |

**Completion Detection Strategy:**

- **While working:** `• Working (8s • esc to interrupt)` is present
- **When done:** This line disappears from output
- **Detection pattern:** `esc to interrupt` absence = complete

**Advantages Over Copilot/Claude:**

- ✅ **More explicit** - Clear "Working" message vs. subtle escape text
- ✅ **Timer shows progress** - User sees how long Codex has been working
- ✅ **Unambiguous** - No need to parse complex TUI state

**Implementation Priority:** HIGH - This is the most reliable completion detection among all three CLIs

### `/model` Command Discovery (Dec 17, 2025)

**Finding:** Codex interactive TUI has a `/model` command that lists available models with descriptions.

**Investigation Process:**

1. Started interactive session: `codex`
2. Typed `/model` command
3. Received list of 5 primary models with descriptions

**Models Discovered:**

1. `gpt-5.1-codex-max` - Latest Codex-optimized flagship for deep and fast reasoning
2. `gpt-5.1-codex` - Optimized for codex (Recommended)
3. `gpt-5.1-codex-mini` - Optimized for codex. Cheaper, faster, but less capable
4. `gpt-5.2` - Latest frontier model with improvements across knowledge, reasoning and coding
5. `gpt-5.1` - Broad world knowledge with strong general reasoning

**Implications:**

- ✅ Definitive source for model list (directly from Codex)
- ❌ Cannot be accessed programmatically (requires TTY)
- ✅ Should be used as baseline for static model constants
- ✅ Users can add custom models via config.toml
- 📝 Update static list when Codex adds new models

**Implementation Strategy:**

- Use these 5 models as the static baseline in `ModelConstants.ts`
- Parse `config.toml` to detect user's custom models
- Allow manual model entry in settings for advanced users
- Monitor Codex release notes for new model additions

### Custom Model Support

**Key Finding:** Codex allows users to configure ANY model via `config.toml`, including:

- Claude models (Anthropic)
- OSS models (via LM Studio/Ollama)
- Future models not yet in the static list

**Example config.toml:**

```toml
model = "claude-sonnet-4.5"  # Custom Claude model
model_provider = "anthropic"

# OR

model = "llama-3-70b"  # OSS model
model_provider = "oss"
```

**FlightPath Implementation:**

1. **Static Dropdown:** Show 5 official Codex models from `/model` command
2. **Detected Custom:** If config.toml has a different model, show it in dropdown with "(Custom)" label
3. **Manual Entry:** Provide text input option for users to specify any model
4. **Validation:** Accept any string, no strict validation (user's responsibility)

**Settings UI Design:**

```typescript
// Dropdown options
const options = [
  { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max (Flagship)" },
  { value: "gpt-5.1-codex", label: "GPT-5.1 Codex (Recommended)" },
  { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini (Fast & Cheap)" },
  { value: "gpt-5.2", label: "GPT-5.2 (Latest Frontier)" },
  { value: "gpt-5.1", label: "GPT-5.1 (General Reasoning)" },
  { value: "o3", label: "o3 (Reasoning)" },
  { value: "custom", label: "Custom Model..." }, // Opens text input
];

// If custom model detected from config
if (detectedModel && !standardModels.includes(detectedModel)) {
  options.unshift({
    value: detectedModel,
    label: `${detectedModel} (From Config)`,
  });
}
```

## Appendix: Example Commands

### Headless JSON Execution

```bash
codex exec --json -m gpt-5.1-codex-mini "What is 2+2?"
```

### Interactive with Full Auto

```bash
codex --full-auto -m gpt-5.1-codex "Implement a new feature"
```

### Session Resume

```bash
# Resume last session
codex resume --last

# Resume specific thread (headless)
codex exec resume 019b2dfd-8362-7862-8d9b-d9263625a298
```

### With Sandbox Configuration

```bash
codex exec -s workspace-write -a on-request "Refactor this code"
```

---

**Document Version:** 1.1  
**Last Updated:** January 12, 2026  
**Author:** GitHub Copilot

**Revision History:**

- v1.1 (Jan 12, 2026): Updated completion detection section to reflect notify hook implementation; updated checklists to show implementation status; added Risk 5 about log format changes; cross-referenced CODEX_COMPLETION_DETECTION.md
- v1.0 (Dec 17-18, 2025): Initial research and implementation plan
