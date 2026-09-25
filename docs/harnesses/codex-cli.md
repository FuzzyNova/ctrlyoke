# Codex CLI

See the [generated compatibility matrix](/harnesses/compatibility) for
capability details and version-scoped evidence.

`codex-cli` lets ctrlyoke drive Codex-based workflows from the same schema used by the other CLI harnesses.

## Good fit

- Teams already using Codex in local or CI workflows
- Workflows that benefit from Codex-specific sandbox and approval controls

## Notes

- Install the Codex CLI (`npm install -g @openai/codex`) and sign in before selecting this harness.
- Codex uses sandbox and approval modes rather than individual tool patterns, so `allowedTools` / `deniedTools` are **not enforced** on this harness. The permission `mode` maps to Codex flags:
  - `dangerouslyAllowAll` → `--dangerously-bypass-approvals-and-sandbox`
  - `allowAll` → `--sandbox workspace-write --ask-for-approval on-request`
  - `custom` → `-s <permissions.codexSandboxMode> -a <permissions.codexApprovalPolicy>`- `permissions.codexSandboxMode` (`read-only`, `workspace-write`, `danger-full-access`; default `workspace-write`) and `permissions.codexApprovalPolicy` (`untrusted`, `on-request`, `never`; default `on-request`) are only read in `custom` mode.
- Headless runs use `codex exec`, which does not accept an approval flag, so only the sandbox flag is passed there.
- Directories in `permissions.allowedExternalFileRoots` are passed to Codex as `--add-dir`.

## Example

```yaml
harness: codex-cli
model: gpt-5.5

steps:
  - prompt: Review @src/cli.ts and simplify the option parsing where practical.
```
