# Skills Registry Plan

**Status:** Implemented (2026-10-23). Client in `src/utils/SkillsRegistryClient.ts`,
install in `HarnessFileManager.installSkillFiles`, handlers in
`HarnessFileMessageService`, UI in `SkillsRegistryPanel.tsx` with
`useSkillsRegistryStore`. See "As built" at the end for where the build differs
from the design below.

## Goal

Let users search a public skills registry and install a skill from the Agent &
Skills Manager, the same way the MCP Manager's "Registry" tab
(`McpManagerSection.tsx`) searches `registry.modelcontextprotocol.io` and
imports a server. Once installed, a skill goes through the existing Save/Delete/
Default actions like any other managed skill.

## Decision: skills.sh as the registry

Researched 2026-10-22. Options considered:

| Registry                       | For                                                                                                                                                                                                                                                                                          | Against                                                                                                                          |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **skills.sh (Vercel)**         | Biggest by real use: deduplicated install counts (anthropics/skills `pdf` ~215k), an "official creators" list, and per-skill security audits from Gen Agent Trust Hub, Socket and Snyk. The `skills` CLI (`vercel-labs/skills`, MIT) installs into 40+ agents, which covers all six of ours. | The documented `/api/v1` API needs a Vercel OIDC token (see below).                                                              |
| SkillsMP (skillsmp.com)        | Largest raw index (3M+ SKILL.md files crawled from GitHub); REST + MCP API with an OpenAPI spec.                                                                                                                                                                                             | Unnamed operator, no security scanning, a lot of low-quality crawl results, anonymous limit of 50 requests/day, then paid tiers. |
| anthropics/skills (GitHub)     | Reference set, trustworthy.                                                                                                                                                                                                                                                                  | A few dozen skills: a repo, not a registry.                                                                                      |
| Agensi, ClawHub, awesome-lists | Curated niches.                                                                                                                                                                                                                                                                              | Small, or commercial.                                                                                                            |

Trust is the deciding factor: scans of the public ecosystem find security
problems in roughly 13–37% of skills, so the install-count ranking, the
official-creator badge and the audit verdicts are the features that matter most.

## The API situation (verified 2026-10-22)

| Need                                    | Route                                                        | Auth        | Status                                                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------ | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Search                                  | `GET https://skills.sh/api/search?q&limit[&owner]`           | none        | Undocumented; the route `skills find` uses (`src/find.ts`, overridable via `SKILLS_API_URL`). Returns `{ skills: [{ id, source, name, installs }], searchType, count }`.     |
| Skill files                             | `GET https://skills.sh/api/download/{owner}/{repo}/{slug}`   | none        | Undocumented; the CLI's blob fast path (`src/blob.ts`). Known hash bug: vercel-labs/skills#2388.                                                                             |
| Security audits                         | `GET https://skills.sh/api/v1/skills/audit/{source}/{skill}` | none        | **Documented** and answers without a token. Returns `audits[]` with `provider`, `status` (`pass`/`warn`/`fail`), `riskLevel`, `summary`, `auditedAt`; 404 = not audited yet. |
| Search / detail / leaderboard / curated | `GET /api/v1/skills…`                                        | Vercel OIDC | Documented, but returns 401 without a token from a linked Vercel project.                                                                                                    |

The skills.sh terms say the "public API" is "rate-limited per IP" and that
"reasonable use, including caching results on your own infrastructure, is
encouraged and not restricted". IP-level blocks are reserved for abuse,
scraping that bypasses the limit, and degrading the service. Neither the terms
nor the FAQ address third-party clients, and Vercel has not answered any of
the open issues asking whether `/api/search` and `/api/download` are a
supported contract: vercel-labs/skills#1801, #1825, #2333, #1053, #1055, #1325,
#1434 (no maintainer replies as of 2026-10-22). At least three other desktop
clients (Agent Muse, cc-profile-switch, AcornSkills) face the same choice;
AcornSkills turned discovery off rather than depend on the routes.

**Approach:** call the same unauthenticated routes the CLI calls, on the user's
behalf and only when the user acts. Treat the client as an experimental,
replaceable adapter that degrades gracefully. Do not embed a credential.
Watch #2333/#1825; if Vercel publishes a public client ID or a key-free v1
tier, switch the adapter to it.

Rejected alternatives:

- **Embed a Vercel OIDC token.** Not possible: OIDC tokens expire after ~12 h
  and are minted inside a Vercel deployment, so there is nothing long-lived to
  ship. Any shared bearer secret in a distributed binary is also extractable.
- **Host a ctrlyoke relay on Vercel that mints OIDC tokens.** This works
  technically, but every ctrlyoke user would share one 600 req/min (team,
  project) limit and requests would be attributed to our project. It also adds
  a hosted service and privacy obligations. Revisit only if the undocumented
  routes disappear and Vercel offers nothing public (it would pair with
  `CTRLYOKE_ACCOUNTS_PLAN.md` infrastructure).
- **Scrape the skills.sh sitemap/HTML.** No.

## Design

### Extension side

- `src/utils/SkillsRegistryClient.ts` behind a small interface
  (`searchSkills(query, limit)`, `getSkillAudits(source, slug)`,
  `downloadSkill(source, slug)`), mirroring `safeFetchMcpRegistry` in
  `McpDiscoveryUtils.ts`: errors become `{ error }`, never throws into the
  router. Validate every response shape at runtime; an unexpected shape is
  "registry unavailable", not a crash. Base URL from a constant that a dev env
  var can override, like the CLI's `SKILLS_API_URL`.
- **Install source of truth is GitHub, not `/api/download`.** Use the search
  result's `source` (`owner/repo`) plus the GitHub trees API to find the skill
  folder, then fetch from `raw.githubusercontent.com`. This is the CLI's own
  fallback path, avoids the second undocumented route and its hash bug, and
  matches the files the user reviews. `/api/download` is an optional fast path
  only if GitHub's unauthenticated 60 req/h limit becomes a problem.
- Install writes into the active scope's ctrlyoke skills directory
  (`.ctrlyoke/skills/<slug>/` or `~/.ctrlyoke/skills/<slug>/`) through
  `HarnessFileManager`, then the normal file list refresh shows it. Writing to
  a harness directory stays the existing Save flyout's job.
- Record the origin (`source`, `slug`, commit SHA, installed-at) in a sidecar,
  so an "Update available" check is possible later. Decide the format during
  implementation; if it carries a `schemaVersion`, follow the persisted-state
  rules in `CLAUDE.md`.
- Sanitize names and descriptions (the CLI's `sanitizeMetadata` strips control
  and ANSI characters), and reject path traversal in any file path from the
  repo tree.
- New message pair in `DashboardConstants.ts` / `WebviewMessageTypes.ts`,
  modelled on `REQUEST_MCP_REGISTRY_SEARCH` / `MCP_REGISTRY_SEARCH_RESULT`,
  plus an install request/result routed through `HarnessFileMessageService`.
- Gate the feature with a host capability (as `browseMcpGallery` is), so a
  host that forbids network access can hide the tab.

### Webview

- In the Skills view of `AgentSkillsManagerSection.tsx`, add the MCP Manager's
  "Discover & import" layout: a search box with debounce, results sorted by
  installs, and an Import button that turns into "Imported" when the slug is
  already in the active scope. The loading/error/empty states and pager
  match the MCP Manager's. Agents stay as they are: skills.sh only lists
  skills.
- Each result shows the install count, an "official" badge for official
  creators, and an audit pill (worst status across providers). Until curated
  is reachable without a token, the official list is a small checked-in owner
  list or is left out; don't scrape for it.
- Before installing: a confirm modal that lists the audit verdicts with links
  to skills.sh's per-provider pages and a link to the SKILL.md on GitHub. Any
  `warn`/`fail`, or no audit yet, needs an explicit second confirmation.
- Store state in `useHarnessFileStore` (or a sibling store if it gets crowded).

### Naming the source

The MCP Manager and Stats tab already name their sources (`DATA_SOURCES` in
`DashboardConstants.ts`): the tab is **MCP Registry**, not "Registry", and a
line in the panel links `registry.modelcontextprotocol.io`. Do the same here,
and make it say more, because the routes are undocumented and every result is
a third party's code:

- Add a `SKILLS_SH` entry to `DATA_SOURCES` and build every label below from
  it. Don't hardcode "skills.sh" in components.
- Label the discovery tab **skills.sh**, never "Registry", with a tooltip
  that says it searches the public skills.sh directory run by Vercel.
- At the top of the panel, add a line linking `skills.sh`: results, install
  counts and security audits come from skills.sh (Vercel), your search text is
  sent there, and skills are published by third parties and fetched from their
  GitHub repositories on install.
- On each result, label the install count and audit pill as skills.sh data
  ("12.3k installs on skills.sh"), and link the audit pill to the skill's
  skills.sh security page.
- The install confirm modal names both origins: the audit from skills.sh, the
  files from `github.com/<owner>/<repo>`.
- When the client fails (blocked, shape change), the error names skills.sh
  ("skills.sh search is unavailable") so the user knows which service is
  down. It must not read as a ctrlyoke error.

### Privacy and docs

- Requests send only the user's search text and the chosen skill's public
  `owner/repo`. They are user-initiated: nothing on panel open apart from the
  first search when the user opens the tab, same as the MCP registry.
  vercel-labs/skills#1593 shows the CLI's own audit route leaking private repo
  names; we only ever query public sources taken from search results.
- Add skills.sh to whatever `PRIVACY.md` / docs say about the MCP registry
  call, and update the Agent & Skills Manager docs page.
- CHANGELOG **Added** entry.

## Tests

- Unit: client parsing of each route with fixtures, including unexpected
  shapes, 404 audit, 429 with `Retry-After`, network failure.
- Unit: GitHub tree resolution and path-traversal rejection.
- UI (Vitest): search states, audit pill and confirm gating, Imported state.

## Resolved questions (2026-10-23)

- **Install telemetry: no.** ctrlyoke does not report installs to skills.sh,
  so they don't add to a skill's install count. Reconsider only if Vercel asks
  integrators to report installs through a documented route.
- **"Install via `npx skills add`": not offered.** It would run an unpinned
  npm package fetched at click time, send the CLI's telemetry unless opted
  out, skip the review dialog's audit gate, and write a second lock file and
  update mechanism for the same skill. The reason to want it, `skills update`,
  is covered by ctrlyoke's own update check. Skills the CLI installs into
  `.agents/skills` already appear in the manager under **Agents**, so users who
  prefer the CLI lose nothing by running it themselves.

## As built (2026-10-23)

Verified against the live services on 2026-10-23 (search, audits, a 404 audit,
and a full install of `anthropics/skills/pdf`).

- **Search needs at least 2 characters** (`/api/search` answers 400 otherwise)
  and has no cursor, so the client asks for 50 results once and the panel pages
  them 10 at a time. Opening the tab sends nothing; the first request goes out
  when the user has typed a query.
- **Results carry `skillId`**, which is used as the slug; installs are sorted
  descending by the client.
- **Audits are fetched per visible page** in one batched message (at most 25,
  4 concurrent), and cached in the store. An unknown verdict counts as `warn`.
  The audit pill links to `skills.sh/<source>/<slug>/security/<provider>`.
- **Location is resolved when the review dialog opens**, not at install: HEAD
  commit (`commits/HEAD` with `Accept: application/vnd.github.sha`), then the
  tree at that commit, then frontmatter probes of up to 20 SKILL.md candidates
  ranked by folder name. The install message carries that commit, so the files
  written are exactly the ones the dialog linked to. Two GitHub API calls per
  review; raw downloads don't count against the 60/h limit.
- **Install limits:** 200 files, 2 MB per file, 10 MB total. Symlinks,
  `.git`/`__pycache__`/`node_modules` and `metadata.json` are skipped; any other
  unsafe path (traversal, Windows device names, trailing dot) fails the install.
  `isSafePathSegment` lives in `PathSecurity.ts`.
- **Origin sidecar:** `<skill>/.ctrlyoke-origin.json`, store `skill-origin` v1
  in `PersistedSchemaGuard` (fixture under `src/test/fixtures/formats/`). It
  carries `files`, the git blob SHA of each installed file, so both checks
  below need no download. A replace refuses a newer record. It is copied
  between ctrlyoke scopes but not to harness directories. Enumeration reads it
  into `ManagedFileLocation.origin` for ctrlyoke copies only.
- **Update check** (`REQUEST_SKILLS_REGISTRY_UPDATE_CHECK`, user-initiated, off
  the route queue): per installed skills.sh copy in either scope,
  `checkForUpdate` fetches HEAD (cached 60 s, so skills sharing a repository
  ask once); an unchanged HEAD is up to date with no further call. Otherwise
  the HEAD tree's file SHAs for the skill folder are compared with `files`, so
  commits elsewhere in the repository are not updates. A moved folder is found
  again through the frontmatter probe; a missing one is `notFound`. Local
  edits come from hashing the folder on disk (`findLocalSkillChanges`).
- **Update = install with `replace`.** The handler refuses to replace a copy
  whose origin is not the same registry, `source` and `slug`, so a user's own
  skill with the same folder name is never overwritten (the UI shows **Name in
  use**). The old folder is renamed aside, the staged one renamed in, and the
  old one restored if that fails. Updates always re-resolve the location, and a
  successful install drops the cached location and stale check result.
- **The four registry messages bypass `routeQueue`** (`OFF_QUEUE_MESSAGE_TYPES`
  in `WebviewMessageRouter`), like `REQUEST_SECRET_REGISTRY`, so a slow
  skills.sh or GitHub request can't stall the dashboard. The MCP registry search
  still runs on the queue.
- **Not built:**
  - **Host capability gate.** Capabilities are derived from optional
    `DashboardHostActions` methods, and no host forbids network access today
    (the MCP Registry tab isn't gated either). Add one when such a host exists.
  - **Official badge.** Left out, as the design allowed: curated isn't
    reachable without a token, and no owner list was verified.
  - **Automatic update checks.** Checks run only from the button, so nothing
    is sent to GitHub without a click.
