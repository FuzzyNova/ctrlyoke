# OpenCode CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`opencode-cli` is the OpenCode-backed harness for teams that already rely on OpenCode as their command-line assistant layer.

## Good fit

- Provider-flexible environments that already use OpenCode
- Workflows where you want ctrlyoke orchestration without switching assistant tooling

## Notes

- The workflow surface is the same as the other CLI harnesses.
- Some permission behavior is mode-based rather than pattern-based, so keep that in mind when comparing it to Copilot CLI or Claude CLI.

## Example

```yaml
harness: opencode-cli
model: opencode/claude-sonnet-4-6

steps:
  - prompt: Summarize the responsibilities of @src/platform/ and suggest one cleanup.
```
