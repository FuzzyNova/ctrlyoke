# Schema and Persisted-Format Release Readiness

> **Status:** In progress — phases A–D and phase E implementation items 1–2 are complete; only release-cut verification remains. Written 2026-09-26 against current code.
>
> **Problem in one line:** once ctrlyoke ships, every persisted shape — workflow files,
> `settings.json`, run history, the search index — becomes a compatibility contract, and today
> authored files carry no version, there is no migration path, and several shapes are
> inconsistent in ways that are free to fix now and breaking to fix later.
>
> **Origin.** A pre-release audit of `schemas/workflow-schema.json` and
> `schemas/settings-schema.json` (2026-09-26). The audit found three outright bugs, which were
> fixed in the same session and are **not** part of this plan:
>
> - script steps read `timeout` as seconds while every other script surface uses milliseconds
>   (`WorkflowExecutor.ts`, the preview's `timeout=…s` label);
> - `rootScriptStep` rejected `trustedExternalRoots` and `_templateMeta`;
> - run files wrote `definitionRevision`, `lastModifiedAt` and `isFavorite` without the schema
>   declaring them.
>
> **Relationship to neighbours.** `CLI_DISTRIBUTION_PLAN.md` §3.4 built the refuse-to-write
> guard (`PersistedSchemaGuard.ts`) and explicitly deferred migrations ("Pre-1.0 the policy
> stays 'no migrations'"); §1–§2 here are that deferred half. `RUN_EXPORT_PLAN.md` must carry
> the lineage metadata that §7 removes from run files.

---

## 0. The 18 items and their decisions

| #   | Item                                                                   | Decision                                                                                                                                                             | §    | Phase |
| --- | ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----- |
| 1   | Version marker on authored files + migration plan                      | Implementation complete — format v1 guards, empty-chain migration/read hooks, and persisted-store inventory coverage done 2026-09-26; release fixture freeze pending | 1, 2 | E     |
| 2   | Publish schemas at `https://ctrlyoke.dev/schema/v1/…`, allow `$schema` | Done 2026-09-26 (publication pipeline implemented; production release pending)                                                                                       | 3    | E     |
| 3   | All durations in seconds, with a `Sec` suffix                          | Done 2026-09-26                                                                                                                                                      | 4    | B     |
| 4   | Strict prompt steps / workflow root                                    | Done 2026-09-26                                                                                                                                                      | 5    | D     |
| 5   | Top-level `statusLine` keyed by harness ID; new `diagnostics` group    | Done 2026-09-26                                                                                                                                                      | 6    | B     |
| 6   | Single-source lineage metadata in `workflow.json`                      | Done 2026-09-26                                                                                                                                                      | 7    | C     |
| 7   | Constrain `vars` key names                                             | Done 2026-09-26                                                                                                                                                      | 8.1  | A     |
| 8   | `mcpServerConfig`: exactly one of `command`/`url`                      | Done 2026-09-26                                                                                                                                                      | 8.2  | A     |
| 9   | Integer/range tightening (+ timeout-`0` unification)                   | Done 2026-09-26                                                                                                                                                      | 8.3  | A     |
| 10  | `workflowKey` rejects `.`/`..`                                         | Done 2026-09-26                                                                                                                                                      | 8.4  | A     |
| 11  | Script-step `executionMode` description                                | Done 2026-09-26                                                                                                                                                      | 9    | A     |
| 12  | `endCondition.maxRetries` default description                          | Done 2026-09-26                                                                                                                                                      | 9    | A     |
| 13  | `passRetryPrompt` description                                          | Done 2026-09-26                                                                                                                                                      | 9    | A     |
| 14  | `defaults.priorContext` description / disallow run address             | Done 2026-09-26                                                                                                                                                      | 9    | A     |
| 15  | Delete dead root `_runtime.harness` rule                               | Done 2026-09-26                                                                                                                                                      | 10.1 | A     |
| 16  | Single-source harness-keyed lists                                      | Done 2026-09-26                                                                                                                                                      | 10.2 | A     |
| 17  | Consistent `default` keyword                                           | Done 2026-09-26                                                                                                                                                      | 10.3 | A     |
| 18  | Stale `responseText` claim in `copilot-instructions.md`                | Done 2026-09-26                                                                                                                                                      | 11   | A     |

Phases are ordered in §12. The governing idea: **finish every shape change (A–D) first, then
stamp and freeze `v1` (E)**, so the baseline that ships is the final one and no migration is
ever written for a pre-release rename.

Item 4's schema dialect, `$defs` migration touchpoints, closures, lenient loader, and warning
surfacing in the extension, VS Code/hosted dashboards, and MCP `workflow_status` were
completed 2026-09-26. Authored workflow and settings `schemaVersion` fields and the root
`$schema` key landed in phase E.

---

## 1. Format versions everywhere (item 1, first half)

### 1.1 Inventory of what is persisted today

| Store                                  | Location                                           | Version marker today                                                       | Guarded?                                                                                                |
| -------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Authored workflow file                 | user's repo (`*.ctrlyoke.yaml/json`, `.prompt.md`) | optional root `schemaVersion` = 1; absent means 1                          | yes (`WORKFLOW_DEFINITION`; newer files refused at load)                                                |
| `settings.json` (user + workspace)     | `~/.ctrlyoke/`, `.ctrlyoke/`                       | optional root `schemaVersion` = 1; absent means 1                          | yes (`SETTINGS`; newer files read best-effort and cannot be written)                                    |
| Run working file                       | `.runs/<key>/run-*/workflow.ctrlyoke.json`         | `_runtime.schemaVersion` = 1                                               | yes (`RUN_FILE`)                                                                                        |
| Lineage descriptor                     | `.runs/<key>/workflow.json`                        | `schemaVersion` = 1                                                        | yes                                                                                                     |
| Runner lock                            | `.runs/<key>/runner.json`                          | `schemaVersion` = 2                                                        | yes                                                                                                     |
| Timeline manifest + `events.jsonl`     | `run-*/manifest.json`, `run-*/events.jsonl`        | manifest `schemaVersion` = **1 (integer)**; events have no separate marker | yes (`TIMELINE`, manifest guards run mutations)                                                         |
| History search index                   | `.search-index/v<ver>/`                            | `INDEX_SCHEMA_VERSION` = **1 (integer)**, per directory and index manifest | derived; rebuild on mismatch                                                                            |
| Trust stores, coordination, usage (×3) | `~/.ctrlyoke/…`, project state                     | `schemaVersion` = 1                                                        | yes                                                                                                     |
| Project metadata                       | `ProjectStateRegistry`                             | `schemaVersion` = 1                                                        | yes (`PROJECT_METADATA`)                                                                                |
| Managed/named worktree records         | `WorktreeManager`                                  | each record has `schemaVersion` = 1                                        | yes (`MANAGED_WORKTREE_RECORD`, `NAMED_WORKTREE_SETUP`; newer records remain visible and are read-only) |
| `installations.json`                   | `~/.ctrlyoke/`                                     | file `schemaVersion` = 1; host `indexSchemaVersion` is an integer          | yes (`INSTALLATIONS`; newer files are read for display but never rewritten)                             |
| Statusline launcher / snapshot         | `~/.ctrlyoke/bin/`, sidecar                        | manifest version / `STATUSLINE_SNAPSHOT_PROTOCOL_VERSION` 1                | own protocol                                                                                            |
| CLI `--json` outputs                   | stdout                                             | per-command `*_JSON_SCHEMA_VERSION` = 1                                    | public API — separate policy (see §2.10)                                                                |

`WorkflowOutputHistory` (`OutputHistoryTypes.ts`) is a projection built from the timeline and
sent to the webview; it is never persisted. It has no persisted format version and carries no
`schemaVersion` field.

### 1.2 Decisions

- **One field name, one type:** `schemaVersion`, a positive integer, everywhere. That is what
  `PersistedSchemaGuard.readSchemaVersion` already reads. Convert the two semver strings
  (timeline manifest, search index) to integers. A pre-release reader that finds a string
  treats it as the baseline.
- **Do not reset existing integers to 1.** `runner.json` stays at 2. Resetting would make
  dev-era files look _newer_ than the release build and get them refused (a lock refused as
  held never clears).
- **Authored workflow files:** optional root `schemaVersion: 1`. **Absent means 1** — the
  release baseline — so hand-written files never need it. ctrlyoke's own writers
  (`WorkflowSerializer`, template instantiation, `init`) always stamp it.
- **`settings.json`:** optional root `schemaVersion: 1`, same absent-means-1 rule, stamped by
  `FileConfigBackend` on write.
- Built-in workflow templates carry `schemaVersion: 1`; parser-normalized template
  instantiations and `WorkflowSerializer` exports carry the same version. The workspace `init`
  flow currently creates only `.ctrlyoke/.gitignore` and does not author a workflow or settings
  file; a future init path that creates either file must use these version-stamping writers.
- **Run files carry two numbers with two meanings.** A run file is also a workflow definition,
  so it has root `schemaVersion` (the _definition_ format, same as an authored file) and
  `_runtime.schemaVersion` (the _run-file_ format: runtime blocks, root bookkeeping).
  Document this in the schema descriptions; they are bumped independently.
- **New guarded stores:** `WORKFLOW_DEFINITION`, `SETTINGS`, `TIMELINE` and
  `PROJECT_METADATA` are in `PERSISTED_STORES` at version 1. `TIMELINE` and
  `PROJECT_METADATA` were added with the engine-owned version unification; authored workflow
  and settings now use the first two stores. `ProjectStateRegistry` uses the shared guard.
- **Inventory audit follow-up (done 2026-09-26):** managed worktree records, named worktree
  setup records and `installations.json` are registered stores with integer versions, empty
  migration chains, provisional fixtures and guarded readers/writers. A newer worktree record
  remains visible as managed ownership, is excluded from cleanup/reconciliation, and is never
  overwritten. A newer named setup record remains available for display and blocks setup
  rewriting. A newer installations file remains readable for mismatch display; recording an
  installation or notice skips the write and logs once per path. Installation recording stays
  best-effort and never throws into extension activation or CLI startup.
- **Newer-than-supported behaviour:**
  - a **workflow file** newer than the host is **refused at load with a clean error**
    (decided 2026-09-26; see §1.3). Running it could misinterpret fields, and read-only
    display is not worth a separate code path;
  - **settings** newer than the host are read best-effort with a one-time warning, and the
    settings UI refuses to write them (today an older host silently ignores unknown keys —
    `CLI_DISTRIBUTION_PLAN.md` §3.4's "Low–medium: confusing" row);
  - **managed worktree records** newer than the host remain visible as owned, read-only
    records; they are not reconciled away or cleaned up. **Named worktree setup records** are
    read best-effort but block setup-record rewrites;
  - **`installations.json`** newer than the host is read for display with a one-time warning;
    `recordInstallation` and `markNoticeShown` skip writes without throwing;
  - everything else keeps the existing guard semantics (read, display, never write).

### 1.3 The refusal for a newer workflow file

"Clean" means the user sees one sentence that says what to do — never an Ajv dump and never
the generic parse-failure wrapper.

- **Check the version before validation.** `PromptFileParser.validateAndNormalize` reads
  `schemaVersion` first (from the YAML/JSON root, or the frontmatter of a `.prompt.md`). If
  it is newer than supported, it calls `refuseNewerSchema(WORKFLOW_DEFINITION, …)` before
  Ajv runs. A newer file may legitimately fail today's schema, so validating first would bury
  the real reason under schema errors.
- **Message** (a single `NewerSchemaError` text, reused by every surface): "`deploy.ctrlyoke.yaml`
  uses workflow format 2, which needs a newer ctrlyoke — this version (1.4.0) supports format 1.
  Update ctrlyoke to open it." Include the host's own version, so a support thread can tell
  hosts apart.
- **VS Code / dashboard:** `parsePromptFile`'s catch currently wraps everything as
  `Failed to parse <file>: <error>`. It must special-case `isNewerSchemaError` and show the
  message alone, as an error notification with an **Update** action (open the extension in
  the Extensions view). A workflow that is already listed (recent workflows, file tree)
  shows the same text when opened, instead of silently doing nothing.
- **CLI:** the message goes to stderr, with exit code `2`. Add `WORKFLOW_DEFINITION` to the
  stores `CliSchemaRefusal.ts` treats as run-blocking. `ctrlyoke validate --json` reports it
  as a distinct error code (`workflow-newer-format`) rather than a validation failure.
- **MCP server:** `append_step` and anything else that loads a definition returns the same
  message as a tool error.
- **Run files:** the root (definition) `schemaVersion` gets the same refusal. The separate
  `_runtime.schemaVersion` keeps the existing read-only rule. In practice a run written by a
  newer ctrlyoke will usually carry both, so an older extension can list it in history (the
  list is built from `workflow.json`) but refuses to open it, with the same message.

---

## 2. Migration framework (item 1, second half)

Nothing needs migrating yet. This section is the design the first breaking change after
release will plug into, plus the few pieces worth building **before** release because they
can only be captured then (§2.8's fixture freeze).

### 2.1 Principles

1. **Migrations are code, not schema transforms.** Each is a pure function on untyped JSON,
   `vN → vN+1`, applied stepwise. No function ever skips a version.
2. **Migrate on read, in memory.** Readers always see current-shape data. Ajv validation and
   typed normalization run only _after_ migration, against the current schema only.
3. **Never downgrade.** An older host facing newer data uses the guard (§1.2).
4. **Who writes back depends on who owns the file** (§2.4). ctrlyoke never silently rewrites
   a file the user authored.
5. **Derived data is never migrated** — a version mismatch means rebuild.

### 2.2 Module shape

A new `src/utils/FormatMigrations.ts` beside `PersistedSchemaGuard.ts`. It is Node-only and
`vscode`-free, because the extension, CLI, MCP server **and the statusline launcher** all need
it:

```ts
interface FormatMigration {
  store: PersistedStore;
  from: number; // to === from + 1, implied
  describe: string; // one line, shown in `ctrlyoke migrate` output and backups' log
  migrate(doc: unknown): unknown; // pure; throws MigrationError on unrecoverable input
}

/** Ordered per store; validated at module load and by a unit test. */
const MIGRATIONS: Record<PersistedStore, readonly FormatMigration[]>;

function migrateToCurrent(
  store: PersistedStore,
  doc: unknown
): { doc: unknown; fromVersion: number; applied: string[] };
```

`BASELINE_SCHEMA_VERSIONS` records each store's version at release. The invariant
`CURRENT − BASELINE === MIGRATIONS[store].length` is asserted by a test, so bumping
`CURRENT_SCHEMA_VERSIONS` without adding the migration fails CI.

### 2.3 The read pipeline

```
parse → readSchemaVersion (absent → baseline)
      → newer than current?  → guard (§1.2)
      → older than current?  → migrateToCurrent
      → Ajv (current schema, where the store has one)
      → typed normalization (PromptFileParser, WorkflowStepSanitizer, …)
```

Hook points: `PromptFileParser.validateAndNormalize` (before Ajv) for workflow definitions and
run files; `FileConfigBackend.read` for settings; each store's existing reader for the rest.

### 2.4 Write-back policy by ownership class

| Class                  | Stores                                                                                          | Policy                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Engine-owned documents | run working files, `workflow.json`, `runner.json`, trust, coordination, usage, project metadata | Migrate on read; the next ordinary write persists the current shape (writers already stamp). Before the **first** write that changes a file's version, keep one `<file>.v<N>.bak`.                                                                                                                                                                    |
| Append-only logs       | `events.jsonl` (+ its manifest)                                                                 | Never rewrite for **reading**: the timeline reader uses per-version event _upcasters_ that decode old event shapes into current types. Before **appending** to an older-format run (continue/append/rewind), migrate the whole run directory via stage-and-rename, reusing `promoteToNewRun`'s staging pattern, so one run never mixes event formats. |
| Derived data           | search index, statusline snapshots, caches                                                      | Never migrate; mismatch → rebuild (the search index already works this way).                                                                                                                                                                                                                                                                          |
| User-authored          | workflow files in the repo, `settings.json`                                                     | Never rewritten on load; migrated in memory every time (cheap). Persisted only on an explicit user action — see below.                                                                                                                                                                                                                                |

**User-authored files are the delicate case, because they are shared.** A committed workflow
file is read by teammates who may run an older ctrlyoke. Upgrading it on their behalf breaks
them. So:

- **Dashboard save** writes the current version. When that _raises_ the file's version, show a
  one-time notice: "Saving upgrades this file to format N; ctrlyoke older than X can't open
  it." `installations.json` lets the notice name older ctrlyoke installs on _this_ machine.
- **`ctrlyoke migrate [paths…]`**: `--check` exits non-zero when any file is below current
  (for CI and pre-commit); `--write` upgrades with backups and prints a diff. Ship it with the
  first real migration, not before.
- **Settings UI writes the whole file,** so the first settings write after an upgrade persists
  the migrated shape. It gets the same one-time notice, because `~/.ctrlyoke/settings.json` is
  shared by the extension and the npm CLI.

### 2.5 The statusline launcher is a settings reader outside version pinning

`src/scripts/ctrlyoke-statusline-wrapper.js` reads `settings.json` **raw**
(`settings.permissions.statusLineTracking`) and is installed into `~/.ctrlyoke/bin/`
newest-wins (`StatuslineLauncher.ts`). The launcher can therefore be **newer or older** than
the host that last wrote settings. Any settings migration must:

- ship `FormatMigrations` in the launcher's file set, so the wrapper calls
  `migrateToCurrent("settings", raw)` instead of reading paths directly;
- keep the wrapper tolerant of a _newer_ settings file: fall back to "no ctrlyoke statusline"
  rather than throwing inside the user's harness.

§6 changes this very path pre-release. That is exactly the rename that would need a migration
after release, and it is the worked example to reuse when writing the first real one.

The migration must move the object to the root, rename its four provider keys to harness IDs
under `byHarness`, and preserve the existing script filenames in harness configuration.

### 2.6 Published schemas per version

- `https://ctrlyoke.dev/schema/v1/workflow.json` and `…/v1/settings.json` hold the **latest
  schema compatible with format 1**. They may change **additively** after release (§2.7).
- A breaking change publishes `/schema/v2/` and bumps `schemaVersion` to 2. **`/v1/` is never
  deleted or edited again,** so old files' `$schema` links keep resolving.
- The repo keeps `schemas/` as current and freezes each superseded version under
  `schemas/archive/v<N>/` at the moment of the bump. The site publishes from both; §2.8's
  fixtures reference the archive copies.

### 2.7 What bumps the version

| Change                                                                   | Bump? | Why                                                                                                  |
| ------------------------------------------------------------------------ | ----- | ---------------------------------------------------------------------------------------------------- |
| Rename or remove a field                                                 | yes   | old files need rewriting                                                                             |
| Change a field's meaning, unit, or the behaviour of its omitted default  | yes   | an older host would silently do the wrong thing                                                      |
| Narrow a type or remove an enum value                                    | yes   | old files become invalid                                                                             |
| Add a field an older host **must not ignore** (security, safety, limits) | yes   | ignoring it is unsafe, so older hosts must refuse the file                                           |
| Add an optional field an older host may safely ignore                    | no    | older hosts load it with an "unknown field" warning (§5)                                             |
| Add an enum value                                                        | no\*  | \*an older host rejects the file with a clear error; bump instead if silent misbehaviour is possible |

"Unknown keys are warnings" (§5) and "bump when ignoring is unsafe" are one policy. The
warning covers forward compatibility for harmless additions; the bump is the hard stop for
the rest. The alternative — bump on _every_ addition — was rejected: it churns versions and
backups for changes that transform nothing.

### 2.8 Test infrastructure — build before release

- **Fixture corpus, frozen at release:** `src/test/fixtures/formats/<store>/v<N>/*.json`, with
  representative documents per store, including every optional field and both run-file version
  numbers. The current corpus is provisional and reflects current writer shapes because there is
  no release build yet. Before release, re-capture or confirm every fixture from the actual
  release build, including every optional field and both run-file version numbers; then freeze it.
- **Load test:** every fixture goes through the real reader → migrate → validate against the
  current schema → write → read back unchanged.
- **Chain test:** the §2.2 invariant, per store.
- **Golden test per migration:** the input fixture plus expected output, so a migration's
  behaviour is reviewed as data.

### 2.9 Downgrade

Unsupported. Backups (`.v<N>.bak`) are the manual escape hatch; `ctrlyoke migrate --write`
prints where they went.

### 2.10 Out of scope

CLI `--json` output schemas are a public _API_ contract, not persisted state. Keep their
existing per-command integers and document an additive-only policy for them in the CLI docs.

---

## 3. Published schemas and `$schema` (item 2)

- Add `"$id": "https://ctrlyoke.dev/schema/v1/workflow.json"` and
  `"$id": "https://ctrlyoke.dev/schema/v1/settings.json"`.
- Settings' cross-file refs (`"workflow-schema.json#/definitions/…"`) become
  `"workflow.json#/$defs/…"` (§5.3 moves both schemas to draft 2020-12), resolved relative to
  the `$id`. Anything that compiles the
  settings schema with Ajv must `addSchema(workflowSchema)` first — it is keyed by `$id`, so no
  network access is needed.
- **Verify editors stay offline.** A relative `$ref` resolves against the schema's `$id`, so an
  editor that honours `$id` over the file URI it loaded the schema from would try to fetch
  `https://ctrlyoke.dev/schema/v1/workflow.json` — which does not exist until the site
  publishes it, and breaks offline editing. Before shipping the `$id`s, confirm with
  `vscode-json-languageservice` and `yaml-language-server` that the settings schema, loaded
  through the local `jsonValidation` association, resolves `workflow.json#/$defs/…` to the
  bundled `out/schemas/workflow-schema.json`. If it does not, rename the bundled copy so its
  file name matches the `$id`'s last segment, or keep the file-relative
  `workflow-schema.json#/$defs/…` spelling and register that key with Ajv as well.
- **Verification result (2026-09-26):** `vscode-json-languageservice` 5.7.2 and
  `yaml-language-server` 1.24.0 were installed only under `.ctrlyoke/temp/`. With
  the settings schema loaded through its local association and refs spelled
  `workflow.json#/$defs/…`, both services requested the settings schema and its ref from
  `out/schemas/` only; the test request log contained no HTTP(S) request. Each service
  reported the deliberately invalid harness enum, confirming that the cross-file definition
  was applied. Their file-relative resolver expects `out/schemas/workflow.json`, so the build
  generates that local alias from `workflow-schema.json`; the source schema's `$id` remains
  the exact published `/schema/v1/workflow.json` URL. Ajv 8's 2020 implementation also
  compiled settings with `workflow-schema.json` registered under that `$id` and rejected the
  invalid harness. The scratch installation did not modify project dependencies.
- **Allow a root `$schema` key** (`type: string`, `format: uri`) on every root form: the
  multi-step root, the single-step prompt root, `rootScriptStep` and the settings root.
  Today settings rejects it, and so does a single-step script file (confirmed with Ajv).
- **Writers emit it:** new JSON workflow files and `settings.json` created by `init` include
  `$schema`. New YAML files get the `# yaml-language-server: $schema=…` modeline, not a
  `$schema:` key. `yaml-language-server` 1.24.0 also accepts an inline `$schema` key
  (changelog, verified 2026-09-26), and the schema will allow the key, but older Red Hat YAML
  extensions only honour the modeline.
- **Keep the local `jsonValidation`/`yamlValidation`** associations in `package.json`
  (`./out/schemas/…`), so editing works offline and against unreleased dev schemas.
- **Deploy:** copy `schemas/*.json` (and `schemas/archive/**`) into the landing build output
  at `/schema/v<N>/` (extend `scripts/merge-docs-into-landing.mjs` or add a sibling script).
  Add `schemas/**` to the `deploy.yml` path filter. Serve with
  `Content-Type: application/schema+json` and `Access-Control-Allow-Origin: *` via Netlify
  `_headers` — browser-based editors fetch schemas cross-origin.
- `$schema` is a tooling hint, **not** the version marker: YAML files often have no
  `$schema`, so `schemaVersion` (§1) stays authoritative.

---

## 4. Durations: seconds everywhere, with a `Sec` suffix (item 3)

**Decision (2026-09-26): every user-authored duration is in seconds, and its name says so.**
The script `timeout` bug happened because two surfaces sharing one field disagreed on the
unit, and the unit lived only in prose. One unit removes the disagreement; the suffix makes
the unit visible wherever the value appears (YAML, JSON, the dashboard, diffs).

Why seconds rather than milliseconds:

- Nothing ctrlyoke times needs millisecond precision: scripts, prompts, hooks and retry
  delays run for seconds to hours. In milliseconds a 10-minute condition is `600000`, where
  a dropped zero is an easy 10× error.
- Seconds is already the majority (`scriptTimeout`, `maxPromptTimeout`,
  `maxWorkflowExecutionTime`, `hooks[].timeoutSec`, the CLI's `--script-timeout <seconds>`),
  and harness hook formats such as Claude's are in seconds too, so ctrlyoke's values pass
  straight through.

| Today                                                    | Unit today | Rename to                           |
| -------------------------------------------------------- | ---------- | ----------------------------------- |
| `timeout` (endCondition, preCondition, scriptStep, root) | **ms**     | `timeoutSec`                        |
| `errorBehavior.retryDelayMs`                             | **ms**     | `errorBehavior.retryDelaySec`       |
| `execution.scriptTimeout`                                | s          | `execution.scriptTimeoutSec`        |
| `execution.maxPromptTimeout`                             | s          | `execution.maxPromptTimeoutSec`     |
| `queue.maxWorkflowExecutionTime`                         | s          | `queue.maxWorkflowExecutionTimeSec` |
| `hooks[].timeoutSec`                                     | s          | unchanged                           |

Rules:

- **Fractional seconds are allowed** (`type: number`, `exclusiveMinimum: 0`) for
  `timeoutSec` and `retryDelaySec`, so a sub-second delay stays expressible
  (`retryDelaySec: 0.5`). `hooks[].timeoutSec` stays an integer, because it is passed through
  to harness hook configs. The `-1` "unlimited" settings stay integers (§8.3).
- **Milliseconds stay internal.** Node timers and `Date.now()` are ms, so convert once where
  values are read. Use one shared helper (e.g. `secondsToMs()` beside
  `ConfigurationUtils.getScriptTimeoutMs`), never an inline `* 1000` at each call site. That
  per-site conversion is exactly where the original bug lived.
- **This reverses the 2026-09-26 bug fix's unit, on purpose.** That fix made script steps read
  `timeout` as ms, to match conditions and the schema at the time. The rename moves every
  surface to seconds together. The `WorkflowExecutor` script-step path and both condition
  paths go through the same helper, and the execution preview shows `timeout=…s` again.
- **Other unit-bearing names** (`replayBufferKb`, `historySearchCacheMb`, `maxEntryAgeDays`,
  `cliParticipantTtlMinutes`, `maxBoardBytes`) already carry their unit and are not durations
  a user tunes in the same breath; leave them. CLI flags (`--timeout`,
  `--script-timeout <seconds>`) are CLI API; keep their names and state the unit in `--help`.

Touchpoints for `timeout` → `timeoutSec` and `retryDelayMs` → `retryDelaySec`:

- **Types and parsing:** `ScriptProperties.timeout` and `ErrorBehavior.retryDelayMs`
  (`CtrlYokeTypes.ts`), `WorkflowStepSanitizer.ts` (4 sites), `PromptFileParser.ts:270`.
- **Execution:** `WorkflowExecutor.ts` (script step + two condition sites),
  `EndConditionEvaluator.ts:282`, `ExecutionPreviewService.ts` (timeout label and the
  `retryDelayMs` description), and the `errorBehavior` retry path.
- **Dashboard:** `ScriptConditionEditor.tsx` (label becomes "Timeout (s)"), `editorStore.ts`
  (`scriptTimeout` state), `PromptEditor.tsx`, `utils/executionPreview.ts`, and the
  errorBehavior editor.
- **Everything else:** `PromptPropertyCompletionProvider.ts`, `END_CONDITION_PROPERTIES.TIMEOUT`,
  schema UI metadata, `docs/workflows/end-conditions.md` (example `timeout: 60000` becomes
  `timeoutSec: 60`), and the generated reference pages.
- **Tests:** `interactiveScriptStep.test.ts` (asserts the ms value handed to the PTY
  spawner), and any condition or errorBehavior test with a literal ms value.

Pre-release, so this is a straight rename: no tombstone and no migration. Grep the repo's own
`.ctrlyoke/` workflows and `src/templates/` for the old keys, and convert their values
(÷ 1000) while renaming.

---

## 5. Strict prompt steps, with unknown keys as warnings (item 4)

### 5.1 The tension

Prompt steps and the multi-step root accept any key, so `endConditon:` or a stray `script:`
passes silently. Script steps and conditions are strict. But core instructions
(`parsingAndValidation`) establish that **an Ajv failure makes a workflow unopenable**, and
reserve schema rules for genuinely unrunnable states. An unknown key is runnable — it's
ignored.

### 5.2 Design: strict schema, lenient loader

1. **The closing keyword states the policy.** `unevaluatedProperties: false` means "unknown
   keys are a _warning_". `additionalProperties: false` and `not: { required: […] }` remain
   **hard** rules, reserved for shapes where a wrong key changes meaning. Examples: the
   `worktreeConfig` object forms, where `oneOf` relies on closure to reject a named worktree
   with `merge`; and `worktree`/`trustedExternalRoots` on a step, which a user would expect
   to take effect.
2. **Editors** squiggle every unknown key either way.
3. **`PromptFileParser`** validates strictly. On failure it validates again against a
   **relaxed** schema (the same schema with every `unevaluatedProperties: false` removed,
   derived once at load). If the relaxed schema also fails, it is a real error, as today. If
   it passes, the only problems are unknown keys, and the loader extracts them with the §5.4
   algorithm. It then loads the file and attaches one warning per key: the path, the nearest
   valid key by edit distance ("did you mean `endCondition`?"), and "or a field from a newer
   ctrlyoke".
4. The VS Code and hosted dashboards show these as `FieldDiagnostic`-style warnings.
   MCP `workflow_status` includes warnings from the authored source in its result.
   `ctrlyoke validate` prints them, and `--strict` turns them into errors for CI.
5. §2.7 supplies the other half: anything an older host must not ignore bumps
   `schemaVersion`, so leniency only ever ignores genuinely optional fields.

### 5.3 Mechanics: move both schemas to draft 2020-12 — verified

Draft-07 `additionalProperties` inside an `allOf` branch can't see sibling branches'
properties, so `promptStep = allOf[executionProperties, own]` can't be closed without
hand-maintained allowlists. Draft 2020-12's `unevaluatedProperties` sees the whole
composition. **This was verified empirically on 2026-09-26, not taken from documentation.**
The real `workflow-schema.json` was converted to 2020-12, closures were placed as described
below, and it was run against Ajv and both editor language servers:

| Validator                             | Version tested          | Result                                                                                                                                                                                       |
| ------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ajv (`ajv/dist/2020`)                 | 8.20.0 (the repo's own) | Correct on every case; compiles in strict mode once each closure carries `type: "object"` (`strictTypes` warnings otherwise).                                                                |
| `yaml-language-server` (Red Hat YAML) | 1.24.0 (installed here) | Correct: every typo flagged at its exact key; no false positives.                                                                                                                            |
| `vscode-json-languageservice`         | 5.7.2 and 6.0.0-next.3  | Correct, same results. VS Code's bundled JSON support is on the 5.x line.                                                                                                                    |
| `yaml-language-server`                | 1.19.0 (pre-support)    | **Degrades safely:** no false errors, ordinary type errors still reported; only typo detection is lost. Support landed in **1.20.0** (changelog: "Support JSON Schema 2019-09 and 2020-12"). |

The cases covered:

- **Valid** (must stay clean): a multi-step workflow with a script step, parallel group,
  `finalStep` and conditions; a single-step prompt with `worktree`/`vars`/`trustedExternalRoots`;
  a single-step script with `_templateMeta`; a template with `{harness}` placeholders; a run
  file with root bookkeeping and step `_runtime`; and all six bundled templates under
  `src/templates/workflows/`.
- **Invalid** (must be flagged at the right key): typos on a step, the root, a single-step
  root, a single-step script, `finalStep`, a parallel member, and step `_runtime`; a stray
  `script:` on a prompt step; `endConditon`; and `worktree` on a step (hard rule, still an
  error).

**Decision: take this route** instead of the draft-07 allowlists considered before
verification. It needs no per-form property lists, the `not` rules stay where they are
wanted, and the one tooling gap (Red Hat YAML older than 1.20) fails safe.

**Where closures go.** `unevaluatedProperties` only sees annotations from the subschema it
sits in, so it must go at the **outermost** composition point of each shape, never on a
component that is itself composed further. Closing `promptStep` directly would reject
`worktree` on a single-step root, because `workflowOnlyProperties` is a sibling of
`promptStep` there.

| Shape                                    | Close at                                                                           |
| ---------------------------------------- | ---------------------------------------------------------------------------------- |
| Single-step prompt root                  | `singleStepRoot.oneOf[0]` (the `allOf[promptStep, workflowOnlyProperties]` branch) |
| Single-step script root                  | `rootScriptStep` (switch its `additionalProperties` to `unevaluatedProperties`)    |
| Multi-step root / run file               | the root `oneOf[1]` branch                                                         |
| Every step, `finalStep`, parallel member | `workflowStep`                                                                     |
| Parallel group options                   | `parallelGroupItem`                                                                |
| Step `_runtime`                          | `promptRuntimeMetadata`                                                            |
| Conditions                               | `endCondition`, `preCondition` (switch from `additionalProperties`)                |

Every root branch must also declare `_templateMeta` and the multi-step branch every current
run-file root field (after §7's removals). Do not add `$schema` or `schemaVersion` as root
properties yet; phase E adds them with the version-marker work. The root-level `allOf`
`if`/`then` rule for template placeholders lives outside the `oneOf` branches, so it neither
helps nor hurts the closures.

**Migration touchpoints:**

- **Both schemas:** `$schema` → `https://json-schema.org/draft/2020-12/schema`, and
  `definitions` → `$defs` along with every `#/definitions/` pointer. The settings schema must
  move too: a draft-07 settings schema that `$ref`s into a 2020-12 workflow schema **fails to
  compile** in `Ajv2020` without an extra meta-schema (verified).
- **Ajv entry point:** switch to `ajv/dist/2020` in `PromptFileParser.ts`,
  `WorkflowSchema.test.ts`, `schemaUiPropertyRoundTrip.integration.test.ts` and
  `NotificationSettings.test.ts`.
- **Scripts that walk the schema** by pointer or `definitions`: `generate-schema-docs.mjs`
  (57 `definitions` references plus `WORKFLOW_ROOT_PROPERTIES`), its test, `sync-models.mjs`
  (writes `model.examples` via `schema.definitions.executionProperties`),
  `generate-yaml-schema.mjs`, and `generate-schema-ui-descriptions.mjs`.
- **Tests that read `schema.definitions`:** `WorkflowSerializer.test.ts`,
  `TemplateManager.test.ts`, `WorkflowDefaultsSchemaCoverage.test.ts`,
  `WorktreeResolution.test.ts`, and the round-trip integration test.
- **`src/utils/ValidationUtils.ts`:** delete it. It is used only by tests
  (`validationUtils.test.ts`, `ctrlyoke.test.ts`), and it carries a second, hand-written
  prompt-step schema that has already drifted from the real one (a closed `model` enum from
  `ALL_MODEL_IDS`, checks for the old `prompts` field). It would otherwise need its own
  draft-07 → 2020-12 port.
- **Minimum editor tooling:** document that typo squiggles in YAML need Red Hat YAML ≥ 1.20;
  there is no need to force-upgrade anyone.

### 5.4 Extracting the unknown keys — verified

Ajv's `unevaluatedProperties` errors can't be read off directly. When a `oneOf` alternative
fails, its annotations are dropped, so real keys get reported as "unevaluated" too: `steps`
from the single-step root branch, `parallel` from the `workflowStep` alternative of a parallel
group, and `prompt`/`_runtime` when a step's `_runtime` holds a typo. Validating against only
the matching root branch still leaves the nested cases. The algorithm that proved exact on
all fifteen probe documents (including three typos at different depths, and the parallel-group
option typo `failfast`):

```
if !relaxed(doc): real error — stop
unknown = []
while !strict(doc):
    candidates = distinct unevaluatedProperties error paths, deepest first
    pick = first candidate whose deletion (on a clone) keeps relaxed(doc) true
    if none: treat as a real error (defensive; never hit in probing)
    unknown.push(pick); delete pick from doc
```

The "keeps relaxed valid" test is what separates a genuine unknown key, which can always be
removed, from a spurious report of a real key like `parallel`, whose removal breaks the
document. The loop runs at most once per unknown key, only on files that already failed
strict validation, so the cost is negligible. Ajv must use `allErrors: true` for the strict
pass. The warnings refer to the original document; the pruned clone is only scratch space.

Two error-quality notes carry over from today rather than being introduced by this change:
a hard error inside `oneOf` still surfaces as "must have required property 'prompt'", and a
named worktree with `merge` as "worktree must be boolean". Picking the most relevant error
from a `oneOf` failure is a separate follow-up and was left out of this item.

---

## 6. Settings layout (item 5)

### 6.1 `statusLine`

```jsonc
"statusLine": {                       // was permissions.statusLineTracking
  "useDifferentFormatPerHarness": false,
  "sharedFormat": [ … ],
  "byHarness": {                      // was claude / antigravity / copilot / qwen
    "claude-cli":      { "enabled": true, "customCommand": "", "useCtrlyokeStyle": true, "format": [ … ] },
    "copilot-cli":     { … },
    "qwen-cli":        { … },
    "antigravity-cli": { … }
  }
}
```

- **Naming:** it isn't a permission, and it isn't "tracking". `byHarness` matches
  `ui.harnessColors.byHarness`.
- **Keys:** replace `STATUS_LINE_TRACKING_PROVIDERS` (`DashboardConstants.ts:157`, 17 files)
  with a `HarnessId` subset constant, e.g. `STATUS_LINE_HARNESS_IDS`. Source it from the
  harness capability table if one records statusline support. Keep the per-provider script
  file names (`ctrlyoke-claude-statusline.js`, …) — harness-config recognition depends on
  them — and map harness ID → script name in one place.
- **Scope:** `WORKSPACE_FORBIDDEN_SETTING_ROOTS` (`CtrlYokeConfigService.ts:27`) swaps
  `PERMISSIONS_STATUS_LINE_TRACKING` for the new root.
- **Wrapper:** `ctrlyoke-statusline-wrapper.js:146` reads the new path. Because this happens
  pre-release, it's a direct switch; see §2.5 for the post-release shape.
- **Touchpoints:** `statusLineTracking` appears in 15 files, including
  `StatusLineSection.tsx`, `StatusLineTrackingControls.tsx`, `ConfigurationUtils.ts`, the
  statusline, Claude and Antigravity provider tests, and `StatuslineWrapper.test.ts`.

### 6.2 The two top-level stragglers

- **`ctrlyokeMcpMode` → `execution.ctrlyokeMcpMode`.** It decides how each step receives
  ctrlyoke's MCP server (native vs skill) and is resolved per spawn
  (`ExecutionPropertyResolver`, `CliProviderUtils`, `CliPromptPreparer`); that is execution
  configuration. It appears in 20 files.
- **`enableDiagnosticLogs` → new `diagnostics` group**, as `diagnostics.verboseLogging`. Also
  move **`ui.logRawCliOutput` → `diagnostics.logRawCliOutput`** (decided 2026-09-26): it
  writes to the extension output channel and is a logging switch, not a UI one.
  `enableDiagnosticLogs` appears in 8 files; the primary consumer is `Log.ts`.

The settings **UI** placement (which section shows each control) can stay as it is; only the
paths change. Update the settings schema, `CtrlYokeSettings.ts` (type and `DEFAULT_SETTINGS`),
`SETTING_PATHS`, the settings store, and the generated docs.

---

## 7. Lineage metadata single-sourced in `workflow.json` (item 6)

### 7.1 What moves

| Field                                              | Keep in run file? | Owner after                                                |
| -------------------------------------------------- | ----------------- | ---------------------------------------------------------- |
| `workflowName`                                     | no                | `workflow.json` (`WorkflowLineageDescriptor.workflowName`) |
| `originalFile`                                     | no                | `workflow.json`                                            |
| `isFavorite`                                       | no                | `workflow.json`                                            |
| `lastModifiedAt`                                   | no                | `workflow.json`                                            |
| `startedAt`                                        | **yes**           | per-run fact                                               |
| `definitionRevision`, `parallelGroups`, `_runtime` | **yes**           | per-run                                                    |

### 7.2 Behaviour change to accept consciously

Today each run file records the name it had when written, so runs can show different names
(`WorkingFileManager.ts:746`, `:780`, `:911`, `:936` fall back to the descriptor only when
the run's own value is absent). After single-sourcing, **renaming a workflow renames it
across all of its history**. That matches "a lineage is one workflow", and it is what makes
the change worth doing.

### 7.3 Work

- **Writers:** stop writing the four fields — `WorkingFileManager.ts:654–655`, `:749–751`,
  `:913–915`, and the rename at `:2060–2062`, which becomes descriptor-only through
  `WorkflowLineageRepository`.
- **Readers of `workflowName`:** `PromptQueue.ts:633`, `PromptFileLoader`, `RunLifecycleService`,
  `WorkspaceSessionManager`, `ExternalRunWatchCoordinator`, `mcp-server.ts`,
  `WorkflowSerializer`, `HistorySearchService` and `historySearchRebuildWorker`. The search
  rebuild then reads one descriptor per lineage instead of the name per run, which is
  cheaper. Bump `INDEX_SCHEMA_VERSION`, since it is derived and simply rebuilds.
- **Readers of `originalFile`:** `PromptFileLoader`, `WorkflowInstance`, and
  `getAuthoredSourcePath()` callers, which pass the descriptor's value.
  `core.instructions.md` already names the descriptor as the semantic base for dashboard
  views.
- **Direct run-file access** — anything given only a run-file path (CLI history commands,
  external watch) resolves the descriptor via `WorkflowPaths.parseWorkingFileAddress`.
- **Schema, docs and tests:**
  - remove the four fields from the multi-step root — including `lastModifiedAt` and
    `isFavorite`, which the 2026-09-26 bug fix just declared (correct for today's writer,
    temporary by design);
  - drop them from the `generate-schema-docs.mjs` run-file include list;
  - drop them from the allowance lists in `schemaUiPropertyRoundTrip.integration.test.ts` and
    `WorkflowSerializer.test.ts`;
  - drop the `WorkingFile` type fields.
- **Existing dev history:** pre-release, strip the fields when reading a run file so §5's
  unknown-key warnings don't fire on old runs.
- **`RUN_EXPORT_PLAN.md`:** a run directory no longer names itself, so an export bundle must
  include the descriptor's name/original-file fields.

---

## 8. Constraint tightening (items 7–10)

### 8.1 `vars` keys (item 7)

Add `propertyNames: { "pattern": "^\\w+$" }` to `varsConfig`, matching
`VARIABLE_NAME_PATTERN_SOURCE` (`KeyValueKeyKinds.ts:14`). Add a test asserting the schema
pattern equals the code constant. Keys differing only in case (`foo`/`FOO`) collide in
`CTRLYOKE_VAR_*` (`ScriptProcessRunner.ts:80` upper-cases them). JSON Schema can't express
that, so `PromptFileParser` reports it as a validation error. The parser and CLI use the
same key-validation helper, including when CLI values are merged with workflow defaults.
A bad key can never work, so a hard error is appropriate here.

### 8.2 `mcpServerConfig` (item 8)

Enforce what the description already promises in both the schema and managed MCP registry
reader. The registry check previously accepted both fields; it now requires exactly one,
matching the schema:

```json
"oneOf": [
  { "required": ["command"], "not": { "required": ["url"] } },
  { "required": ["url"], "not": { "required": ["command"] } }
]
```

Do not tie `args`/`env` to `command` or `transport`/`headers` to `url`: the runtime accepts
those fields with either transport, so schema dependencies would reject runtime-accepted
configurations.

### 8.3 Numbers (item 9)

| Field                                                                                          | Change                                                    |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `sessionId` (number form)                                                                      | `integer`, `minimum: 1` (it's a 1-based prompt reference) |
| `endCondition.maxRetries`                                                                      | `integer` (keep `-1..100`)                                |
| `timeoutSec`, `retryDelaySec`                                                                  | `number`, `exclusiveMinimum: 0` (fractional allowed, §4)  |
| `hooks[].timeoutSec`                                                                           | `minimum: 1`                                              |
| `server.port`, `server.standalonePort`, `server.fallbackPorts[]`                               | `integer`, `1..65535`                                     |
| `queue.maxSize`, `terminal.scrollback`, `ui.outputVirtualizationRowThreshold`                  | `integer`                                                 |
| `runs.maxRuns`, `execution.maxPromptTimeout`, `queue.maxWorkflowExecutionTime` (current names) | `integer`, `minimum: -1`                                  |

The duration fields use positive fractional seconds, hook timeouts are positive integers, and condition/script timeout `0` uses the same explicit-value semantics throughout. Existing `DEFAULT_SETTINGS`, bundled templates, and `.ctrlyoke` workflow files were checked against the tightened constraints.

Before the duration rename, conditions treated `0` as "use the default"
(`condition.timeout || …`), while script steps treated it as a literal 0 ms. The shared
seconds→ms helper now preserves explicit values and each execution path uses `??` only to
select the configured default when the field is absent. `exclusiveMinimum: 0` rejects zero in
authored files.

`parallelGroupDefinition.endIndex ≥ startIndex` can't be expressed in the schema; leave it to
the parser.

### 8.4 `workflowKey` (item 10)

Tighten the `workflowRunAddress.workflowKey` pattern to reject `.` and `..`:
`^(?!\.{1,2}$)[^/\\]+$`. Leave Windows reserved names to `WorkflowPaths.isSafeSegment`,
because JSON Schema regexes have no case-insensitive flag. The code already rejects all of
these, so this only improves the error. Lowest priority in the plan.

---

## 9. Description fixes (items 11–14)

- **11 — `scriptStep.executionMode`:** omitting it inherits the workflow's `executionMode`,
  then the `defaults.executionMode` setting (`PropertyResolver.resolveExecutionMode`).
- **12 — `endCondition.maxRetries`:** 0 means no retries by default; when either `onPass` or
  `onFail` is `retry` and this field is omitted, one retry is allowed (`EndConditionHandler`).
  Keep the `onFail` description free of a duplicate default claim.
- **13 — `passRetryPrompt`:** pass retries substitute both `$preCondition:<field>` and
  `$endCondition:<field>` placeholders. `CliPromptPreparer` applies the same
  `substituteConditionOutputRefs` path to pass-retry prompts and ordinary retry prompts.
- **14 — `defaults.priorContext`:** this is the default `priorContext` for each step that
  doesn't set its own. The settings form allows only the keyword and number-array branches;
  it references their dedicated `priorContextKeyword` and `priorContextPromptNumbers`
  definitions, not the run-address branch.

The script-timeout description and the stale `ctrlyoke.scriptTimeout` references were fixed
with the 2026-09-26 bugs.

---

## 10. Structural cleanups (items 15–17)

### 10.1 Dead root `_runtime.harness` rule (item 15)

The top-level `allOf` adds `properties._runtime.properties.harness`, but `runtimeMetadata`
has `additionalProperties: false` and no `harness`, so the rule can never apply. Delete just
that root `_runtime` clause. The step-level and `finalStep` `_runtime` clauses are live —
they keep template placeholders out of non-template files — so keep them.

### 10.2 Harness-keyed lists (item 16)

- **`commit.harness`:** replace the hand-copied enum with
  `anyOf: [{ "$ref": "workflow-schema.json#/definitions/harnessId" }, { "const": "" }]` (ref
  spelling per §3).
- **`modelPricing`:** add `propertyNames: { "$ref": "…/harnessId" }`.
- **`defaults.models`, `defaults.additionalArgs`, `ui.harnessColors.byHarness`, and §6's
  `statusLine.byHarness`:** keep the explicit per-harness `properties`, which power
  IntelliSense key completion. Add one unit test that walks both schemas: every
  harness-keyed object must list exactly `HARNESS_IDS` (or its declared subset, for
  `statusLine`), and the `harnessId` enum must equal `HARNESS_IDS`. The drift then fails CI
  instead of shipping.

### 10.3 `default` keyword (item 17)

Settings now declare `default` for every leaf with a value in
`CTRLYOKE_SETTINGS_DEFAULTS` (IntelliSense shows it on hover). A path-driven test asserts each
schema `default` deep-equals the configured value and rejects any undocumented leaf without a
default. Container objects and statusline format arrays are exempt. The only optional leaves
without a configured default are the sparse per-harness `defaults.additionalArgs` and
`ui.harnessColors.byHarness` entries; their absence means no override.

---

## 11. Instruction-file fix (item 18)

In `.github/copilot-instructions.md` → Debugging, the `run-<timestamp>/workflow.ctrlyoke.json`
bullet lists `responseText` among `_runtime` fields. Step output lives only in `events.jsonl`
(the `promptRuntimeMetadata` description says so). It now lists "(harness, sessionId,
timestamps, terminal status)".

After implementation, record the durable rules where the next agent will look:

- the migration read pipeline and write-back classes → `utils.instructions.md` (next to
  `PersistedSchemaGuard`) — done;
- the "strict schema, lenient loader" rule → `core.instructions.md` `parsingAndValidation`,
  amending the bullet that currently says every Ajv failure is fatal, and replacing the "three step allowlists" bullet with the §5.3 closure-placement rule;
- the §2.5 launcher constraint → `harness-shared.instructions.md`.

---

## 12. Order

| Phase | Items                                         | Notes                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** | 7–18                                          | Independent and small; any order. Regenerate docs/YAML schema after each schema edit (`npm run generate-schema-docs`, `npm run generate-schema`). §8.3's `timeoutSec`/`retryDelaySec` rows and the timeout-`0` unification land with B, since they name B's fields.                                                                                                                                                     |
| **B** | 3, 5                                          | The two rename sets; do them together so the settings file only changes shape once.                                                                                                                                                                                                                                                                                                                                     |
| **C** | 6                                             | Needs B's settled field names; bumps the search index.                                                                                                                                                                                                                                                                                                                                                                  |
| **D** | 4                                             | Last shape change: the draft 2020-12 move, closures, lenient loader and `ValidationUtils` deletion, after all renames and §7's removals.                                                                                                                                                                                                                                                                                |
| **E** | 1, 2 + §2.2 skeleton + §2.8                   | Workflow/settings version fields, all persisted-store guards, and §1.3 refusal landed 2026-09-26. Empty-chain `FormatMigrations`, read hooks, launcher support, and provisional fixtures landed 2026-09-26. Semver strings converted and the `/schema/v1/` publish pipeline built. At the release cut: deploy and verify `/schema/v1/`, and **re-capture or confirm the fixture corpus from the actual release build.** |
| post  | §2.4 `ctrlyoke migrate`, first real migration | When the first breaking change lands after release.                                                                                                                                                                                                                                                                                                                                                                     |

### Release checklist (end of phase E)

- [x] Every store in §1.1 carries an integer `schemaVersion` and is covered by the guard.
- [x] `BASELINE_SCHEMA_VERSIONS` recorded; chain test green with zero migrations.
- [ ] Provisional fixture corpus re-captured or confirmed from the actual release build (including optional fields and both run-file version numbers) and committed.
- [x] `schemas/` copied to `schemas/archive/v1/`; the publish script checks the archive remains byte-identical while v1 is current.
- [ ] `/schema/v1/` deployed and verified live with the right headers at the actual release cut.
- [x] Built-in YAML templates carry the workflow schema modeline; `WorkflowSerializer` and custom-template writers stamp workflow schema hints, and settings writes stamp `$schema` with `schemaVersion`. Workspace `init` currently creates only `.ctrlyoke/.gitignore`, not a settings file.

---

## 13. Resolved decisions

All questions raised by the first draft were settled on 2026-09-26:

1. **Newer workflow file on an older host** → refuse to open it, with a clean error (§1.3).
2. **`ui.logRawCliOutput`** → moves to `diagnostics.logRawCliOutput` (§6.2).
3. **Draft-07 allowlists vs 2020-12 `unevaluatedProperties`** → 2020-12, after empirical
   verification against Ajv 8.20, `yaml-language-server` 1.24/1.19 and
   `vscode-json-languageservice` 5.7/6.0 (§5.3–§5.4).
