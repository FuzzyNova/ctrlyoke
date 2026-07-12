# Working-File Model & Template Flow Plan

## Overview

Make the **working file** the single primary artifact for every workflow-creation path, and
treat durable `.ctrlyoke.yaml`/`.json` files purely as **export artifacts** produced on demand
via **Save As**. This removes the long-standing tension where creating a workflow from a template
silently produced _two_ files (a durable copy in `.ctrlyoke/workflows/` **and** a working copy in
`.ctrlyoke/.queue/`), while the `+` button produced only a working file. After this change:

- **All** creation paths produce exactly one thing: a working file, loaded in the dashboard.
- Durable files exist only when the user explicitly exports one (Save As), and can live anywhere
  the user chooses — ctrlyoke no longer owns or scaffolds a `workflows/` directory.
- The working-file directory is renamed `.ctrlyoke/.queue/` → `.ctrlyoke/.working/` to match the
  "working file" terminology already used throughout the code (`WorkingFileManager`,
  `createWorkingFile`, `workingFilePath`) and to convey the correct mental model of what lives there.

## Motivation / Current Behavior

| Path                                                     | Today                                                                                                                                                                                     | Problem                                                                                   |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `+` button (`WorkflowControls`)                          | `CLEAR_WORKFLOW` → `createWorkflowForClient` → blank in-memory instance → working file in `.queue` on first edit                                                                          | ✅ Already the target model                                                               |
| Template **Create** / **Create & Run** (`TemplateModal`) | `TemplateManager.createWorkflow()` **writes a durable file** to `.ctrlyoke/workflows/` → `loadPromptFile()` creates a `.queue` working file tethered via `originalFile` → optionally runs | ❌ Produces two files; working file is bound to a durable source the user never asked for |

The durable `workflows/` folder also gets **auto-scaffolded on every init** (`WorkspaceInitializer`
`USER_DIRECTORIES`), so it exists (empty) even for users who never save a shareable workflow. That
auto-presence is what previously made `.working` vs `.workflows` a naming footgun — removing the
folder removes the footgun.

## Target Model (one principle)

> The working file is the workflow. Editing the dashboard auto-saves to the working file. **Save As**
> is the only thing that writes a durable, runtime-free copy, and the user decides where it goes.

---

## Change 1 — Template creation becomes working-file-only

Template **Create** should behave exactly like `+` but seeded from the chosen template; **Create & Run**
does the same and auto-starts. No durable file is written.

- `TemplateManager.createWorkflow()` currently does substitution → strips `_templateMeta` → **writes to
  `workflowsDir`** → returns a path. Split the "produce workflow content" work from the "write to disk"
  work: keep all substitution/`_templateMeta`-stripping, but **stop before `writeFile`** and return the
  parsed steps + workflow-level properties in memory instead of a file path.
- `WorkflowSerializer.handleCreateWorkflow()` should feed those steps directly into the working-file
  creation path (`PromptQueue.createWorkingFile(...)` via the active instance) with **`originalFile`
  left `undefined`** — the signal for "no durable source; Save As is the only export." Then load the
  working file into the dashboard, and run if `runAfter`.
  - Do **not** round-trip through a durable file or a temp file. Given pre-release / no back-compat,
    build the clean in-memory → working-file path.
- The user-provided **Workflow Name** field stays and now drives **both** the in-file `workflowName`
  (shown in `WorkflowStatus`) **and the working-file basename**, so `.working/` is human-browsable.
  Pass the name as `nameForFile` to `createWorkingFile` — the existing generator sanitizes it and
  appends a timestamp (`<name>-<timestamp>.ctrlyoke.json`), so **uniqueness is already handled** and no
  new collision logic is required.

### Simplifications that fall out of Change 1

- **Remove the Format (YAML/JSON) radio and the Save-Location path preview from `TemplateModal`.**
  Working files are always JSON, and there is no durable path at creation time. Format and location are
  now exclusively Save-As concerns. This deletes a chunk of `TemplateModal` UI and the `format` /
  `workflowsDir` fields from the `CREATE_WORKFLOW` message payload.

---

## Change 2 — Remove the durable `workflows/` folder from source entirely

With Change 1 (template flow no longer writes durable) and Change 4 (Save-As defaults away from it),
`.ctrlyoke/workflows/` has **zero remaining producers** and can be deleted wholesale.

- `WorkspaceInitializer.ts` — remove `PATH_CONSTANTS.WORKFLOWS_DIR` from `USER_DIRECTORIES` (stop
  scaffolding an empty folder on init).
- `ConfigurationUtils.ts` — remove the `WORKFLOWS_DIR: "workflows"` constant from `PATH_CONSTANTS`.
- Delete the `workflowsDir` plumbing that only existed to feed that folder:
  - `TemplateManager.createWorkflow` — `workflowsDir` param removed (folded into Change 1's rewrite).
  - `WorkflowSerializer.handleCreateWorkflow` — drop `workflowsDir` from the destructured `CREATE_WORKFLOW` message.
  - `WorkflowSerializer.handleNewWorkflow` — stop sending `workflowsDir` in `OPEN_NEW_WORKFLOW_MODAL`.
  - `DashboardConstants.ts` — update the `SAVE_WORKFLOW_DIALOG_DATA` comment (drop `workflowsDir`).
  - `WebviewMessageTypes.ts` — remove `workflowsDir` from the two message interfaces that declare it (lines ~752, ~803).
  - `uiStore.ts` — remove `workflowsDir` state field / default `".ctrlyoke/workflows"` (line ~484) and
    the `openNewWorkflowModal({ workflowsDir })` parameter.
  - `useMessageHandler.ts:1314` — remove the `message.workflowsDir || ".ctrlyoke/workflows"` fallback.
- Update tests that assert `".ctrlyoke/workflows"` (`uiStore.test.ts`, etc.).

---

## Change 3 — Rename `.ctrlyoke/.queue/` → `.ctrlyoke/.working/`

There are **two independent sources of the dir name** — both must change or the MCP server silently
drifts from the extension:

- `ConfigurationUtils.ts` — rename the constant **`PATH_CONSTANTS.QUEUE_DIR` → `PATH_CONSTANTS.WORKING_DIR`**
  with value `".working"`. (The real single source.) Update all references to the renamed constant.
- `mcp-server.ts:43` — `const QUEUE_DIR = ".queue"` is **hardcoded separately** with a comment saying it
  "must match PATH_CONSTANTS." Change it too. **Recommended cleanup:** have the MCP server import the
  shared constant instead of re-declaring it, so this class of drift can't recur.
- `.gitignore:18` — `.ctrlyoke/.queue/` → `.ctrlyoke/.working/`.
- Update comments/log strings/tests that reference the `.queue` **directory** (`WorkingFileManager`,
  `PromptFileLoader`, `WorkspaceSessionManager`, `CliMcpConfigGenerator.test.ts`, etc.).

**Scope boundary — keep the "queue" mental model for the step sequence.** Only the directory-name
constant (`QUEUE_DIR` → `WORKING_DIR`) and its string value change. The _step-queue_ naming stays
untouched: `PromptQueue` (really the workflow's step queue), `queueAccess`, `queueExtensions`,
`PromptQueue.ts`, etc. all refer to the ordered sequence of steps in the workflow — a valid and
distinct concept from the on-disk working-file directory — so renaming them would be pure churn. The
`.working/` directory holds working files; the queue is the steps inside a workflow.

No data migration: `.queue/` is gitignored working state. Pre-release, existing dirs can simply be
abandoned (in-progress sessions in old `.queue/` folders won't auto-load — acceptable).

---

## Change 4 — Save-As default → repo root / last-used, plus explanatory note

- **Default path.** `WorkflowSerializer` (the `SAVE_WORKFLOW_DIALOG_DATA` builder, ~line 85) currently
  defaults an unsaved workflow's export path to `.ctrlyoke/workflows/<name>.ctrlyoke.yaml`. Change the
  default to **repo root** (`<name>.ctrlyoke.yaml`), then **persist and prefer the last-used export
  directory** so the user "decides once."
  - Persistence: a workspace-scoped key (VS Code `workspaceState`, or a config value via
    `ConfigurationUtils`) holding the last directory the user saved a durable workflow to. See Open
    Questions for exact mechanism.
- **Explanatory note in `SaveWorkflowDialog`.** Add body copy (not just the tiny footer line) that
  teaches the model, e.g.:
  > _This workflow is auto-saved to your working area as you edit. Use Save As to export a clean,
  > shareable copy without runtime state._
  > Phrase around "auto-saved" + "shareable copy" rather than naming `.ctrlyoke/.working/` — the folder is
  > an implementation detail users shouldn't need to learn.

---

## Suggested sequencing

1. **Change 3** (rename `.queue` → `.working`) — pure mechanical, unblocks clean naming everywhere else.
2. **Change 1** (template flow → working-file-only) — the real behavioral change; also lets us delete
   the Format/path UI in `TemplateModal`.
3. **Change 2** (delete `workflows/` folder + `workflowsDir` plumbing) — naturally follows Change 1.
4. **Change 4** (Save-As default + note) — Save-As polish; independent, can land anytime after Change 2.

## Testing impact

- Tests around `handleCreateWorkflow` / `TemplateManager.createWorkflow` currently assert a durable file
  written to `workflowsDir`. Retarget them to assert **a working file created with `originalFile`
  undefined** and no durable write.
- `uiStore.test.ts` and any test asserting `".ctrlyoke/workflows"` need updating (Change 2).
- Search `src/test/**` and `src/ui/webview-react/test/**` for `.queue` string literals and update to
  `.working` (Change 3).
- `WorkspaceInitializer.test.ts` asserts the scaffolded directory set — drop `workflows` there.

---

## Resolved Decisions

1. **Working-file naming from templates → name the working file too.** The template's Workflow Name
   drives the working-file basename (via `nameForFile`), not just the in-file `workflowName`, so
   `.working/` is human-browsable. The existing timestamp suffix already guarantees uniqueness — no new
   collision handling needed. (Folded into Change 1.)

2. **Last-used export location → `workspaceState`.** Per-workspace, invisible, no settings clutter.
   It's a convenience default, not a user-facing preference. (Folded into Change 4.)

3. **First-ever export default → repo root.** Then prefer the last-used export directory on subsequent
   saves. Matches "let the user decide" without ctrlyoke owning a folder. (Folded into Change 4.)

4. **Rename scope → constant only, keep the step-queue vocabulary.** Rename `QUEUE_DIR` → `WORKING_DIR`
   (+ the `mcp-server.ts` duplicate). Leave `PromptQueue`, `queueAccess`, `queueExtensions`, etc. as-is —
   they name the workflow's ordered step sequence, a distinct concept from the on-disk `.working/`
   directory. (Folded into Change 3.)

5. **`format` at creation → removed from `TemplateModal`; no other surface needs it.** Verified the
   full creation surface: the CLI (`src/cli.ts`) exposes only `run` / `validate` / `commit` (its `--json`
   flag formats run _results_, not workflow files), and the MCP server (`src/mcp-server.ts`) has no
   create-from-template tool. Workflows are created **only** by the dashboard `+` button and
   `TemplateModal`, and format is chosen **only** at Save As. Dropping the YAML/JSON radio from
   `TemplateModal` is safe. (Folded into Change 1.)
