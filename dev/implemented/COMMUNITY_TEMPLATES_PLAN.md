# Community Templates Plan

**Status:** Implemented (2026-11-22). Both phases are done, and the library is live.

> **2026-11-22 completion check:** `FuzzyNova/ctrlyoke-templates` is public (MIT-0) with the
> scaffold pushed and the Review Branch seed listed in `index.json`. ctrlyoke's own
> `CommunityTemplateClient` downloads the live index and template through jsDelivr. Guardrails
> (checked with `gh`): an active `main` ruleset requires one approving review with code-owner
> review (`* @nhickster`), stale-review dismissal and last-push approval, squash merges only,
> the `validate` status check (strict), and blocks deletion and force-pushes; repository admins
> may bypass, as on `FuzzyNova/ctrlyoke`. Actions run read-only and need approval for every
> outside contributor; secret scanning with push protection and Dependabot security updates are
> on. `validate.yml` runs on pull requests, pushes to `main`, weekly and on demand. Its last two
> runs passed. Each community row also gained the **Report** link (open question 3), which opens
> the library's report form with the template's id in the title.
>
> **One follow-up after the 0.9.0 release:** the library validates against the latest ctrlyoke
> release, and 0.8.0 lacks `_templateMeta.author`/`tags`. Once 0.9.0 is tagged, the seed (and
> new submissions) may add them. Nothing needs to change in this repository for that.

> **2026-11-22 layout change:** the Templates tab no longer has a **Defaults**/**Discover** page
> bar. It now uses the MCP Manager's two-column layout: **Defaults** beside **Community
> templates** at `lg` and wider, stacked below that, inside the drawer's standard full-width
> scroll container. A page bar hid the library behind a second click, and the only reason for it
> was consistency with Workflow Defaults' page bar. Because the column is now visible as soon as
> the tab opens, the index is fetched only when the user chooses **Browse community templates**
> (or **Refresh**), never on mount: like the MCP registry and skills.sh, no third party is
> contacted until the user asks to browse (`docs/guide/privacy.md`). `TEMPLATES_PAGES`/
> `TEMPLATES_TABS` were removed. Mentions of the Discover page and
> page bar below are historical.
>
> **2026-11-21 implementation:** In this repo: `_templateMeta.author`/`tags` (schema, no bump;
> parsed into `TemplateInfo`), `TemplateManager.installTemplateContent`,
> `src/utils/CommunityTemplateClient.ts` (jsDelivr fetch, `index.json` parsing and
> sanitizing, `CTRLYOKE_COMMUNITY_TEMPLATES_URL` override for a fork or a local static
> server), `src/ui/CommunityTemplateService.ts` (off-queue router handlers), the four message
> types, `communityTemplatesStore.ts`, and the Templates tab's **Defaults**/**Discover** page
> bar with `CommunityTemplatesPage.tsx`. Docs: `docs/workflows/templates.md#community-templates`
> and a `cdn.jsdelivr.net` row in `docs/guide/privacy.md`.
>
> The `FuzzyNova/ctrlyoke-templates` content (layout below, the Review Branch seed, generator,
> strict validator, CI workflow) was scaffolded in a sibling folder, `C:\dev\ctrlyoke-templates`.
> Counsel cleared the MIT-0 grant on 2026-11-21 (`RELEASE_CHECKLIST.md` §15.1), which covers
> publishing the library. **Remaining, all Nathan's:** (1) create the repository, push the
> scaffold, and turn on branch protection (required code-owner review and the `validate`
> check); (2) ship a ctrlyoke release containing the `author`/`tags` schema change before the
> library accepts templates that use them; the seed template omits them for that reason. Until
> the repository exists, **Discover** shows its offline state (the index 404s). _(Both done or
> superseded; see the completion check above.)_
>
> Deviations from the plan below: the CI tripwire reports GitHub annotations instead of a PR
> comment (no token with write access needed); templates must use `.ctrlyoke.yaml` (the client
> also accepts `.yml`/`.json` should the rule ever relax); an index entry's `author` comes only
> from `_templateMeta.author`, because a handle can itself contain hyphens.

> **2026-11-20 decision:** community templates live in a **separate public repository,
> `FuzzyNova/ctrlyoke-templates`, licensed MIT-0 (MIT No Attribution)**, not in a
> `community-templates/` directory of this repo. See "Decision: a separate MIT-0 repository"
> below. (MIT-0 was chosen over CC0 on 2026-11-21: templates contain scripts, and some
> corporate legal policies reject CC0 for code because it withholds patent rights.) The legal
> reasoning, and the license changes that go with it, are in
> [`LICENSE_2.3_LAWYER_REVIEW.md`](../implemented/LICENSE_2.3_LAWYER_REVIEW.md).

> **2026-10-10 audit:** Not started. Refreshed stale code references
> (`TemplateManager`, `PromptFileParser`, `McpDiscoveryUtils`,
> `DashboardMessageRouter`, `DashboardConstants` line numbers; `ALL_TABS` moved to
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

## Decision: PR-reviewed GitHub repo, not Gists or a hosted DB

Sharing a template means opening a PR that adds one `.ctrlyoke.yaml` file. This reuses the
workflow schema (`schemas/workflow-schema.json`) as an automatic, CI-enforced correctness
gate. It needs no new backend, and normal PR review moderates it for free. The trust model is
the same as for a built-in template, but without the maintainer-only
`BUILT_IN_TEMPLATE_IDS`/`manifest.json` edits.

## Decision: a separate MIT-0 repository (`FuzzyNova/ctrlyoke-templates`)

Templates go in their own public repository, not in a directory of `FuzzyNova/ctrlyoke`.
The reason is licensing, not engineering:

- Everything in `FuzzyNova/ctrlyoke` is under the commercial `LICENSE.md`. A template in a
  subdirectory of it would need a path-scoped carve-out in the license, a path-scoped
  exemption from the contributor agreement, and contributors opening PRs against a
  commercially licensed repository.
- In a separate repository whose only license is MIT-0, all of that disappears. GitHub's
  Terms of Service (D.6, "inbound = outbound") license each contribution under the
  repository's license. Contributors never touch the commercial license. Users can copy a
  template into any tool, gist or repository without attribution. That is the point of a
  community library.

The engineering cost is small. The templates repo's CI needs the workflow schema from this
repo (see "CI validation gate"), and the generator/validator scripts live there instead of
in `scripts/`. Under license v2.3 (adopted 2026-11-21), `schemas/` is itself MIT-0, so the
templates repo may fetch, cache or vendor the schema freely.

The repository is created and administered by Nathan on GitHub; an agent never creates it.
Both repositories are public, so unauthenticated fetches (`raw.githubusercontent.com`, or
jsDelivr's GitHub mirror) work with no backend.

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

## Phase 1 — `ctrlyoke-templates` repository + CI validation

This is useful even before any discovery UI exists in the extension: contributors can
already open PRs, and maintainers get automatic validation instead of reading YAML by eye.

Phase 1 has two parts. The `_templateMeta` schema change is made in **this** repo and
shipped in a ctrlyoke release. Everything else is done in **`FuzzyNova/ctrlyoke-templates`**.

### Layout (`FuzzyNova/ctrlyoke-templates`)

```
LICENSE                                   # MIT-0, verbatim; the only license in the repo
README.md                                 # what the library is, how to install from ctrlyoke, safety note
CONTRIBUTING.md                           # submission guidelines; states submissions are MIT-0
templates/
  <author-handle>-<template-slug>.ctrlyoke.yaml   # one file per template
index.json                                # generated, never hand-edited
scripts/
  generate-index.mjs
  validate-templates.mjs
.github/
  CODEOWNERS                              # * @nhickster
  PULL_REQUEST_TEMPLATE.md                # checkbox: "I wrote this, or have the right to submit it, and license it under MIT-0"
  ISSUE_TEMPLATE/report-template.yml      # report a broken or malicious template
  workflows/validate.yml
```

**Licensing rules for the repo:**

- `LICENSE` is the MIT-0 text, unmodified apart from its copyright line:
  `Copyright (c) 2026 Fuzzy Nova LLC and ctrlyoke-templates contributors`. Each contributor
  keeps the copyright in their own template and licenses it under MIT-0. The README and
  `CONTRIBUTING.md` say so.
- Every template is MIT-0. Don't accept per-file license overrides: one license for the
  whole library keeps "copy it anywhere" true and the index simple.
- Nothing from `FuzzyNova/ctrlyoke` is copied into this repo except the schema fetched at CI
  time, and that is never committed. Before seeding the library, check that the seed
  templates contain no commercially licensed code.
- Turn on branch protection with required code-owner review and the `validate` check,
  matching the `main` ruleset in this repo (`scripts/apply-github-guardrails.mjs`).

Filename convention `<author>-<slug>` avoids id collisions across independent
contributors without a central registration step (built-ins don't need this —
one maintainer, no collisions).

### `_templateMeta` gets two more fields: `author` and `tags` (this repo)

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

**Ordering:** this schema change must ship in a ctrlyoke release before the templates repo
accepts templates that use `author`/`tags`, because that repo validates against the latest
released schema (below).

### Generated index, not a hand-maintained manifest (templates repo)

`src/templates/workflows/manifest.json` is hand-edited, which is fine for nine files one
maintainer controls. A community library with many independent PRs would fight over one
shared JSON file. Instead, `scripts/generate-index.mjs` in the templates repo scans
`templates/*.ctrlyoke.{yaml,yml,json}`, parses each file's `_templateMeta`, and emits
`index.json` at the repo root. The index is an array of
`{ id, name, description, author, tags, file }`, the same shape as `manifest.json`, so
Phase 2's client code can share a type. The templates repo cannot import ctrlyoke's
TypeScript, so the index format is versioned. The root object is
`{ schemaVersion: 1, templates: [...] }`, and `CommunityTemplateService` refuses an
unknown major version instead of guessing.

### CI validation gate (templates repo)

`.github/workflows/validate.yml`, triggered on `pull_request` and on `push` to `main`:

1. Fetch the workflow schema **from ctrlyoke's latest release tag**:
   `https://raw.githubusercontent.com/FuzzyNova/ctrlyoke/<latest v* tag>/schemas/workflow-schema.json`,
   resolving the tag through the GitHub API (`releases/latest`). Don't use
   `ctrlyoke.dev/schema/v1/workflow.json`: it follows this repo's `main`, which can be
   ahead of the published release. A template that uses a field users can't run yet must
   fail. Tag schema files referenced by `$ref` are fetched the same way.
2. `scripts/validate-templates.mjs` parses each changed `.ctrlyoke.*` file and validates it
   with Ajv against that schema. Keep its options in step with
   `PromptFileParser.validateAndNormalize` (`src/core/PromptFileParser.ts:311`). It rejects
   unknown top-level fields, bad `harness` enum values, malformed `_templateMeta`, and so
   on. It also rejects: a missing `_templateMeta.name` or `description`; a filename that
   doesn't match `<author>-<slug>.ctrlyoke.yaml`; and an id (derived from the filename)
   already claimed by a different file in `index.json`.
3. Regenerate `index.json` and fail if the committed copy is stale (`git diff --exit-code`
   after running the generator). That keeps the index honest without trusting contributors
   to run the script themselves.
4. Optionally, a light tripwire: flag obviously dangerous `endCondition.script`/step content
   (such as `rm -rf` or obvious exfiltration patterns) as a PR comment, warning rather than
   failing. Human review is still the real gate; this just draws attention to it.
5. A scheduled weekly run of the same validation against the newest release tag. It catches
   templates that a ctrlyoke schema bump made invalid, and the fix is a migration PR in the
   templates repo.

`CODEOWNERS` (`* @nhickster`) and branch protection make every external PR need maintainer
approval, the same trust boundary as this repo.

### Changes in this repo besides the schema

- Add a `DOCS_URLS`/constant entry for the templates repo URLs (index, per-file raw URL,
  GitHub "view source" URL, report-issue URL). Phase 2 is the only consumer; keep the URLs
  single-sourced in `DashboardConstants.ts`.
- Add a docs page (or a section of the templates guide) on sharing a template: open a PR
  against `FuzzyNova/ctrlyoke-templates`; submissions are MIT-0.

---

## Phase 2 — Discovery & Import

This phase depends only on Phase 1 having produced `index.json` in
`FuzzyNova/ctrlyoke-templates`.

### Fetch source

Serve `index.json` and each template file from jsDelivr's GitHub mirror
(`https://cdn.jsdelivr.net/gh/FuzzyNova/ctrlyoke-templates@main/index.json` and
`.../templates/<file>`)
rather than `api.github.com` — the same reasoning
`McpDiscoveryUtils.fetchMcpRegistry` (`src/utils/McpDiscoveryUtils.ts:1119`)
gives for hitting a purpose-built endpoint directly: no auth, no per-IP rate
limit shared with every other GitHub API consumer, and it's a cached CDN.
Accept jsDelivr's ~12h cache latency for v1; a merge-triggered cache-purge
webhook is a fast-follow if that's ever a real complaint.

### Backend: `CommunityTemplateService` (parallels `McpManagerService`)

New `src/ui/CommunityTemplateService.ts`, constructed the same way
`McpManagerService` is (a `workspaceRoot` accessor; the per-request
`DashboardClientContext` is passed to each handler, not the constructor),
wired into `DashboardMessageRouter.ts` next to `this.mcpManager`
(`src/ui/DashboardMessageRouter.ts:386`, `:451`, dispatch near `:1686`).

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

Mirrors `mcpManagerStore.ts`: `index: CommunityTemplateEntry[] |
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
      — a one-line notice above the list: community templates are written by
        third parties, can run commands, and should be reviewed before running
        (matches the proposed license Section 5(e) disclaimer)
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

## Seed templates

Templates to have in `ctrlyoke-templates` when Phase 1 ships, so the gallery
isn't empty on day one and contributors have real examples to copy. These are
ideas that were deliberately kept out of the built-ins to keep that set lean.

- **Review Branch.** Review the current branch against its base (`~diff` and
  the branch's commits), fix what it finds, and gate on the test command. It
  runs on a capable model, because reviewing takes judgment. No built-in shows
  the diff or commit references, and reviewing work an agent already did is one
  of the most common things people do with one. Proposed 2026-11-07, during the
  built-in template trim.

---

## Decisions

- **Repo-hosted, PR-reviewed sharing**, not Gists or a hosted DB — reuses
  schema validation as the safety gate, no new backend for Phase 1.
- **A separate MIT-0 repository (`FuzzyNova/ctrlyoke-templates`)**, not a directory of
  this repo (2026-11-20). It keeps the community library out of the commercial license
  entirely, so no path-scoped license carve-out or CLA exemption is needed. Its CI
  validates against the schema of the latest ctrlyoke release tag.
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
store/component/service. Phase 1's CI workflow is its own verification: a deliberately
broken test PR against `FuzzyNova/ctrlyoke-templates` should fail `validate.yml`. Manual check for Phase 2: install a template from the index
into both Workspace and User scope, confirm it appears in the New Workflow
template picker (`TemplateManager.discoverCustomTemplates`) immediately
without a reload.
