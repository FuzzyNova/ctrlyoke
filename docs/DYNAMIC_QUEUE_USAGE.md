# Dynamic Queue Usage Guide

## Overview

Dynamic Queue is an advanced FlightPath feature that allows GitHub Copilot to autonomously extend workflows by adding new prompts to `.flightpath.json` files during execution. This transforms FlightPath from a static workflow executor into an adaptive autonomous agent framework.

## Enabling Dynamic Queue

Dynamic Queue is **disabled by default**. To enable it:

1. Open VS Code Settings (`Ctrl+,` or `Cmd+,`)
2. Search for "FlightPath"
3. Enable `FlightPath: Enable Dynamic Queue`

### Related Settings

- **Enable Dynamic Queue** (`flightpath.enableDynamicQueue`): Master switch (default: `false`)
- **Dynamic Extension On Last Prompt** (`flightpath.dynamicExtensionOnLastPrompt`): Allow extension on last prompt when no explicit flags set (default: `true`)
- **Max Queue Size** (`flightpath.maxQueueSize`): Maximum prompts allowed (default: `100`, range: 1-1000)
- **Max Execution Time** (`flightpath.maxExecutionTime`): Maximum execution time in seconds (default: `18000` = 5 hours, range: 300-86400)
- **Unlimited Mode** (`flightpath.unlimitedMode`): Ignore all limits (default: `false`, may be restricted in future paid tier)
- **Notify On Queue Extension** (`flightpath.notifyOnQueueExtension`): Show notifications when queue grows (default: `true`)

## How It Works

### Prompt Identity Tracking

FlightPath tracks completed prompts using a **hybrid identity system**:

1. **Explicit ID** (optional): User or Copilot-provided `id` field (e.g., `"id": "analyze-code"`)
2. **Content Hash** (automatic): SHA-256 hash of prompt text as fallback

When reloading the queue, prompts matching completed IDs or hashes are skipped to prevent duplicate execution.

### Selective Instruction Injection

Dynamic queue instructions are only injected when:

1. **Explicit flag**: Prompt has `"allowDynamicExtension": true`, OR
2. **Default behavior**: It's the last prompt AND no other prompts have explicit `allowDynamicExtension` flags

This saves tokens and gives you fine-grained control over which prompts can extend the queue.

### Safety Guardrails

- **Queue size limit**: Prevents infinite loops (configurable, default: 100 prompts)
- **Execution time limit**: Stops runaway workflows (configurable, default: 5 hours)
- **Invalid JSON handling**: Graceful error recovery if file is corrupted
- **Pause-aware timing**: Time spent paused doesn't count toward execution limit

## Usage Patterns

### 1. Explicit Extension (Recommended)

Use `allowDynamicExtension: true` on specific prompts that should be able to extend the workflow.

```json
{
  "prompts": [
    {
      "id": "analyze",
      "prompt": "Examine the codebase and identify issues"
    },
    {
      "id": "fix",
      "prompt": "Fix the issues. If you need multiple steps, add them to this file.",
      "allowDynamicExtension": true
    }
  ]
}
```

**Benefits**:

- Explicit control over where extension happens
- Clear intent documented in the file
- Prevents accidental extensions

### 2. Default Behavior (Last Prompt)

When no prompts have explicit `allowDynamicExtension` flags, only the **last prompt** can extend the queue (if `dynamicExtensionOnLastPrompt` setting is `true`).

```json
{
  "prompts": [
    {
      "id": "task-1",
      "prompt": "Do initial analysis"
    },
    {
      "id": "task-2",
      "prompt": "Create implementation plan. Add more tasks if needed."
    }
  ]
}
```

**Benefits**:

- Simpler JSON (no flags needed)
- Last prompt naturally becomes the "decision point"
- Can disable with setting if you want fully static queues

### 3. Disable Extension

Use `allowDynamicExtension: false` to explicitly prevent extension on specific prompts.

```json
{
  "prompts": [
    {
      "id": "implement",
      "prompt": "Implement the feature",
      "allowDynamicExtension": true
    },
    {
      "id": "commit",
      "prompt": "Commit all changes",
      "allowDynamicExtension": false
    }
  ]
}
```

**Benefits**:

- Ensure critical final steps (like commits) never get extended
- Mix extensible and static prompts in same workflow

## Example Workflows

### Adaptive Debugging

```json
{
  "prompts": [
    {
      "id": "gather-logs",
      "prompt": "Examine error logs and identify the exception stack trace"
    },
    {
      "id": "diagnose",
      "prompt": "Analyze the stack trace and determine the root cause. If multiple potential causes exist, add diagnostic prompts to this file (bugfix.flightpath.json) to investigate each one.",
      "allowDynamicExtension": true
    }
  ]
}
```

### Exploratory Refactoring

```json
{
  "prompts": [
    {
      "id": "analyze-arch",
      "prompt": "Review the codebase architecture and identify areas that violate SOLID principles"
    },
    {
      "id": "plan-refactor",
      "prompt": "Based on the analysis, add specific refactoring tasks to this file (.flightpath/refactor.flightpath.json). Each task should refactor one module or component.",
      "allowDynamicExtension": true
    }
  ]
}
```

### Iterative Feature Development

```json
{
  "prompts": [
    {
      "id": "scaffold",
      "prompt": "Create the basic feature scaffold with types and interfaces"
    },
    {
      "id": "implement-core",
      "prompt": "Implement core feature logic. After implementation, add prompts to this file for: 1) Adding tests, 2) Adding error handling, 3) Adding documentation",
      "allowDynamicExtension": true,
      "endCondition": {
        "script": "verify_core_implementation.js",
        "returns": "true"
      }
    }
  ]
}
```

## What Copilot Sees

When `allowDynamicExtension` is enabled for a prompt, Copilot receives these instructions wrapped in `<criticalInstruction>` XML tags:

```xml
<criticalInstruction>
You are executing prompt 2 of 3 in a FlightPath workflow.

DYNAMIC QUEUE EXTENSION:
If you need additional steps to complete this task, you can extend the workflow:
1. Read the current file: .flightpath/bugfix.flightpath.json
2. Insert new prompts AFTER the current prompt (index 2) in the "prompts" array
   - Recommended: Insert immediately after current position for logical flow
   - Alternative: Append to end of array if order doesn't matter
3. Include "id" fields for clarity (e.g., "id": "step-4-refactor-auth")
4. Optionally set "allowDynamicExtension": true on prompts that may need further extension
5. Keep existing prompts intact - DO NOT modify or delete completed prompts
6. Save the file - FlightPath will detect changes and continue

Current queue: 3/100 prompts
Max execution time: 18000s

IMPORTANT: Only extend the queue if truly necessary. Each prompt adds execution time.
</criticalInstruction>
```

**Note**: VS Code's Copilot Chat UI **hides XML tags** from the visible chat history, but Copilot still processes them. This keeps the chat clean while enabling automation.

## Best Practices

### 1. Use Descriptive IDs

```json
{
  "id": "refactor-auth-module",
  "prompt": "Refactor authentication module to use async/await"
}
```

Good IDs make it easy to understand the workflow and debug issues.

### 2. Guide Copilot's Extension Logic

Be explicit about when and how to extend:

```json
{
  "id": "implement",
  "prompt": "Implement the feature. If you encounter blockers or the task requires multiple steps, break it down by adding prompts to this file.",
  "allowDynamicExtension": true
}
```

### 3. Set Reasonable Limits

For exploratory work:

```json
// Settings: maxQueueSize: 50, maxExecutionTime: 3600 (1 hour)
```

For autonomous agents:

```json
// Settings: maxQueueSize: 200, maxExecutionTime: 18000 (5 hours)
```

For unlimited experimentation (use with caution):

```json
// Settings: unlimitedMode: true
```

### 4. Use End Conditions with Dynamic Queues

Combine validation with extension for robust workflows:

```json
{
  "id": "implement-feature",
  "prompt": "Implement the feature. Add tests and documentation if needed.",
  "allowDynamicExtension": true,
  "endCondition": {
    "script": "npm test",
    "returns": "true",
    "maxRetries": 3
  }
}
```

### 5. Monitor Queue Growth

Enable notifications to stay informed:

- Notifications show: `"Queue extended (+2 prompts, 5/100)"`
- Dashboard displays real-time queue size
- Output panel logs all extensions

## Troubleshooting

### Queue Not Extending

1. **Check setting**: Is `enableDynamicQueue` enabled?
2. **Check flags**: Does prompt have `allowDynamicExtension: true` or is it the last prompt?
3. **Check file path**: Is FlightPath executing from a `.flightpath.json` file (not `.prompt.md`)?
4. **Check logs**: Look in Output panel (FlightPath channel) for reload messages

### Invalid JSON Errors

If Copilot creates invalid JSON:

- FlightPath logs the error and continues with current queue
- Notification shows: "Queue file has invalid JSON. Continuing with current queue."
- Fix the JSON manually and run again

### Queue Size Limit Reached

If you see: "Queue limit reached (100/100 prompts)"

- Increase `maxQueueSize` in settings, OR
- Enable `unlimitedMode` (use with caution)

### Execution Time Limit Reached

If you see: "Maximum execution time reached"

- Increase `maxExecutionTime` in settings, OR
- Enable `unlimitedMode`, OR
- Break work into smaller workflows

## Security Considerations

- **Workspace-only**: Dynamic queue only modifies files in your workspace
- **No automatic execution**: Queue extensions don't auto-start - FlightPath just adds prompts and continues current execution
- **Validation**: JSON schema validation ensures file integrity
- **User control**: You can pause/stop at any time

## Future Enhancements

Planned features (post-MVP):

- **Tool-based API**: `flightpath.addPrompt()` for cleaner extension
- **Queue branching**: Conditional workflow paths
- **Prompt templates**: Pre-built dynamic queue patterns
- **Analytics**: Track queue growth patterns and success rates
- **Rollback support**: Undo queue extensions

## FAQ

**Q: Does this work with Chat mode?**
A: Yes! Dynamic queue works with both CLI and Chat integration modes.

**Q: Can I use this with single-prompt `.prompt.md` files?**
A: No. Dynamic queue only works with `.flightpath.yaml` and `.flightpath.json` files (which support the `prompts` array).

**Q: Will this use a lot of tokens?**
A: Instructions are only injected on prompts that need them (explicit flag or last prompt). Each instruction adds ~200 tokens.

**Q: What happens if Copilot adds duplicate prompts?**
A: FlightPath's content hashing prevents re-execution of duplicates.

**Q: Can I manually edit the queue during execution?**
A: Yes, but changes only take effect after the current prompt completes (FlightPath reloads between prompts).

**Q: Is this feature free?**
A: Currently yes, but `unlimitedMode` may be restricted to a paid tier in future releases.
