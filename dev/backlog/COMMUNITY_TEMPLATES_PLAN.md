# Community Templates Plan

**Status:** Proposed — not started (no `community-templates/` directory, no
`CommunityTemplate*` code).

> **2026-10-10 audit:** Not started. Refreshed stale code references
> (`TemplateManager`, `PromptFileParser`, `McpDiscoveryUtils`,
> `WebviewMessageRouter`, `DashboardConstants` line numbers; `ALL_TABS` moved to
> `components/settings/settingsTabs.ts`; `McpManagerService` now takes only a
> `workspaceRoot` accessor). Noted that `_templateMeta` has
> `additionalProperties: false` and no `tags` field, so `author`/`tags` both need
> schema additions.
>
> **2026-10-26 review:** still not started. `FuzzyNova/ctrlyoke` went public on 2026-10-20
> (`RELEASE_CHECKLIST.md` Phase 14), so Phase 2's fetch-source blocker is gone and the
> private-repo fallbacks are dropped below. Refreshed line references.
>
> Last reviewed against code: 2026-10-26

## Goal

Let users share custom workflow templates (like the user's own
`.ctrlyoke/templates/yoke-driven-loop.ctrlyoke.yaml` — an interactive twist on
`spec-driven-loop`) with other ctrlyoke users, and let users discover and install
templates other people have shared. Modeled directly on how the MCP Manager
(`McpManagerSection.tsx`) already solves the same shape of problem for MCP
servers: an installed registry plus a "Discover & Import" panel with local-scan
and remote-browse tabs.

## Why

Built-in templates (`src/templates/workflows/*.ctrlyoke.yaml` +
`manifest.json`) are the curated nine (including `template-starter`) shown in the New Workflow picker. Custom
templates already have a home — `.ctrlyoke/templates/` (workspace) and
`~/.ctrlyoke/templates/` (user), both scanned by
`TemplateManager.discoverCustomTemplates()` — but there is no way to get a
template from one person's machine onto another's. Real users are already
writing project-specific variants worth sharing as inspiration (a different
harness/model split per step, interactive plan/review steps), not necessarily
as one-size-fits-all built-ins.

## Decision: PR-reviewed repo directory, not Gists or a hosted DB

A `community-templates/` directory in this repo. Sharing = a PR adding one
`.ctrlyoke.yaml` file. This reuses the existing workflow schema
(`schemas/workflow-schema.json`) as an automatic, CI-enforced correctness gate,
needs no new backend, and gets free moderation via normal PR review — the same
trust model as adding a built-in template, just without requiring
`BUILT_IN_TEMPLATE_IDS`/`manifest.json` edits gatekept to the maintainer.

## The repo is public

`FuzzyNova/ctrlyoke` was flipped to public on 2026-10-20
([`RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md) Phase 14), so public
unauthenticated fetch (`raw.githubusercontent.com`, jsDelivr's GitHub mirror) of a
`community-templates/` directory works with no backend. Phases 1 and 2 can both ship
whenever they are prioritized; no separate public repo or proxy is needed.

## Non-goals

- A separate hosted database, submission form, or `ctrlyoke.dev` backend for
  templates — rejected in the brainstorm that preceded this plan: PR review
  reuses schema validation and needs no auth system.
- Ratings, comments, download counts — no infra for it, no evidence it's
  needed yet.
- Publishing directly from the extension (a "Share this template" button that
  opens a PR via the GitHub API) — v1 is manual PR submission; automating PR
  creation is a fast-follow if manual submission volume justifies it.

---

## Phase 1 — `community-templates/` directory + CI validation

Useful even before
any in-extension discovery UI exists: contributors can already open PRs and
maintainers get automatic validation instead of manually eyeballing YAML.

### Layout

```
community-templates/
  <author-handle>-<template-slug>.ctrlyoke.yaml   # one file per template
  README.md                                        # submission guidelines
```

Filename convention `<author>-<slug>` avoids id collisions across independent
contributors without a central registration step (built-ins don't need this —
one maintainer, no collisions).

### `_templateMeta` gets two more fields: `author` and `tags`

Add optional `author?: string` and `tags?: string[]` to `_templateMeta`, parsed
alongside `name`/`description` in `TemplateManager.parseTemplateMeta`
(`src/core/TemplateManager.ts:211`, `ParsedTemplateMeta` at `:128`), so a
shared template can credit its source and be filtered in the gallery. Purely
cosmetic — not used by `createWorkflow` substitution (`:630`). Both must also be
added to `#/$defs/templateMetadata` in `schemas/workflow-schema.json` (it is
`additionalProperties: false`, so a template using them fails strict
validation and the CI gate below; the runtime loader's relaxed schema only
downgrades unknown keys to warnings), followed by `npm run schema:update`. This
is a no-bump additive schema change per `CONTRIBUTING.md`. Built-in `tags` live only in
`manifest.json` today; `_templateMeta` has no `tags` field yet.

### Generated index, not a hand-maintained manifest

Unlike `src/templates/workflows/manifest.json` (hand-edited, fine for nine
maintainer-controlled files), a community directory with many independent PRs
would fight over one shared JSON file. Instead: a new
`scripts/generate-community-templates-index.mjs` (same pattern as
`scripts/generate-step-palette.mjs`) scans
`community-templates/*.ctrlyoke.{yaml,yml,json}`, parses each file's
`_templateMeta`, and emits `community-templates/index.json` — an array of
`{ id, name, description, author, tags, file }`. Same shape as
`manifest.json` so Phase 2's client code can share a type.

### CI validation gate

New `.github/workflows/community-templates.yml`, triggered on `pull_request`
with `paths: [community-templates/**]`:

1. `npm ci`.
2. Run a new `scripts/validate-community-templates.mjs` that, for each changed
   `.ctrlyoke.*` file, parses it and runs it through the same Ajv validation
   `PromptFileParser.validateAndNormalize` uses against
   `schemas/workflow-schema.json` (`src/core/PromptFileParser.ts:311`) —
   rejects unknown top-level fields, bad `harness` enum values, malformed
   `_templateMeta`, etc. Also reject: missing `_templateMeta.name` or
   `description`, a filename that doesn't match
   `<author>-<slug>.ctrlyoke.yaml`, and an id (derived from filename) already
   claimed by a different file in `index.json`.
3. Regenerate `community-templates/index.json` and fail if the committed copy
   is stale (`git diff --exit-code` after running the generator) — keeps the
   index honest without trusting contributors to run the script themselves.
4. Optional light tripwire: flag (warn, don't hard-fail) obviously-dangerous
   `endCondition.script`/step content (e.g. `rm -rf`, obvious exfil patterns)
   as a PR comment — the real gate is still human review; this just calls
   attention to it.

Add a `CODEOWNERS` line for `community-templates/` so external PRs still
require maintainer approval to merge — the same trust boundary as any other PR
today.

---

## Phase 2 — Discovery & Import

The repo is public, so this phase has no external blocker. It depends only on
Phase 1 producing `community-templates/index.json`.

### Fetch source

Serve `index.json` and each template file from jsDelivr's GitHub mirror
(`https://cdn.jsdelivr.net/gh/FuzzyNova/ctrlyoke@main/community-templates/...`)
rather than `api.github.com` — the same reasoning
`McpDiscoveryUtils.fetchMcpRegistry` (`src/utils/McpDiscoveryUtils.ts:1119`)
gives for hitting a purpose-built endpoint directly: no auth, no per-IP rate
limit shared with every other GitHub API consumer, and it's a cached CDN.
Accept jsDelivr's ~12h cache latency for v1; a merge-triggered cache-purge
webhook is a fast-follow if that's ever a real complaint.

### Backend: `CommunityTemplateService` (parallels `McpManagerService`)

New `src/ui/CommunityTemplateService.ts`, constructed the same way
`McpManagerService` is (a `workspaceRoot` accessor; the per-request
`WebviewClientContext` is passed to each handler, not the constructor),
wired into `WebviewMessageRouter.ts` next to `this.mcpManager`
(`src/ui/WebviewMessageRouter.ts:386`, `:451`, dispatch near `:1686`).

Responsibilities:

- `handleRequestCommunityIndex` — fetch `index.json` (cache in-memory for the
  session, mirroring how `hasLoadedRemoteRegistry` in `McpManagerSection.tsx` gates
  the MCP registry's first fetch) → emit `COMMUNITY_TEMPLATE_INDEX_RESULT`.
- `handleInstallCommunityTemplate` — fetch the one template file named by the
  index entry's `file` field, run it through `PromptFileParser`'s schema
  validation (never trust a network payload straight onto disk), then write
  it via a new `TemplateManager.installTemplateContent(name, scope, format,
content)` that shares `prepareCustomTemplatePath`'s existing name/collision
  checks (`src/core/TemplateManager.ts:717`) rather than duplicating them →
  emit success/failure the way `McpManagerService.handleSaveRegistryServer`
  does.

### New message types (`DashboardConstants.ts`, alongside the MCP registry ones near `:887`)

```
REQUEST_COMMUNITY_TEMPLATE_INDEX
COMMUNITY_TEMPLATE_INDEX_RESULT
INSTALL_COMMUNITY_TEMPLATE
COMMUNITY_TEMPLATE_INSTALL_RESULT
```

Payload types in `WebviewMessageTypes.ts`: `CommunityTemplateEntry` (`id,
name, description, author, tags, file`), `InstallCommunityTemplateMessage`
(`{ id: string; scope: TemplateScope }`),
`CommunityTemplateInstallResultMessage` (`{ id: string; success: boolean;
error?: string; localTemplateId?: string }`).

### Webview store: `useCommunityTemplatesStore`

Mirrors `useMcpManagerStore.ts`: `index: CommunityTemplateEntry[] |
undefined`, `isLoading`, `error`, `query`, `installingIds: Set<string>`
(per-row spinner, since install is per-item and can be slow, unlike the MCP
tab's single loading flag). Actions: `requestIndex()`, `installTemplate(id,
scope)`.

### UI: a **Discover** page in the Templates settings tab

> **Revised 2026-10-11:** this UI is no longer its own settings tab. It is the
> **Discover** page of the **Templates** tab designed in
> [`TEMPLATE_VARIABLE_DEFAULTS_PLAN.md`](../implemented/TEMPLATE_VARIABLE_DEFAULTS_PLAN.md)
> (Phase 2, and "Follow-up — community templates in the Templates tab"). That
> tab is where users already manage templates: the default template and saved
> variable values. Installing a template belongs next to them, and an installed
> template is immediately available in that tab's **Defaults** page. The page
> structure and scope rules are recorded there. The component below is the
> page's body. The Templates tab has shipped (`TemplatesSection.tsx`, which today renders
> only `TemplateDefaultsPage`); the page bar is still to be added with this phase.

New `src/ui/webview-react/components/settings/CommunityTemplatesPage.tsx`,
modeled directly on `McpManagerSection.tsx`'s "Discover & import" registry tab
(starts near `:1175`) — installing a community template is structurally the same
action as importing a registry MCP server: search box, result list, a per-row
"Install" button that disables once already present locally.

Simpler than MCP Manager — no "local scan" tab (there's no local-file
equivalent to discover) and no "installed" management panel (installed
templates are already fully managed by the existing New Workflow template
picker):

```
Templates tab → Discover page
├── Search box (client-side filter over the fetched index — no server-side
│   pagination needed at this scale, unlike the MCP registry)
├── (no scope picker: installs go to the drawer's User/Workspace toggle —
│   User → ~/.ctrlyoke/templates, Workspace → .ctrlyoke/templates)
└── Result list
      — name, description, author, tags
      — "Install" button → INSTALL_COMMUNITY_TEMPLATE
      — "Installed" (disabled) if a custom template with the same id already
        exists in the target scope
      — "View source" link to the GitHub file (opens externally, never
        fetched into the webview)
      — after install: "Set defaults" link → Defaults page, with the new
        template's card added
```

### Settings drawer wiring

No new `GLOBAL_SETTINGS_TABS` entry. `TemplatesSection` gains the page bar
described in the template-defaults plan's follow-up section and renders
`CommunityTemplatesPage` on its **Discover** page. The page itself needs no
`fullSettings`, but the Templates tab as a whole does (Defaults reads per-scope
values from it), so the tab keeps its normal `fullSettings` gating in
`GlobalSettingsDrawer.tsx`. `InstallCommunityTemplateMessage.scope` is filled
from the drawer's active scope.

---

## Decisions

- **Repo-hosted, PR-reviewed sharing**, not Gists or a hosted DB — reuses
  schema validation as the safety gate, no new backend for Phase 1.
- **Generated `index.json`, not a hand-edited manifest** — avoids merge
  conflicts across independent community PRs; the built-ins' hand-maintained
  `manifest.json` stays as-is (low churn, single maintainer).
- **UI lives in the Settings drawer**, not folded into the existing
  `TemplateModal.tsx` creation flow — installing a shared template is a
  one-time "add to my library" action like installing an MCP server, not a
  per-workflow choice; once installed it shows up in the normal template
  picker for free (it's just another `.ctrlyoke/templates/` file). It is the
  **Discover** page of the Templates tab
  ([`TEMPLATE_VARIABLE_DEFAULTS_PLAN.md`](../implemented/TEMPLATE_VARIABLE_DEFAULTS_PLAN.md)),
  not a tab of its own, and installs into the drawer's active scope.

## Open questions

1. **Empty index / offline** — the Discover page should show a friendly empty or
   offline state if `index.json` 404s or the fetch fails.
2. **Update handling** — if a maintainer edits a merged community template
   (typo fix, schema-compat fix), an already-installed local copy silently
   drifts out of sync. v1 answer: accept it, same as installing an MCP server
   today (no "check for updates" surface exists for that either). Revisit
   only if this becomes a real complaint.
3. **Removal/reporting** — what happens to a malicious or broken template
   already installed by users if it's later pulled from the index? Out of
   scope for v1 (PR review is the gate before it ever reaches the index); a
   "report" link could point at a GitHub issue template as a cheap first
   step.
4. **`author` field trust** — free-text from the PR author, not verified
   identity. Fine for a small community; revisit if impersonation becomes a
   real problem.

## Verification

`npm run typecheck`, `npm run lint`, `npm test` for Phase 2's new
store/component/service. Phase 1's CI workflow is its own verification (a
deliberately-broken test PR against `community-templates/` should fail the
new workflow). Manual check for Phase 2: install a template from the index
into both Workspace and User scope, confirm it appears in the New Workflow
template picker (`TemplateManager.discoverCustomTemplates`) immediately
without a reload.
