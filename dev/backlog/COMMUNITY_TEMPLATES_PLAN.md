# Community Templates Plan

**Status:** Proposed — not started (no `community-templates/` directory, no
`CommunityTemplate*` code).

> **2026-10-10 audit:** Not started. Refreshed stale code references
> (`TemplateManager`, `PromptFileParser`, `McpDiscoveryUtils`,
> `WebviewMessageRouter`, `DashboardConstants` line numbers; `ALL_TABS` moved to
> `components/settings/settingsTabs.ts`; `McpManagerService` now takes only a
> `workspaceRoot` accessor). Noted that `_templateMeta` has
> `additionalProperties: false` and no `tags` field, so `author`/`tags` both need
> schema additions. `FuzzyNova/ctrlyoke` is still private as of this audit.

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
`manifest.json`) are the curated six (including `template-starter`) shown in the New Workflow picker. Custom
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

## The repo is private today, but that resolves itself

`gh repo view FuzzyNova/ctrlyoke` confirms **`FuzzyNova/ctrlyoke` is
currently private**. Public unauthenticated fetch (`raw.githubusercontent.com`,
jsDelivr's GitHub mirror) — the zero-backend way to serve a
`community-templates/` directory to every installed extension — does not work
against a private repo. This only matters for Phase 2 (Discovery & Import);
Phase 1 (accepting and validating submissions) is unaffected and can ship
regardless.

Per [`RELEASE_CHECKLIST.md`](../active/RELEASE_CHECKLIST.md) Phase 14, the
repo-visibility flip has already cleared every pre-flip gate (secret scan,
Issues/PRs/tags skim, MFA hardening) and is "ready to execute whenever Nathan
chooses to trigger the actual toggle" — going public is an already-decided,
near-term step of shipping v1, not a new decision this plan needs to force.
So Phase 2's fetch-source question resolves itself once that toggle flips;
no separate public repo is needed (see the revised Phase 2 ranking below).

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

Works today, independent of the repo-visibility decision. Useful even before
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
(`src/core/TemplateManager.ts:148`, `ParsedTemplateMeta` at `:106`), so a
shared template can credit its source and be filtered in the gallery. Purely
cosmetic — not used by `createWorkflow` substitution (`:543`). Both must also be
added to `#/$defs/templateMetadata` in `schemas/workflow-schema.json` (it is
`additionalProperties: false`, so a template using them fails strict
validation and the CI gate below; the runtime loader's relaxed schema only
downgrades unknown keys to warnings), followed by `npm run schema:update`. This
is a no-bump additive schema change per `CONTRIBUTING.md`. Built-in `tags` live only in
`manifest.json` today; `_templateMeta` has no `tags` field yet.

### Generated index, not a hand-maintained manifest

Unlike `src/templates/workflows/manifest.json` (hand-edited, fine for six
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
   `schemas/workflow-schema.json` (`src/core/PromptFileParser.ts:288`) —
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

## Phase 2 — Discovery & Import (sequenced after the repo goes public)

**Recommended: wait for `RELEASE_CHECKLIST.md` Phase 14 (repo visibility
flip) rather than standing up any workaround.** That flip is already an
accepted, near-term part of shipping v1 — not a hypothetical this plan has to
route around. Phase 1 (submissions + CI validation) ships now regardless; the
Discover/Import UI in this phase simply waits for a repo that already exists
to become fetchable. Two fallbacks, only worth considering if the visibility
flip stalls significantly past this feature's own timeline:

1. **A dedicated public repo — e.g. `ctrlyoke-templates`** — split off now
   instead of waiting. Keeps zero backend and unblocks immediately, at the
   cost of a repo to later fold back in (or keep permanently separate) once
   `FuzzyNova/ctrlyoke` itself goes public.
2. **A small serverless proxy** (e.g. a Cloudflare Worker, or something
   hosted alongside `ctrlyoke.dev`) holding a GitHub token server-side,
   re-exposing `index.json` and individual template files over plain HTTP.
   Real backend surface area for what is otherwise a zero-backend feature —
   only worth it if the repo needs to stay private indefinitely, which is not
   the plan.

The client-side shape in this phase is identical no matter which path is
taken — only the base URL changes.

### Fetch source

Once a public repo exists, serve `index.json` and each template file from
jsDelivr's GitHub mirror
(`https://cdn.jsdelivr.net/gh/<owner>/<repo>@main/community-templates/...`)
rather than `api.github.com` — the same reasoning
`McpDiscoveryUtils.fetchMcpRegistry` (`src/utils/McpDiscoveryUtils.ts:911`)
gives for hitting a purpose-built endpoint directly: no auth, no per-IP rate
limit shared with every other GitHub API consumer, and it's a cached CDN.
Accept jsDelivr's ~12h cache latency for v1; a merge-triggered cache-purge
webhook is a fast-follow if that's ever a real complaint.

### Backend: `CommunityTemplateService` (parallels `McpManagerService`)

New `src/ui/CommunityTemplateService.ts`, constructed the same way
`McpManagerService` is (a `workspaceRoot` accessor; the per-request
`WebviewClientContext` is passed to each handler, not the constructor),
wired into `WebviewMessageRouter.ts` next to `this.mcpManager`
(`src/ui/WebviewMessageRouter.ts:268`, `:328`, dispatch near `:1395`).

Responsibilities:

- `handleRequestCommunityIndex` — fetch `index.json` (cache in-memory for the
  session, mirroring how `hasLoadedRemoteRegistry` gates the MCP registry's
  first fetch) → emit `COMMUNITY_TEMPLATE_INDEX_RESULT`.
- `handleInstallCommunityTemplate` — fetch the one template file named by the
  index entry's `file` field, run it through `PromptFileParser`'s schema
  validation (never trust a network payload straight onto disk), then write
  it via a new `TemplateManager.installTemplateContent(name, scope, format,
content)` that shares `prepareCustomTemplatePath`'s existing name/collision
  checks (`src/core/TemplateManager.ts:616`) rather than duplicating them →
  emit success/failure the way `McpManagerService.handleSaveRegistryServer`
  does.

### New message types (`DashboardConstants.ts`, alongside the `MCP_*` ones near `:696`)

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

### UI: `CommunityTemplatesSection.tsx`

New `src/ui/webview-react/components/settings/CommunityTemplatesSection.tsx`,
modeled directly on `McpManagerSection.tsx`'s "Discover & import" registry tab
(starts near `:1170`; registry search near `:1317`) — installing a community template is structurally the same
action as importing a registry MCP server: search box, result list, a per-row
"Install" button that disables once already present locally.

Simpler than MCP Manager — no "local scan" tab (there's no local-file
equivalent to discover) and no "installed" management panel (installed
templates are already fully managed by the existing New Workflow template
picker):

```
Community Templates (new settings tab)
├── Search box (client-side filter over the fetched index — no server-side
│   pagination needed at this scale, unlike the MCP registry)
├── Scope picker: install into Workspace | User (reuses TEMPLATE_SCOPE_OPTIONS
│   from templateScope.ts)
└── Result list
      — name, description, author, tags
      — "Install" button → INSTALL_COMMUNITY_TEMPLATE
      — "Installed" (disabled) if a custom template with the same id already
        exists in the target scope
      — "View source" link to the GitHub file (opens externally, never
        fetched into the webview)
```

### Settings drawer wiring

Add `COMMUNITY_TEMPLATES: "communitytemplates"` to `GLOBAL_SETTINGS_TABS`
(`src/types/DashboardConstants.ts:3122`), a tab entry in `ALL_TABS` right
after `MCP_MANAGER`
(`src/ui/webview-react/components/settings/settingsTabs.ts:76`–`80`),
and a render branch next to the existing `MCP_MANAGER` one in
`src/ui/webview-react/components/layout/GlobalSettingsDrawer.tsx` (`:545`).
No `fullSettings` dependency, same as
`mcpmanager`/`agentskillsmanager`/`languageservers` — add it to the
`!fullSettings` exclusion list (`:566`) and, if it should render full-width,
to `isFullWidthSettingsTab` (`:121`).

---

## Decisions

- **Repo-hosted, PR-reviewed sharing**, not Gists or a hosted DB — reuses
  schema validation as the safety gate, no new backend for Phase 1.
- **Generated `index.json`, not a hand-edited manifest** — avoids merge
  conflicts across independent community PRs; the built-ins' hand-maintained
  `manifest.json` stays as-is (low churn, single maintainer).
- **UI lives in the Settings drawer as its own tab**, not folded into the
  existing `TemplateModal.tsx` creation flow — installing a shared template is
  a one-time "add to my library" action like installing an MCP server, not a
  per-workflow choice; once installed it shows up in the normal template
  picker for free (it's just another `.ctrlyoke/templates/` file).

## Open questions

1. **Timing relative to Phase 14** — should Phase 2 work start before or
   after the repo-visibility flip actually happens? Given the flip is
   described as ready to execute on Nathan's call, the simplest path is to
   build Phase 2 whenever it's prioritized and treat "is the repo public yet"
   as a runtime fact the Discover tab checks (e.g. hide/disable it with a
   "coming at launch" note if the fetch 404s), rather than gating engineering
   work on the flip's exact date.
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
