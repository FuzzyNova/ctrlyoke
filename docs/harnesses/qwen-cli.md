# Qwen CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`qwen-cli` runs ctrlyoke workflows against Qwen Code while preserving the same step model, session controls, and validation hooks.

## Good fit

- Teams that already use Qwen Code directly
- Workflows where you want the ctrlyoke queue, history, and script gating on top of Qwen

## Notes

- Install with `npm install -g @qwen-code/qwen-code` and authenticate before selecting this harness.
- The model list comes from the `modelProviders` in `~/.qwen/settings.json`; `qwen3.5-plus` is the fallback.
- ctrlyoke registers its completion hooks in the workspace `.qwen/settings.json` for the duration of a run, then restores the file. MCP servers are passed per process with `--mcp-config`.
- Image references are not attached on this harness, and `error` hooks do not fire. See the [compatibility matrix](/harnesses/compatibility).
- `permissions.allowedExternalFileRoots` is not passed to Qwen; it has no `--add-dir` equivalent.

## Example

```yaml
harness: qwen-cli
model: qwen3.5-plus

steps:
  - prompt: Audit @src/utils/ for duplicated logic and recommend one shared helper.
```
