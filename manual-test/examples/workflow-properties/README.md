# Workflow Properties Examples

This directory contains example workflows demonstrating the workflow-level properties feature in FlightPath.

## Examples Overview

### 1. Shared End Condition (`shared-end-condition.flightpath.yaml`)

**Use Case:** Ensure all implementation prompts pass tests before proceeding

**Key Features:**

- Workflow-wide end condition validates all code changes
- Tests run after each prompt completes
- Automatic retry on test failures
- Documentation prompts skip validation

**When to use:**

- Test-driven development workflows
- Quality gates for code changes
- CI/CD-like validation in AI workflows

---

### 2. Shared Harness/Model (`shared-harness-model.flightpath.yaml`)

**Use Case:** Reproducible code review workflow with consistent AI configuration

**Key Features:**

- Standardized harness and model across team members
- Custom agent provides specialized code review expertise
- Different models for different review phases
- Fresh chat session per review phase

**When to use:**

- Shared team workflows
- Reproducible multi-step processes
- Workflows that should behave identically across users

---

### 3. Mixed Precedence (`mixed-precedence.flightpath.yaml`)

**Use Case:** Demonstrates all three precedence levels (prompt > workflow > settings)

**Key Features:**

- Workflow defaults apply to most prompts
- Selective prompt-level overrides for special cases
- Shows precedence resolution clearly
- Educational example for understanding the system

**When to use:**

- Learning workflow properties
- Understanding precedence resolution
- Complex workflows with varying requirements

---

## How to Use These Examples

### Running an Example

1. **Open in FlightPath:**
   - Right-click the workflow file
   - Select **"Run with FlightPath"**

2. **Review Configuration:**
   - Open FlightPath dashboard
   - Click Settings icon to view workflow properties
   - See how workflow-level defaults are applied

3. **Examine Precedence:**
   - Check prompt drawer to see which prompts have overrides
   - Compare workflow properties vs. prompt properties
   - Observe which values take precedence

### Modifying Examples

**Add workflow-wide validation:**

```yaml
endCondition:
  script: npm test
  returns: "true"
  maxRetries: 2
  retryPrompt: |
    Tests failed: {error}
    Please fix before proceeding.
```

**Override at prompt level:**

```yaml
prompts:
  - name: special-task
    prompt: "Complex task requiring best model"
    model: claude-opus # Override workflow default
```

**Disable validation for specific prompt:**

```yaml
prompts:
  - name: documentation
    prompt: "Update README"
    endCondition: null # Skip workflow validation
```

---

## Example Comparison

| Example              | Harness     | Model             | End Condition | Agent    | Prompts |
| -------------------- | ----------- | ----------------- | ------------- | -------- | ------- |
| Shared End Condition | copilot-cli | claude-sonnet-4.5 | Workflow-wide | None     | 3       |
| Shared Harness/Model | claude-cli  | sonnet            | None          | reviewer | 3       |
| Mixed Precedence     | copilot-cli | claude-sonnet-4.5 | None          | None     | 3       |

---

## Creating Your Own Workflows

### Template with All Properties

```yaml
# Workflow-level properties (optional, but recommended for sharing)
harness: copilot-cli
model: claude-sonnet-4.5
agent: .github/agents/my-agent.agent.md
newChatSession: true
allowDynamicExtension: false

# Optional: Workflow-wide validation
endCondition:
  script: npm test
  returns: "true"
  timeout: 30000
  maxRetries: 2
  retryPrompt: |
    Validation failed: {error}

    Please fix the issues before proceeding.

# Prompts
prompts:
  - name: step-1
    prompt: "First step"
    # Inherits all workflow properties

  - name: step-2
    prompt: "Second step with override"
    model: gpt-5 # Override workflow model

  - name: step-3
    prompt: "Third step"
    endCondition: null # Disable workflow validation
```

### Best Practices

1. **Set harness and model for reproducibility**
   - Ensures workflow behaves consistently across users
   - Documents intended execution configuration

2. **Use workflow-wide end conditions for quality gates**
   - Apply validation to all implementation prompts
   - Skip validation for non-code prompts (docs, analysis)

3. **Override selectively at prompt level**
   - Use faster models for simple tasks
   - Use powerful models for complex reasoning

4. **Add comments to explain overrides**
   - Document why prompt differs from workflow default
   - Helps future maintainers understand intent

---

## Further Reading

- **[Workflow Properties Guide](../docs/WORKFLOW_PROPERTIES.md)** - Complete feature documentation
- **[End Conditions Guide](../docs/END_CONDITIONS.md)** - Validation script reference
- **[Custom Agents](../docs/FLIGHTPATH_CUSTOM_TEMPLATES.md)** - Creating specialized agents
- **[Prompt Syntax](../docs/PROMPT_SYNTAX.md)** - Writing effective prompts

---

## Troubleshooting

**Q: Workflow properties not applied?**

A: Check for prompt-level overrides. Prompt properties take precedence over workflow properties.

**Q: "Set as Default" button doesn't appear?**

A: Workflow property matches global setting (already in sync). Button only appears when values differ.

**Q: End condition not running?**

A: Check if prompt has `endCondition: null` (disables workflow validation).

**Q: Model not available?**

A: Verify model is supported by selected harness. See [Workflow Properties Guide](../docs/WORKFLOW_PROPERTIES.md#model) for model lists.
