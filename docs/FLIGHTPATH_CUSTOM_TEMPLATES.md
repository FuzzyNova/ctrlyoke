# FlightPath Custom Templates System

This document designs the template distribution and import system for FlightPath workflow templates.

## Overview

FlightPath needs a way to ship pre-built workflow templates (like BMAD automation, code review workflows, testing pipelines) that users can easily import into their projects. This extends the existing pattern used for end condition scripts.

---

## Current State

### Existing Template Pattern: End Condition Scripts

FlightPath already has a template system for end condition scripts:

| Component            | Location                                    | Purpose                                  |
| -------------------- | ------------------------------------------- | ---------------------------------------- |
| **Source templates** | `src/templates/*.{js,py,sh,bat,ps1}`        | Script templates in source               |
| **Build copy**       | `esbuild.js` (copyTemplatesPlugin)          | Copies to `out/templates/` during build  |
| **Runtime access**   | `context.extensionPath + "/out/templates/"` | Extension reads bundled templates        |
| **User command**     | `flightpath.createEndConditionScript`       | QuickPick UI to select and copy template |
| **Destination**      | `.flightpath/` in user's workspace          | Where templates are copied               |

**Flow:**

1. User runs command from palette
2. QuickPick shows available script types (Python, JS, Shell, PowerShell)
3. Selected template copied from extension to `.flightpath/`
4. File opened in editor for customization

### Existing Prompt File Creation

The `flightpath.createPromptFile` command creates a new prompt file with hardcoded example content:

```typescript
// FlightPathManager.ts
private createExampleFlightPathContent(): string {
  return JSON.stringify({
    prompts: [
      { prompt: "/explain @workspace..." },
      { prompt: "/fix @workspace...", endCondition: {...} }
    ]
  }, null, 2);
}
```

**Limitation**: Only one generic template, no categories or workflow-specific templates.

---

## Proposed Design

### Template Categories

Organize templates into categories:

```
src/templates/
├── scripts/                    # End condition scripts (existing)
│   ├── check_condition.js
│   ├── check_condition.py
│   ├── check_condition.sh
│   ├── check_condition.bat
│   └── check_condition.ps1
│
└── workflows/                  # NEW: Workflow templates
    ├── getting-started/
    │   ├── simple-prompt.prompt.json
    │   ├── multi-step-workflow.flightpath.json
    │   └── with-validation.flightpath.json
    │
    ├── code-quality/
    │   ├── code-review.flightpath.json
    │   ├── refactoring-workflow.flightpath.json
    │   └── test-generation.flightpath.json
    │
    ├── documentation/
    │   ├── generate-docs.flightpath.json
    │   └── readme-generator.flightpath.json
    │
    └── bmad/                   # BMAD integration templates
        ├── quick-flow-brownfield.flightpath.json
        ├── method-brownfield.flightpath.json
        └── prompts/
            ├── pm-tech-spec.prompt.md
            ├── sm-sprint-planning.prompt.md
            ├── dev-story.prompt.md
            └── ...
```

### Template Manifest

Each category has a manifest file describing available templates:

```json
// src/templates/workflows/manifest.json
{
  "version": "1.0",
  "categories": [
    {
      "id": "getting-started",
      "label": "Getting Started",
      "description": "Basic templates to learn FlightPath",
      "icon": "$(lightbulb)",
      "templates": [
        {
          "id": "simple-prompt",
          "label": "Simple Prompt",
          "description": "Single prompt with no end condition",
          "file": "getting-started/simple-prompt.prompt.json",
          "tags": ["beginner", "single"]
        },
        {
          "id": "multi-step",
          "label": "Multi-Step Workflow",
          "description": "Sequential prompts demonstrating workflow chaining",
          "file": "getting-started/multi-step-workflow.flightpath.json",
          "tags": ["beginner", "multi-step"]
        }
      ]
    },
    {
      "id": "bmad",
      "label": "BMAD Method",
      "description": "BMad agile development workflow automation",
      "icon": "$(rocket)",
      "templates": [
        {
          "id": "quick-flow",
          "label": "Quick Flow (Brownfield)",
          "description": "Fast tech-spec to implementation for small features",
          "file": "bmad/quick-flow-brownfield.flightpath.json",
          "tags": ["bmad", "quick", "brownfield"],
          "includes": ["bmad/prompts/"]
        },
        {
          "id": "method-brownfield",
          "label": "BMad Method (Brownfield)",
          "description": "Full PRD → Architecture → Implementation workflow",
          "file": "bmad/method-brownfield.flightpath.json",
          "tags": ["bmad", "full", "brownfield"],
          "includes": ["bmad/prompts/"]
        }
      ]
    }
  ]
}
```

### New Commands

#### 1. `flightpath.importTemplate`

Main command to browse and import templates:

```typescript
async importTemplate(): Promise<void> {
  // Load manifest
  const manifestPath = path.join(
    this.context.extensionPath,
    "out/templates/workflows/manifest.json"
  );
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));

  // Show category picker
  const category = await vscode.window.showQuickPick(
    manifest.categories.map(c => ({
      label: `${c.icon} ${c.label}`,
      description: c.description,
      category: c
    })),
    { placeHolder: "Select template category" }
  );

  if (!category) return;

  // Show template picker within category
  const template = await vscode.window.showQuickPick(
    category.category.templates.map(t => ({
      label: t.label,
      description: t.description,
      detail: t.tags?.join(', '),
      template: t
    })),
    { placeHolder: `Select ${category.category.label} template` }
  );

  if (!template) return;

  // Copy template and any includes
  await this.copyTemplate(template.template);
}
```

#### 2. `flightpath.createPromptFile` (Enhanced)

Enhance existing command to offer template selection:

```typescript
async createPromptFile(): Promise<void> {
  const choice = await vscode.window.showQuickPick([
    {
      label: "$(new-file) Empty Prompt File",
      description: "Create a blank prompt file",
      action: "empty"
    },
    {
      label: "$(file-symlink-directory) From Template",
      description: "Import a pre-built workflow template",
      action: "template"
    }
  ], { placeHolder: "How would you like to create your prompt file?" });

  if (choice?.action === "template") {
    await this.importTemplate();
  } else if (choice?.action === "empty") {
    // Existing empty file creation logic
    await this.createEmptyPromptFile();
  }
}
```

### Build System Updates

Update `esbuild.js` to handle workflow templates:

```javascript
const copyWorkflowTemplatesPlugin = {
  name: "copy-workflow-templates",
  setup(build) {
    build.onEnd(() => {
      const srcWorkflows = path.join(
        __dirname,
        "src",
        "templates",
        "workflows"
      );
      const outWorkflows = path.join(
        __dirname,
        "out",
        "templates",
        "workflows"
      );

      // Recursively copy workflow templates directory
      copyDirSync(srcWorkflows, outWorkflows);
      console.log(`[copy] templates/workflows/ -> out/templates/workflows/`);
    });
  },
};
```

### Template Copy Logic

Handle templates with associated files (like BMAD prompts):

```typescript
private async copyTemplate(template: TemplateDefinition): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    vscode.window.showErrorMessage("No workspace folder open");
    return;
  }

  const flightpathDir = path.join(workspaceFolder.uri.fsPath, ".flightpath");
  const templatesBase = path.join(this.context.extensionPath, "out/templates/workflows");

  // Copy main template file
  const srcFile = path.join(templatesBase, template.file);
  const destFile = path.join(flightpathDir, path.basename(template.file));
  await this.copyFile(srcFile, destFile);

  // Copy included directories (e.g., bmad/prompts/)
  if (template.includes) {
    for (const include of template.includes) {
      const srcDir = path.join(templatesBase, include);
      const destDir = path.join(flightpathDir, include);
      await this.copyDirRecursive(srcDir, destDir);
    }
  }

  // Open the main template file
  const doc = await vscode.workspace.openTextDocument(destFile);
  await vscode.window.showTextDocument(doc);

  vscode.window.showInformationMessage(
    `✅ Imported template: ${template.label}`,
    "View Files"
  ).then(action => {
    if (action === "View Files") {
      vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(flightpathDir));
    }
  });
}
```

---

## User Experience

### Command Palette

```
> FlightPath: Import Workflow Template
> FlightPath: Create Prompt File
> FlightPath: Create End Condition Script  (existing)
```

### Explorer Context Menu

Right-click on `.flightpath/` folder:

- "Import FlightPath Template..."

### Welcome/Onboarding

When FlightPath activates in a workspace without any `.flightpath/` files:

```
Welcome to FlightPath! 🚀

Get started quickly with a template:
[Import Template]  [Create Empty File]  [Read Docs]
```

---

## Template File Examples

### Getting Started: Simple Prompt

```json
// templates/workflows/getting-started/simple-prompt.prompt.json
{
  "$schema": "https://flightpath.dev/schemas/prompt-schema.json",
  "prompt": "/explain @workspace Analyze this codebase and summarize its architecture"
}
```

### Getting Started: Multi-Step Workflow

```json
// templates/workflows/getting-started/multi-step-workflow.flightpath.json
{
  "$schema": "https://flightpath.dev/schemas/prompt-schema.json",
  "prompts": [
    {
      "id": "analyze",
      "prompt": "/explain @workspace Analyze this codebase for potential improvements"
    },
    {
      "id": "implement",
      "prompt": "Implement the top 3 improvements you identified",
      "endCondition": {
        "script": "npm test",
        "returns": "true",
        "maxRetries": 2,
        "retryPrompt": "Tests failed. Please fix the issues:\n{scriptOutput}"
      }
    }
  ]
}
```

### Code Quality: Code Review

```json
// templates/workflows/code-quality/code-review.flightpath.json
{
  "$schema": "https://flightpath.dev/schemas/prompt-schema.json",
  "prompts": [
    {
      "id": "review",
      "prompt": "@workspace Review all changed files for:\n- Code quality issues\n- Security vulnerabilities\n- Performance concerns\n- Missing tests\n\nProvide specific file:line references for each issue."
    },
    {
      "id": "fix-critical",
      "prompt": "Fix any critical or security issues identified in the review.",
      "endCondition": {
        "script": "npm run lint && npm test",
        "returns": "true"
      }
    }
  ]
}
```

---

## Implementation Phases

### Phase 1: Core Infrastructure

1. Create `src/templates/workflows/` directory structure
2. Create `manifest.json` schema and initial content
3. Update `esbuild.js` with `copyWorkflowTemplatesPlugin`
4. Implement `TemplateManager` class with copy logic

### Phase 2: Commands and UI

1. Add `flightpath.importTemplate` command
2. Enhance `flightpath.createPromptFile` with template option
3. Add explorer context menu for `.flightpath/` folder
4. Register commands in `package.json`

### Phase 3: Initial Templates

1. Create "Getting Started" templates (3-4 examples)
2. Create "Code Quality" templates (2-3 examples)
3. Create "Documentation" templates (1-2 examples)

### Phase 4: BMAD Templates

1. Create BMAD autonomous agents (pm, sm, dev, architect, analyst)
2. Create Quick Flow template with prompts
3. Create Method Brownfield template with prompts
4. Test end-to-end BMAD automation

---

## Configuration

### Settings

```json
{
  "flightpath.templateDirectory": {
    "type": "string",
    "default": ".flightpath",
    "description": "Directory where imported templates are placed"
  },
  "flightpath.showTemplateWelcome": {
    "type": "boolean",
    "default": true,
    "description": "Show template import prompt in empty workspaces"
  }
}
```

### Package.json Contributions

```json
{
  "contributes": {
    "commands": [
      {
        "command": "flightpath.importTemplate",
        "title": "Import Workflow Template",
        "category": "FlightPath",
        "icon": "$(file-symlink-directory)"
      }
    ],
    "menus": {
      "commandPalette": [{ "command": "flightpath.importTemplate" }],
      "explorer/context": [
        {
          "command": "flightpath.importTemplate",
          "when": "explorerResourceIsFolder && resourceFilename == '.flightpath'",
          "group": "flightpath@1"
        }
      ]
    }
  }
}
```

---

## Future Enhancements

### Template Variables

Support variable substitution during import:

```json
{
  "prompts": [
    {
      "prompt": "Analyze {{PROJECT_NAME}} for {{ANALYSIS_TYPE}}"
    }
  ]
}
```

User prompted for values during import.

### Online Template Gallery

```typescript
interface RemoteTemplateSource {
  name: string;
  url: string; // GitHub repo or API endpoint
  enabled: boolean;
}
```

Settings:

```json
{
  "flightpath.templateSources": [
    {
      "name": "FlightPath Official",
      "url": "https://github.com/flightpath/templates",
      "enabled": true
    },
    {
      "name": "Community Templates",
      "url": "https://github.com/flightpath-community/templates",
      "enabled": false
    }
  ]
}
```

### Template Sharing

Command to export current workflow as shareable template:

- `flightpath.exportAsTemplate`
- Creates template package with manifest entry
- Optionally publishes to community repo

---

## Related Documentation

- [BMAD for FlightPath](./BMAD_FOR_FLIGHTPATH.md) - BMAD automation templates
- [Dynamic Queue](./DYNAMIC_QUEUE_USAGE.md) - How templates can extend during execution
- [End Conditions](./END_CONDITIONS.md) - Validation scripts for templates
