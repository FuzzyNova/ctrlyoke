# Implement "New Workflow" Modal for FlightPath Dashboard

## Overview

Implement the "New Workflow" modal dialog feature for the FlightPath dashboard as specified in `#file:docs/WORKFLOW_TEMPLATES_DESIGN.md`. This feature allows users to create workflow files from built-in or custom templates, with variable substitution and a streamlined UX.

## Design Reference

The complete UX design and technical specification is in `#file:docs/WORKFLOW_TEMPLATES_DESIGN.md`. Read the "Dashboard Integration" and "Implementation Architecture" sections carefully before implementing.

## Implementation Tasks

### 1. Update Dashboard Header Buttons

**File: `src/ui/webview/dashboard.html`**

Reorganize the header buttons into two semantic groups with a visual divider:

- **Left group** (current file actions): Select, Edit
- **Right group** (creation actions): New Prompt, New Workflow

The "New" button is renamed to "New Prompt" and a new "New Workflow" button is added.

```html
<div class="file-buttons">
  <!-- Current file actions -->
  <button
    id="select-file"
    class="btn-secondary btn-small"
    title="Select a different prompt file"
  >
    Select
  </button>
  <button
    id="edit-file"
    class="btn-secondary btn-small"
    title="Open current prompt file in editor"
    disabled
  >
    Edit
  </button>

  <span class="button-divider"></span>

  <!-- Creation actions -->
  <button
    id="new-prompt"
    class="btn-secondary btn-small"
    title="Create new draft prompt (.prompt.md)"
  >
    New Prompt
  </button>
  <button
    id="new-workflow"
    class="btn-secondary btn-small"
    title="Create workflow from template"
  >
    New Workflow
  </button>
</div>
```

**File: `src/ui/webview/dashboard.css`**

Add divider styling:

```css
.button-divider {
  display: inline-block;
  width: 1px;
  height: 16px;
  background-color: var(--vscode-widget-border);
  margin: 0 8px;
  vertical-align: middle;
}
```

### 2. Add Modal HTML Structure

**File: `src/ui/webview/dashboard.html`**

Add the modal structure at the end of `#app`, before closing `</div>`:

```html
<!-- New Workflow Modal -->
<div id="new-workflow-modal" class="modal" hidden>
  <div class="modal-overlay"></div>
  <div class="modal-content">
    <div class="modal-header">
      <h2>New Workflow</h2>
      <button class="modal-close" title="Close">&times;</button>
    </div>
    <div class="modal-body">
      <div class="template-section">
        <label for="template-select">Template:</label>
        <select id="template-select">
          <!-- Populated dynamically -->
        </select>
        <button
          id="set-default-btn"
          class="btn-link"
          title="Set as default template"
        >
          Set as Default
        </button>
        <span id="default-confirmation" class="confirmation-message" hidden
          >✓ Set as default</span
        >
      </div>
      <p id="template-description" class="template-description"></p>

      <div id="variables-section" class="variables-section" hidden>
        <!-- Variable inputs populated dynamically -->
      </div>

      <div class="filename-section">
        <label for="workflow-name">Workflow name:</label>
        <div class="filename-input-group">
          <input type="text" id="workflow-name" placeholder="my-workflow" />
          <span class="filename-extension">.flightpath.json</span>
        </div>
        <p id="save-path-preview" class="save-path-preview"></p>
        <p id="filename-error" class="error-message" hidden></p>
      </div>
    </div>
    <div class="modal-footer">
      <button id="modal-cancel" class="btn-secondary">Cancel</button>
      <button id="modal-create" class="btn-secondary">Create</button>
      <button id="modal-create-run" class="btn-primary">Create & Run</button>
    </div>
  </div>
</div>
```

### 3. Add Modal CSS Styles

**File: `src/ui/webview/dashboard.css`**

Add styles for the modal overlay, content, form elements, and animations. Key considerations:

- Modal overlay dims the background
- Modal content is centered with max-width
- Variables section is scrollable when many variables exist
- Dropdown shows separators between template groups
- Confirmation message fades in/out

### 4. Add Message Types

**File: `src/types/DashboardConstants.ts`**

Add new message types for template modal communication:

```typescript
// Add to MESSAGE_TYPES object:

// New Workflow Modal - Extension -> Webview
OPEN_NEW_WORKFLOW_MODAL: "openNewWorkflowModal",
TEMPLATE_INFO: "templateInfo",
DEFAULT_TEMPLATE_SET: "defaultTemplateSet",
WORKFLOW_CREATED: "workflowCreated",

// New Workflow Modal - Webview -> Extension
NEW_WORKFLOW: "newWorkflow",  // Opens modal (from button click)
TEMPLATE_SELECTED: "templateSelected",
SET_DEFAULT_TEMPLATE: "setDefaultTemplate",
CREATE_WORKFLOW: "createWorkflow",
CREATE_NEW_TEMPLATE: "createNewTemplate",
CLOSE_MODAL: "closeModal",
```

### 5. Implement Modal JavaScript Logic

**File: `src/ui/webview/dashboard.js`**

Add:

- Event listeners for "New Workflow" button and modal controls
- Template dropdown population with separators (built-in | custom | action)
- Dynamic variable form generation when template changes
- Filename validation (no special characters, not empty)
- Path preview update based on `workflowsDir` setting
- "Set as Default" button with confirmation feedback
- Keyboard navigation (Tab, Escape, Enter, Ctrl+Enter)
- Focus trap within modal

### 6. Create TemplateManager Class

**File: `src/flightpath/TemplateManager.ts`**

```typescript
import * as vscode from "vscode";
import * as path from "path";

export interface TemplateInfo {
  id: string;
  name: string;
  description: string;
  path: string | null;
  variables: string[];
  isBuiltIn: boolean;
  isAction?: boolean;
}

export class TemplateManager {
  private context: vscode.ExtensionContext;
  private workspaceFolder: vscode.WorkspaceFolder | undefined;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  }

  // Built-in template definitions
  private readonly BUILT_IN_TEMPLATES: TemplateInfo[] = [
    {
      id: "blank",
      name: "Blank",
      description: "Empty 2-prompt workflow",
      path: null,
      variables: [],
      isBuiltIn: true,
    },
    {
      id: "simple-feature",
      name: "Simple Feature",
      description: "Plan → Implement → Commit",
      path: null,
      variables: ["featureDescription"],
      isBuiltIn: true,
    },
    {
      id: "fix-tests",
      name: "Fix Tests",
      description: "Run tests and fix failures with retry",
      path: null,
      variables: ["testCommand"],
      isBuiltIn: true,
    },
    {
      id: "full-feature",
      name: "Full Feature",
      description: "Plan → Implement → Review → Docs → Commit",
      path: null,
      variables: ["featureDescription", "planDocument"],
      isBuiltIn: true,
    },
  ];

  async getAvailableTemplates(): Promise<TemplateInfo[]> {
    const templates: TemplateInfo[] = [...this.BUILT_IN_TEMPLATES];

    // Discover custom templates from .flightpath/templates/
    const customTemplates = await this.discoverCustomTemplates();
    templates.push(...customTemplates);

    // Add "Create New Template" action at the end
    templates.push({
      id: "__create_new__",
      name: "➕ Create New Template...",
      description: "Create a custom template from a starting point",
      path: null,
      variables: [],
      isBuiltIn: false,
      isAction: true,
    });

    return templates;
  }

  async getTemplateContent(templateId: string): Promise<string> {
    if (templateId === "blank") {
      return this.getBlankTemplateContent();
    }

    // Load from built-in or custom template file
    // ...
  }

  getBlankTemplateContent(): string {
    return JSON.stringify(
      {
        prompts: [{ prompt: "" }, { prompt: "" }],
      },
      null,
      2
    );
  }

  extractVariables(content: string): string[] {
    const pattern = /\{([a-z][a-zA-Z0-9]*)\}/g;
    const reserved = ["scriptOutput", "retryCount", "maxRetries"];
    const variables = new Set<string>();

    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (!reserved.includes(match[1])) {
        variables.add(match[1]);
      }
    }

    return Array.from(variables);
  }

  async createWorkflow(
    templateId: string,
    variables: Record<string, string>,
    filename: string,
    workflowsDir: string
  ): Promise<string> {
    // Get template content
    // Replace variables
    // Save to workflowsDir
    // Return created file path
  }

  private async discoverCustomTemplates(): Promise<TemplateInfo[]> {
    // Scan .flightpath/templates/ for .flightpath.json files
    // ...
  }
}
```

### 7. Update FlightPathDashboardProvider

**File: `src/ui/FlightPathDashboardProvider.ts`**

Add:

- TemplateManager instance
- Handle new message types from webview
- Send template list when modal opens
- Handle template selection and variable extraction
- Handle "Set as Default" (update settings)
- Handle "Create Workflow" (create file, optionally load and run)
- Handle "Create New Template" (trigger command)

### 8. Add Settings to package.json

**File: `package.json`**

Add new settings under `contributes.configuration.properties`:

```json
"flightpath.workflowsDirectory": {
  "type": "string",
  "default": ".flightpath/workflows",
  "description": "Directory for generated workflow files (relative to workspace root)"
},
"flightpath.defaultWorkflowTemplate": {
  "type": "string",
  "default": "blank",
  "description": "Default template selected in 'New Workflow' dialog",
  "enum": ["blank", "simple-feature", "fix-tests", "full-feature"],
  "enumDescriptions": [
    "Empty 2-prompt workflow",
    "Plan → Implement → Commit",
    "Run tests and fix failures with retry",
    "Plan → Implement → Review → Docs → Commit"
  ]
}
```

Note: Custom templates use `custom:{filename}` format stored as string, but enum only shows built-in options for discoverability.

### 9. Register Commands

**File: `src/extension.ts`**

Register new commands:

- `flightpath.newWorkflow` - Opens modal (can also be triggered from dashboard)
- `flightpath.createNewTemplate` - Shows QuickPick for starting point, creates template file

### 10. Create Built-in Template Files

**Directory: `src/templates/workflows/`**

Create template files that will be bundled with the extension:

- `simple-feature.flightpath.json`
- `fix-tests.flightpath.json`
- `full-feature.flightpath.json`

Note: "Blank" template is generated in code, not stored as a file.

Also create/update `manifest.json` with template metadata.

## Key UX Requirements

1. **Modal opens with user's default template selected** (from `defaultWorkflowTemplate` setting)
2. **Template dropdown shows groups with separators**: Built-in | Custom | Create New
3. **Variables form appears/disappears** based on selected template
4. **Filename validation** prevents invalid characters and empty names
5. **Path preview updates** in real-time based on filename input
6. **"Set as Default" button** shows brief confirmation, updates setting
7. **"Create New Template" action** closes modal, opens QuickPick flow
8. **Keyboard shortcuts**: Escape=close, Enter=Create, Ctrl+Enter=Create & Run
9. **Focus management**: Focus trap in modal, focus first input on open

## Testing Checklist

- [ ] "New Prompt" button still works (renamed from "New")
- [ ] "New Workflow" button opens modal
- [ ] Modal can be closed with X button, Cancel, or Escape key
- [ ] Template dropdown shows built-in templates, custom templates (if any), and "Create New Template" action
- [ ] Selecting a template updates description and variables form
- [ ] Variables form shows input for each variable in template
- [ ] Filename validation prevents special characters
- [ ] Path preview shows correct path based on `workflowsDirectory` setting
- [ ] "Set as Default" updates setting and shows confirmation
- [ ] "Create" creates workflow file and closes modal
- [ ] "Create & Run" creates workflow file, loads it, and starts execution
- [ ] "Create New Template" closes modal and opens QuickPick
- [ ] Created workflow file has correct content with variables substituted
- [ ] Modal state resets when reopened

## Implementation Order

1. Add MESSAGE_TYPES to DashboardConstants.ts
2. Create TemplateManager.ts with basic structure
3. Update dashboard.html with buttons and modal structure
4. Add modal styles to dashboard.css
5. Implement modal JavaScript in dashboard.js
6. Update FlightPathDashboardProvider.ts to handle messages
7. Add settings to package.json
8. Register commands in extension.ts
9. Create template files in src/templates/workflows/
10. Test end-to-end flow
