# FlightPath Workflow Templates

This document describes the workflow template system for FlightPath - pre-built prompt workflows users can import and customize.

## Overview

FlightPath ships workflow templates that demonstrate common automation patterns. Users can import these as starting points and customize them for their projects.

## Template Categories

```
src/templates/workflows/
├── manifest.json                    # Metadata for all workflows
├── basic.prompt.md                  # Single markdown prompt
├── basic-multi-step.flightpath.json # Sequential prompts
├── with-validation.flightpath.json  # Prompts with end conditions
└── full-feature.flightpath.json     # Complete development workflow
```

## Workflow Templates

### 1. Basic Prompt (`basic.prompt.md`)

**Simplest format** - A single markdown file containing one prompt.

```markdown
Analyze the current codebase structure and suggest improvements for code organization.

Focus on:

- File organization
- Naming conventions
- Code duplication opportunities
```

**Use case**: Quick, one-off tasks that don't need validation or multiple steps.

### 2. Multi-Step Workflow (`basic-multi-step.flightpath.json`)

**Sequential execution** - Multiple prompts that build on each other.

```json
{
  "prompts": [
    {
      "id": "analyze",
      "prompt": "@workspace Analyze the codebase for improvement opportunities"
    },
    {
      "id": "implement",
      "prompt": "Implement the top 3 improvements you identified in the previous step"
    },
    {
      "id": "document",
      "prompt": "Update documentation to reflect the changes made"
    }
  ]
}
```

**Use case**: Tasks that naturally break into phases where each step builds on the previous.

### 3. Workflow with Validation (`with-validation.flightpath.json`)

**Automated validation** - Uses end conditions to verify work before proceeding.

```json
{
  "prompts": [
    {
      "id": "implement-feature",
      "prompt": "@workspace Add error handling to API endpoints"
    },
    {
      "id": "validate",
      "prompt": "Review the implementation and fix any issues",
      "endCondition": {
        "script": "npm test",
        "returns": "true",
        "maxRetries": 2,
        "retryPrompt": "Tests failed. Please fix:\n{scriptOutput}"
      }
    }
  ]
}
```

**Use case**: Tasks requiring automated verification (tests, linting, type checking).

### 4. Full Feature Workflow (`full-feature.flightpath.json`)

**Complete development cycle** - Plan → Implement → Review → Docs → Commit.

```json
{
  "prompts": [
    {
      "id": "plan",
      "prompt": "@workspace [FEATURE DESCRIPTION HERE]\n\nAnalyze the codebase and create a detailed implementation plan. Identify all files that need changes."
    },
    {
      "id": "implement",
      "prompt": "Implement the feature according to the plan. Make all necessary code changes."
    },
    {
      "id": "review",
      "prompt": "Review the implementation for:\n- Code quality\n- Type safety\n- Error handling\n- Security issues\n\nFix any problems found.",
      "endCondition": {
        "script": "npm run lint && npm test",
        "returns": "true",
        "maxRetries": 2,
        "retryPrompt": "Validation failed:\n{scriptOutput}"
      }
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
      "id": "basic-prompt",
      "label": "Basic Prompt (Markdown)",
      "description": "Single prompt in markdown format - simplest option",
      "file": "basic.prompt.md",
      "tags": ["beginner", "single"],
      "icon": "$(file)"
    },
    {
      "id": "basic-multi-step",
      "label": "Multi-Step Workflow",
      "description": "Multiple sequential prompts",
      "file": "basic-multi-step.flightpath.json",
      "tags": ["beginner", "multi-step"],
      "icon": "$(list-ordered)"
    },
    {
      "id": "with-validation",
      "label": "Workflow with Validation",
      "description": "Automated testing/validation between steps",
      "file": "with-validation.flightpath.json",
      "tags": ["intermediate", "validation"],
      "icon": "$(verified)"
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

## Import Command (Future)

**Not yet implemented** - Currently users manually copy templates.

Future `flightpath.importWorkflowTemplate` command will:

1. Show QuickPick with available workflows
2. Copy selected template to `.flightpath/`
3. Open file for customization

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
