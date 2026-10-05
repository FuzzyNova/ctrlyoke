# Qwen CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`qwen-cli` runs ctrlyoke workflows against Qwen Code while preserving the same step model, session controls, and validation hooks.

## Good fit

- Teams that already use Qwen Code directly
- Workflows where you want the ctrlyoke queue, history, and script gating on top of Qwen

## Install

Install Qwen Code with its standalone installer:

macOS and Linux:

```bash
curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.sh | bash
```

Windows (PowerShell):

```powershell
irm https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/installation/install-qwen-standalone.ps1 | iex
```

Homebrew (`brew install qwen-code`) and npm (`npm install -g @qwen-code/qwen-code@latest`, Node.js 22+) also work. Restart your terminal after installing.

See [the Qwen Code README](https://github.com/QwenLM/qwen-code#installation) for other install methods.

## Notes

- Authenticate with `qwen` once before selecting this harness.
- The model list comes from the `modelProviders` in `~/.qwen/settings.json`; `qwen3.5-plus` is the fallback.
- ctrlyoke registers its completion hooks in the workspace `.qwen/settings.json` for the duration of a run, then restores the file. MCP servers are passed per process with `--mcp-config`.
- Image references are not attached on this harness, and `error` hooks do not fire. See the [compatibility matrix](/harnesses/compatibility).
- `permissions.trustedExternalRoots` is not passed to Qwen; it has no `--add-dir` equivalent.

## Example

```yaml
harness: qwen-cli
model: qwen3.5-plus

steps:
  - prompt: Audit @src/utils/ for duplicated logic and recommend one shared helper.
```
