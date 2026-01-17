# Workflow Properties Guide

**Status:** Feature Documentation
**Version:** FlightPath 1.0
**Last Updated:** January 17, 2026

## Overview

Workflow properties allow you to define default execution settings at the workflow level, reducing duplication and improving reproducibility. Instead of configuring provider, model, and other settings for each prompt individually, you can set them once for the entire workflow.

### Benefits

✅ **Reproducibility** - Workflows include their own defaults, ensuring consistent behavior across different environments and users

✅ **DRY Principle** - Define shared settings once at the workflow level instead of repeating them for every prompt

✅ **Common End Conditions** - Apply workflow-wide validation (e.g., "all prompts must pass tests") without duplicating configuration

✅ **Better Sharing** - Share workflows with embedded defaults, reducing dependency on recipient's VS Code settings

✅ **Flexibility** - Individual prompts can still override workflow defaults when needed

---

## Three-Tier Precedence System

FlightPath uses a three-tier precedence system to resolve execution properties:

```
┌──────────────────────────────────────────────────┐
│  1. Prompt-Level Properties (Highest Priority)   │
│     - Set on individual prompt                   │
│     - Overrides workflow and global settings     │
└──────────────────────────────────────────────────┘
                     ↓ (if not set)
┌──────────────────────────────────────────────────┐
│  2. Workflow-Level Properties                    │
│     - Set on entire workflow file                │
│     - Shared defaults for all prompts            │
└──────────────────────────────────────────────────┘
                     ↓ (if not set)
┌──────────────────────────────────────────────────┐
│  3. VS Code Global Settings (Fallback)           │
│     - User's default preferences                 │
│     - Apply to all workflows                     │
└──────────────────────────────────────────────────┘
```

### How Precedence Works

When FlightPath executes a prompt, it resolves each property by checking:

1. **Prompt level** - Does this specific prompt have the property set?
2. **Workflow level** - Does the workflow file have the property set?
3. **Global settings** - What is the user's VS Code default setting?

The first defined value wins (highest priority takes precedence).

---

## Setting Workflow Properties

### Using the Workflow Properties Panel

The easiest way to configure workflow properties is through the **Workflow Properties** panel in the FlightPath dashboard:

1. **Load a workflow** - Open an existing `.flightpath.yaml` or `.flightpath.json` file in FlightPath
2. **Click the Settings icon** - Opens the Workflow Properties panel
3. **Configure defaults** - Set provider, model, agent, and other properties
4. **Changes save automatically** - Properties are written to the workflow's working file

**Panel Features:**

- **Set as Default** button - Appears when workflow property differs from global setting. Click to sync workflow value → global settings.
- **Workflow-wide end condition** - Checkbox to enable validation that applies to all prompts
- **Session Settings** - Quick access to frequently-toggled settings (Execution Mode)
- **More Settings...** - Opens VS Code settings for advanced configuration

### YAML Format

Add workflow properties at the root level of your `.flightpath.yaml` file:

```yaml
# Workflow-level properties (apply to all prompts by default)
provider: copilot-cli
model: claude-sonnet-4.5
agent: code-reviewer
newChatSession: true
allowDynamicExtension: false

# Optional: Workflow-wide end condition
endCondition:
  script: npm test
  returns: "true"
  timeout: 30000
  maxRetries: 2
  retryPrompt: |
    Tests failed: {error}

    Please fix the failing tests before proceeding.

# Prompts inherit workflow properties
prompts:
  - id: analyze
    prompt: "Analyze the codebase for bugs"
    # Uses: copilot-cli, claude-sonnet-4.5, code-reviewer

  - id: implement
    prompt: "Implement improvements"
    model: gpt-5 # Override: Use different model
    # Uses: copilot-cli, gpt-5 (overridden), code-reviewer

  - id: document
    prompt: "Update documentation"
    endCondition: null # Override: Disable validation for docs
    # Uses: copilot-cli, claude-sonnet-4.5, code-reviewer
```

### JSON Format

```json
{
  "provider": "copilot-cli",
  "model": "claude-sonnet-4.5",
  "agent": "code-reviewer",
  "newChatSession": true,
  "allowDynamicExtension": false,
  "endCondition": {
    "script": "npm test",
    "returns": "true",
    "timeout": 30000,
    "maxRetries": 2,
    "retryPrompt": "Tests failed: {error}\n\nPlease fix the failing tests."
  },
  "prompts": [
    {
      "id": "analyze",
      "prompt": "Analyze the codebase for bugs"
    },
    {
      "id": "implement",
      "prompt": "Implement improvements",
      "model": "gpt-5"
    },
    {
      "id": "document",
      "prompt": "Update documentation",
      "endCondition": null
    }
  ]
}
```

---

## Available Properties

### provider

**Type:** `"copilot-cli" | "copilot-chat" | "claude-cli" | "codex-cli"`

**Description:** AI provider used to execute prompts

**Default:** Falls back to `flightpath.provider` setting

**Example:**

```yaml
provider: claude-cli
```

### model

**Type:** `string`

**Description:** AI model to use for execution. Available models depend on the selected provider.

**Common Models:**

- Copilot CLI: `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`, `gpt-5`
- Claude CLI: `sonnet`, `opus`, `haiku`
- Codex CLI: `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`

**Default:** Falls back to provider-specific setting (`flightpath.copilotCliModel`, `flightpath.claudeCliModel`, etc.)

**Example:**

```yaml
model: claude-sonnet-4.5
```

### agent

**Type:** `string` (path to `.agent.md` file)

**Description:** Custom agent file that defines specialized instructions and behavior

**Default:** No agent (undefined)

**Example:**

```yaml
agent: .github/agents/code-reviewer.agent.md
```

### newChatSession

**Type:** `boolean`

**Description:** Whether to start a fresh chat session for each prompt (true) or continue previous conversation (false)

**Default:** Falls back to `flightpath.newChatSessionPerPrompt` setting

**Example:**

```yaml
newChatSession: true
```

### allowDynamicExtension

**Type:** `boolean`

**Description:** Whether to allow prompts to dynamically extend the workflow by modifying the workflow file during execution

**Default:** `false` (no fallback setting)

**Example:**

```yaml
allowDynamicExtension: true
```

### endCondition

**Type:** `object` or `null`

**Description:** Validation script that runs after prompt completion. Can be set at workflow level to apply to all prompts, or at prompt level for specific validation.

**Properties:**

- `script` - Command to execute (e.g., `npm test`, `python validate.py`)
- `returns` - Expected output (e.g., `"true"`, `"success"`)
- `timeout` - Maximum execution time in milliseconds
- `maxRetries` - Number of retry attempts on failure (-1 = unlimited)
- `retryPrompt` - Message sent to AI when validation fails (supports `{error}` placeholder)

**Default:** No end condition (undefined)

**Workflow-Level Example:**

```yaml
endCondition:
  script: npm test
  returns: "true"
  timeout: 30000
  maxRetries: 2
  retryPrompt: |
    Tests failed: {error}

    Please fix the issues.
```

**Disable for Specific Prompt:**

```yaml
prompts:
  - id: docs
    prompt: "Update documentation"
    endCondition: null # Override workflow-level validation
```

---

## Working File: Single Source of Truth

FlightPath uses a **working file** system to track workflow execution state. When you load a workflow, FlightPath creates a working copy that serves as the single source of truth.

### How Working Files Work

1. **Load workflow** - FlightPath creates `.flightpath/.working/<filename>.working.yaml`
2. **Properties stored** - Provider and model always included; other properties included when explicitly set
3. **Runtime state** - Execution progress, completed prompts, session IDs tracked in working file
4. **Modifications** - AI can modify working file during execution (if `allowDynamicExtension: true`)
5. **Resume** - Working file enables resuming interrupted workflows

### What Gets Saved

**Always saved:**

- `provider` - Required for execution
- `model` - Required for execution

**Saved when explicitly set:**

- `agent` - Only if configured
- `newChatSession` - Only if different from default
- `allowDynamicExtension` - Only if enabled
- `endCondition` - Only if configured

**Example Working File:**

```yaml
provider: copilot-cli
model: claude-sonnet-4.5
agent: code-reviewer
endCondition:
  script: npm test
  returns: "true"

prompts:
  - id: analyze
    prompt: "Analyze code"
    _runtime:
      provider: copilot-cli
      model: claude-sonnet-4.5
      sessionId: abc-123
      startedAt: 1737158400000
      completedAt: 1737158450000
```

### Benefits

- **Consistency** - Workflow state preserved across sessions
- **Auditability** - Complete execution history in one file
- **AI Integration** - LLMs can modify workflow configuration programmatically
- **Resumability** - Interrupted workflows can resume from last state

---

## Example Workflows

### Example 1: Shared End Condition

**Use Case:** Ensure all prompts pass tests before proceeding

```yaml
# All prompts must pass tests
provider: copilot-cli
model: claude-sonnet-4.5
endCondition:
  script: npm test
  returns: "true"
  timeout: 60000
  maxRetries: 2
  retryPrompt: |
    Tests failed: {error}

    Please fix the failing tests before moving to the next step.

prompts:
  - id: implement-auth
    prompt: "Implement user authentication feature"
    # Will run tests after completion

  - id: add-auth-tests
    prompt: "Add comprehensive tests for authentication"
    # Will run tests after completion

  - id: update-docs
    prompt: "Update authentication documentation"
    endCondition: null # Skip validation for documentation
```

**What happens:**

1. Copilot implements auth feature → Tests run → Retry if failed
2. Copilot adds tests → Tests run → Retry if failed
3. Copilot updates docs → No validation (end condition disabled)

### Example 2: Reproducible Code Review

**Use Case:** Consistent code review process across team members

```yaml
# Standardized code review configuration
provider: claude-cli
model: sonnet
agent: .github/agents/code-reviewer.agent.md
newChatSession: true # Fresh context for each review phase

prompts:
  - id: security-review
    prompt: |
      Review the latest changes for security vulnerabilities.
      Focus on: authentication, authorization, input validation, data exposure.

  - id: performance-review
    prompt: |
      Analyze performance implications of the changes.
      Identify bottlenecks, inefficient algorithms, resource leaks.
    model: haiku # Override: Use faster model for performance check

  - id: style-review
    prompt: |
      Check code style, naming conventions, and best practices.
      Suggest improvements for readability and maintainability.
    model: haiku # Override: Use faster model for style check
```

**Benefits:**

- Same AI provider/model for all team members
- Code reviewer agent provides specialized expertise
- Fast models for simple checks (performance, style)
- Fresh session per review phase (clearer context)

### Example 3: Mixed Precedence

**Use Case:** Demonstrating all three precedence levels

```yaml
# Workflow defaults
provider: copilot-cli
model: claude-sonnet-4.5
newChatSession: false

prompts:
  - id: analyze
    prompt: "Analyze the codebase architecture"
    # Uses workflow defaults:
    #   provider: copilot-cli (workflow)
    #   model: claude-sonnet-4.5 (workflow)
    #   newChatSession: false (workflow)

  - id: implement
    prompt: "Implement architectural improvements"
    model: gpt-5 # Prompt-level override
    # Uses:
    #   provider: copilot-cli (workflow)
    #   model: gpt-5 (prompt override)
    #   newChatSession: false (workflow)

  - id: review
    prompt: "Review changes for compliance"
    provider: claude-cli # Prompt-level override
    model: opus # Prompt-level override
    newChatSession: true # Prompt-level override
    # All workflow defaults overridden:
    #   provider: claude-cli (prompt override)
    #   model: opus (prompt override)
    #   newChatSession: true (prompt override)
```

**Precedence visualization:**

| Prompt    | Provider    | Model             | New Session | Source       |
| --------- | ----------- | ----------------- | ----------- | ------------ |
| analyze   | copilot-cli | claude-sonnet-4.5 | false       | All workflow |
| implement | copilot-cli | gpt-5             | false       | Mixed        |
| review    | claude-cli  | opus              | true        | All prompt   |

---

## Best Practices

### 1. Set Workflow Defaults for Shared Workflows

When sharing workflows with teammates, include provider and model to ensure consistency:

```yaml
# Good: Reproducible across team
provider: copilot-cli
model: claude-sonnet-4.5

prompts:
  - prompt: "Implement feature X"
```

### 2. Use Workflow-Wide End Conditions for Quality Gates

Apply validation across all implementation prompts:

```yaml
# Ensure all changes pass tests
endCondition:
  script: npm test
  returns: "true"
  maxRetries: 1

prompts:
  - prompt: "Add feature A"
  - prompt: "Add feature B"
  - prompt: "Add feature C"
```

### 3. Override Selectively at Prompt Level

Use faster/cheaper models for simple tasks:

```yaml
# Workflow default: Powerful model
model: claude-sonnet-4.5

prompts:
  - prompt: "Design complex algorithm"
    # Uses sonnet (complex task)

  - prompt: "Fix typos in comments"
    model: claude-haiku-4.5 # Override: Use fast model
```

### 4. Document Why Overrides Exist

Add comments explaining prompt-level overrides:

```yaml
prompts:
  - id: security-audit
    prompt: "Audit for security issues"
    model: opus # Override: Use most capable model for security

  - id: format-code
    prompt: "Apply code formatting"
    model: haiku # Override: Simple task, use fast model
```

### 5. Disable End Conditions for Non-Code Prompts

Skip validation for documentation, planning, or analysis:

```yaml
endCondition:
  script: npm test
  returns: "true"

prompts:
  - prompt: "Implement feature"
    # Tests run

  - prompt: "Update README"
    endCondition: null # Skip tests for docs
```

---

## UI Walkthrough

### Opening Workflow Properties Panel

1. Load a workflow file (`.flightpath.yaml` or `.flightpath.json`)
2. Click the **Settings icon** (⚙️) in the FlightPath dashboard
3. The Workflow Properties panel opens

### Understanding the Interface

**Workflow Properties Section:**

- Configure defaults for all prompts in this workflow
- Changes save to the working file immediately
- Each field shows current workflow value

**"Set as Default" Button:**

- Appears when workflow value differs from VS Code global setting
- Click to sync workflow value → global settings
- Button animates (✓ Default) and fades out after syncing

**Session Settings Section:**

- Quick access to frequently-toggled settings
- **Execution Mode** - Updates global setting (not workflow-specific)
- Clearly labeled as "Quick Access" to avoid confusion

**More Settings... Button:**

- Opens VS Code settings for advanced configuration
- Tool permissions, timeouts, log directories, etc.

### Setting Workflow Properties

**Example: Configure provider and model**

1. Select provider from dropdown (e.g., "Claude CLI")
2. Select model from dropdown (e.g., "Sonnet")
3. Properties save automatically to working file
4. If different from global setting, "Set as Default" button appears
5. Optionally click "Set as Default" to update global settings

**Example: Add workflow-wide end condition**

1. Check "Apply end condition to all prompts" checkbox
2. End condition details expand
3. Enter script: `npm test`
4. Enter expected return: `true`
5. Set timeout: `30000` (milliseconds)
6. Set max retries: `2`
7. Enter retry prompt with `{error}` placeholder
8. Properties save to working file

### When Settings Panel is Disabled

The Workflow Properties panel is disabled when:

- No workflow is loaded
- Workflow file is invalid
- Working file cannot be created

**Re-enabling:** Load a valid workflow file to enable the panel.

---

## Common Patterns

### Pattern 1: Test-Driven Development Workflow

All prompts must pass tests before proceeding:

```yaml
provider: copilot-cli
model: claude-sonnet-4.5
endCondition:
  script: npm test
  returns: "true"
  maxRetries: 2

prompts:
  - prompt: "Write tests for feature X"
  - prompt: "Implement feature X"
  - prompt: "Refactor for performance"
```

### Pattern 2: Multi-Agent Workflow

Different agents for different phases:

```yaml
prompts:
  - id: plan
    agent: architect
    prompt: "Design system architecture"

  - id: implement
    agent: developer
    prompt: "Implement the design"

  - id: review
    agent: reviewer
    prompt: "Review implementation"
```

### Pattern 3: Progressive Model Selection

Start with powerful model, use faster models for refinement:

```yaml
model: claude-sonnet-4.5 # Default: Powerful

prompts:
  - prompt: "Design complex algorithm"
    # Uses sonnet

  - prompt: "Optimize implementation"
    model: claude-haiku-4.5 # Fast model for simple optimization

  - prompt: "Add inline comments"
    model: claude-haiku-4.5 # Fast model for documentation
```

---

## Troubleshooting

### Problem: "Set as Default" button doesn't appear

**Cause:** Workflow property matches global setting (already in sync)

**Solution:** This is expected behavior. Button only appears when values differ.

### Problem: Workflow properties not applied

**Possible causes:**

1. **Prompt-level override** - Check if specific prompt has property set (takes precedence)
2. **Working file outdated** - Reload workflow to regenerate working file
3. **Schema validation error** - Check Output panel for validation errors

**Solution:** Review precedence order and check for prompt-level overrides.

### Problem: End condition not running

**Possible causes:**

1. **Disabled at prompt level** - Prompt has `endCondition: null`
2. **Script not found** - Validation script path is invalid
3. **Timeout too short** - Script exceeds timeout limit

**Solution:** Check prompt-level overrides and script configuration.

### Problem: Changes not saving

**Cause:** Working file is read-only or locked

**Solution:**

1. Close and reload workflow
2. Check file permissions in `.flightpath/.working/` directory
3. Delete working file and reload workflow

### Problem: Model not available

**Cause:** Selected model not supported by current provider

**Solution:**

1. Check `flightpath.provider` setting matches workflow provider
2. Verify model is available for selected provider (see model lists above)
3. Update workflow or switch provider

---

## Migration Guide

### Adding Properties to Existing Workflows

**Step 1: Identify Common Settings**

Review your workflow and identify repeated settings:

```yaml
# Before: Duplicated settings
prompts:
  - prompt: "Analyze code"
    provider: copilot-cli
    model: claude-sonnet-4.5

  - prompt: "Implement fixes"
    provider: copilot-cli
    model: claude-sonnet-4.5
```

**Step 2: Move to Workflow Level**

Extract common properties to workflow root:

```yaml
# After: DRY with workflow properties
provider: copilot-cli
model: claude-sonnet-4.5

prompts:
  - prompt: "Analyze code"
  - prompt: "Implement fixes"
```

**Step 3: Keep Intentional Overrides**

Preserve prompt-level overrides that are intentional:

```yaml
provider: copilot-cli
model: claude-sonnet-4.5

prompts:
  - prompt: "Complex analysis"
    # Uses workflow default (sonnet)

  - prompt: "Simple formatting"
    model: claude-haiku-4.5 # Keep this override
```

### Converting from Settings-Based to Workflow-Based

**Before (relies on user settings):**

```yaml
# No workflow properties
# Assumes user has correct settings configured

prompts:
  - prompt: "Implement feature"
```

**After (self-contained workflow):**

```yaml
# Explicit workflow defaults
# Works consistently across all users

provider: copilot-cli
model: claude-sonnet-4.5
agent: code-reviewer

prompts:
  - prompt: "Implement feature"
```

**Benefits:**

- Reproducible across team
- No setup required for recipients
- Clear execution configuration

---

## Related Documentation

- **[FlightPath Quick Start](../QUICK_START.md)** - Getting started guide
- **[End Conditions Guide](END_CONDITIONS.md)** - Detailed validation documentation
- **[Custom Agents](FLIGHTPATH_CUSTOM_TEMPLATES.md)** - Creating specialized agents
- **[CLI Design](COPILOT_CLI_DESIGN.md)** - Provider implementation details
- **[Prompt Syntax](PROMPT_SYNTAX.md)** - Writing effective prompts

---

## Appendix: Full Schema Reference

### Workflow File Schema (YAML)

```yaml
# Workflow-level properties (optional)
provider: "copilot-cli" | "copilot-chat" | "claude-cli" | "codex-cli"
model: string
agent: string
newChatSession: boolean
allowDynamicExtension: boolean
endCondition:
  script: string
  returns: string
  timeout: number
  maxRetries: number
  retryPrompt: string

# Required
prompts:
  - id: string  # Optional
    prompt: string  # Required

    # Prompt-level overrides (optional)
    provider: "copilot-cli" | "copilot-chat" | "claude-cli" | "codex-cli"
    model: string
    agent: string
    newChatSession: boolean
    allowDynamicExtension: boolean
    endCondition:
      script: string
      returns: string
      timeout: number
      maxRetries: number
      retryPrompt: string
```

### Workflow File Schema (JSON)

```json
{
  "provider": "copilot-cli | copilot-chat | claude-cli | codex-cli",
  "model": "string",
  "agent": "string",
  "newChatSession": true,
  "allowDynamicExtension": false,
  "endCondition": {
    "script": "string",
    "returns": "string",
    "timeout": 30000,
    "maxRetries": 0,
    "retryPrompt": "string"
  },
  "prompts": [
    {
      "id": "string",
      "prompt": "string",
      "provider": "copilot-cli | copilot-chat | claude-cli | codex-cli",
      "model": "string",
      "agent": "string",
      "newChatSession": true,
      "allowDynamicExtension": false,
      "endCondition": {}
    }
  ]
}
```

---

**End of Guide**
