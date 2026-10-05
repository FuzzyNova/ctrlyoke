# OpenCode CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`opencode-cli` is the OpenCode-backed harness for teams that already rely on OpenCode as their command-line assistant layer.

## Good fit

- Provider-flexible environments that already use OpenCode
- Workflows where you want ctrlyoke orchestration without switching assistant tooling

## Install

Install OpenCode with its install script on macOS and Linux. It has no native Windows installer script, so use npm (or Scoop or Chocolatey) there; OpenCode recommends WSL for the best Windows experience.

macOS and Linux:

```bash
curl -fsSL https://opencode.ai/install | bash
```

Windows (PowerShell):

```powershell
npm install -g opencode-ai
```

Homebrew (`brew install anomalyco/tap/opencode`), Scoop (`scoop install opencode`), and Chocolatey (`choco install opencode`) also work.

See [OpenCode's install guide](https://opencode.ai/docs/) for other install methods.

## Notes

- Make sure `opencode models` lists the models you want before selecting this harness.
- The workflow surface is the same as the other CLI harnesses.
- Models use OpenCode's `provider/model` form. The dashboard lists what `opencode models` reports for your setup.
- Tool permissions (`mode`, `allowedTools`, `deniedTools`), MCP servers, and ctrlyoke's completion plugin are delivered per process through `OPENCODE_CONFIG_CONTENT`; ctrlyoke does not write a workspace `opencode.json`. OpenCode's own categories are coarser than tool patterns (for example, `write` and `edit` both map to OpenCode's `edit` permission).
- `permissions.trustedExternalRoots` is not passed to OpenCode; it has no `--add-dir` equivalent.

## Example

```yaml
harness: opencode-cli
model: opencode/claude-sonnet-4-6

steps:
  - prompt: Summarize the responsibilities of @src/platform/ and suggest one cleanup.
```
