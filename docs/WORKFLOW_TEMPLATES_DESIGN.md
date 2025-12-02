# FlightPath Workflow Templates

This document describes the workflow template system for FlightPath - pre-built prompt workflows users can import and customize with placeholder variables.

## Workspace Folder Structure

FlightPath organizes user files in a structured `.flightpath/` directory:

```
.flightpath/
├── scripts/       # Validation scripts (end conditions)
├── prompts/       # Draft prompts (*.prompt.md)
├── templates/     # Workflow templates with {placeholder} variables
└── workflows/     # Ready-to-run workflows (*.flightpath.json, *.prompt.json)
```

| Folder       | Purpose                              | File Types                          |
| ------------ | ------------------------------------ | ----------------------------------- |
| `scripts/`   | End condition validation scripts     | `.js`, `.py`, `.sh`, `.ps1`, `.bat` |
| `prompts/`   | Single-prompt drafts for quick tasks | `.prompt.md`                        |
| `templates/` | Parameterized workflow templates     | `.flightpath.json`                  |
| `workflows/` | Executable workflow files            | `.flightpath.json`, `.prompt.json`  |

## Template Detection

Templates and workflows use the same `.flightpath.json` extension. FlightPath distinguishes them by:

1. **Location**: Files in `.flightpath/templates/` are treated as templates
2. **Variable detection**: Files containing `{variableName}` patterns are templates

This means:

- Templates ARE valid workflows - they just have placeholders
- You can run a template directly (placeholders become literal text)
- Or generate a workflow from it with values filled in

## Template Variables

Templates use `{variableName}` syntax for placeholder values:

```json
{
  "prompts": [
    {
      "id": "scan",
      "prompt": "Look at {directory} and scan all the files, then create a summary."
    },
    {
      "id": "save",
      "prompt": "Save the summary to {outputFile} in {outputDir}."
    }
  ]
}
```

**Variable extraction**: FlightPath scans the template for unique `{camelCase}` patterns and presents a form for the user to fill in values.

**Example form for above template:**

| Variable     | Value           |
| ------------ | --------------- |
| `directory`  | `[input field]` |
| `outputFile` | `[input field]` |
| `outputDir`  | `[input field]` |

### Variable Naming Convention

- Use `camelCase` for variable names: `{sourceDir}`, `{outputFile}`
- Descriptive names: `{testCommand}` not `{cmd}`
- Reuse variables when the same value appears multiple times

### Reserved Variables (Future)

Some variables may be auto-populated in the future:

| Variable          | Description                   |
| ----------------- | ----------------------------- |
| `{workspaceRoot}` | Current workspace folder path |
| `{workspaceName}` | Current workspace folder name |
| `{currentFile}`   | Active editor file path       |
| `{date}`          | Current date (YYYY-MM-DD)     |
| `{timestamp}`     | Current timestamp             |

## Built-in Templates

FlightPath ships with starter templates that users can import:

### 1. Simple Feature (`simple-feature.flightpath.json`)

```json
{
  "prompts": [
    {
      "id": "plan",
      "prompt": "{featureDescription}\n\nCreate an implementation plan for this feature. Identify all files that need changes."
    },
    {
      "id": "implement",
      "prompt": "Implement the plan you just created. Make all necessary code changes.",
      "newChatSession": false
    },
    {
      "id": "commit",
      "prompt": "Generate a conventional commit message. Format: feat(scope): description",
      "newChatSession": false
    }
  ]
}
```

**Variables detected**: `featureDescription`

### 2. Fix Tests (`fix-tests.flightpath.json`)

```json
{
  "prompts": [
    {
      "id": "fix-tests",
      "prompt": "There are currently failing tests. Run {testCommand} to see which tests are failing, then fix them.",
      "endCondition": {
        "script": "{testCommand}",
        "returns": "true",
        "maxRetries": 5,
        "retryPrompt": "Tests are still failing. Please fix the remaining issues:\n{scriptOutput}"
      }
    }
  ]
}
```

**Variables detected**: `testCommand`

### 3. Full Feature (`full-feature.flightpath.json`)

```json
{
  "prompts": [
    {
      "id": "plan",
      "prompt": "{featureDescription}\n\nAnalyze the codebase and create a detailed implementation plan. Save it to {planDocument}",
      "endCondition": {
        "script": "test -f {planDocument}",
        "returns": "true",
        "maxRetries": 2,
        "retryPrompt": "The plan document was not created. Please create {planDocument} with the implementation plan."
      }
    },
    {
      "id": "implement",
      "prompt": "Implement the feature according to the plan in #file:{planDocument}. Make all necessary code changes."
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

**Variables detected**: `featureDescription`, `planDocument`

## Dashboard Integration (Planned)

### Create Workflow from Template

A new dashboard button **"New from Template"** opens the template workflow:

1. **Select Template**: QuickPick shows available templates from:
   - `.flightpath/templates/` (user templates)
   - Built-in FlightPath templates

2. **Fill Variables**: Form panel displays input fields for each detected `{variable}`:
   - Variable name shown as label
   - All fields are simple text inputs

3. **Generate Workflow**: FlightPath:
   - Replaces all `{variable}` placeholders with values
   - Saves to `.flightpath/workflows/` with user-chosen filename
   - Opens the new workflow file
   - Optionally starts execution immediately

### Template Form UI (Planned)

```
┌─────────────────────────────────────────────────────┐
│ Create Workflow from Template                        │
├─────────────────────────────────────────────────────┤
│ Template: Full Feature Workflow                      │
│                                                      │
│ featureDescription:                                  │
│ ┌─────────────────────────────────────────────────┐ │
│ │ Add user authentication with OAuth2 support     │ │
│ └─────────────────────────────────────────────────┘ │
│                                                      │
│ planDocument:                                        │
│ ┌─────────────────────────────────────────────────┐ │
│ │ docs/FEATURE_PLAN.md                            │ │
│ └─────────────────────────────────────────────────┘ │
│                                                      │
│ Save as: ┌────────────────────────────────────────┐ │
│          │ auth-feature.flightpath.json           │ │
│          └────────────────────────────────────────┘ │
│                                                      │
│              [Cancel]  [Create]  [Create & Run]     │
└─────────────────────────────────────────────────────┘
```

## Commands

| Command                              | Description                                           |
| ------------------------------------ | ----------------------------------------------------- |
| `flightpath.importWorkflowTemplates` | Import built-in templates to `.flightpath/templates/` |
| `flightpath.createFromTemplate`      | Create workflow from template (planned)               |

## Import Command

The `flightpath.importWorkflowTemplates` command:

1. Shows QuickPick with available templates (multi-select)
2. Copies selected templates to `.flightpath/templates/`
3. Prompts for overwrite confirmation if file exists
4. Opens imported template for review

## Variable Extraction Algorithm

FlightPath extracts variables using a simple regex pattern:

```javascript
const variablePattern = /\{([a-z][a-zA-Z0-9]*)\}/g;
```

This matches:

- `{featureDescription}` ✓
- `{testCommand}` ✓
- `{planDocument}` ✓
- `{scriptOutput}` ✗ (reserved for retry prompts)
- `{retryCount}` ✗ (reserved)
- `{maxRetries}` ✗ (reserved)

Reserved variables are filtered out during extraction.

## Build System

Templates are copied during build:

- **Source**: `src/templates/workflows/`
- **Output**: `out/templates/workflows/`
- **Access**: `context.extensionPath + "/out/templates/workflows/"`

The existing `copyTemplatesPlugin` in `esbuild.js` handles subdirectory copying.

## Related Documentation

- [Custom Templates](./FLIGHTPATH_CUSTOM_TEMPLATES.md) - Agent templates and end condition scripts
- [End Conditions](./END_CONDITIONS.md) - Validation script documentation
- [Dynamic Queue](./DYNAMIC_QUEUE_USAGE.md) - How workflows can extend during execution
