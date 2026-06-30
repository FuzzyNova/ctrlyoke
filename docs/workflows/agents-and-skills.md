# Agents and skills

Agents and skills let you add reusable instruction layers without copying the same guidance into every workflow.

## Agent

`agent` selects one custom agent by name.

```yaml
agent: ctrlyoke-orchestrator
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
