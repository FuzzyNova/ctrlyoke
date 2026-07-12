---
applyTo: "src/templates/**"
---

<purpose>
Bundled source assets for workflow templates, built-in agents, and starter end-condition scripts.
Runtime code reads the built copies from `out/templates/`, never `src/templates/` directly.
</purpose>

<entryPoints>
- `src/core/TemplateManager.ts` owns built-in workflow IDs, `_templateMeta` parsing, placeholder extraction/replacement, and workflow creation.
- `src/core/orchestration/TemplateImporter.ts` uses `workflows/manifest.json` to populate the workflow-template import UI and copy files into a workspace.
- `src/utils/AgentDiscovery.ts` uses `agents/manifest.json` as the curated built-in-agent registry; it exposes the bundled files as immutable fallbacks, while `AgentSkillsManagerSection` exports copies for customization or native harness use.
</entryPoints>

<workflowTemplates>
- Built-in workflow files here are YAML; `TemplateManager` treats them as the source of truth for built-ins (`simple-feature`, `fix-tests`, `full-feature`, `spec-driven-loop`). `blank` is special-cased in code and has no file here.
- Workspace custom templates are discovered separately from `.ctrlyoke/templates/*.ctrlyoke.json` as `custom:<name>` IDs. Do not assume files under `src/templates/workflows/` cover all available templates.
- `_templateMeta` is authoring-only metadata for the picker UI; `createWorkflow()` strips it before writing the real workflow file.
- `spec-driven-loop` is the canonical example of `finalStep` orchestration: it relies on `agent`, `mcpServers: [ctrlyoke]`, and `priorContext: all` together.
</workflowTemplates>

<templateVariables>
- Supported placeholders are `{name}`, `{text:name}`, and `{file:name}`. Extraction is regex-based, so keep names simple (`[a-z][a-zA-Z0-9]*`).
- File variables belong in prompt text as `@{file:name}` — the `@` stays outside the braces so substitution still produces a valid attachment reference.
- `_templateMeta.variables` can enrich extracted variables with `type`, `fileFilter`, and `autoFillFilename`; only the first variable marked `autoFillFilename: true` wins.
- Retry placeholders like `{stdout}`, `{stderr}`, `{expected}`, `{actual}`, `{exitCode}`, and `{compareSource}` are reserved runtime values, not template-input variables.
</templateVariables>

<manifests>
- Keep each manifest in sync with the actual files it exposes. `TemplateImporter` trusts workflow `file` names when copying, and `AgentDiscovery` trusts agent `file` names when exposing built-ins.
- Manifest entries are the curated runtime surface. Adding an agent manifest entry makes it available as a built-in; adding/removing a built-in workflow also requires updating `TemplateManager.BUILT_IN_TEMPLATE_IDS`.
</manifests>

<agentsAndScripts>
- Built-in `.agent.md` files are read directly from the extension bundle. The Agent & Skills Manager can copy them verbatim into `.ctrlyoke/agents/` for customization or into harness directories for native subagent use; frontmatter and body style are never normalized during copying.
- `check_condition.*` files are starter examples for `endCondition.script`. Keep them portable, simple, and aligned with the runtime contract: compare output deterministically and return `"true"` on success.
</agentsAndScripts>

<build>
Edit `src/templates/**`, not `out/templates/**`.
</build>
