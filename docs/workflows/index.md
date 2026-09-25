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
- a `steps` array containing prompt steps, script steps, and `parallel` groups
- an optional `finalStep`
- runtime metadata added automatically during execution

A one-step workflow can also skip `steps` and put a single prompt step (or a
`type: script` step) directly at the root:

```yaml
harness: claude-cli
prompt: Review @src/ and list the riskiest modules.
```

Read the format-specific pages next:

- [YAML format](/workflows/yaml-format)
- [JSON format](/workflows/json-format)
- [Prompt Markdown format](/workflows/prompt-md-format)
- [Context references](/workflows/context-files)
- [Agents and skills](/workflows/agents-and-skills)
- [Templates](/workflows/templates)
