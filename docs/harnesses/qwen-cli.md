# Qwen CLI

`qwen-cli` runs FlightPath workflows against Qwen Code while preserving the same step model, session controls, and validation hooks.

## Good fit

- Teams that already use Qwen Code directly
- Workflows where you want the FlightPath queue, history, and script gating on top of Qwen

## Example

```yaml
harness: qwen-cli
model: qwen3.5-plus

steps:
  - prompt: Audit @src/utils/ for duplicated logic and recommend one shared helper.
```
