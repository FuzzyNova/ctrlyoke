# ctrlyoke Rebrand — Source/Repo/Product Rename Plan

**Created:** June 28, 2026
**Status:** Backlog — planning
**Decision:** Rename the product from **FlightPath** to **ctrlyoke**. See `dev/reference/rebrand-naming.md` for the naming rationale and trademark clearance (`dev/reference/trademark-search-results.csv`).

> **Pre-release, no back-compat.** Per `CLAUDE.md`, there are no published users to migrate. We rename hard — no aliases, no dual-read of old directory/extension names — except the developer-local cleanup noted in [§9](#9-developer-local-migration). This keeps the rename a clean cut rather than a permanent compatibility tax.

---

## 0. Brand-name decisions (resolve before starting)

| Question | Decision | Rationale |
| --- | --- | --- |
| **Workspace runtime dir** | **`.ctrlyoke/`** (not `.yoke`) | A CLI tool already ships as `yoke` (IaC) — `.yoke` invites collision/confusion. `.ctrlyoke` is unambiguous and matches the brand. |
| **User-level dir** | **`~/.ctrlyoke/`** | Mirrors the workspace dir; replaces today's `~/.flightpath/` (settings, agents, skills, scripts, mcp registry). |
| **CLI binary** | **`ctrlyoke`** + **`ctrlyoke-mcp`** | `ctrlyoke run` / `validate` / `commit` read cleanly (the rebrand doc's CLI-ergonomics win). |
| **VS Code command namespace** | **`ctrlyoke.*`** | e.g. `ctrlyoke.openPanel`, `ctrlyoke.run`. User-facing churn is fine pre-release. |
| **Config namespace / setting** | **`ctrlyoke.workspaceDirectory`** | Single `CONFIG_NAMESPACE` constant. |
| **Workflow file extension** | **`.workflow.yml` / `.workflow.json`** (NOT `.ctrlyoke.*`) | Decoupled from the product name per the decision in `rebrand-naming.md` §"Decision". Tracked here as a coordinated workstream ([§6](#6-workstream-f--workflow-file-extension)) because it touches the same `package.json` activation/validation surfaces. |
| **PascalCase identifier root** | **`CtrlYoke`** | `FlightPathConfigService` → `CtrlYokeConfigService`, etc. |
| **Publisher** | **Keep `fuzzynova`** (open question — see [§12](#12-open-questions)) | FuzzyNova is the parent brand (rebrand doc references "Fuzzy Nova parent branding"). Confirm before touching `package.json publisher`. |
| **Domain** | **`ctrlyoke.dev`** (redirect `controlyoke.*` + `.com` → `.dev`) | Per rebrand doc; replaces `flightpath.dev`. |

---

## 1. Scope at a glance

A repo-wide grep for `flightpath|FlightPath|FLIGHTPATH` returns **~2,371 hits across ~250 files**; `.flightpath` (dir literal) alone is **~1,072 hits across ~249 files**. This is not a single find-and-replace — there are **distinct token classes** that must be handled with different replacements, and several **hard renames** (files, directories, schemas, images) that grep won't catch.

### Token-class substitution map

Apply these as **case-sensitive** replacements. Do **not** run a blanket case-insensitive replace — it will corrupt the distinct casings.

| Token | Replace with | Where it appears |
| --- | --- | --- |
| `FlightPath` (PascalCase, prose/brand) | `ctrlyoke` *(prose/UI)* or `CtrlYoke` *(identifiers)* — **context-dependent, see note** | Display names, class names, comments |
| `flightpath` (lowercase) | `ctrlyoke` | package name, command/config namespace, MCP tool ids, CLI name |
| `FLIGHTPATH` (upper / const) | `CTRLYOKE` | `FLIGHTPATH_DIR` const, env-style names |
| `.flightpath` (dir literal) | `.ctrlyoke` | runtime dir, paths, `.gitignore`, log paths |
| `flightpath-mcp` | `ctrlyoke-mcp` | CLI bin, docs |
| `flightpath-<harness>-hook` | `ctrlyoke-<harness>-hook` | hook script filenames + log filenames |
| `flightpath.dev` | `ctrlyoke.dev` | site/domain |
| `*.flightpath.yaml/yml/json` | `*.workflow.yaml/yml/json` | **separate extension decision — [§6](#6-workstream-f--workflow-file-extension)** |

> **PascalCase note:** `FlightPath` maps to **`CtrlYoke`** when it is a code identifier (class, type, file name: `CtrlYokeConfigService`, `CtrlYokeTypes`), but to the **lowercase brand `ctrlyoke`** in user-facing display strings (`displayName`, command titles, UI labels, docs prose). The `category` shown in the VS Code command palette becomes `ctrlyoke`. Decide per occurrence; do not auto-map.

---

## 2. Single sources of truth (do these first — they cascade)

Renaming these constants flips the largest number of *runtime* references in one move. Everything that imports them updates for free.

| File | Symbol | Change |
| --- | --- | --- |
| `src/utils/ConfigurationUtils.ts` | `PATH_CONSTANTS.FLIGHTPATH_DIR = ".flightpath"` | → `".ctrlyoke"`. Rename the key `FLIGHTPATH_DIR` → `CTRLYOKE_DIR` (and update ~all `PATH_CONSTANTS.FLIGHTPATH_DIR` call sites — UI, utils, server, mcp). |
| `src/mcp-server.ts` | `const FLIGHTPATH_DIR = ".flightpath"` (local dupe) | → `const CTRLYOKE_DIR = ".ctrlyoke"`. **Note the DRY violation**: the MCP server hardcodes its own copy because it can't import the VS Code-coupled module — consider extracting a shared platform-neutral constants module while we're here. |
| `src/platform/VsCodeWorkspaceRoot.ts` | `CONFIG_NAMESPACE = "flightpath"` | → `"ctrlyoke"`. Drives the `ctrlyoke.workspaceDirectory` setting lookup. |

> Subdirectory names inside the runtime dir (`.queue`, `scripts`, `prompts`, `logs`, `.history`, etc.) **do not change** — only the root `.flightpath` → `.ctrlyoke`.

---

## 3. Workstream A — `package.json` (extension manifest)

The single highest-density branding file. All of these change:

- `name`: `flightpath` → `ctrlyoke`
- `displayName`: `FlightPath` → `ctrlyoke`
- `description`: keep wording, drop "FlightPath" if present
- `repository.url`, `homepage` (`https://flightpath.dev` → `https://ctrlyoke.dev`), `bugs.url` — **gated on repo rename + publisher decision** ([§10](#10-workstream-l--repo--ci), [§12](#12-open-questions))
- `bin`: `flightpath-mcp` → `ctrlyoke-mcp`, `flightpath` → `ctrlyoke` (and the emitted `out/*.js` targets stay, only keys rename)
- `contributes.configuration.title` + property key `flightpath.workspaceDirectory` → `ctrlyoke.workspaceDirectory`
- `contributes.commands[*].command` — **~30 commands** `flightpath.*` → `ctrlyoke.*`, and `category: "FlightPath"` → `ctrlyoke`
- `contributes.keybindings[*].command` + `when` clauses (`focusedView == 'flightpath.dashboard'` → `ctrlyoke.dashboard`)
- `contributes.menus.*` — every `command`, `when` (e.g. `flightpath.devMode`, `flightpath.generatingCommitMessage`), and `group` prefix (`flightpath@1`, `2_flightpath`) → `ctrlyoke*`
- `contributes.viewsContainers.panel[*].id/title/icon` and `contributes.views` key `flightpath` + `flightpath.dashboard`
- `contributes.mcpServerDefinitionProviders[*].id/label` (`flightpath.workflowMcpProvider`)
- `contributes.languageModelTools[*]` — **4 tools**: `flightpath_queue_status`, `flightpath_append_queue`, `flightpath_capabilities`, `flightpath_read_output` (`name` + `toolReferenceName` + `displayName` + `modelDescription` prose) → `ctrlyoke_*`
- `contributes.jsonValidation` / `yamlValidation` `fileMatch` — coordinate with [§6](#6-workstream-f--workflow-file-extension) (extension change) and [§7](#7-workstream-g--schemas) (schema rename)
- `activationEvents`: `workspaceContains:**/*.flightpath.{yaml,yml,json}` → `**/*.workflow.{yaml,yml,json}` ([§6](#6-workstream-f--workflow-file-extension))
- `icon` + command icon paths → renamed images ([§8](#8-workstream-j--icons--images))

> **`flightpath.devMode` / context-key churn:** the `when`-clause context keys are set in `src/extension.ts` via `setContext`. Rename the manifest **and** the `setContext` calls together or menus silently break.

---

## 4. Workstream B — Source identifiers (classes, types, files)

**Hard file renames** (update all imports — use the LSP rename where possible):

| Current | New |
| --- | --- |
| `src/types/FlightPathTypes.ts` | `CtrlYokeTypes.ts` |
| `src/types/FlightPathSettings.ts` | `CtrlYokeSettings.ts` |
| `src/config/FlightPathConfigService.ts` | `CtrlYokeConfigService.ts` |
| `src/ui/FlightPathMcpServerProvider.ts` | `CtrlYokeMcpServerProvider.ts` |
| `src/ui/FlightPathWebviewProvider.ts` | `CtrlYokeWebviewProvider.ts` |
| `src/server/FlightPathHostedServer.ts` | `CtrlYokeHostedServer.ts` |
| `src/test/unit/FlightPath*.test.ts` (×2) | `CtrlYoke*.test.ts` |

> The core engine classes (`WorkflowOrchestrator`, `WorkflowInstance`, `WorkflowExecutor`, `WorkflowStateMachine`, `PromptQueue`, …) are **already brand-neutral** — leave them. This is why "Workflow" is the right extension name and why the engine needs almost no identifier churn.

**In-code string identifiers:**
- The built-in MCP server shorthand `"flightpath"` (the id users put in a step's `mcpServers: ["flightpath"]`) → `"ctrlyoke"`. Lives in `FlightPathTypes.ts` docs, `extension.ts`, `FlightPathMcpServerProvider.ts`, `PromptPropertyCompletionProvider.ts`, `mcp-server.ts` (`name: "flightpath"`), and the `WebviewMessageTypes.ts` special-dir union (`"flightpath"` target id). Update the union type and every comparator together.
- `src/types/DashboardConstants.ts` — branding strings + the special-dir doc comment (`"flightpath" → .flightpath/agents|skills …`).
- `src/cli.ts` `.name("flightpath")` → `.name("ctrlyoke")` and help text.

---

## 5. Workstream C — Hook/notify scripts & user-dir paths

**Rename script files** (`src/scripts/`) and update every reference (esbuild copy config, `.vscodeignore`, knip.json, the per-harness `*CliProvider.ts` / `*NotificationMonitor.ts` that spawn them, and `server/HostedServiceWorkerScript.ts`):

| Current | New |
| --- | --- |
| `flightpath-claude-hook.js` | `ctrlyoke-claude-hook.js` |
| `flightpath-copilot-hook.js` | `ctrlyoke-copilot-hook.js` |
| `flightpath-codex-notify.js` | `ctrlyoke-codex-notify.js` |
| `flightpath-gemini-hook.js` | `ctrlyoke-gemini-hook.js` |
| `flightpath-qwen-hook.js` | `ctrlyoke-qwen-hook.js` |
| `flightpath-hook-utils.js` | `ctrlyoke-hook-utils.js` |
| `flightpath-opencode-plugin.ts` | `ctrlyoke-opencode-plugin.ts` |
| `src/server/flightpath-service-worker.js` | `ctrlyoke-service-worker.js` |

**User-level dir** `~/.flightpath/` → `~/.ctrlyoke/` (these `os.homedir()` joins): `FileConfigBackend.ts` (settings.json), `HarnessFileManager.ts` / `HarnessDirectoryUtils.ts` (agents/skills), `McpConfigPaths.ts` (mcp/servers.json), `EndConditionEvaluator.ts` (scripts), `WebviewSettingsSync.ts`, `cli.ts` comments. Most of these should route through the renamed `PATH_CONSTANTS.CTRLYOKE_DIR` rather than re-hardcoding `".ctrlyoke"` — **fold any stray hardcoded `".flightpath"` literals into the constant while renaming** (DRY).

---

## 6. Workstream F — Workflow file extension

Independent brand decision (`rebrand-naming.md`): `*.flightpath.{yaml,yml,json}` → `*.workflow.{yaml,yml,json}`. Coordinate with [§3](#3-workstream-a--packagejson-extension-manifest) and [§7](#7-workstream-g--schemas):

- `package.json` `activationEvents`, `jsonValidation.fileMatch`, `yamlValidation.fileMatch`, and all the `menus[*].when` regexes (`resourceFilename =~ /\.(flightpath\.(yaml|yml|json)|prompt\.md)$/`).
- File discovery / parsing: `WorkflowFileDiscovery.ts`, `PromptFileParser.ts`, `PromptFileLoader.ts`, `promptPathUtils.ts`, `WorkflowSerializer.ts`, and the `scripts/migrate-prompt-syntax.mjs` glob.
- **All `manual-test/*.flightpath.{yaml,json}` fixtures** (~25 files) → `*.workflow.*`, plus the docs that reference the extension.
- `.prompt.md` files are unaffected (already brand-neutral).

> Keep this a **separate commit/PR** from the brand rename even though it lands in the same files — it's a different decision and easier to review/revert in isolation.

---

## 7. Workstream G — Schemas

- `schemas/prompt-schema.json` / `prompt-schema.yaml` / `settings-schema.json` — update `$id`, `title`, `description` branding and any `flightpath`/`.flightpath` strings.
- `scripts/generate-yaml-schema.mjs` output references.
- Decide whether to rename `prompt-schema.*` → `workflow-schema.*` to match the new extension (docs already call it `workflow-schema.md`). **Recommend yes** for consistency; adds the file rename + `package.json` validation `url` updates.

---

## 8. Workstream J — Icons & images

Rename and re-point (`package.json` icon paths + any `<img>`/import in landing/docs/README):

- `images/flightpath-icon.svg`, `flightpath-icon-simple.svg`, `flightpath-sidebar-icon.svg`, `flightpath-app-icon.svg`, `flightpath-icon-color-simple.{svg,png}`, `flightpath-icon-simple-{light,dark}.svg`, `images/drafts/flightpath-color-icon*` → `ctrlyoke-*`.
- The icon-generation scripts (`scripts/generate-sidebar-icon.mjs`, `generate-custom-icons.mjs`, `generate-app-icons.mjs`) likely hardcode these names — update source + output paths.
- **New artwork is a design task, not just a rename** — the current art may encode the "flight path" metaphor; a `ctrl`-key/yoke visual is a separate design item. For the code rename, keep the existing glyphs under new filenames and swap art later.

---

## 9. Developer-local migration

Not user-facing, but every active dev workspace (incl. this repo) has live `.flightpath/` and `~/.flightpath/` dirs. After the code rename they'll be orphaned. Provide a tiny one-shot:

- Workspace: `mv .flightpath .ctrlyoke` (git-tracked content like `templates/`, committed workflows; the gitignored `temp/.queue/logs/.history/.search-index/capabilities.json` can just be regenerated).
- User: `mv ~/.flightpath ~/.ctrlyoke`.
- Update `.gitignore` (`.flightpath/temp/` … → `.ctrlyoke/…`) and any committed `.flightpath/` content in the repo (templates, debug fixtures, `manual-test/.flightpath/`).

No runtime back-compat shim — pre-release.

---

## 10. Workstream L — Repo & CI

- **GitHub repo rename** `FuzzyNova/flightpath` → `FuzzyNova/ctrlyoke` (or new org if publisher changes — see [§12](#12-open-questions)). GitHub auto-redirects old URLs, but update `package.json` `repository`/`bugs`/`homepage` and any hardcoded URLs in docs/landing.
- `.github/workflows/deploy.yml` and other workflows — branding, paths, deploy target (site domain).
- `.vscode/launch.json` — `.flightpath` paths / debug config names.
- `esbuild.js`, `knip.json`, `.vscodeignore` — renamed script-file globs ([§5](#5-workstream-c--hooknotify-scripts--user-dir-paths)).

---

## 11. Workstream M — Docs, instructions, and project memory

- **`.github/copilot-instructions.md`, `CLAUDE.md`, all `.github/instructions/*.instructions.md`** — branding, the routing table, log-path examples (`.flightpath/logs/`), the `flightpath-<harness>-hook-debug.log` references in `<debugging>`. Several instruction files are named `flightpath-*.instructions.md` (`flightpath-core`, `flightpath-orchestration`, `flightpath-cli-binary`, `flightpath-chat`) — decide whether to rename the files (then update the routing table) or keep filenames and only fix content. **Recommend keeping the instruction filenames** (they describe the `src/flightpath/` *directory*, which we are NOT renaming) and only updating prose. → confirm the `src/flightpath/` source dir stays (it's brand-neutral-ish; renaming it is a large, low-value churn — recommend **keep**).
- **`docs/`** (VitePress) — `docs/cli/flightpath.md` + `flightpath-mcp.md` rename, `docs/.vitepress/config.mts` branding/domain, all guide/reference/workflow/troubleshooting prose.
- **`landing/`** — `src/config.ts` (`MARKETPLACE_URL` itemName `fuzzynova.flightpath`), `Layout.astro`, all `pages/*.astro` branding + domain.
- **`README.md`, `QUICK_START.md`, `CHANGELOG.md`, `AGENTS.md`, `CHORES.md`** — branding.
- `dev/backlog/*` and `dev/active/*` plans reference FlightPath throughout — **do not bulk-rewrite history docs**; only fix `dev/active/*` if still actionable. `dev/implemented/` and `dev/research/` are historical record — leave as-is.
- This private memory index notes durable knowledge lives in the instruction files — once renamed, no extra memory action needed.

---

## 12. Open questions

1. **Publisher / org**: keep `fuzzynova` (parent brand) or move to a `ctrlyoke`-owned publisher? Affects `package.json publisher`, `MARKETPLACE_URL` itemName, and repo org. *Recommend: keep `fuzzynova`.*
2. **`src/flightpath/` directory rename**: it's the engine namespace. Renaming to `src/ctrlyoke/` is huge churn for little gain and the engine is brand-neutral internally. *Recommend: keep the directory; rename only the `FlightPath*`-prefixed files in [§4](#4-workstream-b--source-identifiers-classes-types-files).*
3. **`prompt-schema.*` → `workflow-schema.*`**: rename for consistency with the new `.workflow.*` extension? *Recommend: yes.*
4. **Sequencing**: brand rename and extension change (`.workflow.*`) as **two PRs** or one? *Recommend: two — they're independent decisions.*

---

## 13. Suggested execution order

1. **Constants first** ([§2](#2-single-sources-of-truth-do-these-first--they-cascade)) — flips most runtime path references via `PATH_CONSTANTS`/`CONFIG_NAMESPACE`.
2. **Source file/identifier renames** ([§4](#4-workstream-b--source-identifiers-classes-types-files)) via LSP rename; fix imports.
3. **Hook scripts + user-dir paths** ([§5](#5-workstream-c--hooknotify-scripts--user-dir-paths)).
4. **`package.json` manifest** ([§3](#3-workstream-a--packagejson-extension-manifest)) + `setContext` keys in `extension.ts`.
5. **Schemas + icons** ([§7](#7-workstream-g--schemas), [§8](#8-workstream-j--icons--images)).
6. **Tests** — update fixtures/assertions; `npm run typecheck` then `npm test` / `npm run test:ui` / `npm run test:harness`.
7. **Docs / landing / instructions** ([§11](#11-workstream-m--docs-instructions-and-project-memory)).
8. **Repo + CI + domain** ([§10](#10-workstream-l--repo--ci)) — last, coordinated with marketplace.
9. **Extension rename `.workflow.*`** ([§6](#6-workstream-f--workflow-file-extension)) — separate PR.

**Verification gates:** `npm run typecheck` → `npm run lint` → full test suites → manual smoke (init a workspace, confirm `.ctrlyoke/` is created, run a `.workflow.yaml`, confirm hooks fire and logs land in `.ctrlyoke/logs/`). Grep `flightpath|FlightPath|FLIGHTPATH` should return only intentional historical references (`dev/implemented/`, `dev/research/`, CHANGELOG history).
