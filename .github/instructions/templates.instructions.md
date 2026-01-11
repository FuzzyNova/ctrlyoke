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

**Reserved variables** (automatically injected, do NOT use in templates):

- `{scriptOutput}` - Output from endCondition script
- `{retryCount}` - Current retry attempt
- `{maxRetries}` - Maximum retries allowed

**Variable extraction**:

- Pattern: `/\{([a-z][a-zA-Z0-9]*)\}/g`
- Filters out reserved variables
- Used by TemplateManager.extractVariables()
  </templateVariables>

<contextSyntax>
**Parsed:** `#file:path`, `#file:path:lines`, `#file:"path with spaces"`
**Passed through:** `@workspace`, `#codebase`, slash commands (provider-specific)
Use `#file:` for portable templates.
</contextSyntax>

<workflowGuidelines>
Provide JSON + YAML. Use `|` for multi-line YAML. Avoid provider-specific syntax. Import target: `.flightpath/templates/`
</workflowGuidelines>

<integration>
**TemplateManager**: Loads/extracts/substitutes variables, discovers custom templates. Paths: `out/templates/workflows/` (built-in), `.flightpath/templates/` (custom)
**TemplateImporter**: Copies agents/workflows, loads manifests, handles import commands
</integration>

<build>
Source: `src/templates/` → Output: `out/templates/` (never edit). Access via `context.extensionPath`. Manifests must be valid JSON.
</build>
