# FlightPath Workflow Templates

This document describes the workflow template system for FlightPath - pre-built prompt workflows users can import and customize with placeholder variables.

## Workspace Folder Structure

FlightPath organizes user files in a structured `.flightpath/` directory:

```
.flightpath/
├── scripts/       # Validation scripts (end conditions)
├── prompts/       # Draft prompts (*.prompt.md)
├── templates/     # Workflow templates with {placeholder} variables
└── workflows/     # Ready-to-run workflows (*.flightpath.json, *.flightpath.yaml)
```

| Folder       | Purpose                              | File Types                             |
| ------------ | ------------------------------------ | -------------------------------------- |
| `scripts/`   | End condition validation scripts     | `.js`, `.py`, `.sh`, `.ps1`, `.bat`    |
| `prompts/`   | Single-prompt drafts for quick tasks | `.prompt.md`                           |
| `templates/` | Parameterized workflow templates     | `.flightpath.json`                     |
| `workflows/` | Executable workflow files            | `.flightpath.json`, `.flightpath.yaml` |

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

FlightPath ships with built-in templates available in the "New Workflow" dialog:

### 0. Blank (`blank.flightpath.json`) - DEFAULT

```json
{
  "prompts": [
    {
      "prompt": ""
    },
    {
      "prompt": ""
    }
  ]
}
```

**Variables detected**: None (user fills in prompts directly after creation)

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

## Dashboard Integration

### Dashboard Header Layout

The dashboard header buttons are organized into two semantic groups:

```
<prompt name> [Select][Edit] | [New Prompt][New Workflow]
             └── current file ──┘ └── creation actions ──┘
```

- **Left group**: Actions on the currently loaded file (Select, Edit)
- **Right group**: Actions to create new files (New Prompt, New Workflow)
- **Divider**: Visual separator between groups

### User Flow

1. **"New Workflow" button** in dashboard header → Opens modal dialog
2. **Select Template** from dropdown in modal (defaults to user's preferred template)
3. **Fill variables** (if template has any) + **enter workflow name**
4. **Create** or **Create & Run** → Saves workflow file and optionally executes

### Modal Dialog

The modal dialog is a CSS overlay within the dashboard webview. It provides focused task completion without leaving the FlightPath panel.

**Design Principles:**

- Template selection dropdown at the top (defaults to `defaultWorkflowTemplate` setting)
- "Set as Default" button to save current selection as the default
- Scrollable variable form for templates with many variables
- Filename input is separate from extension (`.flightpath.json` is automatic)
- Live preview of full save path based on `workflowsDirectory` setting

#### Modal Layout

```
┌─────────────────────────────────────────────────────┐
│ New Workflow                                    [×] │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Template:                                           │
│ ┌─────────────────────────────────────────────[▼]─┐ │
│ │ Blank                                           │ │
│ └─────────────────────────────────────────────────┘ │
│ [Set as Default]                                    │
│                                                     │
│ ─────────────────────────────────────────────────── │
│                                                     │
│ Workflow name:                                      │
│ ┌──────────────────────────────────┐                │
│ │ my-workflow                      │.flightpath.json│
│ └──────────────────────────────────┘                │
│ 📁 .flightpath/workflows/my-workflow.flightpath.json│
│                                                     │
│                        [Cancel] [Create] [Create & Run]
└─────────────────────────────────────────────────────┘
```

#### Template Dropdown Structure

The dropdown shows built-in templates first, then custom templates, then a "Create New Template" action:

```
┌─────────────────────────────────────────────────────┐
│ Blank                                          ← default (or user's default)
│ Simple Feature                                      │
│ Fix Tests                                           │
│ Full Feature                                        │
├─────────────────────────────────────────────────────┤
│ my-custom-workflow                                  │
│ team-review-process                                 │
├─────────────────────────────────────────────────────┤
│ ➕ Create New Template...                           │
└─────────────────────────────────────────────────────┘
```

**Built-in templates** (always available):
| Template | Description |
|----------|-------------|
| **Blank** | Empty 2-prompt workflow |
| **Simple Feature** | Plan → Implement → Commit |
| **Fix Tests** | Run tests and fix failures with retry |
| **Full Feature** | Plan → Implement → Review → Docs → Commit |

**Custom templates** (from `.flightpath/templates/`):

- Listed below first separator
- May include duplicates of built-in templates if user imported them (this is intentional - imported templates are meant to be customized)

**Create New Template** action:

- Always at bottom after second separator
- Closes the modal
- Opens QuickPick to select starting point (Blank, Simple Feature, Fix Tests, Full Feature)
- Imports selected template to `.flightpath/templates/`
- Opens the new template file for editing

#### "Set as Default" Button

Below the template dropdown, a small button allows setting the current selection as the default:

```
Template:
┌─────────────────────────────────────────────[▼]─┐
│ Full Feature                                    │
└─────────────────────────────────────────────────┘
[Set as Default]    ← saves "full-feature" to settings
```

**Behavior:**

- Clicking "Set as Default" updates `flightpath.defaultWorkflowTemplate` setting
- Shows brief confirmation: "✓ Full Feature set as default"
- Works for both built-in and custom templates
- Custom templates are saved by their filename (e.g., `custom:my-template`)

#### With Variables (Example: Full Feature)

When a template with variables is selected, the form expands:

```
┌─────────────────────────────────────────────────────┐
│ New Workflow                                    [×] │
├─────────────────────────────────────────────────────┤
│                                                     │
│ Template:                                           │
│ ┌─────────────────────────────────────────────[▼]─┐ │
│ │ Full Feature                                    │ │
│ └─────────────────────────────────────────────────┘ │
│ [Set as Default]                                    │
│ Plan → Implement → Review → Docs → Commit           │
│                                                     │
│ ┌─────────────────────────────────────────────────┐ │
│ │ featureDescription                              │ │
│ │ ┌─────────────────────────────────────────────┐ │ │
│ │ │ Add user authentication with OAuth2 support │ │ │
│ │ └─────────────────────────────────────────────┘ │ │
│ │                                                 │ │
│ │ planDocument                                    │ │
│ │ ┌─────────────────────────────────────────────┐ │ │
│ │ │ docs/AUTH_PLAN.md                           │ │ │
│ │ └─────────────────────────────────────────────┘ │ │
│ └─────────────────────────────────────────────────┘ │
│                                                     │
│ ─────────────────────────────────────────────────── │
│ Workflow name:                                      │
│ ┌──────────────────────────────────┐                │
│ │ auth-feature                     │.flightpath.json│
│ └──────────────────────────────────┘                │
│ 📁 .flightpath/workflows/auth-feature.flightpath.json
│                                                     │
│                        [Cancel] [Create] [Create & Run]
└─────────────────────────────────────────────────────┘
```

#### "Create New Template" Flow

When user selects "➕ Create New Template..." from dropdown:

1. Modal closes
2. QuickPick opens with starting point options:
   ```
   ┌─────────────────────────────────────────────────────┐
   │ Select a starting point for your new template       │
   ├─────────────────────────────────────────────────────┤
   │ ○ Blank                                             │
   │   Empty 2-prompt workflow                           │
   │                                                     │
   │ ○ Simple Feature                                    │
   │   Plan → Implement → Commit                         │
   │                                                     │
   │ ○ Fix Tests                                         │
   │   Run tests and fix failures with retry             │
   │                                                     │
   │ ○ Full Feature                                      │
   │   Plan → Implement → Review → Docs → Commit         │
   └─────────────────────────────────────────────────────┘
   ```
3. User selects a starting point
4. Input box prompts for template name (e.g., "my-custom-workflow")
5. Template is copied to `.flightpath/templates/{name}.flightpath.json`
6. Template file opens in editor for customization

#### Adaptive Behavior by Variable Count

| Variables | Behavior                                            |
| --------- | --------------------------------------------------- |
| **0**     | Just template dropdown + filename (Blank template)  |
| **1-3**   | Compact form, no scrolling needed                   |
| **4+**    | Scrollable variable form area, sticky header/footer |

#### Filename Input Design

- **Input field**: User types workflow name only (e.g., `auth-feature`)
- **Fixed suffix**: `.flightpath.json` shown as non-editable label
- **Path preview**: Shows full relative path where file will be saved
- **Validation**: Prevents invalid filename characters, shows error inline

```
Workflow name:
┌──────────────────────────────────┐
│ auth-feature                     │.flightpath.json
└──────────────────────────────────┘
📁 Will save to: .flightpath/workflows/auth-feature.flightpath.json
```

#### Keyboard Navigation

| Key          | Action                   |
| ------------ | ------------------------ |
| `Tab`        | Move between form fields |
| `Shift+Tab`  | Move backwards           |
| `Enter`      | Submit form (Create)     |
| `Escape`     | Cancel and close modal   |
| `Ctrl+Enter` | Create & Run             |

#### Accessibility

- All form fields have proper labels
- Focus trap within modal while open
- Screen reader announcements for modal open/close
- Error messages associated with form fields

## Settings

| Setting                              | Type   | Default                 | Description                                                         |
| ------------------------------------ | ------ | ----------------------- | ------------------------------------------------------------------- |
| `flightpath.workflowsDirectory`      | string | `.flightpath/workflows` | Directory for generated workflow files (relative to workspace root) |
| `flightpath.defaultWorkflowTemplate` | string | `blank`                 | Default template selected in "New Workflow" dialog                  |

### workflowsDirectory Setting

Controls where workflows created from templates are saved:

```json
{
  "flightpath.workflowsDirectory": ".flightpath/workflows"
}
```

**Examples:**

- `.flightpath/workflows` (default) - Standard location
- `workflows` - Top-level workflows folder
- `.github/flightpath` - GitHub-style organization

The path preview in the modal updates dynamically based on this setting.

### defaultWorkflowTemplate Setting

Controls which template is pre-selected when opening the "New Workflow" dialog:

```json
{
  "flightpath.defaultWorkflowTemplate": "blank"
}
```

**Values:**

| Value               | Description                                   |
| ------------------- | --------------------------------------------- |
| `blank`             | Empty 2-prompt workflow (default)             |
| `simple-feature`    | Plan → Implement → Commit                     |
| `fix-tests`         | Run tests and fix failures with retry         |
| `full-feature`      | Plan → Implement → Review → Docs → Commit     |
| `custom:{filename}` | Custom template from `.flightpath/templates/` |

**Examples:**

- `"blank"` - Start with empty workflow
- `"full-feature"` - Start with comprehensive workflow
- `"custom:my-team-workflow"` - Start with custom template `my-team-workflow.flightpath.json`

**Setting via UI:**

- Click "Set as Default" button in the New Workflow dialog
- Automatically updates this setting with the currently selected template

## Commands

| Command                        | Description                                                  |
| ------------------------------ | ------------------------------------------------------------ |
| `flightpath.newWorkflow`       | Opens "New Workflow" modal in dashboard                      |
| `flightpath.createNewTemplate` | Creates a new custom template (QuickPick for starting point) |

### newWorkflow Command

Opens the "New Workflow" modal dialog in the dashboard:

- Can be triggered from dashboard "New Workflow" button or command palette
- Modal contains template dropdown, variable form, and filename input
- "Create New Template" option in dropdown triggers `createNewTemplate`
- "Set as Default" button saves current selection to settings

### createNewTemplate Command

Creates a new custom template from a built-in starting point:

1. Shows QuickPick with starting point options (Blank, Simple Feature, Fix Tests, Full Feature)
2. Prompts for template name via input box
3. Copies selected template to `.flightpath/templates/{name}.flightpath.json`
4. Opens the new template file in editor for customization

**Triggered by:**

- Selecting "➕ Create New Template..." from the dropdown in New Workflow modal
- Running command from command palette

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

## Implementation Architecture

### Modal Component Structure

The modal is implemented as a CSS overlay within the existing dashboard webview:

```
dashboard.html
├── #app (main dashboard container)
│   ├── #header
│   ├── #main-content
│   └── #new-workflow-modal (hidden by default)
│       ├── .modal-overlay (dims background)
│       └── .modal-content
│           ├── .modal-header (title + close button)
│           ├── .modal-body
│           │   ├── .template-selector (dropdown + "Set as Default" button)
│           │   ├── .template-description (updates on selection)
│           │   ├── .variables-form (scrollable, shown if variables exist)
│           │   └── .filename-section
│           └── .modal-footer (action buttons)
```

### Message Types

New messages between webview and extension:

| Message                | Direction           | Payload                                             |
| ---------------------- | ------------------- | --------------------------------------------------- |
| `openNewWorkflowModal` | Extension → Webview | `{ templates[], defaultTemplateId, workflowsDir }`  |
| `templateSelected`     | Webview → Extension | `{ templateId }`                                    |
| `templateInfo`         | Extension → Webview | `{ description, variables[] }`                      |
| `setDefaultTemplate`   | Webview → Extension | `{ templateId }`                                    |
| `defaultTemplateSet`   | Extension → Webview | `{ success, templateName }`                         |
| `createWorkflow`       | Webview → Extension | `{ templateId, variables: {}, filename, runAfter }` |
| `workflowCreated`      | Extension → Webview | `{ success, filePath, error? }`                     |
| `closeModal`           | Webview → Extension | `{}`                                                |
| `createNewTemplate`    | Webview → Extension | `{}` (triggers QuickPick flow)                      |

### Template Data Structure

```typescript
interface TemplateInfo {
  id: string;           // Unique identifier (e.g., "blank", "simple-feature", "custom:my-template")
  name: string;         // Display name (e.g., "Blank", "Simple Feature")
  description: string;  // Short description for dropdown/tooltip
  path: string | null;  // Full path to template file (null for built-in "blank")
  variables: string[];  // Extracted variable names
  isBuiltIn: boolean;   // true for Blank/Simple/Fix Tests/Full Feature
  isAction?: boolean;   // true for "Create New Template" action item
}

// Built-in templates (always available, hardcoded)
const BUILT_IN_TEMPLATES: TemplateInfo[] = [
  { id: "blank", name: "Blank", description: "Empty 2-prompt workflow", path: null, variables: [], isBuiltIn: true },
  { id: "simple-feature", name: "Simple Feature", description: "Plan → Implement → Commit", isBuiltIn: true, ... },
  { id: "fix-tests", name: "Fix Tests", description: "Run tests and fix failures with retry", isBuiltIn: true, ... },
  { id: "full-feature", name: "Full Feature", description: "Plan → Implement → Review → Docs → Commit", isBuiltIn: true, ... },
];

// Special action item (always last in dropdown)
const CREATE_TEMPLATE_ACTION: TemplateInfo = {
  id: "__create_new__",
  name: "➕ Create New Template...",
  description: "Create a custom template from a starting point",
  path: null,
  variables: [],
  isBuiltIn: false,
  isAction: true,
};
```

### File Structure

```
src/
├── flightpath/
│   └── TemplateManager.ts       # Template loading, variable extraction, file generation
├── ui/
│   ├── FlightPathDashboardProvider.ts  # Handles template messages
│   └── webview/
│       ├── dashboard.html       # Add modal HTML structure
│       ├── dashboard.css        # Add modal styles
│       └── dashboard.js         # Add modal logic
└── types/
    └── DashboardConstants.ts    # Add MESSAGE_TYPES for templates
```

### TemplateManager Class

```typescript
class TemplateManager {
  // Get all available templates (built-in + custom)
  getAvailableTemplates(): Promise<TemplateInfo[]>;

  // Get template content and extract variables
  getTemplateDetails(
    templateId: string
  ): Promise<{ content: string; variables: string[] }>;

  // Generate "Blank" template content (no file needed)
  getBlankTemplateContent(): string;

  // Replace variables and save new workflow
  createWorkflow(
    templateId: string,
    variables: Record<string, string>,
    outputFilename: string,
    workflowsDir: string
  ): Promise<string>; // Returns path to created file

  // Extract {variableName} patterns from template
  private extractVariables(templateContent: string): string[];
}
```

### Blank Template Handling

The "Blank" template is special:

- **No file on disk** - content is generated in code
- **No variables** - user fills in prompts after creation
- **Default selection** - selected by default when modal opens
- **Minimal structure** - just two empty prompt placeholders

```typescript
getBlankTemplateContent(): string {
  return JSON.stringify({
    prompts: [
      { prompt: "" },
      { prompt: "" }
    ]
  }, null, 2);
}
```
