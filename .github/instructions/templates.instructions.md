---
applyTo: "src/templates/**"
---

<purpose>
Templates for end condition scripts, custom agents, and workflow files.
Copied to `out/templates/` during build.
</purpose>

<directory>
`agents/` - Custom agents with manifest
`workflows/` - Workflow templates (YAML) with manifest
`check_condition.*` - End condition script templates (5 types: `.py`, `.js`, `.sh`, `.bat`, `.ps1`)
</directory>

<endConditionScripts>
**Contract:** stdout = expected value, exit 0 = success. Include shebang. Use `subprocess`/`spawn` (not `eval`). Default to returning `"true"`.
</endConditionScripts>

<agentFormat>
`.agent.md` files with YAML frontmatter (`name`, `description`, optional: `tools`, `model`).

Two structural styles in use:

- **XML structure** (`spec-orchestrator`): `<purpose>`, `<guidelines>`, `<criticalRules>` tags
- **Markdown headings** (`flightpath-orchestrator`): standard `##` sections

Both styles are valid. XML structure is preferred for agents that need strict behavioral rules.
</agentFormat>

<manifestFiles>
`agents/manifest.json` and `workflows/manifest.json` share the same schema:
```json
{ "id", "label", "description", "file", "tags": [], "icon": "$(codicon)" }
```
Loaded by TemplateImporter for import commands. Must be valid JSON.
</manifestFiles>

<templateVariables>
Templates support `{variableName}` placeholder substitution:

**Built-in workflow templates** (`BUILT_IN_TEMPLATE_IDS` in TemplateManager):

- `blank` — generated (no file), empty 2-prompt workflow
- `simple-feature` — `{featureDescription}`
- `fix-tests` — `{testCommand}`
- `full-feature` — `{featureDescription}`, `{planDocument}`
- `spec-driven-loop` — `{file:specFile}` (file type with `fileFilter` + `autoFillFilename`)

**Reserved variables** (injected at runtime into `retryPrompt`, do NOT use as template placeholders):

- `{stdout}` — stdout from the endCondition script
- `{stderr}` — stderr from the endCondition script
- `{expected}` — expected return value
- `{actual}` — actual return value (same as stdout)
- `{exitCode}` — script exit code
- `{compareSource}` — compare mode (`auto`, `stdout`, `stderr`)

**Variable extraction pattern:** `/\{(?:(file|text):)?([a-z][a-zA-Z0-9]*)\}/g`

**Typed placeholder syntax:**

| Syntax           | Type            | Modal UI                                                    |
| ---------------- | --------------- | ----------------------------------------------------------- |
| `{varName}`      | text (default)  | plain text input                                            |
| `{text:varName}` | text (explicit) | plain text input                                            |
| `{file:varName}` | file            | text input + Browse button (workspace-relative file picker) |

`extractVariables()` parses the type prefix. `replaceVariables()` substitutes all three forms.

**`_templateMeta` block** — declare in any template (built-in YAML or custom JSON) to enrich variables with UI metadata:

```yaml
_templateMeta:
  name: My Template
  description: What this does
  variables:
    specFile:
      type: file
      fileFilter: ["**/*.md", "**/*.txt"]
      autoFillFilename: true # auto-fills workflow filename from selected file's basename
```

- `fileFilter` — glob patterns for the file picker
- `autoFillFilename: true` — only the first variable with this wins; others are ignored with a warning
- `_templateMeta` is stripped from the workflow file on creation (it's authoring metadata only)
  </templateVariables>

<workflowFields>
Built-in templates use YAML (`.flightpath.yaml`). Custom templates use JSON (`.flightpath.json`).

Key workflow-level fields used in templates:

- `steps[]` — main execution sequence
- `finalStep` — single prompt run after all `steps` complete; used with `agent` + `mcpServers: ["flightpath"]` + `priorContext: all` for orchestration loops (see `spec-driven-loop`)
- `resumeSession: true` on a prompt — continues in the same session as the previous prompt

The `_templateMeta` top-level key is template-only; never appears in executed workflow files.
</workflowFields>

<contextSyntax>
**Full file / directory attachment:** `@path/to/file.ts`, `@path/to/dir/`
**Line range:** `#selection:path:startLine-endLine`
**Template file variable:** `@{file:varName}` — substituted before parsing

Use `@path` for attaching whole files in templates — portable across all harnesses.
`@{file:varName}` is the correct syntax for file-type template variables (note: `@` prefix outside the braces).
</contextSyntax>

<integration>
**TemplateManager**: Loads/extracts/substitutes variables, discovers custom templates.
- Built-in paths: `out/templates/workflows/` (YAML files)
- Custom paths: `.flightpath/templates/` (JSON files, IDs prefixed with `custom:`)
- `getAvailableTemplates()` reads `_templateMeta` from each YAML/JSON file for name, description, and variable enrichment

**TemplateImporter**: Copies agents/workflows, loads manifests, handles import commands
</integration>

<build>
Source: `src/templates/` → Output: `out/templates/` (never edit `out/`). Access via `context.extensionPath`. Manifests must be valid JSON.
</build>
