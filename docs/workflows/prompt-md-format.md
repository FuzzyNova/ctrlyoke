# Prompt Markdown format

`.prompt.md` is the lightest-weight way to use ctrlyoke. The file becomes the prompt of a single step, with an optional leading YAML frontmatter block. ctrlyoke reads `schemaVersion` from that block, removes the block from the prompt, and trims the remaining prompt text. The frontmatter must be valid YAML; an invalid block makes the file fail to load. Harness, model, and every other property come from your `defaults.*` settings.

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
