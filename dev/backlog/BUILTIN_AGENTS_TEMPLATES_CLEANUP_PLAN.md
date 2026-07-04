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

- Rewrite `ctrlyoke-orchestrator.agent.md` to:
  - Use current, valid model labels (single-source from `ModelConstants.ts`; avoid
    hardcoding a specific version that will rot — prefer describing tiers, e.g.
    "a strong model for planning, a cheaper/faster model for docs/commit").
  - Teach **YAML** (`.ctrlyoke.yaml`) as the primary format (JSON as an aside at most),
    matching the shipped templates and schema.
  - Trim redundant examples; keep it tight.
- Audit `spec-orchestrator.agent.md` for the same issues (it looks clean, but confirm).
- Ensure **no agent mentions Gemini** once `gemini-cli` is removed (see the Antigravity plan).

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

- [ ] `ctrlyoke-orchestrator.agent.md` uses valid model labels + YAML-first guidance; trimmed.
- [ ] `spec-orchestrator.agent.md` audited/confirmed current.
- [ ] No built-in agent references Gemini after harness removal.
- [ ] `simple-feature`, `full-feature`, `fix-tests` declare typed `_templateMeta.variables` with defaults.
- [ ] Template-instantiation UI shows typed inputs for all built-in templates.
- [ ] `_templateMeta.variables` shape documented for template authors.
