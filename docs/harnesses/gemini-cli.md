# Gemini CLI

`gemini-cli` integrates Gemini-based coding workflows into the same FlightPath runtime.

## Good fit

- Teams already using Gemini CLI
- Workflows that need Gemini while still benefiting from FlightPath features such as script gates and queue replay

## Example

```yaml
harness: gemini-cli
model: gemini-2.5-pro

steps:
  - prompt: Explain the architecture of @src/flightpath/ and identify the most coupled area.
```
