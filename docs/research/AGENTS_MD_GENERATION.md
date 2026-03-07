# AGENTS.md Generation & Hierarchical Injection System

**Status**: Planning  
**Date**: December 19, 2025  
**Purpose**: Standardize FlightPath on AGENTS.md with hierarchical concatenation, replacing Copilot's broken single-file approach

**Related Documents**:

- [Template Setup Scripts](./TEMPLATE_SETUP_SCRIPTS.md) - Architecture for scripted template system
- [Workflow Templates](../WORKFLOW_TEMPLATES_DESIGN.md) - Base template system design

---

## Executive Summary

FlightPath will implement a complete AGENTS.md instruction system that:

1. **Disables Copilot's native AGENTS.md loading** (which only returns nearest file, not parent hierarchy)
2. **Manually injects all parent AGENTS.md files** in root → file order (mimicking Codex/Claude behavior)
3. **Provides a scripted template** that generates repository-wide AGENTS.md workflows intelligently
4. **Uses XML formatting** for clear instruction attribution and parseability
5. **Supports optional CLAUDE.md symlinks** for cross-tool compatibility

**Key Architectural Decision**: AGENTS.md generation is implemented as FlightPath's **first scripted template** (see TEMPLATE_SETUP_SCRIPTS.md), leveraging the template setup script system rather than a standalone command.

---

## User Experience Flow

### Phase 1: Generate Workflow (via Scripted Template)

1. User opens FlightPath dashboard
2. Clicks **"New Workflow"** button
3. Selects **"Generate Repository Instructions"** from template dropdown
4. Setup script executes automatically:
   - Walks directory tree from workspace root
   - Identifies candidate directories (>1 file OR >1 subdirectory)
   - Filters out build artifacts (node_modules, dist, out, .git, etc.)
   - Sorts directories bottom-up (leaf → root) for proper dependency order
   - Generates workflow with prompts for each directory
5. Modal shows success: "✓ Found 12 directories for AGENTS.md generation"
6. User enters workflow filename (pre-filled: `generate-agents-md`)
7. User clicks "Create" or "Create & Run"
8. Workflow opens in editor for review/customization (if "Create")
9. User runs workflow with **"FlightPath: Take Off"** (or already running if "Create & Run")

### Phase 2: Execute Workflow

1. AI processes each directory prompt in order:
   - **Leaf directories first**: Analyze contents, generate AGENTS.md if needed
   - **Intermediate directories**: Read child AGENTS.md files, create parent-level instructions
   - **Root directory last**: Synthesize high-level overview referencing all subdirectories
2. Each prompt can create/skip AGENTS.md based on AI's analysis
3. Optional: Create CLAUDE.md symlinks automatically (based on setting)

### Phase 3: Enable Hierarchical Injection

1. User enables FlightPath settings:
   - `flightpath.disableCopilotAgentsMd`: `true` (blocks Copilot's native loading)
   - `flightpath.attachAgentsHierarchy`: `true` (enables FlightPath's manual injection)
2. When sending prompts to Copilot CLI:
   - FlightPath discovers all AGENTS.md files from file's directory → root
   - Wraps each in `<projectInstructions source="...">` XML tags
   - Prepends to prompt text in root → file order
   - Adds `--no-custom-instructions` flag to Copilot CLI command
3. Result: Full instruction hierarchy like Codex/Claude, not just nearest file

---

## Architecture Design

### Overview

The AGENTS.md system consists of two independent subsystems:

1. **Generation System**: Scripted template that creates AGENTS.md workflows (see TEMPLATE_SETUP_SCRIPTS.md)
2. **Injection System**: Runtime hierarchical concatenation for Copilot CLI (this document)

These systems work together but can be used independently:

- Users can manually create AGENTS.md files and still benefit from hierarchical injection
- Users can generate AGENTS.md workflows without enabling injection

### Generation System Components

#### Built-in Template: "Generate Repository Instructions"

**Template file**: `src/templates/workflows/generate-agents-md.flightpath.json`

```json
{
  "name": "Generate Repository Instructions",
  "description": "Create AGENTS.md files for repository structure",
  "setupScript": "scripts/analyze-repo-for-agents.js",
  "prompts": []
}
```

**Setup script**: `src/templates/workflows/scripts/analyze-repo-for-agents.js`

This script implements the directory walking, filtering, sorting, and prompt generation logic described in TEMPLATE_SETUP_SCRIPTS.md. See that document for full implementation details.

**Key responsibilities**:

- Walk directory tree and identify candidates
- Sort directories leaf → root (topological)
- Generate prompt for each directory
- Output workflow JSON via stdout

**Output format** (mode: workflow):

```json
{
  "mode": "workflow",
  "workflow": {
    "prompts": [
      {
        "id": "agents-md-0",
        "prompt": "Analyze src/ui/webview directory..."
      },
      {
        "id": "agents-md-1",
        "prompt": "Analyze src/ui directory (review child AGENTS.md)..."
      },
      {
        "id": "root-agents-md",
        "prompt": "Create root AGENTS.md (synthesize all subdirectories)..."
      }
    ]
  },
  "suggestedFilename": "generate-agents-md"
}
```

### Injection System Components

#### 1. AgentsFileResolver Utility (`src/utils/AgentsFileResolver.ts`)

**Purpose**: Discover and format AGENTS.md files for injection

**Key Methods**:

```typescript
export class AgentsFileResolver {
  /**
   * Discover all AGENTS.md files from directory up to workspace root
   * @param startPath Starting file or directory path
   * @param workspaceRoot Workspace root path
   * @returns Array of AGENTS.md file paths ordered root → startPath
   */
  static async discoverAgentsFiles(
    startPath: string,
    workspaceRoot: string
  ): Promise<string[]>;

  /**
   * Read and format AGENTS.md files with XML tags
   * @param agentsFiles Array of AGENTS.md file paths (ordered root → file)
   * @returns Formatted XML string for injection
   */
  static async formatAgentsContent(agentsFiles: string[]): Promise<string>;

  /**
   * Get relative path for XML source attribution
   * @param filePath Absolute path to AGENTS.md
   * @param workspaceRoot Workspace root path
   * @returns Relative path like "/src/flightpath/AGENTS.md"
   */
  static getRelativePath(filePath: string, workspaceRoot: string): string;
}
```

**XML Output Format**:

```xml
<projectInstructions source="/AGENTS.md">
Always read the main project instructions:

@.github/copilot-instructions.md

The `.github/instructions/` directory contains detailed implementation guidelines...
</projectInstructions>

<projectInstructions source="/src/AGENTS.md">
## Source Directory Guidelines

All TypeScript source code follows strict mode with comprehensive error handling...
</projectInstructions>

<projectInstructions source="/src/flightpath/AGENTS.md">
## FlightPath Core Module

This directory contains the orchestration layer...
</projectInstructions>
```

**Discovery Algorithm**:

1. Start at file's directory (or workflow file's directory if no #file: references)
2. Walk up directory tree one level at a time
3. Check for AGENTS.md at each level
4. Collect all found files
5. Reverse array so root is first (concatenation order)
6. Return ordered array

---

## Prompt Templates (for Setup Script)

#### 3. CopilotCliProvider (`src/flightpath/harness/copilot/CopilotCliProvider.ts`)

**Changes**:

**A) Add `--no-custom-instructions` flag when setting enabled**

```typescript
private buildCliArgs(
  prompt: PromptItem,
  isInteractive: boolean = false
): string[] {
  const args: string[] = [];

  // NEW: Disable Copilot's native AGENTS.md loading if setting enabled
  if (ConfigurationUtils.shouldDisableCopilotAgentsMd()) {
    args.push("--no-custom-instructions");
    Log.info("🚫 Disabled Copilot's native AGENTS.md loading");
  }

  // ... rest of existing logic
}
```

**B) No changes to prompt building** - injection happens in CliIntegration

#### 4. HarnessIntegration (`src/flightpath/HarnessIntegration.ts`)

**Changes**:

**Modify prompt text building to inject AGENTS.md hierarchy** (alongside existing context and agent expansion logic at ~line 220)

```typescript
protected async buildPromptText(prompt: PromptItem): Promise<string> {
  let finalPrompt = prompt.prompt;

  // Existing context expansion logic
  if (this.shouldExpandContext()) {
    finalPrompt = await ContextExpander.expandContext(
      finalPrompt,
      this.context
    );
  }

  // NEW: Inject AGENTS.md hierarchy if enabled
  if (ConfigurationUtils.shouldAttachAgentsHierarchy()) {
    const agentsContent = await this.getAgentsHierarchyContent(prompt);
    if (agentsContent) {
      finalPrompt = `${agentsContent}\n\n${finalPrompt}`;
    }
  }

  return finalPrompt;
}

/**
 * Get AGENTS.md hierarchy content for injection
 */
private async getAgentsHierarchyContent(
  prompt: PromptItem
): Promise<string | null> {
  try {
    // Determine starting path for discovery
    const startPath = await this.getPromptContextPath(prompt);
    if (!startPath) {
      return null;
    }

    const workspaceRoot = this.getWorkspaceRoot();
    if (!workspaceRoot) {
      return null;
    }

    // Discover and format AGENTS.md files
    const agentsFiles = await AgentsFileResolver.discoverAgentsFiles(
      startPath,
      workspaceRoot
    );

    if (agentsFiles.length === 0) {
      return null;
    }

    return await AgentsFileResolver.formatAgentsContent(agentsFiles);
  } catch (error) {
    Log.error(`Failed to load AGENTS.md hierarchy: ${error}`);
    return null;
  }
}

/**
 * Determine starting path for AGENTS.md discovery
 * Uses first #file: reference if available, otherwise workflow file path
 */
private async getPromptContextPath(prompt: PromptItem): Promise<string | null> {
  // Check for #file: references in prompt
  const fileMatch = prompt.prompt.match(/#file:([^\s:]+)/);
  if (fileMatch) {
    const filePath = fileMatch[1];
    const workspaceRoot = this.getWorkspaceRoot();
    if (workspaceRoot) {
      return path.join(workspaceRoot, filePath);
    }
  }

  // Fallback to workflow file path if available
  // (This would need to be passed via context parameter)
  return null;
}
```

#### 5. Extension Registration (`src/extension.ts`)

**Changes**:

```typescript
// Register new command
context.subscriptions.push(
  vscode.commands.registerCommand(
    "flightpath.generateAgentsWorkflow",
    async () => {
      // Quick input for symlink preference
      const createSymlinks = await vscode.window.showQuickPick(
        [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ],
        {
          placeHolder: "Create CLAUDE.md symlinks alongside AGENTS.md files?",
          title: "AGENTS.md Generation",
        }
      );

      if (createSymlinks === undefined) {
        return; // User cancelled
      }

      // Update setting to remember choice
      await vscode.workspace
        .getConfiguration("flightpath")
        .update(
          "createClaudeMdSymlinks",
          createSymlinks.value,
          vscode.ConfigurationTarget.Workspace
        );

      // Generate workflow
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showErrorMessage("No workspace folder open");
        return;
      }

      const workflow = await AgentsWorkflowGenerator.generateWorkflow(
        workspaceFolder.uri.fsPath,
        createSymlinks.value
      );

      // Save workflow file
      const workflowPath = path.join(
        workspaceFolder.uri.fsPath,
        ".flightpath",
        "workflows",
        "generate-agents-md.flightpath.json"
      );

      await fs.mkdir(path.dirname(workflowPath), { recursive: true });
      await fs.writeFile(
        workflowPath,
        JSON.stringify(workflow, null, 2),
        "utf-8"
      );

      // Open workflow for review
      const doc = await vscode.workspace.openTextDocument(workflowPath);
      await vscode.window.showTextDocument(doc);

      vscode.window.showInformationMessage(
        `Generated AGENTS.md workflow. Review and run with "FlightPath: Take Off"`
      );
    }
  )
);
```

#### 6. Configuration Utilities (`src/utils/ConfigurationUtils.ts`)

**Add new utility methods**:

```typescript
export class ConfigurationUtils {
  // ... existing methods

  /**
   * Check if Copilot's native AGENTS.md loading should be disabled
   */
  static shouldDisableCopilotAgentsMd(): boolean {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("disableCopilotAgentsMd", false);
  }

  /**
   * Check if AGENTS.md hierarchy should be attached to prompts
   */
  static shouldAttachAgentsHierarchy(): boolean {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("attachAgentsHierarchy", false);
  }

  /**
   * Check if CLAUDE.md symlinks should be created
   */
  static shouldCreateClaudeMdSymlinks(): boolean {
    return vscode.workspace
      .getConfiguration("flightpath")
      .get<boolean>("createClaudeMdSymlinks", false);
  }
}
```

#### 7. Package.json Settings

**Add new configuration properties**:

```json
{
  "contributes": {
    "configuration": {
      "properties": {
        "flightpath.disableCopilotAgentsMd": {
          "type": "boolean",
          "default": false,
          "description": "Disable Copilot's native AGENTS.md instruction loading. Enable this when using flightpath.attachAgentsHierarchy for full control over instruction concatenation.",
          "order": 50
        },
        "flightpath.attachAgentsHierarchy": {
          "type": "boolean",
          "default": false,
          "description": "Automatically attach all parent AGENTS.md files when sending prompts (mimics Codex/Claude concatenation behavior). Requires disableCopilotAgentsMd to be enabled.",
          "order": 51
        },
        "flightpath.createClaudeMdSymlinks": {
          "type": "boolean",
          "default": false,
          "description": "Automatically create CLAUDE.md symlinks alongside AGENTS.md files for cross-tool compatibility",
          "order": 52
        }
      }
    },
    "commands": [
      {
        "command": "flightpath.generateAgentsWorkflow",
        "title": "Generate Repository Instructions Workflow",
        "category": "FlightPath"
      }
    ]
  }
}
```

---

## Prompt Templates (for Setup Script)

These templates are used by the setup script (`analyze-repo-for-agents.js`) to generate prompts for each directory.

### Template 1: Leaf/Intermediate Directory Analysis

```markdown
Analyze the `{dirPath}` directory and determine if it needs an AGENTS.md instruction file.

<task>
1. List all files and subdirectories in `{dirPath}`
2. Read key files to understand the directory's purpose and responsibilities
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

{symlinkInstructions}
</task>

<context>
Directory path: {dirPath}
Workspace root: {workspaceRoot}
{childAgentsFiles}
</context>

Proceed with analysis and generate AGENTS.md if appropriate.
```

**Variables**:

- `{dirPath}`: Relative path from workspace root (e.g., `src/flightpath/cli`)
- `{workspaceRoot}`: Absolute workspace root path
- `{symlinkInstructions}`: (If enabled) "Also create a CLAUDE.md symlink: `New-Item -ItemType SymbolicLink -Path CLAUDE.md -Target AGENTS.md` (Windows) or `ln -s AGENTS.md CLAUDE.md` (Unix)"
- `{childAgentsFiles}`: (For intermediate directories) "Existing AGENTS.md files in subdirectories:\n- {list of child AGENTS.md paths}"

**Note**: The `createClaudeMdSymlinks` setting value is passed to the setup script via `--settings-json` argument. See TEMPLATE_SETUP_SCRIPTS.md for details.

### Template 2: Root Directory Synthesis

````markdown
Create a root-level AGENTS.md instruction file that provides high-level project guidance.

<task>
1. Review all generated AGENTS.md files from subdirectories:
{agentsFileList}

2. Read `.github/copilot-instructions.md` to understand existing project instructions

3. Create root AGENTS.md that:
   - Provides a concise project overview (1-2 paragraphs)
   - References key subdirectory instruction files
   - Establishes repository-wide patterns NOT covered in subdirectories
   - Avoids duplicating information already in child AGENTS.md files
   - Keeps it minimal - more detailed instructions belong in subdirectories

4. Recommended structure:

   ```markdown
   # [Project Name] Repository Instructions

   [Brief project description and purpose]

   ## Key Subdirectory Instructions

   - `src/[module]/AGENTS.md` - [Brief description]
   - `docs/AGENTS.md` - [Brief description]

   ## Repository-Wide Guidelines

   [Cross-cutting concerns, overall architecture principles, etc.]
   ```
````

{symlinkInstructions}
</task>

<context>
Workspace root: {workspaceRoot}
Generated AGENTS.md files:
{agentsFileList}
</context>

Proceed with creating root-level AGENTS.md.

````

**Variables**:
- `{workspaceRoot}`: Absolute workspace root path
- `{agentsFileList}`: Bulleted list of all generated AGENTS.md file paths
- `{symlinkInstructions}`: (If enabled) Symlink creation instructions

---

## Implementation Checklist

### Phase 1: Template Setup Script Infrastructure

**Note**: This phase implements the general template setup script system. See TEMPLATE_SETUP_SCRIPTS.md for full implementation details.

- [ ] Extend `WorkflowTemplate` interface with `setupScript` field
- [ ] Add `templateSetupScriptTimeout` setting to package.json (default: 120000ms)
- [ ] Implement setup script executor in TemplateManager
- [ ] Add trust state storage (workspace state)
- [ ] Implement trust dialog UI
- [ ] Add "View Script" functionality
- [ ] Update dashboard modal to handle setup script execution
- [ ] Add progress indicator during script execution
- [ ] Handle all three output modes (workflow, variables, error)

### Phase 2: AGENTS.md Setup Script & Template

- [ ] Create template: `src/templates/workflows/generate-agents-md.flightpath.json`
  ```json
  {
    "name": "Generate Repository Instructions",
    "description": "Create AGENTS.md files for repository structure",
    "setupScript": "scripts/analyze-repo-for-agents.js",
    "prompts": []
  }
````

- [ ] Create setup script: `src/templates/workflows/scripts/analyze-repo-for-agents.js`
  - [ ] Implement directory walking with filtering
  - [ ] Implement topological sorting (leaf → root)
  - [ ] Implement prompt template generation
  - [ ] Handle `createClaudeMdSymlinks` setting from input
  - [ ] Output workflow JSON via stdout
  - [ ] Handle error cases gracefully
  - [ ] Add progress logging to stderr
- [ ] Test setup script execution
  - [ ] Test on FlightPath repository (12+ directories expected)
  - [ ] Test on minimal repository (should output error mode)
  - [ ] Test on very large repository (verify timeout handling)
  - [ ] Verify prompt structure and ordering

### Phase 3: AGENTS.md Injection System

### Phase 3: AGENTS.md Injection System

- [ ] Create `src/utils/AgentsFileResolver.ts`
  - [ ] Implement `discoverAgentsFiles()`
  - [ ] Implement `formatAgentsContent()` with XML formatting
  - [ ] Implement `getRelativePath()`
  - [ ] Add error handling and logging
  - [ ] Write unit tests

### Phase 4: CLI Integration for Injection

- [ ] Modify `src/flightpath/harness/copilot/CopilotCliProvider.ts`
  - [ ] Add `--no-custom-instructions` flag logic in `buildCliArgs()`
  - [ ] Test flag behavior with Copilot CLI

- [ ] Modify `src/flightpath/HarnessIntegration.ts`
  - [ ] Add `getAgentsHierarchyContent()` method
  - [ ] Add `getPromptContextPath()` method
  - [ ] Integrate into `HarnessIntegration.ts` prompt building (alongside context/agent expansion)
  - [ ] Test injection with multiple hierarchy levels

### Phase 5: Settings & Configuration

- [ ] Modify `src/utils/ConfigurationUtils.ts`
  - [ ] Add `shouldDisableCopilotAgentsMd()`
  - [ ] Add `shouldAttachAgentsHierarchy()`
  - [ ] Add `shouldCreateClaudeMdSymlinks()`

- [ ] Modify `package.json`
  - [ ] Add `disableCopilotAgentsMd` setting
  - [ ] Add `attachAgentsHierarchy` setting
  - [ ] Add `createClaudeMdSymlinks` setting
  - [ ] Add `templateSetupScriptTimeout` setting (from Phase 1)

### Phase 6: Documentation & Testing

- [ ] Update `.github/copilot-instructions.md`
  - [ ] Document new AGENTS.md system
  - [ ] Document settings usage
  - [ ] Add architecture notes

- [ ] Create user guide: `docs/AGENTS_MD_USAGE.md`
  - [ ] Workflow generation guide
  - [ ] Settings configuration guide
  - [ ] Best practices for AGENTS.md content

### Phase 6: Documentation & Testing

- [ ] Update `.github/copilot-instructions.md`
  - [ ] Document new AGENTS.md system
  - [ ] Document settings usage
  - [ ] Add architecture notes
  - [ ] Reference TEMPLATE_SETUP_SCRIPTS.md

- [ ] Update `docs/WORKFLOW_TEMPLATES_DESIGN.md`
  - [ ] Add "Generate Repository Instructions" to built-in templates list
  - [ ] Document setup script feature integration

- [ ] Create user guide: `docs/AGENTS_MD_USAGE.md`
  - [ ] Template usage guide (New Workflow → Generate Repository Instructions)
  - [ ] Settings configuration guide
  - [ ] Best practices for AGENTS.md content
  - [ ] Troubleshooting setup script issues

- [ ] Unit tests
  - [ ] AgentsFileResolver discovery and formatting
  - [ ] Setup script output parsing
  - [ ] Trust state management
- [ ] Integration tests
  - [ ] Template execution end-to-end
  - [ ] AGENTS.md hierarchy injection
  - [ ] CLI flag integration

- [ ] Manual testing
  - [ ] Test template selection in New Workflow modal
  - [ ] Verify setup script executes and generates workflow
  - [ ] Run generated workflow and verify AGENTS.md files
  - [ ] Test hierarchical injection with 3+ levels
  - [ ] Verify `--no-custom-instructions` flag works
  - [ ] Test with Claude CLI (should be unaffected)
  - [ ] Test with Codex CLI (should be unaffected)
  - [ ] Test trust dialog for custom templates with setup scripts

### Phase 7: Polish & Release

- [ ] Add telemetry/analytics for feature usage
- [ ] Add error recovery and user feedback
- [ ] Create demo video or GIF showing:
  - [ ] Using "Generate Repository Instructions" template
  - [ ] Setup script execution and workflow generation
  - [ ] Running the workflow to create AGENTS.md files
  - [ ] Enabling hierarchical injection
- [ ] Update CHANGELOG.md
- [ ] Update README.md with new feature
- [ ] Prepare release notes highlighting:
  - [ ] First scripted template example
  - [ ] AGENTS.md standardization across tools
  - [ ] Hierarchical instruction injection

---

## Edge Cases & Considerations

### 1. Empty Directory Tree

**Scenario**: Repository has no candidate directories (very small project)
**Solution**: Show info message: "No suitable directories found for AGENTS.md generation. Consider creating manually at project root."

### 2. Existing AGENTS.md Files

**Scenario**: Some AGENTS.md files already exist in repository
**Solution**: Workflow prompts should include instruction: "If AGENTS.md already exists, review and update it rather than overwriting"

### 3. Very Deep Directory Trees

**Scenario**: Repository with 10+ levels of nesting
**Solution**: Add max depth limit (default: 8 levels) to prevent excessive prompt generation

### 4. Large Repositories (100+ directories)

**Scenario**: Monorepo with hundreds of potential candidate directories
**Solution**:

- Setup script can implement stricter filtering (>2 files AND >1 subdirectory)
- Consider max prompts limit (e.g., 50 prompts max) with warning message
- User can review and edit generated workflow before execution
- Consider batching prompts (10-20 directories per workflow run) in future versions
  **Solution**: Use workflow file's directory as starting point for AGENTS.md discovery

### 6. Multiple Workspace Folders

**Scenario**: VS Code multi-root workspace
**Solution**: Prompt user to select which workspace folder to generate workflow for

### 7. Symlink Creation on Windows

**Scenario**: Symlink creation requires admin privileges on some Windows systems
**Solution**: Include fallback in prompts: "If symlink creation fails, copy AGENTS.md to CLAUDE.md instead"

### 8. Setup Script Execution Failure

**Scenario**: Setup script crashes, times out, or outputs invalid JSON  
**Solution**:

- Show error dialog with technical details
- Offer "View Logs" button to see stderr output
- Fallback: User can manually create AGENTS.md or use a simpler template
- Add retry mechanism for transient failures

---

## Testing Strategy

### Unit Tests

**AgentsFileResolver**:

- Test discovery with 0, 1, 2, 3+ AGENTS.md files in hierarchy
- Test XML formatting with various content types
- Test relative path generation
- Test error handling for missing files

**Setup Script** (analyze-repo-for-agents.js):

- Mock file system for predictable testing
- Test directory walking with various structures
- Test filtering rules (include/exclude patterns)
- Test topological sorting with complex trees
- Test prompt generation for different directory types
- Test JSON output format (workflow mode)
- Test error output format

**TemplateManager** (setup script execution):

- Test script execution with valid workflow output
- Test script execution with error output
- Test timeout handling
- Test trust state management
- Test stderr logging capture

### Integration Tests

**End-to-End Template Flow**:

1. Open New Workflow modal
2. Select "Generate Repository Instructions" template
3. Verify setup script executes
4. Verify workflow structure in modal preview
5. Create workflow file
6. Verify file contents match expected structure

**End-to-End AGENTS.md Generation**:

1. Create temporary test repository structure
2. Generate workflow via template
3. Mock AI responses to create AGENTS.md files
4. Verify file creation and content
5. Verify symlink creation (if enabled)

**Hierarchical Injection**:

1. Create test repository with 3-level AGENTS.md hierarchy
2. Enable `attachAgentsHierarchy` setting
3. Send test prompt
4. Verify XML tags and ordering in injected content
5. Verify `--no-custom-instructions` flag presence

### Manual Testing Checklist

- [ ] Test template in New Workflow modal
- [ ] Verify setup script generates workflow for FlightPath repository
- [ ] Review generated prompts for clarity and correctness
- [ ] Run workflow and verify AGENTS.md content quality
- [ ] Test with all three CLI providers (Copilot, Claude, Codex)
- [ ] Verify Copilot ignores its native AGENTS.md with flag
- [ ] Verify hierarchical injection works correctly
- [ ] Test symlink creation on Windows and Unix
- [ ] Test with repository having no candidate directories (error mode)
- [ ] Test with repository having 50+ candidate directories
- [ ] Test setup script timeout handling
- [ ] Test trust dialog for custom setup scripts
- [ ] Verify settings persistence across sessions

---

## Future Enhancements

### 1. Incremental Updates

**Feature**: Template variant that updates/refreshes specific AGENTS.md files without regenerating entire workflow  
**Implementation**: Setup script that detects existing AGENTS.md files and generates prompts only for changed directories  
**Use Case**: After major refactoring, update affected AGENTS.md files only

### 2. Template Library

**Feature**: Additional scripted templates for common patterns  
**Examples**:

- "Component Test Generator" - Discovers React components, generates test prompts
- "API Documentation" - Finds route definitions, creates documentation prompts
- "Migration Helper" - Identifies migration candidates, creates refactoring workflow  
  **Use Case**: Faster workflow creation for common development tasks

### 3. AGENTS.md Validation

**Feature**: Setup script that validates existing AGENTS.md files  
**Checks**: Conciseness, no duplication with parent files, proper structure  
**Output**: Report with suggestions for improvements  
**Use Case**: Maintain high-quality instruction files over time

### 4. Setup Script Parameters

**Feature**: Allow templates to declare configurable parameters (see TEMPLATE_SETUP_SCRIPTS.md Future Enhancements)  
**Example**: Max depth, min file count, custom exclude patterns  
**Use Case**: User customization of generation logic without editing script

### 5. Multi-Root Workspace Support

**Feature**: Setup script detects multi-root workspace, prompts user to select folder  
**Feature**: Allow users to define custom prompt templates in `.flightpath/templates/agents-prompts/`
**Use Case**: Organization-specific instruction formats and standards

---

## Success Metrics

### Adoption Metrics

- Number of users selecting "Generate Repository Instructions" template
- Number of repositories with `attachAgentsHierarchy` enabled
- Number of AGENTS.md files created via generated workflows
- Setup script success rate vs. error rate

### Quality Metrics

- User satisfaction (feedback, GitHub issues)
- Copilot response quality improvement (subjective, user reports)
- Reduction in context-related errors
- Setup script execution time on various repo sizes

### Performance Metrics

- Setup script execution time (target: <2 seconds for typical repo)
- AGENTS.md discovery time (target: <100ms)
- Injection overhead (target: <50ms added to prompt building)

---

## Conclusion

This implementation provides FlightPath users with a comprehensive, standardized approach to repository instructions through two independent but complementary systems:

**Generation System** (via scripted template):

1. **Automated workflow creation** based on repository structure
2. **First example** of FlightPath's powerful setup script system
3. **User control** through reviewable generated workflows
4. **Cross-tool compatibility** via CLAUDE.md symlinks

**Injection System** (runtime):

1. **Works consistently across all CLI providers** (Copilot, Claude, Codex)
2. **Provides full hierarchical concatenation** (not just nearest file)
3. **Replaces Copilot's broken implementation** with correct behavior
4. **XML-tagged attribution** for clear instruction sources

**Key Innovation**: By implementing AGENTS.md generation as a **scripted template** rather than a standalone command, we:

- Demonstrate the power and flexibility of the template setup script system
- Maintain consistent UX (all workflows created via "New Workflow" flow)
- Enable users to customize the generation logic by copying and modifying the template
- Set the pattern for future intelligent workflow generators

The workflow-based approach fits FlightPath's philosophy of transparent, reproducible automation while giving users full visibility and control over the process.

```

```
