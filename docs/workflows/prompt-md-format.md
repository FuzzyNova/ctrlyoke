# Prompt Markdown format

`.prompt.md` is the lightest-weight way to use ctrlyoke. The file becomes the prompt of a single step, with an optional leading YAML frontmatter block. ctrlyoke removes the block from the prompt and trims the remaining prompt text, so the frontmatter is never sent to the harness. The frontmatter must be valid YAML; an invalid block makes the file fail to load. Harness, model, and every other property come from your `defaults.*` settings.

## Frontmatter

ctrlyoke reads two fields and ignores every other key:

- `schemaVersion`: the workflow format version. An older ctrlyoke refuses a newer one.
- `description`: a short summary. When the file runs on its own, it becomes the step's name in the dashboard, cut to 100 characters. It is never sent to the harness.

Because other keys are ignored, a prompt file written for another tool, such as a GitHub Copilot prompt file with `model`, `tools` or `agent`, still loads. ctrlyoke does not apply those keys: their values mean something different there.

See [Prompt Markdown frontmatter](../reference/workflow-schema.md#prompt-file-frontmatter) for the field reference.

## Example

```md
---
description: Explain the coupling in the extension entry point
---

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
`prompt: ./prompts/review.prompt.md`. The step receives the file's prompt text
without its frontmatter, exactly as when the file runs on its own. An empty
`.prompt.md` file, or one with only frontmatter, cannot be run.
