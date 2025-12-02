---
applyTo: "src/templates/**"
---

<purpose>
Templates for end condition scripts, custom agents, and workflow files.
Copied to `out/templates/` during build.
</purpose>

## End Condition Scripts

<contract>
- Output expected value to stdout (`"true"`, `"false"`, etc.)
- Exit code 0 = success, non-zero = error
- Supported: `.py`, `.js`, `.sh`, `.bat`, `.ps1`
</contract>

<scriptGuidelines>
- Include shebang for Unix scripts
- No network access or file modifications
- Use subprocess for commands (not `eval`)
- Default to returning `"true"`
</scriptGuidelines>

## Custom Agents

<agentFormat>
Agents use `.agent.md` format with YAML frontmatter:

```markdown
---
name: agent-name
description: Brief description for picker
---

# Agent Title

<purpose>...</purpose>
<criticalRules>...</criticalRules>
<guidelines>...</guidelines>
```

</agentFormat>

<agentGuidelines>
- Use XML tags for structure (see XML_PROMPTING_GUIDELINES.md)
- NO model names in frontmatter (user/workflow controlled)
- NO tools list in frontmatter (user/workflow controlled)
- Only `name` and `description` in frontmatter
- Required XML sections: `<purpose>`, `<guidelines>`
- Optional XML sections: `<criticalRules>`, `<examples>`, `<context>`
</agentGuidelines>

## Workflow Templates

<workflowFormat>
- `.prompt.md` - Single markdown prompt
- `.flightpath.json` - Multi-step workflow with optional validation
</workflowFormat>

<contextSyntax>
**FlightPath parses and processes:**
- `#file:path` - Attaches file content inline via `buildAttachmentXml()`
- `#file:path:startLine-endLine` - Attaches specific line range
- `#file:"path with spaces"` - Quoted paths for spaces

**FlightPath does NOT parse (passed through as literal text):**

- `@workspace` - Copilot Chat-specific
- `#codebase` - Copilot Chat-specific
- `/explain`, `/fix`, etc. - Slash commands (provider-specific)

Use plain English prompts + `#file:` for portable templates.
</contextSyntax>

<workflowGuidelines>
- Include `$schema` reference in JSON files
- Use descriptive `id` for each prompt
- Add `model` override only when needed (e.g., haiku for simple tasks)
- Include `endCondition` for validation-required steps
- Avoid provider-specific syntax (`@workspace`, `/commands`) in templates
</workflowGuidelines>

## Build

<build>
- Source: `src/templates/`
- Output: `out/templates/` (esbuild copies, never edit output)
- Access: `context.extensionPath + "/out/templates/"`
</build>
