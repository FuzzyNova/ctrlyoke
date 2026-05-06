# Codex CLI

`codex-cli` lets FlightPath drive Codex-based workflows from the same schema used by the other CLI harnesses.

## Good fit

- Teams already using Codex in local or CI workflows
- Workflows that benefit from Codex-specific sandbox and approval controls

## Notes

- The standalone `flightpath` CLI currently documents `codex-cli` in its `run` command help alongside `copilot-cli` and `claude-cli`.
- Global settings include Codex-specific defaults for sandbox mode and approval policy.

## Example

```yaml
harness: codex-cli
model: gpt-5.2-codex

steps:
  - prompt: Review @src/cli.ts and simplify the option parsing where practical.
```
