# YAML Workflow Format Support

## Problem Statement

FlightPath currently uses JSON for workflow files (`.flightpath.json`, `.prompt.json`), which has significant usability issues:

1. **No Multi-line Strings**: JSON requires escaping newlines (`\n`), making prompts hard to read and edit
2. **Manual Editing is Clunky**: Long prompts become unwieldy single-line strings
3. **Poor Readability**: Complex workflows with multi-paragraph prompts are difficult to maintain
4. **Confusing Dual Formats**: Both `.prompt.json` and `.flightpath.json` exist, causing user confusion

**Example of the problem:**

```json
{
  "prompts": [
    {
      "prompt": "Analyze the FlightPath extension architecture and suggest improvements.\n\nFocus on:\n- Separation of concerns\n- SOLID principles\n- Code maintainability\n\nProvide specific recommendations with code examples.",
      "model": "claude-sonnet-4.5"
    }
  ]
}
```

## Solution: YAML Support

Add support for YAML workflow files alongside JSON, providing a more human-friendly editing experience.

### Supported File Formats (Post-Implementation)

| Format             | Purpose                     | Use Case                                            |
| ------------------ | --------------------------- | --------------------------------------------------- |
| `.prompt.md`       | Single prompts (Markdown)   | Quick one-off prompts, simplest format              |
| `.flightpath.yaml` | Multi-step workflows (YAML) | Complex workflows with readable multi-line prompts  |
| `.flightpath.json` | Multi-step workflows (JSON) | Programmatic generation, CI/CD, API usage           |
| ~~`.prompt.json`~~ | **REMOVED**                 | Deleted - confusing and redundant with `.prompt.md` |

**Note**: Pre-release status means no backward compatibility needed. All `.prompt.json` files have been deleted from the project.

### YAML Advantages

1. **Native Multi-line Strings**: Use literal block scalar (`|`) for preserved line breaks
2. **Readable Formatting**: Natural indentation and structure
3. **Comment Support**: Inline documentation with `#` comments
4. **Easier Editing**: Standard text editing without escape sequences
5. **Cleaner Context References**: Multi-line prompts with `@workspace`, `#file:path` references

### YAML Multi-line String Syntax

**Literal Block Scalar (`|`) - DEFAULT**:

- Preserves all line breaks exactly as written
- Use for prompts with lists, formatting, XML tags
- What you see is what you get

**Folded Scalar (`>`) - OPTIONAL**:

- Folds single newlines into spaces
- Use only for long prose paragraphs
- Less common for AI prompts

**FlightPath convention**: Always use `|` (literal) in templates and examples for predictable formatting.

## YAML Format Specification

### Single Prompt Format

```yaml
# Single prompt workflow
prompt: |
  Analyze the FlightPath extension architecture and suggest improvements.

  Focus on:
  - Separation of concerns
  - SOLID principles
  - Code maintainability

  Provide specific recommendations with code examples.

model: claude-sonnet-4.5

endCondition:
  script: validate_improvements.py
  returns: "true"
  timeout: 30000
```

### Multi-Prompt Workflow Format

```yaml
# Multi-step feature implementation workflow
prompts:
  - id: analyze
    prompt: |
      Analyze the current authentication system in the codebase.

      Focus on:
      - Security vulnerabilities
      - Code organization
      - Test coverage

      Provide a detailed report with recommendations.
    model: claude-sonnet-4.5
    endCondition:
      script: check_analysis.js
      returns: "true"

  - id: implement
    prompt: |
      Based on the analysis, implement the following improvements:

      1. Add OAuth2 support
      2. Improve password hashing
      3. Add rate limiting

      Follow the recommendations from the analysis step.
    newChatSession: false
    endCondition:
      script: verify_changes.py
      returns: "true"
      maxRetries: 2
      retryPrompt: |
        The validation failed: {error}

        Please review and fix the implementation.

  - id: test
    prompt: Write comprehensive tests for the new authentication features.
    model: claude-haiku-4.5
```

### File Path References

```yaml
# Prompt referencing external file
prompt: ./prompts/analyze-code.prompt.md
model: claude-sonnet-4.5

endCondition:
  script: validate_analysis.sh
  returns: "success"
```

### Dynamic Queue Example

```yaml
# Workflow that can extend itself
prompts:
  - id: plan
    prompt: |
      Create an implementation plan for adding user profile management.

      Break down the work into steps and add them to this workflow.
    allowDynamicExtension: true
    model: claude-sonnet-4.5

  - id: review
    prompt: Review all changes and ensure they meet the requirements.
    model: claude-sonnet-4.5
```

### Agent-Based Workflow

```yaml
# Using custom agents (CLI mode only)
prompts:
  - id: orchestrate
    prompt: |
      Plan the implementation of a new settings panel.

      Create a detailed plan with implementation steps.
    agent: flightpath-orchestrator
    model: claude-sonnet-4.5

  - id: implement
    prompt: Implement the plan from the orchestrator.
    agent: code-architect
    newChatSession: false
```

## Implementation Plan

### Phase 1: Core YAML Support

1. **Add YAML Parser** (`js-yaml` dependency)
   - Install: `npm install js-yaml @types/js-yaml`
   - Add to `PromptFileParser.ts`

2. **Update File Detection**
   - Modify `PromptFileParser.parsePromptFile()` to detect `.yaml` extension
   - Parse YAML and convert to `PromptFile` interface (same as JSON)

3. **Schema Handling** (Single Source of Truth)
   - Keep `schemas/prompt-schema.json` as the canonical schema
   - **Auto-generate** `schemas/prompt-schema.yaml` from JSON schema via npm script
   - Both formats use the same schema (JSON Schema can be written in YAML)
   - Validate parsed YAML against schema (convert to JSON internally for AJV)

4. **File Type Registration**
   - Update `package.json` language associations
   - Add `.flightpath.yaml` to file patterns
   - Remove `.prompt.json` from all file patterns

### Phase 2: Context Menu & Commands

1. **Context Menu Integration**
   - Add `.flightpath.yaml` to `when` clauses
   - Update `executePromptFile()` to handle YAML files

2. **Command Updates**
   - `flightpath.createPromptFile` - Default to YAML format
   - `flightpath.takeOff` - Support YAML file selection
   - Add setting: `flightpath.defaultWorkflowFormat` (yaml | json)

3. **Template System**
   - Convert all templates in `src/templates/workflows/` to YAML
   - Keep JSON versions for reference/compatibility
   - Update `TemplateManager.ts` to respect format setting
   - All templates use `|` (literal) for multi-line prompts

### Phase 3: Editor Experience

1. **IntelliSense Support**
   - Add YAML schema to VS Code settings
   - Configure schema association for `*.flightpath.yaml`
     (use `|` for prompts)

2. **Validation**
   - Real-time schema validation in editor
   - Error diagnostics for invalid YAML

3. **Default Format Setting**
   - Add `flightpath.defaultWorkflowFormat` setting
   - Default: `yaml` (human-friendly editing)
   - Option: `json` (programmatic/automation use)
   - Used by `flightpath.createPromptFile` command
4. **Validation**
   - Real-time schema validation in editor
   - Error diagnostics for invalid YAML

### Phase 4: Remove `.prompt.json` Support

**Status**: ✅ Completed - All `.prompt.json` files deleted from project

1. **Files Deleted**
   - `manual-test/test-simple.prompt.json`
   - `manual-test/.flightpath/with-end-condition.prompt.json`
   - `manual-test/.flightpath/with-file.prompt.json`
   - `src/test/fixtures/prompts/single.prompt.json`

2. **Code Cleanup Required**
   - Remove `.prompt.json` from all file patterns in `package.json`
   - Remove from context menu `when` clauses
   - Remove parser logic (no backward compatibility needed)
   - Remove from command file pickers

3. **Documentation Updates**
   - Update all docs to remove `.prompt.json` references
   - Update examples and templates
   - Update test documentation in `manual-test/README.md`

## Technical Implementation Details

### PromptFileParser Changes

````typescript
import * as yaml from 'js-yaml';

export class PromptFileParser {
  async parsePromptFile(filePath: string): Promise<PromptFile> {
    const content = await fs.readFile(filePath, 'utf8');
    const ext = path.extname(filePath).toLowerCase();

    let data: any;

    if (ext === '.yaml' || ext === '.yml') {
      // Parse YAML
      data = yaml.load(content);
    } else if (ext === '.json') {
      // Parse JSON (.flightpath.json only, .prompt.json removed)
      data = JSON.parse(content);
    } else if (ext === '.md') {
      // Existing Markdown parsing
      return this.parseMarkdownPrompt(content);
    } else {
      throw new Error(`Unsupported file type: ${ext}`);
    }

    // Validate against schema (same for both JSON and YAML)
    this.validatePromptFile(data);

    return data as PromptFile;
  }
}
``` - Single Source of Truth

**Approach**: Auto-generate YAML schema from JSON schema

JSON Schema is format-agnostic - the same schema can be written in JSON or YAML. We'll:

1. **Canonical Source**: Keep `schemas/prompt-schema.json` as the single source of truth
2. **Auto-Generate YAML**: Create npm script to convert JSON → YAML schema
3. **Build Integration**: Run conversion during build process
4. **Runtime Validation**: Parse YAML workflows → convert to JSON → validate with AJV

**Benefits**:
- ✅ Single source of truth (no drift between schemas)
- ✅ Simple maintenance (edit JSON, YAML auto-generates)
- ✅ VS Code IntelliSense works with YAML schema
- ✅ Existing validation logic unchanged

**Implementation**:

```javascript
// scripts/generate-yaml-schema.mjs
import fs from 'fs';
import yaml from 'js-yaml';

const jsonSchema = JSON.parse(
  fs.readFileSync('schemas/prompt-schema.json', 'utf8')
);

const yamlSchema = yaml.dump(jsonSchema, {
  indent: 2,
  lineWidth: 100,
  noRefs: true,
  sortKeys: false
});

fs.writeFileSync('schemas/prompt-schema.yaml', yamlSchema, 'utf8');
console.log('✅ Generated schemas/prompt-schema.yaml from JSON schema');
````

**Package.json scripts**:

```json
{
  "scripts": {
    "generate-schema": "node scripts/generate-yaml-schema.mjs",
    "prebuild": "npm run generate-schema",
    "precompile": "npm run generate-schema"
  }
}
```

This ensures the YAML schema is always up-to-date with the JSON

**Recommendation**: Use Option 1 - parse YAML to JSON internally, validate with existing schema.

### VS Code Configuration

Add to `package.json`:

```json
{
  "contributes": {
    "yamlValidation": [
      {
        "fileMatch": "*.flightpath.yaml",
        "url": "./schemas/prompt-schema.json"
      }
    ],
    "languages": [
      {
        "id": "yaml",
        "extensions": [".flightpath.yaml"],
        "aliases": ["FlightPath Workflow (YAML)"]
      }
    ]
  }
}
```

Install `redhat.vscode-yaml` extension for YAML IntelliSense (recommended, not required).

## Migration Strategy

### User Migration Path

1. **Simple Single Prompts**: `.prompt.json` → `.prompt.md`
   ```json
   { "prompt": "Analyze this code" }
   ```
   Becomes:
   ```markdown
   Analyze this code
   **Status**: ✅ No migration needed - All `.prompt.json` files deleted
   ```

Since FlightPath is pre-release:

- No backward compatibility required
- No user migration concerns
- Clean slate for new format support

Future users will create new workflows using:

- `.prompt.md` for simple single prompts
- `.flightpath.yaml` for complex multi-step workflows (recommended)
- `.flightpath.json` for programmatic/CI/CD use cases {
  "prompt": "Analyze the FlightPath extension architecture.\n\nFocus on:\n- Code organization\n- SOLID principles\n- Areas for improvement\n\nProvide specific recommendations.",
  "model": "claude-sonnet-4.5"
  },
  {
  "prompt": "Based on the analysis, implement the following:\n\n1. Refactor FlightPathManager\n2. Extract common interfaces\n3. Improve error handling\n\nFollow SOLID principles.",
  "endCondition": {
  "script": "validate_refactor.py",
  "returns": "true",
  "maxRetries": 2,
  "retryPrompt": "Validation failed: {error}\n\nPlease fix the issues."
  }
  }
  ]
  }

````

### After (YAML) - Easy to Edit

```yaml
prompts:
  - prompt: |
      Analyze the FlightPath extension architecture.

      Focus on:
      - Code organization
      - SOLID principles
      - Areas for improvement

      Provide specific recommendations.
    model: claude-sonnet-4.5

  - prompt: |
      Based on the analysis, implement the following:

      1. Refactor FlightPathManager
      2. Extract common interfaces
      3. Improve error handling

      Follow SOLID principles.
    endCondition:
      script: validate_refactor.py
      returns: "true"
      maxRetries: 2
      retryPrompt: |
        Validation failed: {error}

        Please fix the issues.
````

## Documentation Updates Required

1. **README.md** - Update file format list, remove `.prompt.json`
2. **QUICK_START.md** - Show YAML examples instead of `.prompt.json`
3. **copilot-instructions.md** - Update file format section
4. **WORKFLOW_TEMPLATES_DESIGN.md** - Add YAML template examples
5. **All example files** - Convert to `.prompt.md` or `.flightpath.yaml`

## Testing Requirements

1. **Unit Tests**
   - Parse valid YAML workflows
   - Parse single prompt YAML
   - Validate YAML against schema
   - Handle malformed YAML gracefully
   - Test file path references in YAML

2. **Integration Tests**
   - Execute YAML workflows end-to-end
   - Multi-step YAML workflows
   - YAML with end conditions
   - Dynamic queue with YAML

3. **Manual Testing**
   - Create workflows from YAML templates
   - Edit YAML in VS Code with IntelliSense
   - Context menu integration
   - File path resolution

## Benefits Summary

### For Users

- ✅ **Easier to write**: Natural multi-line prompts
- ✅ **Easier to read**: Clear structure and indentation
- ✅ **Easier to maintain**: Comments and readable formatting
- ✅ **Less confusing**: Single format for workflows (`.flightpath.yaml`)
- ✅ **Better editing**: Standard YAML editor support

### For FlightPath

- ✅ **Simplified formats**: 3 clear file types instead of 4
- ✅ **Better UX**: Users can choose format based on use case
- ✅ **Industry standard**: YAML is widely used for configs/workflows
- ✅ **Future-proof**: YAML supports complex structures as features grow

## Timeline Estimate

- **Phase 1** (Core YAML Support): 4-6 hours
- **Phase 2** (Context Menu & Commands): 2-3 hours
- **Phase 3** (Editor Experience): 2-3 hours
- **Phase 4** (Remove `.prompt.json`): 3-4 hours
- **Testing & Documentation**: 4-5 hours

**Total**: ~15-21 hours

## Risks & Mitigations

| Risk                            | Mitigation                                         |
| ------------------------------- | -------------------------------------------------- |
| YAML parsing errors             | Comprehensive error handling, clear error messages |
| Schema validation complexity    | Reuse JSON schema, convert YAML→JSON internally    |
| Breaking changes for JSON users | Keep JSON support, only deprecate `.prompt.json`   |
| IntelliSense not working        | Document `redhat.vscode-yaml` requirement          |
| Migration confusion             | Clear docs, automated migration tool               |

## Decision: YAML vs TOML vs Other

**Why YAML over TOML?**

- More widely adopted in dev tools (GitHub Actions, Docker Compose, K8s)
- Better multi-line string support (literal block scalars)
- VS Code has excellent YAML support built-in
- Familiar to most developers

\*\*WDefault Format Strategy

**YAML is the new default** for user-created workflows:

### When to Use Each Format

| Format       | Default For               | Best For                                |
| ------------ | ------------------------- | --------------------------------------- |
| **YAML**     | ✅ User-created workflows | Human editing, direct prompt authoring  |
| **JSON**     | ⚠️ Opt-in via setting     | CI/CD, scripts, API generation, tooling |
| **Markdown** | ✅ Single prompts         | Simplest option, quick tasks            |

### Implementation

1. **Setting**: `flightpath.defaultWorkflowFormat` = `"yaml"` (default)
2. **Templates**: All workflow templates provided in YAML format
3. **Commands**: `flightpath.createPromptFile` generates `.flightpath.yaml` by default
4. **Documentation**: YAML examples shown first, JSON as alternative

### Rationale

- 🎯 **Primary use case**: Humans writing prompts manually
- 📝 **Natural editing**: Line breaks, comments, readable structure
- 🔧 **JSON compatibility**: Automation tools can still generate JSON
- 🚀 **Future-proof**: YAML is standard for config files (GitHub Actions, Docker, K8s)

## Post-Implementation

After YAML support is stable:

1. **All new templates** ship as YAML (JSON deprecated for templates)
2. **Documentation** shows YAML examples first
3. **Tutorials** teach YAML format as primary
4. **JSON** remains fully supported for programmatic use
   After YAML support is stable:

5. **Update all templates** to use YAML by default
6. **Documentation** should show YAML examples first
7. **Tutorials** should teach YAML format
8. **JSON** remains documented for API/CI/CD use cases
9. **Markdown** remains the simplest option for single prompts

---

## Summary

FlightPath will support **three file formats**:

| Format       | Use Case                           | Extension          |
| ------------ | ---------------------------------- | ------------------ |
| **Markdown** | Single prompts, simplest option    | `.prompt.md`       |
| **YAML**     | Multi-step workflows, human-edited | `.flightpath.yaml` |
| **JSON**     | Programmatic generation, CI/CD     | `.flightpath.json` |

This provides:

- **Simplicity** for quick tasks (Markdown)
- **Readability** for complex workflows (YAML - DEFAULT)
- **Programmability** for automation (JSON - opt-in)

**Key Decisions**:

1. **YAML is the default** for user-created workflows (better UX for manual editing)
2. **Use `|` (literal block scalar)** in all templates for predictable line break handling
3. **JSON remains supported** for automation tools via `defaultWorkflowFormat` setting
4. **`.prompt.json` removed** - confusing and redundant with `.prompt.md`

---

## Implementation Checklist

- **Phase 1** (Core YAML Support): 4-6 hours
  - Update context menus
  - Update command file pickers
  - Add YAML template support
- **Phase 3** (Editor Experience): 2-3 hours
  - Configure VS Code YAML schema association
  - Add code snippets for YAML workflows
- **Phase 4** (Remove `.prompt.json`): 2-3 hours
  - ✅ Files already deleted
  - Remove from `package.json`
  - Remove from code (file pickers, patterns)
  - Update documentation
- **Testing & Documentation**: 3-4 hours
  - Create YAML test files
  - Update manual test docs
  - Update README and guides

**Total**: ~13-19 hours (reduced due to no migration needed)at will be deprecated and removed to eliminate confusion.
