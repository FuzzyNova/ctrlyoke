# Template Setup Scripts

**Status**: Planning  
**Date**: December 19, 2025  
**Purpose**: Extend ctrlyoke's workflow template system to support setup scripts that dynamically generate workflow content

---

## Executive Summary

ctrlyoke's template system currently supports simple `{variable}` replacement for creating workflows. This design adds **optional setup scripts** that can analyze the workspace and programmatically generate workflow content, enabling powerful templates like:

- **Generate Repository Instructions**: Analyzes directory structure, creates AGENTS.md prompts for each relevant directory
- **Component Test Generator**: Discovers React components, generates test prompts for each
- **API Documentation**: Finds route definitions, creates documentation prompts per endpoint
- **Refactor Package**: Analyzes module dependencies, creates refactoring workflow

**Key Principles**:

- **Optional enhancement**: Existing simple templates continue to work unchanged
- **Full workspace access**: Scripts can read/write files (they generate the workflow files after all)
- **User trust model**: Built-in templates trusted, custom templates require first-run consent
- **Unified UX**: Setup scripts integrate seamlessly into existing "New Workflow" flow

---

## Architecture Integration

### Existing Template System

From WORKFLOW_TEMPLATES_DESIGN.md, templates currently work like this:

```json
{
  "prompts": [
    {
      "prompt": "Implement {featureDescription}"
    }
  ]
}
```

User flow:

1. Select template from dropdown
2. Fill variable form (`{featureDescription}`)
3. Enter workflow filename
4. Create → workflow saved to `.ctrlyoke/workflows/`

### Enhanced Template System

Templates can now optionally include a setup script:

```json
{
  "name": "Generate Repository Instructions",
  "description": "Create AGENTS.md files for repository structure",
  "setupScript": "scripts/analyze-repo-for-agents.js",
  "prompts": []
}
```

Enhanced user flow:

1. Select template from dropdown
2. **If `setupScript` exists**: Script runs, generates workflow content
3. **If script outputs variables**: Fill variable form with pre-populated values
4. Enter workflow filename (or use script-suggested name)
5. Create → workflow saved

---

## Setup Script Interface

### Execution Environment

**Working directory**: Workspace root  
**Process**: Isolated Node.js process  
**Permissions**: Full file system access (same as extension)  
**Timeout**: Configurable setting (default: 120 seconds, or no timeout for v1)

### Script Input

Setup scripts receive context via **command-line arguments**:

```bash
node scripts/analyze-repo-for-agents.js \
  --workspace-root "/path/to/workspace" \
  --template-path "/path/to/template.ctrlyoke.json" \
  --settings-json '{"createClaudeMdSymlinks":false,...}'
```

**Available arguments**:

- `--workspace-root`: Absolute path to workspace folder
- `--template-path`: Absolute path to template file
- `--settings-json`: JSON string of relevant ctrlyoke settings

**Environment variables**:

- `CTRLYOKE_SETUP=true`: Indicates script is running in ctrlyoke context
- Standard Node.js environment

### Script Output

Scripts write to **stdout** as JSON. Three output modes:

#### Mode 1: Full Workflow Generation

Replace the entire template with generated workflow:

```json
{
  "mode": "workflow",
  "workflow": {
    "prompts": [
      {
        "id": "analyze-ui",
        "prompt": "Analyze src/ui directory and create AGENTS.md if needed"
      },
      {
        "id": "analyze-src",
        "prompt": "Analyze src directory, review child AGENTS.md files, create parent AGENTS.md"
      }
    ]
  },
  "suggestedFilename": "generate-agents-md"
}
```

**Use case**: Templates where structure is fully determined by repo analysis (AGENTS.md generation)

#### Mode 2: Variable Pre-fill

Pre-populate variable values, user can still edit:

```json
{
  "mode": "variables",
  "variables": {
    "componentName": "UserProfile",
    "componentPath": "src/components/UserProfile.tsx",
    "testPath": "src/__tests__/UserProfile.test.tsx"
  },
  "suggestedFilename": "test-user-profile"
}
```

**Use case**: Templates that discover values but user might want to adjust (component testing)

#### Mode 3: Error

Script encountered an issue or found nothing to do:

```json
{
  "mode": "error",
  "error": "No suitable directories found for AGENTS.md generation",
  "userMessage": "Your repository doesn't have subdirectories that would benefit from AGENTS.md files. Consider creating one manually at the root level."
}
```

**Use case**: Graceful handling when repo structure doesn't match template expectations

### TypeScript Interface

```typescript
interface SetupScriptInput {
  workspaceRoot: string;
  templatePath: string;
  settings: Record<string, any>;
}

interface SetupScriptOutputWorkflow {
  mode: "workflow";
  workflow: PromptFile; // Full workflow structure
  suggestedFilename?: string;
}

interface SetupScriptOutputVariables {
  mode: "variables";
  variables: Record<string, string>;
  suggestedFilename?: string;
}

interface SetupScriptOutputError {
  mode: "error";
  error: string; // Technical error message (for logs)
  userMessage: string; // User-friendly explanation
}

type SetupScriptOutput =
  | SetupScriptOutputWorkflow
  | SetupScriptOutputVariables
  | SetupScriptOutputError;
```

---

## Example: AGENTS.md Setup Script

### Template File

`.ctrlyoke/templates/generate-agents-md.ctrlyoke.json`:

```json
{
  "name": "Generate Repository Instructions",
  "description": "Create AGENTS.md files for repository structure",
  "setupScript": "scripts/analyze-repo-for-agents.js",
  "prompts": []
}
```

### Setup Script

`src/templates/workflows/scripts/analyze-repo-for-agents.js`:

```javascript
#!/usr/bin/env node
const fs = require("fs").promises;
const path = require("path");

// Parse command-line arguments
const args = process.argv.slice(2);
const workspaceRoot = getArg(args, "--workspace-root");
const settingsJson = getArg(args, "--settings-json");
const settings = JSON.parse(settingsJson || "{}");

async function main() {
  try {
    // Walk directory tree, identify candidates
    const candidates = await findCandidateDirectories(workspaceRoot);

    if (candidates.length === 0) {
      // No candidates found
      return outputError(
        "No suitable directories found",
        "Your repository structure doesn't require subdirectory AGENTS.md files. " +
          "Consider creating a single AGENTS.md at the repository root."
      );
    }

    // Sort directories leaf → root (topological)
    const sorted = topologicalSort(candidates);

    // Generate prompts for each directory
    const prompts = sorted.map((dir, index) => {
      const isRoot = dir === workspaceRoot;
      return generatePromptForDirectory(dir, isRoot, settings, index);
    });

    // Output full workflow
    outputWorkflow({
      steps: prompts,
    });
  } catch (error) {
    outputError(error.message, "Failed to analyze repository structure");
  }
}

async function findCandidateDirectories(rootDir) {
  const candidates = [];
  const excludePatterns = [
    "node_modules",
    ".git",
    "dist",
    "out",
    "build",
    ".ctrlyoke",
    ".github",
    ".vscode",
    "coverage",
    "logs",
  ];

  async function walk(dir, depth = 0) {
    const entries = await fs.readdir(dir, { withFileTypes: true });

    // Count files and subdirs
    const files = entries.filter((e) => e.isFile()).length;
    const subdirs = entries.filter((e) => e.isDirectory()).length;

    // Candidate if >1 file OR >1 subdirectory
    if (files > 1 || subdirs > 1) {
      candidates.push(dir);
    }

    // Recurse into subdirectories
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const name = entry.name;
        const shouldSkip =
          name.startsWith(".") ||
          excludePatterns.some((pattern) => name.includes(pattern));

        if (!shouldSkip) {
          await walk(path.join(dir, name), depth + 1);
        }
      }
    }
  }

  await walk(rootDir);
  return candidates;
}

function topologicalSort(dirs) {
  // Sort by depth (leaf → root)
  return dirs.sort((a, b) => {
    const depthA = a.split(path.sep).length;
    const depthB = b.split(path.sep).length;
    return depthB - depthA; // Deeper directories first
  });
}

function generatePromptForDirectory(dirPath, isRoot, settings, index) {
  const relativePath = path.relative(process.cwd(), dirPath);
  const symlinkInstruction = settings.createClaudeMdSymlinks
    ? "\n\nAlso create CLAUDE.md symlink: `ln -s AGENTS.md CLAUDE.md` (Unix) or `New-Item -ItemType SymbolicLink -Path CLAUDE.md -Target AGENTS.md` (Windows)"
    : "";

  if (isRoot) {
    return {
      id: `root-agents-md`,
      prompt: `Create a root-level AGENTS.md instruction file.

<task>
1. Review all generated AGENTS.md files from previous prompts
2. Read .github/copilot-instructions.md to understand existing project instructions
3. Create root AGENTS.md that:
   - Provides concise project overview (1-2 paragraphs)
   - References key subdirectory instruction files
   - Establishes repository-wide patterns NOT covered in subdirectories
   - Avoids duplicating information already in child AGENTS.md files
4. Keep it minimal - detailed instructions belong in subdirectories
</task>${symlinkInstruction}`,
    };
  } else {
    return {
      id: `agents-md-${index}`,
      prompt: `Analyze the \`${relativePath}\` directory and determine if it needs an AGENTS.md instruction file.

<task>
1. List all files and subdirectories in \`${relativePath}\`
2. Read key files to understand directory purpose and responsibilities
3. Assess whether this directory has:
   - A distinct architectural role or responsibility
   - Specific patterns or conventions that differ from parent directories
   - Non-obvious implementation details that would help AI agents
   - Gotchas or important context for working with this code

4. Decision criteria:
   - CREATE AGENTS.md if the directory represents a cohesive module with specific patterns
   - SKIP AGENTS.md if it's just organizational grouping with no unique conventions
   
5. If creating AGENTS.md, include:
   - **Purpose**: Clear 1-2 sentence description of directory responsibility
   - **Key Patterns**: Important conventions and approaches used here
   - **Implementation Details**: Non-obvious information AI agents should know
   - **References**: Links to key files or related directories
   
6. Keep it concise - focus on what's NOT obvious from the code itself
</task>${symlinkInstruction}`,
    };
  }
}

// Output helpers
function outputWorkflow(workflow, suggestedFilename = "generate-agents-md") {
  console.log(
    JSON.stringify({
      mode: "workflow",
      workflow,
      suggestedFilename,
    })
  );
}

function outputVariables(variables, suggestedFilename) {
  console.log(
    JSON.stringify({
      mode: "variables",
      variables,
      suggestedFilename,
    })
  );
}

function outputError(error, userMessage) {
  console.log(
    JSON.stringify({
      mode: "error",
      error,
      userMessage,
    })
  );
}

function getArg(args, flag) {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : null;
}

// Run
main().catch((err) => {
  outputError(err.message, "Setup script failed");
  process.exit(1);
});
```

---

## User Experience Flow

### Template Selection

User opens "New Workflow" modal, selects template with setup script:

```
Template:
┌─────────────────────────────────────────────[▼]─┐
│ Generate Repository Instructions                │
└─────────────────────────────────────────────────┘
[Set as Default]
Create AGENTS.md files for repository structure
```

### First-Time Trust Dialog (Custom Templates Only)

If template is not built-in and hasn't been trusted before:

```
┌─────────────────────────────────────────────────┐
│ Template Security                           [×] │
├─────────────────────────────────────────────────┤
│ This template includes a setup script:          │
│                                                 │
│ 📄 scripts/analyze-repo-for-agents.js           │
│                                                 │
│ Setup scripts can read and write files in your │
│ workspace. Only run templates from trusted      │
│ sources.                                        │
│                                                 │
│           [View Script] [Cancel] [Trust & Run]  │
└─────────────────────────────────────────────────┘
```

**"View Script" button**: Opens script file in editor, user can review before trusting

**Built-in templates**: Skip this dialog (pre-trusted)

### Script Execution UI

While script runs, show progress indicator:

```
Template: Generate Repository Instructions

⏳ Analyzing repository structure...

[Cancel]
```

**If script takes >5 seconds**: Show more detailed status

```
⏳ Analyzing repository structure...
   Found 47 directories, filtering candidates...
```

### Script Success (Mode: workflow)

Script completes, workflow is ready:

```
Template: Generate Repository Instructions

✓ Found 12 directories for AGENTS.md generation

Workflow name:
┌──────────────────────────────────┐
│ generate-agents-md               │.ctrlyoke.json
└──────────────────────────────────┘
📁 .ctrlyoke/workflows/generate-agents-md.ctrlyoke.json

                   [Cancel] [Create] [Create & Run]
```

**User can**:

- Edit the suggested filename
- Click "Create" to save and review workflow
- Click "Create & Run" to save and immediately execute

### Script Success (Mode: variables)

Script pre-filled variables, user can edit:

```
Template: Component Tests

✓ Discovered component: UserProfile

┌─────────────────────────────────────────────────┐
│ componentName                                   │
│ ┌─────────────────────────────────────────────┐ │
│ │ UserProfile                                 │ │ ← pre-filled
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ componentPath                                   │
│ ┌─────────────────────────────────────────────┐ │
│ │ src/components/UserProfile.tsx              │ │ ← pre-filled
│ └─────────────────────────────────────────────┘ │
│                                                 │
│ testPath                                        │
│ ┌─────────────────────────────────────────────┐ │
│ │ src/__tests__/UserProfile.test.tsx          │ │ ← pre-filled
│ └─────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────┘

Workflow name:
┌──────────────────────────────────┐
│ test-user-profile                │.ctrlyoke.json
└──────────────────────────────────┘

                   [Cancel] [Create] [Create & Run]
```

### Script Error

Script reports nothing to do or encounters error:

```
Template: Generate Repository Instructions

⚠ No suitable directories found

Your repository structure doesn't require subdirectory
AGENTS.md files. Consider creating a single AGENTS.md at
the repository root.

                              [OK] [Try Different Template]
```

---

## Implementation Architecture

### Template Schema Extension

Extend `WorkflowTemplate` interface in types:

```typescript
interface WorkflowTemplate {
  name?: string;
  description?: string;
  setupScript?: string; // NEW: Path relative to template directory
  steps: PromptItem[];
}
```

**Note**: No `setupTimeout` in template - use global setting instead

### TemplateManager Changes

Add setup script execution to `TemplateManager.ts`:

```typescript
class TemplateManager {
  /**
   * Execute template setup script
   * @returns Script output or null if no setup script
   */
  async executeSetupScript(
    templateId: string,
    templatePath: string
  ): Promise<SetupScriptOutput | null> {
    const template = await this.loadTemplate(templateId, templatePath);

    if (!template.setupScript) {
      return null; // No setup script, use normal template flow
    }

    // Check trust for custom templates
    if (!this.isBuiltInTemplate(templateId)) {
      const trusted = await this.checkTemplateTrust(templateId);
      if (!trusted) {
        // User declined trust
        return {
          mode: "error",
          error: "Template not trusted",
          userMessage: "Setup script execution cancelled",
        };
      }
    }

    // Build script path
    const templateDir = path.dirname(templatePath);
    const scriptPath = path.join(templateDir, template.setupScript);

    // Build arguments
    const workspaceRoot = this.getWorkspaceRoot();
    const settings = this.getRelevantSettings();

    const args = [
      "--workspace-root",
      workspaceRoot,
      "--template-path",
      templatePath,
      "--settings-json",
      JSON.stringify(settings),
    ];

    // Execute script
    try {
      const timeout = this.getSetupScriptTimeout();
      const result = await this.execSetupScript(scriptPath, args, timeout);
      return JSON.parse(result.stdout);
    } catch (error) {
      return {
        mode: "error",
        error: error.message,
        userMessage: "Setup script failed to execute",
      };
    }
  }

  private async execSetupScript(
    scriptPath: string,
    args: string[],
    timeout: number | null
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const options: any = {
        cwd: this.getWorkspaceRoot(),
        env: { ...process.env, CTRLYOKE_SETUP: "true" },
      };

      if (timeout !== null) {
        options.timeout = timeout;
      }

      const proc = spawn("node", [scriptPath, ...args], options);

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Setup script exited with code ${code}`));
        }
      });

      proc.on("error", (err) => {
        reject(err);
      });
    });
  }

  private getSetupScriptTimeout(): number | null {
    const timeout = vscode.workspace
      .getConfiguration("ctrlyoke")
      .get<number>("templateSetupScriptTimeout");

    // 0 means no timeout
    return timeout === 0 ? null : timeout;
  }

  private getRelevantSettings(): Record<string, any> {
    const config = vscode.workspace.getConfiguration("ctrlyoke");
    return {
      createClaudeMdSymlinks: config.get("createClaudeMdSymlinks"),
      disableCopilotAgentsMd: config.get("disableCopilotAgentsMd"),
      attachAgentsHierarchy: config.get("attachAgentsHierarchy"),
      // Add other relevant settings as needed
    };
  }
}
```

### Trust Storage

Store trusted templates in workspace state:

```typescript
interface TemplateTrustState {
  trustedTemplates: Set<string>; // Template IDs
}

class TemplateManager {
  private async checkTemplateTrust(templateId: string): Promise<boolean> {
    // Built-in templates are always trusted
    if (this.isBuiltInTemplate(templateId)) {
      return true;
    }

    // Check if already trusted
    const trustedTemplates = this.getTrustedTemplates();
    if (trustedTemplates.has(templateId)) {
      return true;
    }

    // Show trust dialog
    const choice = await vscode.window.showWarningMessage(
      `This template includes a setup script that can read and write files in your workspace. Only run templates from trusted sources.`,
      { modal: true },
      "View Script",
      "Trust & Run"
    );

    if (choice === "View Script") {
      // Open script file, then re-prompt
      await this.viewSetupScript(templateId);
      return await this.checkTemplateTrust(templateId); // Recursive call
    }

    if (choice === "Trust & Run") {
      // Save trust preference
      trustedTemplates.add(templateId);
      await this.saveTrustedTemplates(trustedTemplates);
      return true;
    }

    return false; // User cancelled
  }
}
```

### Dashboard Message Flow

New message types for setup script execution:

```typescript
// Webview → Extension
interface ExecuteSetupScriptMessage {
  type: "executeSetupScript";
  templateId: string;
}

// Extension → Webview
interface SetupScriptProgressMessage {
  type: "setupScriptProgress";
  status: "running" | "success" | "error";
  message?: string;
  result?: SetupScriptOutput;
}
```

**Flow**:

1. User selects template with setup script
2. Webview sends `executeSetupScript` message
3. Extension runs script, sends progress updates
4. Extension sends final result
5. Webview updates UI based on result mode

---

## Settings

### New Setting: templateSetupScriptTimeout

```json
{
  "ctrlyoke.templateSetupScriptTimeout": {
    "type": "number",
    "default": 120000,
    "description": "Maximum execution time for template setup scripts in milliseconds. Set to 0 for no timeout.",
    "order": 53
  }
}
```

**Options**:

- `120000` (2 minutes) - Default, handles most repos
- `300000` (5 minutes) - For very large monorepos
- `0` - No timeout (for v1, might not enforce timeout at all)

**Rationale**: Single global setting is simpler than per-template configuration. Power users can adjust if needed.

---

## Security Considerations

### Threat Model

**Setup scripts have full workspace access** because:

1. They need to analyze repository structure (read files)
2. They generate workflow files (write to `.ctrlyoke/workflows/`)
3. Running in same security context as extension itself

**Risks**:

- Malicious script could delete files
- Script could exfiltrate data
- Script could modify source code

**Mitigations**:

1. **Trust model**: Custom templates require explicit user consent
2. **Built-in trust**: Shipped templates are reviewed and trusted by default
3. **Script visibility**: "View Script" button lets users inspect before running
4. **Isolated process**: Script runs in separate Node.js process (can be killed)
5. **Workspace-scoped**: No access outside workspace folder (via cwd constraint)

### Best Practices for Script Authors

**DO**:

- ✓ Validate all inputs from command-line args
- ✓ Handle errors gracefully with user-friendly messages
- ✓ Log progress for long-running analysis
- ✓ Use read-only operations where possible
- ✓ Document what files/directories the script accesses

**DON'T**:

- ✗ Access files outside workspace root
- ✗ Make network requests without documenting
- ✗ Modify source files (only create workflow files)
- ✗ Use eval() or execute arbitrary code
- ✗ Store sensitive data in workflow files

---

## Built-in Templates with Setup Scripts

### 1. Generate Repository Instructions

**Purpose**: Create AGENTS.md files across repository  
**Script**: `analyze-repo-for-agents.js`  
**Output**: Full workflow with prompts for each directory

**Use case**: First-time AGENTS.md setup, or refresh after major refactoring

### Future Examples

### 2. Component Test Generator

**Purpose**: Generate test files for React components  
**Script**: `find-react-components.js`  
**Output**: Variables pre-filled with component paths

```json
{
  "mode": "variables",
  "variables": {
    "componentName": "UserProfile",
    "componentPath": "src/components/UserProfile.tsx",
    "testPath": "src/__tests__/UserProfile.test.tsx"
  }
}
```

### 3. API Documentation Workflow

**Purpose**: Document API endpoints  
**Script**: `analyze-api-routes.js`  
**Output**: Full workflow with one prompt per endpoint

### 4. Migration Helper

**Purpose**: Migrate code from old to new pattern  
**Script**: `find-migration-candidates.js`  
**Output**: Workflow with targeted refactoring prompts

---

## Testing Strategy

### Unit Tests

**TemplateManager**:

- Execute setup script with valid output (workflow mode)
- Execute setup script with valid output (variables mode)
- Execute setup script with error output
- Handle script timeout
- Handle script execution failure (invalid JSON)
- Handle script execution failure (non-zero exit code)

**Trust System**:

- Built-in templates auto-trusted
- Custom templates require user consent
- Trust state persists across sessions
- Trust revocation (future)

### Integration Tests

**End-to-End Setup Script Flow**:

1. Create test workspace with known structure
2. Load template with setup script
3. Execute script
4. Verify generated workflow structure
5. Verify suggested filename
6. Create workflow file
7. Verify file contents

### Manual Testing

**AGENTS.md Setup Script**:

- [ ] Run on ctrlyoke repository (12+ directories expected)
- [ ] Run on minimal repository (should gracefully handle empty result)
- [ ] Run on very large repository (1000+ directories, test timeout)
- [ ] Verify symlink instructions include correct OS-specific commands
- [ ] Test trust dialog for custom templates
- [ ] Test "View Script" button opens correct file

---

## Implementation Checklist

### Phase 1: Core Infrastructure

- [ ] Extend `WorkflowTemplate` interface with `setupScript` field
- [ ] Add `templateSetupScriptTimeout` setting to package.json
- [ ] Implement setup script executor in TemplateManager
- [ ] Add trust state storage (workspace state)
- [ ] Implement trust dialog UI
- [ ] Add "View Script" functionality

### Phase 2: Dashboard Integration

- [ ] Add message types for setup script execution
- [ ] Update modal to handle setup script flow
- [ ] Add progress indicator UI during script execution
- [ ] Handle all three output modes (workflow, variables, error)
- [ ] Update filename suggestion based on script output

### Phase 3: AGENTS.md Template

- [ ] Create `generate-agents-md.ctrlyoke.json` template
- [ ] Implement `analyze-repo-for-agents.js` setup script
- [ ] Copy to built-in templates directory
- [ ] Test on various repository structures
- [ ] Document template usage

### Phase 4: Documentation

- [ ] Update WORKFLOW_TEMPLATES_DESIGN.md with setup script section
- [ ] Create setup script authoring guide
- [ ] Add troubleshooting section
- [ ] Document security best practices

### Phase 5: Polish

- [ ] Add better progress messages during analysis
- [ ] Consider adding script cancellation support
- [ ] Add script logging for debugging
- [ ] Error recovery and user feedback improvements

---

## Future Enhancements

### 1. Script Parameters

Allow templates to declare configurable parameters:

```json
{
  "setupScript": "analyze-repo.js",
  "scriptParameters": [
    {
      "name": "maxDepth",
      "type": "number",
      "default": 5,
      "description": "Maximum directory depth to analyze"
    }
  ]
}
```

User gets form to configure before script runs.

### 2. Script Caching

Cache script results to avoid re-running on same repo:

```typescript
{
  "cacheKey": "repo-structure-hash",
  "cachedOutput": { ... },
  "cacheTimestamp": "2025-12-19T10:30:00Z"
}
```

Invalidate cache on file system changes.

### 3. TypeScript Support

Allow setup scripts in TypeScript:

```json
{
  "setupScript": "analyze-repo.ts"
}
```

Use ts-node or compile on-the-fly.

### 4. Template Marketplace

Share community templates with setup scripts:

- Template repository with reviews
- Verified/signed templates
- Download and trust in one step

### 5. Progress Streaming

Allow scripts to stream progress updates:

```javascript
// In setup script
console.error(JSON.stringify({ progress: 0.5, message: "Analyzed 50 files" }));
```

Show live progress bar in UI.

---

## Conclusion

Template setup scripts transform ctrlyoke from a simple variable-replacement system into a **programmable workflow generation platform**. This enables:

1. **Intelligent automation**: Workflows adapt to repository structure
2. **Reduced manual work**: Scripts do the tedious discovery/analysis
3. **Consistency**: Generated workflows follow patterns reliably
4. **Extensibility**: Users can create custom templates for their needs

The AGENTS.md generation template is the perfect first use case, demonstrating the power of setup scripts while solving a real pain point (creating hierarchical instruction files).

**Integration with existing system is seamless**: Simple templates continue to work unchanged, setup scripts are purely additive.
