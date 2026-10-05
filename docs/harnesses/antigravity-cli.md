# Antigravity CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`antigravity-cli` integrates Google's Antigravity CLI (`agy`) into ctrlyoke.

Use it when:

- You want Google's current CLI path for coding workflows
- You need Antigravity model choices such as Gemini Flash, Claude, or GPT-OSS
- You want ctrlyoke workflow execution, MCP, agents, skills, and history around `agy`

```yaml
harness: antigravity-cli
model: gemini-3.6-flash-low
steps:
  - prompt: Update the implementation and run the focused tests.
```

## Install

Install `agy` with Google's installer. It is not published to npm.

macOS and Linux:

```bash
curl -fsSL https://antigravity.google/cli/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://antigravity.google/cli/install.ps1 | iex
```

From Windows CMD, run `curl -fsSL https://antigravity.google/cli/install.cmd -o install.cmd && install.cmd && del install.cmd` instead.

See [the Antigravity CLI docs](https://antigravity.google/docs/cli-overview) for other install methods.

## Notes

- Authenticate with `agy` once before selecting this harness.
- ctrlyoke requires `agy` 1.1.12 or newer.
- Permissions are coarse modes only: `dangerouslyAllowAll` passes `--dangerously-skip-permissions`, `custom` passes `--sandbox`, and `allowAll` passes nothing, so `agy` applies its own approval behavior. `allowedTools` / `deniedTools` are not enforced, and MCP servers cannot be filtered per tool. Image references are not attached.
- Only the `preToolUse`, `postToolUse`, `sessionStart`, and `stop` hook events fire; `userPromptSubmit`, `permissionRequest`, `notification`, and `error` do not.
- MCP servers are written to the workspace `.agents/mcp_config.json`, which `agy` discovers on its own. There is no per-prompt server scoping, so parallel workflows in one workspace share that file's servers.
- ctrlyoke's hooks go in `~/.gemini/config/hooks.json` and its statusline in `~/.gemini/antigravity-cli/settings.json`; ctrlyoke restores both files when the run ends.
- ctrlyoke's default Antigravity model is `gemini-3.6-flash-medium`, not `agy`'s own Claude Sonnet default.
- Models are the IDs `agy models` prints (`gemini-3.6-flash-low`, `claude-sonnet-4-6`, …). The dashboard shows agy's friendlier labels ("Gemini 3.6 Flash (Low)"), and `agy` itself accepts either spelling, but workflow files and settings use the ID.
- For manual test runs, prefer a Gemini Flash tier to avoid exhausting the much smaller Claude quota.
- Antigravity stores some user-level config under `~/.gemini/`; those paths are expected and are not Gemini CLI support.
