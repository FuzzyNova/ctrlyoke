# Gemini CLI

`gemini-cli` integrates Gemini-based coding workflows into the same ctrlyoke runtime.

## Good fit

- Teams already using Gemini CLI
- Workflows that need Gemini while still benefiting from ctrlyoke features such as script gates and queue replay

## Example

```yaml
harness: gemini-cli
model: gemini-2.5-pro

steps:
  - prompt: Explain the architecture of @src/ctrlyoke/ and identify the most coupled area.
```
