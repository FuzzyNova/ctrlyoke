# Prompt Markdown format

`.prompt.md` is the lightest-weight way to use ctrlyoke. The entire file content, trimmed, becomes the prompt of a single step. ctrlyoke does not parse YAML frontmatter in these files, so any frontmatter is sent to the harness as part of the prompt text. Harness, model, and every other property come from your `defaults.*` settings.

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
- `harness`, `model`, `agent`, `skills`, `vars`, or any other property

If you need structured automation, move to YAML or JSON. A YAML or JSON step can
still reuse a Markdown prompt by path, for example
`prompt: ./prompts/review.prompt.md`. An empty `.prompt.md` file cannot be run.
