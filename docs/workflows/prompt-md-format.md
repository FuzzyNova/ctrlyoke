# Prompt Markdown format

`.prompt.md` is the lightest-weight way to use ctrlyoke. The file body is the prompt.

## Example

```md
Review @src/extension.ts and explain the three most coupled areas.
```

## When to use it

- one-off prompts
- quick experiments
- context-heavy prompts that are easier to read in Markdown

## Limits

Because the file is only prompt text, it cannot embed workflow-level structure such as:

- `steps`
- `finalStep`
- `endCondition`
- per-step `harness` and `model` overrides

If you need structured automation, move to YAML or JSON.
