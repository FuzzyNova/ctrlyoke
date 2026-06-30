# Workflow examples

These examples are intentionally small so you can adapt them quickly.

## Architecture review

```yaml
harness: copilot-cli
steps:
  - prompt: Explain the structure of @src/ctrlyoke/ and point out one coupling problem.
```

## Implement with validation

```yaml
harness: claude-cli
model: sonnet
steps:
  - prompt: Fix the failing tests in @src/test/
    endCondition:
      script: npm test
      returns: "0"
      compareSource: exitCode
```

## Script gate before an AI step

```yaml
steps:
  - type: script
    name: check-format
    script: npm run format:check
    compareSource: exitCode
    returns: "0"
    onFail: stopWorkflow

  - prompt: Update the docs after the formatting check passes.
```

## Final-step review loop

```yaml
steps:
  - prompt: Implement the requested feature in @src/

finalStep:
  prompt: Review the work and append follow-up tasks if anything is missing.
  mcpServers:
    - ctrlyoke
```
