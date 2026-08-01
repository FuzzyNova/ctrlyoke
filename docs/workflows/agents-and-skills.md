# Agents and skills

Agents and skills let you add reusable instruction layers without copying the same guidance into every workflow.

Workflow `agent` and `skills` fields are portable ctrlyoke prompt attachments.
`CliPromptPreparer.createCategorizedPromptFiles()` resolves their content into
categorized prompt references; agent content is wrapped in
`<agentInstructions>` tags before the reference is supplied to the harness.
These fields are supported independently of any harness-native discovery
feature.

## Agent

`agent` selects one custom agent by name.

```yaml
agent: ctrlyoke-workflow-composer
```

The schema expects the bare name, not a file path or extension.

## Skills

`skills` attaches a list of skill names:

```yaml
skills:
  - code-review
  - refactor-helper
```

Prompt-level skills replace workflow-level skills rather than merging with them.

## Agents & Skills settings

The Agents & Skills settings page manages a separate, optional path: copying
agent and skill files into harness-native discovery directories. Native
discovery can enable ambient skills or native subagent spawning, and its
behavior varies by harness. It does not determine whether workflow `agent` or
`skills` attachments are supported.

## Disabling inherited values

Use `null` when you want to stop inheritance from the workflow level:

```yaml
steps:
  - prompt: Run without the default agent.
    agent: null
```

## When to use them

- use an **agent** for a stable persona or role
- use **skills** for smaller reusable instruction packs
- keep workflow prompts focused on the task rather than repeating general process guidance
