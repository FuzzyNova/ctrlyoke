# Built-in Agents & Templates Cleanup

**Created:** July 4, 2026
**Status:** PLANNING
**Priority:** **v0.1.0 BLOCKER** — both parts (confirmed by Nathan, July 4, 2026)
**Effort:** 2–4 days
**Related:** [`BUILTIN_TECH_SUPPORT_AGENT_PLAN.md`](BUILTIN_TECH_SUPPORT_AGENT_PLAN.md), [`ANTIGRAVITY_CLI_HARNESS_PLAN.md`](ANTIGRAVITY_CLI_HARNESS_PLAN.md)

---

## Background

The built-in agents and workflow templates in `src/templates/` are the first real
ctrlyoke content most new users touch (New Workflow from Template, agent picker).
They are currently uneven — some are stale/incorrect, and only one uses the good
variable pattern.

### Problems found (July 4, 2026 review)

1. **`ctrlyoke-orchestrator.agent.md` is stale and partly wrong** — ships to every user:
   - References dead model IDs: `claude-sonnet-4.5`, `claude-haiku-4.5`, `gpt-5`
     (frontmatter `model: Claude Sonnet 4.5`). These are not current ctrlyoke harness
     model labels and mislead the model the agent tells users to pick.
   - Teaches the **JSON** workflow format (`.ctrlyoke.json`) with large JSON examples,
     while the product is now **YAML-first** (`.ctrlyoke.yaml`) — format inconsistency
     with everything else we ship.
   - Very long and example-heavy; hard to maintain.

2. **Templates don't use typed variables consistently.** Only
   `spec-driven-loop.ctrlyoke.yaml` declares `_templateMeta.variables` (a typed `file`
   variable with `fileFilter` + `autoFillFilename`). The other three use bare, untyped
   `{placeholder}` tokens with no declaration:
   - `simple-feature` → `{featureDescription}` (no variable metadata)
   - `full-feature` → `{featureDescription}`, `{planDocument}` (no metadata, no default)
   - `fix-tests` → `{testCommand}` (no metadata, no default like `npm test`)

   Without declarations these placeholders get no typed input UI, no defaults, no
   file-picker, and no validation — a worse authoring experience than the spec loop.

## Goals

### A. Fix / modernize the built-in agents (correctness)

> **Reframe (decided July 2026):** "orchestrator" was overloaded. There are two distinct
> roles: a **design-time author** that composes a workflow *file* from a request, and a
> **run-time controller** that lives inside a running workflow's `finalStep` and extends
> the queue via the `ctrlyoke_append_queue` MCP tool. The old `ctrlyoke-orchestrator` was
> the former (written before `mcp-server.ts` existed) but misnamed. It was **renamed to
> `ctrlyoke-workflow-composer`** and rewritten; `spec-orchestrator` is the run-time role
> and stays as-is. Convention adopted: `ctrlyoke-*` = meta agents about operating ctrlyoke
> (composer, tech-support); unprefixed = agents that do the user's dev work
> (`spec-orchestrator`, `test-repair`).

- [x] Rename `ctrlyoke-orchestrator.agent.md` → **`ctrlyoke-workflow-composer.agent.md`** and rewrite to:
  - Drop hardcoded model IDs entirely (they rot and are harness-relative) — the agent now
    tells the model to omit per-step `model` or describe a tier (capable for
    plan/implement/review, cheaper/faster for docs/commit).
  - Teach **YAML** (`.ctrlyoke.yaml`) with the real `steps:`/`@path`/`endCondition`/`{stdout}`
    format; JSON examples removed.
  - Trimmed ~60%; added a note pointing at the spec-driven-loop pattern for open-ended work.
  - Updated all references: `manifest.json`, `schemas/workflow-schema.json` (+ regenerated
    `.yaml`), `docs/workflows/agents-and-skills.md`, `CopilotChatIntegration.ts` comment.
    Deleted the stale `.github/agents/` dogfood copy.
- [x] Audited `spec-orchestrator.agent.md` — clean, current, no dead models; left as-is.
- [x] No built-in agent mentions Gemini (confirmed post-`gemini-cli` removal).

### A.2 New agent — `test-repair` (added July 2026)

Green-lit alongside Part A: a dedicated fix-it agent for the existing `fix-tests` template
(which previously had no agent). It reads the failed end-condition `{stdout}`, finds the
root cause, and makes the smallest correct fix — with hard rules against masking failures
(no skip/delete/`.only`, no weakened assertions). Wired into `fix-tests.ctrlyoke.yaml`
(`agent: test-repair`) and registered in `manifest.json`.

- [x] `test-repair.agent.md` created and wired into the `fix-tests` template.

### B. Bring all templates up to the `spec-driven-loop` variable pattern (UX)

- Add `_templateMeta.variables` to `simple-feature`, `full-feature`, `fix-tests`:
  - `featureDescription` → `string`/multiline with a helpful description.
  - `planDocument` → `string` with a sensible default (e.g. `docs/plan.md`).
  - `testCommand` → `string` with a default (e.g. `npm test`).
  - Use `file` type + `fileFilter` where a file input makes sense.
- Verify the template-instantiation UI renders the typed inputs (this is the payoff).
- Confirm the variable schema (`_templateMeta.variables`) is documented so template
  authors and the docs stay consistent.

## Should this block release?

**Decision: both parts block v0.1.0** (Nathan, July 4, 2026):

- **Part A (agent correctness) — BLOCKER.** Shipping a built-in agent that recommends
  non-existent models (`gpt-5`, `claude-sonnet-4.5`) and teaches a non-primary format
  is exactly the "broken/misleading in v0.1.0" class (same reasoning as the broken
  Gemini harness). It ships to every user and undermines trust.
- **Part B (template variables) — BLOCKER.** Originally scoped as recommended polish,
  but Nathan is treating the full new-user experience as a launch gate; the built-in
  templates are the first content users touch, so they ship with typed variables.

Tracked in `RELEASE_PLAN.md` §2.9.

## Acceptance

**Part A (agents) — DONE:**

- [x] `ctrlyoke-orchestrator` renamed → `ctrlyoke-workflow-composer`; YAML-first, no hardcoded model IDs, trimmed.
- [x] `spec-orchestrator.agent.md` audited/confirmed current.
- [x] No built-in agent references Gemini after harness removal.
- [x] `test-repair` agent added and wired into the `fix-tests` template.

**Part B (template variables) — DONE:**

> The existing variable model only supported `type`/`fileFilter`/`autoFillFilename`, so
> Part B first **extended the model** with `default`, `description`, and `multiline`
> (`TemplateManager.TemplateVariable` + `parseTemplateMeta` + `mergeVariablesWithMeta`,
> mirrored in the webview `uiStore` type and rendered by `TemplateModal.tsx`). Defaults are
> applied server-side in `createWorkflow` so a blank field substitutes its default instead
> of leaving a literal `{token}`.

- [x] `simple-feature` (`featureDescription`, multiline), `full-feature` (`featureDescription` multiline, `planDocument` default `docs/plan.md`), and `fix-tests` (`testCommand` default `npm test`) declare typed `_templateMeta.variables` with descriptions/defaults.
- [x] `TemplateModal.tsx` seeds declared defaults, renders variable descriptions, and renders multiline vars as a textarea.
- [x] `_templateMeta.variables` shape documented: new `docs/workflows/templates.md` page (wired into the sidebar), the `TemplateManager` doc-comment, and the enhanced "New Template" starter that demonstrates every field.
- [x] Unit test `src/test/unit/TemplateManager.test.ts` covers parsing + merge of the new fields (runs in the VS Code test host).
