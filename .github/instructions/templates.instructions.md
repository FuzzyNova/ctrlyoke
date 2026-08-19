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
- `src/utils/AgentDiscovery.ts` discovers each bundled `.agent.md` directly from its frontmatter; it exposes these immutable fallbacks while `AgentSkillsManagerSection` exports copies for customization or native harness use.
</entryPoints>

<workflowTemplates>
- Built-in workflow files here are YAML; `TemplateManager` treats them as the source of truth for built-ins (`template-starter`, `simple-feature`, `fix-tests`, `full-feature`, `spec-driven-loop`). `blank` is special-cased in code and has no file here.
- Workspace and user custom templates are discovered from `.ctrlyoke/templates/*.ctrlyoke.{yaml,yml,json}` as scope-qualified custom IDs. A basename is unique within a scope regardless of format. Do not assume files under `src/templates/workflows/` cover all available templates.
- `_templateMeta` is authoring-only metadata for the picker UI; `createWorkflow()` strips it before writing the real workflow file.
- `spec-driven-loop` is the canonical example of `finalStep` orchestration, and deliberately ships `steps: []` — the orchestrator stages every step itself. It relies on `agent`, `mcpServers: [ctrlyoke]`, `resumeSession: true`, and `sessionId: finalStep` together; the resumed session (not `priorContext`) is what carries the plan across loops.
- A final-step-only workflow is valid everywhere — empty `steps` plus a `finalStep` passes both schema validation and `validateWorkflowSteps`. See the `hasExecutableSteps` bullet in `core.instructions.md` before adding any new "does this workflow have work" check.
</workflowTemplates>

<templateVariables>
- Supported placeholders are `{name}`, `{text:name}`, and `{file:name}`. Extraction is regex-based, so keep names simple (`[a-z][a-zA-Z0-9]*`).
- The workflow schema treats `_templateMeta` as the authoring marker: valid `{variableName}` placeholders are accepted in enum-constrained template fields such as `harness`, while ordinary workflows without `_templateMeta` remain restricted to concrete runtime values.
- File variables belong in prompt text as `@{file:name}` — the `@` stays outside the braces so substitution still produces a valid attachment reference.
- `_templateMeta.variables` can enrich extracted variables with `type`, `fileFilter`, and `autoFillFilename`; only the first variable marked `autoFillFilename: true` wins.
- Condition output references use `$preCondition:<field>` and `$endCondition:<field>` with fields `stdout`, `stderr`, `expected`, `actual`, `exitCode`, and `compareSource`; they are runtime values, not template-input variables. `$preCondition:*` works in step and retry prompts, while `$endCondition:*` is only available in retry prompts.
</templateVariables>

<manifests>
- Keep `workflows/manifest.json` in sync with the actual workflow files it exposes; `TemplateImporter` trusts its `file` names when copying.
- The workflow manifest is the curated import surface. Adding/removing a built-in workflow also requires updating `TemplateManager.BUILT_IN_TEMPLATE_IDS`.
</manifests>

<agentsAndScripts>
- Built-in `.agent.md` files are the single source of their own identity and description: `AgentDiscovery` scans the bundled directory and reads `name`/`description` from frontmatter. The Agent & Skills Manager can copy them verbatim into `.ctrlyoke/agents/` for customization or into harness directories for native subagent use; frontmatter and body style are never normalized during copying.
- `check_condition.*` files are starter examples for `endCondition.script`. Keep them portable, simple, and aligned with the runtime contract: compare output deterministically and return `"true"` on success.
</agentsAndScripts>

<build>
Edit `src/templates/**`, not `out/templates/**`.
</build>
