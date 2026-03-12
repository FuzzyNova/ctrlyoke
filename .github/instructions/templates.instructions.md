---
applyTo: "src/templates/**"
---

<purpose>
Templates for end condition scripts, custom agents, and workflow files.
Copied to `out/templates/` during build.
</purpose>

<directory>
`agents/` - Custom agents with manifest
`workflows/` - Workflow templates (JSON + YAML) with manifest
`check_condition.*` - End condition script templates (5 types)
</directory>

<endConditionScripts>
**Contract:** stdout = expected value, exit 0 = success. Supports `.py`, `.js`, `.sh`, `.bat`, `.ps1`. Include shebang, avoid network/filesystem, use subprocess (not `eval`).
</endConditionScripts>

<agentFormat>
`.agent.md` with YAML frontmatter (name, description, optional: tools, model). XML structure: `<purpose>`, `<guidelines>`, optional: `<criticalRules>`, `<examples>`, `<context>`. See XML_PROMPTING_GUIDELINES.md.
</agentFormat>

<manifestFiles>
`agents/manifest.json` - Agent metadata (id, label, description, file, tags, icon)
`workflows/manifest.json` - Workflow metadata (same structure)
Loaded by TemplateImporter for import commands.
</manifestFiles>

<templateVariables>
Templates support `{variableName}` placeholder substitution:

**Built-in templates** (defined in TemplateManager.BUILT_IN_TEMPLATES):

- `simple-feature`: `{featureDescription}`
- `fix-tests`: `{testCommand}`
- `full-feature`: `{featureDescription}`, `{planDocument}`
- `spec-driven-loop`: `{specFile}`

**Reserved variables** (automatically injected, do NOT use in templates):

- `{scriptOutput}` - Output from endCondition script
- `{retryCount}` - Current retry attempt
- `{maxRetries}` - Maximum retries allowed

**Variable extraction**:

- Pattern: `/\{([a-z][a-zA-Z0-9]*)\}/g`
- Filters out reserved variables
- Used by TemplateManager.extractVariables()

**Typed placeholder syntax** — variable type is encoded directly in the placeholder:

| Syntax | Type | Modal UI |
|--------|------|----------|
| `{varName}` | text (default) | plain text input |
| `{text:varName}` | text (explicit) | plain text input |
| `{file:varName}` | file | text input + Browse button (workspace-relative file picker) |

This syntax works in **both built-in and custom templates** — `extractVariables()` parses the prefix. `replaceVariables()` substitutes all three forms with the user-provided value.

**Advanced built-in-only metadata** (cannot be expressed in placeholder syntax, declared in `TemplateManager.BUILT_IN_TEMPLATES`):

- `fileFilter` — glob patterns for the file picker filter (e.g. `['**/*.md', '**/*.txt']`)
- `autoFillFilename: true` — auto-fills the workflow name from the selected file's basename
  </templateVariables>

<contextSyntax>
**Full file / directory attachment:** `@path/to/file.ts`, `@path/to/dir/`
**Line range or symbol:** `#file:path`, `#file:path:startLine-endLine`, `#file:"path with spaces"`
**Passed through (harness-handled):** `@workspace`, `#codebase`, slash commands

Use `@path` for attaching whole files in templates — it is portable across all harnesses.
`#file:` is for line ranges and symbol excerpts only.
</contextSyntax>

<workflowGuidelines>
Provide JSON + YAML. Use `|` for multi-line YAML. Avoid harness-specific syntax. Import target: `.flightpath/templates/`
</workflowGuidelines>

<integration>
**TemplateManager**: Loads/extracts/substitutes variables, discovers custom templates. Paths: `out/templates/workflows/` (built-in), `.flightpath/templates/` (custom)
**TemplateImporter**: Copies agents/workflows, loads manifests, handles import commands
</integration>

<build>
Source: `src/templates/` → Output: `out/templates/` (never edit). Access via `context.extensionPath`. Manifests must be valid JSON.
</build>
