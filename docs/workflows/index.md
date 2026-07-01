# Workflow files

ctrlyoke supports three file formats:

| Format   | Extension                         | Best use                             |
| -------- | --------------------------------- | ------------------------------------ |
| YAML     | `.ctrlyoke.yaml`, `.ctrlyoke.yml` | Multi-step workflows written by hand |
| JSON     | `.ctrlyoke.json`                  | Generated workflows and automation   |
| Markdown | `.prompt.md`                      | Single prompt files                  |

## Current schema shape

The current multi-step schema uses `steps`, not `prompts`.

```yaml
harness: copilot-cli
steps:
  - prompt: Review @src/
finalStep:
  prompt: Summarize the result and any follow-up work.
```

## Main workflow building blocks

- root-level execution defaults such as `harness`, `model`, and `toolPermissions`
- a `steps` array containing prompt steps and script steps
- an optional `finalStep`
- runtime metadata added automatically during execution

Read the format-specific pages next:

- [YAML format](/workflows/yaml-format)
- [JSON format](/workflows/json-format)
- [Prompt Markdown format](/workflows/prompt-md-format)
