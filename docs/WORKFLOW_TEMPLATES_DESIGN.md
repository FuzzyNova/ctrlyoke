# FlightPath Workflow Templates

This document describes the workflow template system for FlightPath - pre-built prompt workflows users can import and customize.

## Overview

FlightPath ships workflow templates that demonstrate common automation patterns. Users can import these as starting points and customize them for their projects.

## Template Categories

```
src/templates/workflows/
├── manifest.json                         # Metadata for all workflows
├── simple-feature.flightpath.json        # Plan → Implement → Commit (same session)
├── fix-tests.flightpath.json             # Fix failing tests with retry loop
└── full-feature.flightpath.json          # Complete development workflow
```

## Workflow Templates

### 1. Simple Feature Workflow (`simple-feature.flightpath.json`)

**Same-session execution** - Uses `newChatSession: false` to maintain context between prompts.

```json
{
  "prompts": [
    {
      "id": "plan",
      "prompt": "[FEATURE DESCRIPTION HERE]\n\nCreate an implementation plan for this feature. Identify all files that need changes and outline the approach."
    },
    {
      "id": "implement",
      "prompt": "Implement the plan you just created. Make all necessary code changes.",
      "newChatSession": false
    },
    {
      "id": "commit",
      "prompt": "Generate a conventional commit message for the changes. Format: feat(scope): description",
      "newChatSession": false
    }
  ]
}
```

**Use case**: Quick feature implementation where context from the planning phase is useful for implementation.

### 2. Fix Tests (`fix-tests.flightpath.json`)

**Validation retry loop** - Keeps fixing until tests pass.

```json
{
  "prompts": [
    {
      "id": "fix-tests",
      "prompt": "There are currently failing tests. Run npm test to see which tests are failing, then fix them.",
      "endCondition": {
        "script": "npm test",
        "returns": "true",
        "maxRetries": 5,
        "retryPrompt": "Tests are still failing. Please fix the remaining issues:\n{scriptOutput}"
      }
    }
  ]
}
```

**Use case**: Automated test fixing with validation loop - keeps retrying until all tests pass.

### 3. Full Feature Workflow (`full-feature.flightpath.json`)

**Complete development cycle** - Plan → Implement → Review → Docs → Commit.

```json
{
  "prompts": [
    {
      "id": "plan",
      "prompt": "[FEATURE DESCRIPTION HERE]\n\nAnalyze the codebase and create a detailed implementation plan. Identify all files that need changes and outline the approach. Create a new document called docs/FEATURE_PLAN.md",
      "endCondition": {
        "script": "test -f docs/FEATURE_PLAN.md",
        "returns": "true",
        "maxRetries": 2,
        "retryPrompt": "The plan document was not created. Please create docs/FEATURE_PLAN.md with the implementation plan."
      }
    },
    {
      "id": "implement",
      "prompt": "Implement the feature according to the plan in #file:docs/FEATURE_PLAN.md. Make all necessary code changes."
    },
    {
      "id": "review",
      "prompt": "Review the implementation for:\n- Code quality\n- Type safety\n- Error handling\n- Security issues\n\nFix any problems found."
    },
    {
      "id": "update-docs",
      "prompt": "Update relevant documentation to explain the new feature."
    },
    {
      "id": "commit-message",
      "prompt": "Generate a conventional commit message. Format: feat(scope): description"
    }
  ]
}
```

**Use case**: Complete feature implementation with full quality assurance.

## File Attachments

Use `#file:` syntax to attach file content to prompts. FlightPath reads the file and includes its content in the prompt context.

**Supported formats:**

```
#file:src/utils/helper.ts              # Attach entire file
#file:src/utils/helper.ts:10-50        # Attach lines 10-50
#file:"path with spaces/file.ts"       # Quoted paths for spaces
#file:"my file.ts":1-20                # Quoted path with line range
```

**Example with file attachment:**

```json
{
  "id": "refactor",
  "prompt": "Refactor this utility to use async/await:\n\n#file:src/utils/legacy.ts"
}
```

**Note:** FlightPath converts `#file:` references to inline content. Other context syntax like `@workspace` or `#codebase` are passed through as literal text (they're Copilot Chat-specific and not processed by FlightPath).

## Model Override

Templates use the default model from FlightPath settings. Override per-prompt when needed:

```json
{
  "id": "quick-task",
  "prompt": "Generate a commit message",
  "model": "claude-haiku-4.5"
}
```

**Available models**: `claude-sonnet-4.5`, `claude-sonnet-4`, `claude-haiku-4.5`, `gpt-5`

## Workflow Manifest

The `manifest.json` describes available templates:

```json
{
  "version": "1.0",
  "description": "FlightPath workflow templates",
  "workflows": [
    {
      "id": "simple-feature",
      "label": "Simple Feature Workflow",
      "description": "Plan → Implement → Commit in same session",
      "file": "simple-feature.flightpath.json",
      "tags": ["beginner", "same-session"],
      "icon": "$(lightbulb)"
    },
    {
      "id": "fix-tests",
      "label": "Fix Tests",
      "description": "Fix failing tests with validation retry loop until they pass",
      "file": "fix-tests.flightpath.json",
      "tags": ["intermediate", "validation", "testing"],
      "icon": "$(testing-run-icon)"
    },
    {
      "id": "full-feature",
      "label": "Full Feature Workflow",
      "description": "Complete Plan→Implement→Review→Docs→Commit workflow",
      "file": "full-feature.flightpath.json",
      "tags": ["advanced", "complete"],
      "icon": "$(rocket)"
    }
  ]
}
```

## Import Command

The `flightpath.importWorkflowTemplates` command:

1. Shows QuickPick with available workflows (multi-select)
2. Copies selected templates to `.flightpath/` (or configured `promptsDirectory`)
3. Prompts for overwrite confirmation if file exists
4. Opens imported workflow for customization

**Usage**: Run `FlightPath: Import Workflow Templates` from Command Palette.

## Build System

Workflow templates are copied during build:

- **Source**: `src/templates/workflows/`
- **Output**: `out/templates/workflows/`
- **Access**: `context.extensionPath + "/out/templates/workflows/"`

The `copyWorkflowTemplatesPlugin` in `esbuild.js` handles this.

## Related Documentation

- [Custom Templates](./FLIGHTPATH_CUSTOM_TEMPLATES.md) - Agent templates and end condition scripts
- [End Conditions](./END_CONDITIONS.md) - Validation script documentation
- [Dynamic Queue](./DYNAMIC_QUEUE_USAGE.md) - How workflows can extend during execution
