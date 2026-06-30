# ctrlyoke Rebrand — Source/Repo/Product Rename Plan

**Created:** June 28, 2026
**Status:** 🟡 In progress — **PR1 (brand) + PR2 (extension) DONE & committed on `main`.** Remaining: `docs/` + `landing/` prose, legal docs, and external/business steps. **See [Execution Status](#execution-status--updated-june-30-2026) first.**
**Decision:** Rename the product from **FlightPath** to **ctrlyoke**. See `dev/reference/rebrand-naming.md` for the naming rationale and trademark clearance (`dev/reference/trademark-search-results.csv`).

> **Pre-release, no back-compat.** Per `CLAUDE.md`, there are no published users to migrate. We rename hard — no aliases, no dual-read of old directory/extension names — except the developer-local cleanup noted in [§9](#9-developer-local-migration). This keeps the rename a clean cut rather than a permanent compatibility tax.

---

## Execution Status — updated June 30, 2026

> **Fresh-chat handoff.** The **code rebrand is essentially complete** — PR1 (brand) and PR2 (extension) are committed on `main`. What's left is docs/site *prose*, legal docs, and external/business steps. Read this section first; the workstreams below (§0–§13) are the original detailed reference.

### ✅ Done & committed (`main`)

Three commits:
- `5310c2b6` — **PR1 wave 1**: §2 constants, §12.2 `src/flightpath → src/core`, §4 file renames, §5 script renames, §3 `package.json`, all `src/` brand.
- `8e7c612b` — **PR1 wave 2**: §11 instruction files + shared-memory docs, agent-template renames.
- `a11db47d` — **PR2**: §6 extension `*.flightpath.* → *.ctrlyoke.*` + §7 schema rename, **plus** the brand gaps PR1's `src`-only sweep missed (`scripts/`, `prompts/`, `manual-test/`, `README`, `QUICK_START`).

Completed workstreams:
- **§2 Constants** — `CTRLYOKE_DIR=".ctrlyoke"`, `CONFIG_NAMESPACE="ctrlyoke"`, `EXTENSION_NAMESPACE="ctrlyoke."`. ⚠ The suggested DRY extraction of a shared constants module was **not** done — `mcp-server.ts` still hardcodes its own `CTRLYOKE_DIR` dupe.
- **§3 `package.json`** — name/displayName/bin/~30 commands/config/4 LM tools/views/menus/`when`-keys all `ctrlyoke.*`. `repository`/`homepage`/`bugs` already point at `FuzzyNova/ctrlyoke` + `ctrlyoke.dev` → **⚠ these 404 until the repo rename + domain go live.**
- **§4 Identifiers** — all 8 `FlightPath*` files → `CtrlYoke*`; MCP shorthand id `"ctrlyoke"`. Also caught `Flightpath`/`flightPath` casing variants the §1 token map missed.
- **§5 Hook scripts + user dir** — 8 scripts renamed; `~/.flightpath → ~/.ctrlyoke` via `CTRLYOKE_DIR`. Stale Copilot hook-file comments (`.github/hooks/flightpath.json`) → `ctrlyoke.json`.
- **§6 Extension (PR2)** — 37 workflow files renamed + every string/regex/when-clause + `WORKFLOW_FILE_NAMES`/`WORKFLOW_FILE_SUFFIXES`. Working-file path now reads `.ctrlyoke/.queue/<name>.ctrlyoke.json`.
- **§7 Schemas** — `prompt-schema.* → workflow-schema.*` (renamed + content + refs + yaml regenerated). **Decision: kept `workflow-schema`, NOT `ctrlyoke-schema`** — internal plumbing (only `package.json` url / `PromptFileParser` / scripts reference it), so accurate-and-neutral wins.
- **§8 Icons** — already implemented in a prior chat; untouched as instructed.
- **§9 Dev-local migration** — `.flightpath → .ctrlyoke` (repo + `manual-test/`), `flightpath-test.code-workspace → ctrlyoke-test.code-workspace`, `.gitignore`. ⚠ **Renaming `.flightpath` while the extension host was running crashed it** — do dev-local moves with ctrlyoke STOPPED.
- **§11 (the code-adjacent half)** — `.github/instructions/*` (+ 4 brand-named files renamed *dropping* the brand: `flightpath-core→core`, etc.), `copilot-instructions.md`, regenerated `CLAUDE.md`/`AGENTS.md` (fixed hardcoded brand in `generate-agent-files.mjs`), `README`, `QUICK_START`, `CHORES.md`, `scripts/*.mjs`, `prompts/`, `manual-test/`.
- **Build-correctness fix:** `strip-dev-commands.mjs` matched the stale `"FlightPath Test"` category / `flightpath.test.*` ids (dev-command strip was silently broken) — now `ctrlyoke`.

**Verification — all green:** `npm run typecheck` ✅ · `npm run lint` ✅ · `npm run test:ui` (937/937) ✅ · `npm run compile` ✅. Residue audit: **0** `flightpath|FlightPath|FLIGHTPATH` across `src/`, `scripts/`, `schemas/`, `prompts/`, `.github/`, `package.json`, `manual-test/`, `README`, `QUICK_START`.

**Not verifiable in the rebrand chat — run locally:** `npm test` (downloads VS Code) and `npm run test:harness` (spawns real CLIs). Plus a manual smoke: create `foo.ctrlyoke.yaml`, confirm discovery + schema validation, run it, confirm hooks fire and logs land in `.ctrlyoke/logs/`.

### ⏳ Remaining

**Code-side (safe to do now — same `flightpath → ctrlyoke` map):**
- **§11 `docs/`** (~340 hits) — VitePress prose; rename `docs/cli/flightpath.md` + `flightpath-mcp.md`; `docs/.vitepress/config.mts` branding/domain. Brand → `ctrlyoke`, extension refs `.flightpath.* → .ctrlyoke.*`, domain `flightpath.dev → ctrlyoke.dev`.
- **§11 `landing/`** (~93 hits) — `src/config.ts` (`MARKETPLACE_URL` itemName `fuzzynova.flightpath → fuzzynova.ctrlyoke`), `Layout.astro` + `pages/*.astro`, domain. (Deferred only because URLs want the live domain.)
- `dev/` plans + `CHANGELOG.md` history → **leave** (historical record; the plan docs intentionally mention both names).

**Legal (counsel-final — §11.5; flag to attorney, don't silently ship):**
- `LICENSE.md` (5) + `PRIVACY.md` (9) — product name + `flightpath.dev` + `*@flightpath.dev` addresses. Name/address swap only.

**External / business (Nathan — §10, §11.5):**
- GitHub repo rename `FuzzyNova/flightpath → FuzzyNova/ctrlyoke`.
- Domain DNS + Netlify (`.github/workflows/deploy.yml` already references `ctrlyoke.dev`), `@ctrlyoke.dev` email inboxes, marketplace publish `fuzzynova.ctrlyoke`, licensing vendors.
- `.vscode/launch.json` `--disable-extension=...` id — sanity-check against your actually-installed extension id.

### How a fresh chat should continue
1. Confirm clean tree on `main` (the 3 rebrand commits above present).
2. `docs/` + `landing/` swap (brand + extension + `ctrlyoke.dev` URLs) → commit.
3. Hand `LICENSE.md` / `PRIVACY.md` to the attorney.
4. Run `npm test` + `npm run test:harness` + manual smoke locally.
5. External steps (repo / domain / email / marketplace).

---

## 0. Brand-name decisions (resolve before starting)

| Question | Decision | Rationale |
| --- | --- | --- |
| **Workspace runtime dir** | **`.ctrlyoke/`** (not `.yoke`) | A CLI tool already ships as `yoke` (IaC) — `.yoke` invites collision/confusion. `.ctrlyoke` is unambiguous and matches the brand. |
| **User-level dir** | **`~/.ctrlyoke/`** | Mirrors the workspace dir; replaces today's `~/.flightpath/` (settings, agents, skills, scripts, mcp registry). |
| **CLI binary** | **`ctrlyoke`** + **`ctrlyoke-mcp`** | `ctrlyoke run` / `validate` / `commit` read cleanly (the rebrand doc's CLI-ergonomics win). |
| **VS Code command namespace** | **`ctrlyoke.*`** | e.g. `ctrlyoke.openPanel`, `ctrlyoke.run`. User-facing churn is fine pre-release. |
| **Config namespace / setting** | **`ctrlyoke.workspaceDirectory`** | Single `CONFIG_NAMESPACE` constant. |
| **Workflow file extension** | **`.ctrlyoke.yml` / `.ctrlyoke.yaml` / `.ctrlyoke.json`** *(brand-coupled — SUPERSEDES the earlier `.workflow.*` decouple decision, June 30 2026)* | Reversed the `rebrand-naming.md` decouple after a sanity check: `.workflow.*` is a maximally-generic word (GitHub-Actions association) and, because the VS Code extension claims files by **global glob** (`activationEvents`/`jsonValidation`/`yamlValidation`/menu `when`), a generic extension would over-claim and schema-validate unrelated `*.workflow.yml` files. A branded namespace self-identifies shared/downloaded workflow files that live outside `.ctrlyoke/`, and claims cleanly with zero false-positives. The decouple's only upside (rebrand durability) is moot: this is the one and only rebrand — `ctrlyoke.dev`/`.com` + `controlyoke.*` are owned and the mark is TM-cleared. |
| **Wordmark (text)** | **lowercase `ctrlyoke`** everywhere it's written | Matches package/CLI/domain (all forced lowercase); zero "how do I capitalize it" overhead. The keycap styling lives **only in the logo**, never in the text wordmark. Pronounced **"control-yoke"** — the `ctrl` keycap reinforces the pronunciation. |
| **PascalCase identifier root** | **`CtrlYoke`** | `FlightPathConfigService` → `CtrlYokeConfigService`, etc. |
| **Publisher** | **Keep `fuzzynova`** (resolved) | Fuzzy Nova is the studio (a DBA to Nathan); unaffected by the product rename. `package.json publisher` stays `fuzzynova`; marketplace item → `fuzzynova.ctrlyoke`. |
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
| `*.flightpath.yaml/yml/json` | `*.ctrlyoke.yaml/yml/json` | **separate extension decision — [§6](#6-workstream-f--workflow-file-extension)** |

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

Brand-coupled per the revised [§0](#0-brand-name-decisions-resolve-before-starting) decision: `*.flightpath.{yaml,yml,json}` → `*.ctrlyoke.{yaml,yml,json}`. Coordinate with [§3](#3-workstream-a--packagejson-extension-manifest) and [§7](#7-workstream-g--schemas):

- `package.json` `activationEvents`, `jsonValidation.fileMatch`, `yamlValidation.fileMatch`, and all the `menus[*].when` regexes (`resourceFilename =~ /\.(flightpath\.(yaml|yml|json)|prompt\.md)$/` → `ctrlyoke\.(...)`).
- File discovery / parsing: `WorkflowFileDiscovery.ts` (incl. `WORKFLOW_FILE_NAMES`/`WORKFLOW_FILE_SUFFIXES`), `PromptFileParser.ts`, `PromptFileLoader.ts`, `promptPathUtils.ts`, `WorkflowSerializer.ts`, and the `scripts/migrate-prompt-syntax.mjs` glob.
- **All `manual-test/*.flightpath.{yaml,json}` fixtures**, `src/test/fixtures/prompts/*`, `src/templates/workflows/*`, and committed `.ctrlyoke/workflows/*` → `*.ctrlyoke.*` (rename files + every string/regex reference), plus the docs that reference the extension.
- `.prompt.md` files are unaffected (already brand-neutral).
- Note: this means the working-file path reads `.ctrlyoke/.queue/<name>.ctrlyoke.json` (runtime dir + branded extension) — repetitive but unambiguous.

> Keep this a **separate commit/PR** from the brand rename even though it lands in the same files — it's a different decision and easier to review/revert in isolation. Since the extension is now also `ctrlyoke`, this is mechanically the same `flightpath → ctrlyoke` swap, but kept as its own commit for reviewability.

---

## 7. Workstream G — Schemas

- `schemas/prompt-schema.json` / `prompt-schema.yaml` / `settings-schema.json` — update `$id`, `title`, `description` branding and any `flightpath`/`.flightpath` strings.
- `scripts/generate-yaml-schema.mjs` output references.
- Decide whether to rename `prompt-schema.*` → `workflow-schema.*` to match the new extension (docs already call it `workflow-schema.md`). **Recommend yes** for consistency; adds the file rename + `package.json` validation `url` updates.

---

## 8. Workstream J — Logo, icons & images

> **✅ IMPLEMENTED (separate chat, June 29, 2026) — the rename PR should SKIP this section and not touch `images/` or the icon generators.** Standardized on a **single master** `images/ctrlyoke-icon.svg` (no more `-simple`/`-standard` variants; gradients deferred). All assets generate from it via `npm run generate-icons`. Files now: master `ctrlyoke-icon.svg`, generated `ctrlyoke-app-icon.svg` (2-token), `ctrlyoke-sidebar-icon.svg`, `ctrlyoke-icon-{light,dark}.svg`, `icon.png`, `apple-touch-icon.png`. All `flightpath-*` image files deleted; `package.json`/`.vscodeignore`/`vite.config.ts`/`DashboardConstants.ts` (`HOSTED_ICON_FILES`)/`FlightPathHostedServer.ts`/`ServerSection.tsx` icon refs updated; `generate-icons` script reordered (app-icons before custom-icons). Subsections below are retained as the design rationale.

### 8.1 Brand/logo design decisions (locked June 28, 2026)

Three distinct layers — keep them separate:

| Layer | Value | Nature |
| --- | --- | --- |
| **Name (canonical)** — what you type/write | lowercase **`ctrlyoke`** | CLI, npm, domain, prose, `package.json` `displayName` value & panel `title` |
| **Logotype / wordmark** — stylized text logo | all-caps **`CTRLYOKE`** (custom font) *allowed* | design asset (artwork) |
| **Logomark** — the icon | `ctrl` keycap → yoke "Y" | design asset (artwork) |

- The all-caps `CTRLYOKE` logotype is **logo styling only** — it does **not** change the canonical lowercase name or the CLI. (Mirrors a real keyboard: the keycap is stamped **CTRL**, but you type `ctrl` — which is the brand metaphor itself.)
- **Logomark = a `ctrl` keycap whose edges resolve into a yoke "Y".** The Y is formed by **shared edges / negative space** — the keycap's bottom edge *becomes* the yoke stem — **not** by a rendered drop-shadow. This is the deliberate design constraint, because it's the only way the mark survives flattening (see §8.2). The keycap (an uppercase-stamped `CTRL`) reinforces the "control-yoke" pronunciation.
- **One logomark, multiple renders.** Author a single 2-color master; the full-color version layers "extra" (lit-from-top highlight, soft shadow, gradient) on top of the *same geometry*. Monochrome and color must read as the same logo.
- **Wide logotype variant** (full `CTRLYOKE` lockup) for site headers / marketplace banner is a separate asset from the square logomark used in the VS Code tab.

> **VS Code title casing (verified behavior):** VS Code force-uppercases **view/panel titles** via CSS (`text-transform: uppercase`), so the panel tab displays `CTRLYOKE` regardless of the `title` string — which happens to match the all-caps logotype. The **marketplace `displayName`** and **command-palette category** render *as typed*. → set `displayName`/`title`/`category` to lowercase `ctrlyoke`; the caps appear only as logo artwork + VS Code's automatic title-casing.

### 8.2 Rendering matrix — design to these constraints

The mark renders in three materially different ways. The geometry must satisfy the **most constrained** (activity-bar) context:

| Context | Rendering | Implication for the art |
| --- | --- | --- |
| **VS Code activity-bar / panel tab** (`viewsContainers.panel[].icon`) | VS Code uses the icon's **alpha channel as a mask** and fills with a **single theme color**. Transparency/opacity gradients survive *as shades of that one color*; **two distinct colors collapse to one**. | Must read as a **single-color silhouette**. The ctrl→Y relationship must be **structural (edges/negative space)**, not color- or shadow-dependent. Draw the shape on a **transparent** background (no filled square). |
| **Marketplace icon** (top-level `package.json` `icon`, 128px PNG) | Full color, no masking | Home of the rich full-color version with the "extra" (highlight/shadow/gradient). |
| **Server favicon + PWA app icon + settings live-preview** (`ServerSection`) | Full color, **user-recolorable 2-color** | See §8.3 — must preserve the 2-token contract. |

### 8.3 Custom-color (2-token) contract — must not break

The hosted-server favicon / PWA icon / settings live-preview let users recolor the icon (`ServerSection.tsx` → `buildIconPreviewDataUrl`, plus server-side PNG regeneration). The mechanism is a **literal regex swap of exactly two color tokens** in the master SVG:

- `ICON_BG_COLOR_DEFAULT = "#072c45"` (background) and `ICON_FG_COLOR_DEFAULT = "#ffffff"` (foreground) — defined in `src/types/IconColorDefaults.ts` (**generated** by `scripts/generate-app-icons.mjs`).
- The new `ctrlyoke` master app-icon SVG **must use exactly these two color literals** (one bg, one fg) so the swap keeps working. New brand defaults are fine — but change them **via the generator**, not by hand-editing `IconColorDefaults.ts` (it's `@generated`).
- Update the `?raw` import in `ServerSection.tsx:18` (`flightpath-app-icon.svg` → `ctrlyoke-app-icon.svg`).

### 8.4 Asset pipeline (as implemented — single master)

- **One hand-authored source:** `images/ctrlyoke-icon.svg` — transparent background, every shape `currentColor` (so the generators can recolor and VS Code can theme it). Never add a background rect to the master (the sidebar/activity-bar render alpha-masks it).
- **`npm run generate-icons`** runs, in order: `generate-sidebar-icon` (→ `ctrlyoke-sidebar-icon.svg`, currentColor @ 24×24) → `generate-app-icons` (→ `ctrlyoke-app-icon.svg` [2-token], `icon.png` 512, `apple-touch-icon.png` 180, `ctrlyoke-icon-{light,dark}.svg` for the SCM toolbar, copies the master to `src/ui/icons/generate-commit-message.svg`, regenerates `IconColorDefaults.ts`) → `generate-custom-icons` (rebuilds `custom-icons.css` masks, incl. the commit-message icon).
- **Remaining design follow-ups** (not blocking): the optional full-color/gradient marketplace render (§8.1 "extra") and the wide `CTRLYOKE` logotype lockup are deferred — `icon.png` is currently the flat 2-color render.
- **Out of scope here:** the landing/docs *site* favicons (`landing/`, `docs/.vitepress`) have their own asset copies — those belong to the domain/site rebrand ([§11](#11-workstream-m--docs-instructions-and-project-memory)/[§11.5](#115-workstream-n--release-coupled-business-identity-the-real-long-pole)), not this extension-icon work.

### 8.5 Trademark filing (logo vs. wordmark) — *not legal advice; confirm with TM attorney*

- File the **standard-character wordmark "ctrlyoke" first** — broad, font/case/color-agnostic protection; covers the keycap logo's text and any future restyle. This is the one that matters.
- File the **logo as a separate design mark later**, once the art is finalized (logos evolve; word marks are forever — don't pay to protect a draft).
- Two marks = two USPTO applications (separate fees, per class). Likely classes IC 009 (downloadable software) + IC 042 (SaaS) — same classes as the FlightPath clearance.

---

## 9. Developer-local migration

Not user-facing, but every active dev workspace (incl. this repo) has live `.flightpath/` and `~/.flightpath/` dirs. After the code rename they'll be orphaned. Provide a tiny one-shot:

- Workspace: `mv .flightpath .ctrlyoke` (git-tracked content like `templates/`, committed workflows; the gitignored `temp/.queue/logs/.history/.search-index/capabilities.json` can just be regenerated).
- User: `mv ~/.flightpath ~/.ctrlyoke`.
- Update `.gitignore` (`.flightpath/temp/` … → `.ctrlyoke/…`) and any committed `.flightpath/` content in the repo (templates, debug fixtures, `manual-test/.flightpath/`).

No runtime back-compat shim — pre-release.

---

## 10. Workstream L — Repo & CI

- **GitHub repo rename** `FuzzyNova/flightpath` → `FuzzyNova/ctrlyoke` (publisher stays `fuzzynova` — [§12](#12-decisions-resolved--june-28-2026) resolved). GitHub auto-redirects old URLs, but update `package.json` `repository`/`bugs`/`homepage` and any hardcoded URLs in docs/landing.
- `.github/workflows/deploy.yml` and other workflows — branding, paths, deploy target (site domain).
- `.vscode/launch.json` — `.flightpath` paths / debug config names.
- `esbuild.js`, `knip.json`, `.vscodeignore` — renamed script-file globs ([§5](#5-workstream-c--hooknotify-scripts--user-dir-paths)).

---

## 11. Workstream M — Docs, instructions, and project memory

- **`.github/copilot-instructions.md`, `CLAUDE.md`, all `.github/instructions/*.instructions.md`** — branding, the routing table, log-path examples (`.flightpath/logs/`), the `flightpath-<harness>-hook-debug.log` references in `<debugging>`. The `flightpath-*.instructions.md` files (`flightpath-core`, `flightpath-orchestration`, `flightpath-cli-binary`, `flightpath-chat`) carry the brand in their names and map to the renamed `src/core/` dir ([§12](#12-decisions-resolved--june-28-2026) #2) — **rename them to drop the brand** (e.g. `flightpath-core` → `core`) and update the routing-table paths (`src/flightpath/**` → `src/core/**`) in the same pass as the dir rename.
- **`docs/`** (VitePress) — `docs/cli/flightpath.md` + `flightpath-mcp.md` rename, `docs/.vitepress/config.mts` branding/domain, all guide/reference/workflow/troubleshooting prose.
- **`landing/`** — `src/config.ts` (`MARKETPLACE_URL` itemName `fuzzynova.flightpath`), `Layout.astro`, all `pages/*.astro` branding + domain.
- **`README.md`, `QUICK_START.md`, `CHANGELOG.md`, `AGENTS.md`, `CHORES.md`** — branding.
- `dev/backlog/*` and `dev/active/*` plans reference FlightPath throughout — **do not bulk-rewrite history docs**; only fix `dev/active/*` if still actionable. `dev/implemented/` and `dev/research/` are historical record — leave as-is.
- This private memory index notes durable knowledge lives in the instruction files — once renamed, no extra memory action needed.

---

## 11.5 Workstream N — Release-coupled business identity (the real long pole)

> **Reality check.** The *code* rebrand is ~a day with agents. The items below are **not code** — they're external/business-identity changes with real-world lead times and a couple of decisions, and they (not the code) are the actual gate on a **commercial launch under `ctrlyoke`**. Lucky timing: most are "configure under the new name from the start" rather than "migrate," because nothing is published yet (see `RELEASE_CHECKLIST.md`).

**True migrations (have lead time):**
- **Product domain** `flightpath.dev` → **`ctrlyoke.dev`**: add `ctrlyoke.dev` to Google Workspace (domain verification), point DNS → Netlify, set the Netlify site's primary domain, and **301 `flightpath.dev` → `ctrlyoke.dev`** (keep the redirect permanently for old links/SEO). DNS + Workspace verification take hours, not minutes.
- **Product email inboxes**: the customer-facing groups currently on `@flightpath.dev` (`support@`, `billing@`, `security@`, `sales@`, `privacy@`, `licensing@` — `RELEASE_CHECKLIST.md` Phase 0.1) must be recreated on **`@ctrlyoke.dev`**. Keep the `@flightpath.dev` versions as **forwarders during a transition overlap**. Studio inboxes (`admin@`/`hello@fuzzno.com`) are unaffected.
- **Legal docs** `LICENSE.md` + `PRIVACY.md` (attorney-final, rendered live at `/terms` + `/privacy`): hardcode "FlightPath", `flightpath.dev`, and the `privacy@`/`support@`/`licensing@flightpath.dev` addresses. Update product name + addresses; a name/address swap is minor but **flag the change to the attorney** since these are counsel-final.
- **GitHub repo** `FuzzyNova/flightpath` → `FuzzyNova/ctrlyoke` (auto-redirects; [§10](#10-workstream-l--repo--ci)).

**Configure under the new name from the start (no migration — not yet published):**
- **VS Code Marketplace publisher item**: publish as **`fuzzynova.ctrlyoke`** (driven by `package.json` `name`). `MARKETPLACE_URL` in `landing/src/config.ts` follows.
- **Licensing vendors** (`RELEASE_CHECKLIST.md` Phase 3, not started): create the Lemon Squeezy product + Keygen policy under `ctrlyoke` naming directly.

**Decisions:** (a) keep `@flightpath.dev` inboxes as forwarders during overlap — *recommend yes, short overlap*; (b) keep `flightpath.dev` as a permanent redirect — *recommend yes*.

---

## 12. Decisions (resolved — June 28, 2026)

1. **Publisher / org: keep `fuzzynova`.** Fuzzy Nova is the studio (a DBA to Nathan), unaffected by the product rename. `package.json publisher` stays `fuzzynova`; marketplace item becomes **`fuzzynova.ctrlyoke`**; repo → `FuzzyNova/ctrlyoke`.
2. **`src/flightpath/` directory: rename to `src/core/`** (NOT `ctrlyoke`). Naming a subdirectory after the product was always a smell, and keeping `flightpath/` post-rebrand leaves the *abandoned* brand as a top-level source dir (worse than either rename). `core` is accurate — the workflow engine + runtime/harness/orchestration layers, vs. the `ui`/`cli`/`server`/`mcp-server` adapters — brand-neutral, and future-proof against any later rename. **Do it as part of the rebrand**, not a follow-up: imports are already being rewritten, so folding it in is nearly free and avoids shipping a stale dir or paying the churn twice. *(Plus the `FlightPath*`-prefixed file renames in [§4](#4-workstream-b--source-identifiers-classes-types-files).)*
   **Mechanics:** `git mv src/flightpath src/core` → rewrite all `flightpath/` → `core/` import paths → update the `CLAUDE.md` routing table (`src/flightpath/**` → `src/core/**`) and any `tsconfig`/lint/`knip` globs → rename the brand-carrying `flightpath-*.instructions.md` files (e.g. `flightpath-core` → `core`) and the routing-table references in the same pass ([§11](#11-workstream-m--docs-instructions-and-project-memory)).
3. **`prompt-schema.*` → `workflow-schema.*`: yes, rename** for consistency with the `.workflow.*` extension ([§7](#7-workstream-g--schemas)).
4. **Sequencing: two PRs.** PR 1 = brand rename (FlightPath → ctrlyoke, everything except the file extension). PR 2 = workflow file-extension change (`.flightpath.*` → `.ctrlyoke.*`, [§6](#6-workstream-f--workflow-file-extension)). Independent; easier to review/revert separately.

---

## 13. Suggested execution order

1. **Constants first** ([§2](#2-single-sources-of-truth-do-these-first--they-cascade)) — flips most runtime path references via `PATH_CONSTANTS`/`CONFIG_NAMESPACE`.
2. **Directory + source/identifier renames** — `git mv src/flightpath src/core` ([§12](#12-decisions-resolved--june-28-2026) #2) and rewrite imports, then the `FlightPath*` file renames ([§4](#4-workstream-b--source-identifiers-classes-types-files)) via LSP rename. Do these together so imports are rewritten once.
3. **Hook scripts + user-dir paths** ([§5](#5-workstream-c--hooknotify-scripts--user-dir-paths)).
4. **`package.json` manifest** ([§3](#3-workstream-a--packagejson-extension-manifest)) + `setContext` keys in `extension.ts`.
5. **Schemas + icons** ([§7](#7-workstream-g--schemas), [§8](#8-workstream-j--icons--images)).
6. **Tests** — update fixtures/assertions; `npm run typecheck` then `npm test` / `npm run test:ui` / `npm run test:harness`.
7. **Docs / landing / instructions** ([§11](#11-workstream-m--docs-instructions-and-project-memory)).
8. **Repo + CI + domain** ([§10](#10-workstream-l--repo--ci)) — last, coordinated with marketplace.
9. **Extension rename `.ctrlyoke.*`** ([§6](#6-workstream-f--workflow-file-extension)) — separate PR.

**Verification gates:** `npm run typecheck` → `npm run lint` → full test suites → manual smoke (init a workspace, confirm `.ctrlyoke/` is created, run a `.ctrlyoke.yaml`, confirm hooks fire and logs land in `.ctrlyoke/logs/`). Grep `flightpath|FlightPath|FLIGHTPATH` should return only intentional historical references (`dev/implemented/`, `dev/research/`, CHANGELOG history) plus the still-pending `docs/` + `landing/` ([Execution Status](#execution-status--updated-june-30-2026)).
