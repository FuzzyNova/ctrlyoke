# Allowed External File Roots Plan

> **2026-07-04 update — interacts with a recent security fix.** A security audit
> found that `ContextExpander.resolveWorkspacePath()` and
> `AttachmentBuilders.buildDirectoryAttachmentXml()` had no containment check at
> all: an `@../../../.ssh/id_rsa` or `@dir/../../` reference from an untrusted
> prompt/workflow file could read or list arbitrary files outside the workspace.
> Both now **hard-reject** anything outside the workspace root (see
> `src/utils/PathSecurity.ts#isPathWithinDirectory`, used by both, and by
> `EndConditionEvaluator`). This is a superset of what this plan already called
> "ambiguous... make this explicit" below — it's now explicit, just not yet
> external-root-aware. Implementing this plan means **loosening** that hard
> reject at exactly those two call sites to also accept
> `allowedExternalFileRoots`, via `FileAccessPolicy` built on top of the same
> `isPathWithinDirectory` primitive rather than a new containment check. See the
> "Shared Path Policy Helper" and "ContextExpander" sections below for the
> updated call sites.

## Problem

ctrlyoke is safest when prompt references and output file links stay inside the
workspace. That default boundary prevents AI-generated text from opening arbitrary
local files and keeps prompt attachment behavior predictable.

The strict boundary is painful for real debugging workflows. Useful context often
lives outside the workspace:

- Harness session logs, e.g. Codex sessions under a user profile directory
- System or application logs under platform-specific log directories
- Temporary repro files outside the repo
- ctrlyoke developer artifacts copied into a scratch directory

Users need a controlled way to attach and open these files without turning every
absolute path emitted by an AI into a trusted file operation.

## Goals

- Keep the workspace root trusted by default.
- Add explicit, user-controlled trust for external directories.
- Support attaching external files to prompts when their parent directory is trusted.
- Support opening external file links from AI output only after trust is established
  or after the user chooses to persist trust for the file's parent directory.
- Preserve current workspace-relative reference behavior and completions.
- Avoid a broad "allow all external files" switch.

## Non-Goals

- No automatic trust of harness log directories.
- No recursive scanning or completions for the entire file system.
- No silent opening of arbitrary AI-generated absolute paths.
- No change to harness sandbox permissions unless the user has explicitly configured
  the harness to allow the same external root.

## Security Model

Introduce an allowlist of trusted absolute directory roots:

```json
{
  "permissions": {
    "allowedExternalFileRoots": [
      "C:/Users/me/.codex/sessions",
      "/Users/me/Library/Logs/my-tool",
      "/var/log/my-app"
    ]
  }
}
```

Effective access rule:

1. Paths inside the current workspace are allowed.
2. Paths inside `permissions.allowedExternalFileRoots` are allowed.
3. Paths outside both are blocked by default and may trigger a user confirmation
   flow depending on the operation.

Path checks must use resolved real paths where possible:

- Normalize slashes.
- Expand `~` only at the extension host boundary, not in the webview.
- Resolve symlinks with `fs.realpath` before comparing when the path exists.
- Compare with platform-aware casing rules; Windows comparisons should be
  case-insensitive.
- A root matches itself and descendants only. `C:/logs2` must not match `C:/logs`.

## Settings

### Schema

Add to `schemas/settings-schema.json` under `permissions`:

```json
"allowedExternalFileRoots": {
  "type": "array",
  "description": "Absolute directory paths outside the workspace that ctrlyoke may read for prompt attachments and open from file links. Workspace files are always allowed.",
  "items": {
    "type": "string"
  },
  "default": []
}
```

Add a UI toggle that controls whether an untrusted, AI-generated file link may
offer the user a persisted trust action:

```json
"offerTrustForUntrustedFileLinks": {
  "type": "boolean",
  "description": "Allow AI-generated file links outside trusted roots to offer Trust Parent Folder. Untrusted paths are always blocked unless their parent is explicitly trusted.",
  "default": true
}
```

Important: `offerTrustForUntrustedFileLinks: false` does not mean "trust all
external paths." It suppresses the **Trust Parent Folder** offer; unknown
external roots remain blocked. Trusted paths always open directly.

**Scope (see "Decisions"):** `allowedExternalFileRoots` must be settable at
both the user/global level and the workspace level. `getAllowedExternalFileRoots()`
returns the **union** of both, using a dedicated scope-aware accessor. Do not
reuse `CtrlYokeConfigService.getAll()` for this: its ordinary deep merge replaces
arrays rather than merging them. Workspace-scoped
entries require the one-time per-workspace trust confirmation described in
"Decisions" before they take effect; user-scoped entries don't (the user
already made that trust decision on their own machine).

Open workspace folders are already trusted workspace roots and do **not** use
this approval flow. It applies only to roots requested by
`permissions.allowedExternalFileRoots` that sit outside the workspace-root set.

Run `npm run generate-schema` after editing the JSON schema. Do not hand-edit the
generated YAML schema.

### Types and Defaults

Update:

- `src/types/CtrlYokeSettings.ts`
  - `permissions.allowedExternalFileRoots: string[]`
  - `ui.offerTrustForUntrustedFileLinks: boolean`
  - Defaults: `[]` and `true`
- `src/types/WebviewMessageTypes.ts`
  - Add the new settings to global settings payloads if needed.
- `src/ui/webview-react/store/settingsStore.ts`
  - Add webview defaults.
- `src/utils/ConfigurationUtils.ts`
  - Add `CONFIG_KEYS.PERMISSIONS_ALLOWED_EXTERNAL_FILE_ROOTS`
  - Add `CONFIG_KEYS.UI_OFFER_TRUST_FOR_UNTRUSTED_FILE_LINKS`
  - Add helpers:

```ts
getAllowedExternalFileRoots(): string[]
shouldOfferTrustForUntrustedFileLinks(): boolean
```

## Shared Path Policy Helper

Create a single extension-host helper, e.g. `src/utils/FileAccessPolicy.ts`.

**Reuse, don't reimplement:** `src/utils/PathSecurity.ts` already exports
`isPathWithinDirectory(candidate, directory)` — the sibling-prefix-safe
containment check (rejects `C:/logs2` matching `C:/logs`) called out in Phase 1's
test list below. `FileAccessPolicy.evaluateFileAccess()` should call it once
against the workspace root and once per configured `allowedExternalFileRoots`
entry, not duplicate the string-prefix logic. `EndConditionEvaluator` also
depends on this helper for script-path sandboxing — keep it a pure,
already-resolved-path comparator and do any `path.resolve`/`fs.realpath`
normalization in the caller, matching current usage.

Responsibilities:

- Normalize and resolve paths.
- Determine whether a candidate path is:
  - inside the workspace
  - inside a trusted external root
  - outside all trusted roots
- Return structured results instead of booleans:

```ts
interface FileAccessDecision {
  allowed: boolean;
  reason: "workspace" | "trustedExternalRoot" | "outsideTrustedRoots";
  normalizedPath: string;
  matchedRoot?: string;
}
```

Suggested API:

```ts
async function evaluateFileAccess(
  candidatePath: string,
  options: {
    workspaceRoot: string;
    allowedExternalFileRoots: string[];
    mustExist?: boolean;
  }
): Promise<FileAccessDecision>;
```

Use this helper anywhere ctrlyoke reads or opens user-referenced files. Do not
duplicate path containment logic in UI/router/expander files.

## Prompt Attachment Flow

### ContextExpander

Update `src/utils/ContextExpander.ts` so file reads use the shared policy helper.

**Current state (as of the 2026-07-04 security fix):** `resolveWorkspacePath()`
already resolves the ref with `path.resolve(workspaceRoot, relativePath)` and
**throws** if `!isPathWithinDirectory(resolved, workspaceRoot)` — no more silent
absolute-path pass-through. It has exactly two callers: the full-file-ref branch
in `expandContextSplit()` (wraps the call in try/catch and logs+skips on
rejection) and `buildAttachmentXml()` (the thrown error propagates to the
`.catch()` already wrapping that call in `expandContextSplit()`). Implementing
this plan means changing `resolveWorkspacePath()` (or replacing it with a call
into `FileAccessPolicy.evaluateFileAccess()`) so the throw only fires for
`reason: "outsideTrustedRoots"`, not for `"trustedExternalRoot"` — the two
existing catch sites don't need to change shape, just what they're allowed to
catch. The "skipped with a warning and a structured error surfaced to the
dashboard" behavior below is still net-new work; today's fix only logs+skips.

- Workspace-relative refs resolve under the workspace.
- Absolute refs are allowed only if they resolve inside the workspace or an allowed
  external root.
- External refs outside trusted roots are skipped with a warning and a structured
  error that can be surfaced to the dashboard.

Recommended constructor change:

```ts
interface ContextExpanderOptions {
  allowedExternalFileRoots?: string[];
}

constructor(workspaceRoot: string, options?: ContextExpanderOptions)
```

Keep the default as `[]` so existing call sites remain secure.

### Reference Syntax

Support absolute file references in prompt text only when they are explicit:

```md
@"C:/Users/me/.codex/sessions/session.jsonl"
@"/Users/me/Library/Logs/my-tool/debug.log"
#selection:"C:/Users/me/.codex/sessions/session.jsonl":10-40
```

Quoted absolute refs are preferred. Unquoted absolute refs can be supported where
the existing parser already accepts them, but docs should recommend quoted refs
because spaces are common in user-profile paths.

### Prompt Editor UX

When the user adds an external file from a picker or paste action:

1. If the file is inside the workspace, insert the normal workspace-relative ref.
2. If the file is under an allowed external root, insert a quoted absolute ref.
3. If the file is outside all trusted roots, show a confirmation dialog:
   - **Trust Parent Folder**: add the parent directory to
     `permissions.allowedExternalFileRoots` and insert the ref.
   - **Cancel**

No one-time/"Attach Once" grant (see "Decisions") — every attachment requires a
persisted trusted root.

## File Link Opening Flow

### Dashboard Output Links

Keep the current default: AI output is untrusted.

When the webview sends `OPEN_FILE`, `src/ui/WebviewMessageRouter.ts` should:

1. Normalize supported local link formats:
   - `C:/path/file.ts`
   - `C:\path\file.ts`
   - `/c:/path/file.ts`
   - `/abs/path/c:/path/file.ts`
   - POSIX absolute paths on macOS/Linux
   - Workspace-relative paths
2. Evaluate with `FileAccessPolicy`.
3. If workspace/trusted external root: open directly.
4. If outside trusted roots and `offerTrustForUntrustedFileLinks` is true: show
   the Trust Parent Folder modal.
5. If outside trusted roots and the Trust Parent Folder offer is disabled: still
   block, because the path is not trusted.

Suggested VS Code modal actions:

- **Trust Parent Folder**
- **Cancel**

No "Open Once" (see "Decisions") — every link open requires a persisted trusted
root. If "Trust Parent Folder" is selected, persist that folder to
`permissions.allowedExternalFileRoots`, then open the file.

### PromptLinkProvider

Update `src/completions/PromptLinkProvider.ts` to resolve absolute references
instead of always joining with the workspace root.

For trusted external refs:

- Link directly to the absolute file URI or the `ctrlyoke.openFileWithSelection`
  command.
- Tooltip should make the external nature obvious:
  `Open external file C:/Users/me/.codex/sessions/session.jsonl`.

For untrusted external refs:

- Prefer a command URI that routes through the same confirm/trust handler rather
  than a raw `file:` URI. This keeps Ctrl+Click behavior aligned with dashboard
  output links.

## Settings UI

Add a section to the Settings drawer, likely under "File Management" or
"Permissions":

- `Allowed external file roots`
  - List current roots
  - Add folder button using `showOpenDialog({ canSelectFolders: true })`
  - Remove button per root
  - Short description: "ctrlyoke may read prompt attachments and open file links
    under these directories. Workspace files are always allowed."

- `Offer trust for untrusted file links`
  - Toggle matching `ui.offerTrustForUntrustedFileLinks`
  - Description must clarify that untrusted roots are still blocked and that
    this only controls whether an AI-generated link can offer Trust Parent Folder.

This setting belongs in the extension host and settings sync layer, not only the
webview store.

## Harness Permission Alignment

Trusted external full-file references are deliberately passed directly to the
harness as normal absolute file references. ctrlyoke does **not** copy them into
the workspace, embed them merely because they are external, redact their
contents, or expire a trust decision automatically.

Append every effective allowed external root (user-scoped roots plus approved
workspace-scoped roots) as `--add-dir <root>` whenever the active harness
supports `--add-dir`: Claude, Codex, Copilot, and Antigravity. This extends the
same root-list assembly used for multi-root workspaces. Each root must be a
configured, canonical permitted root (normally the immediate parent selected by
**Trust Parent Folder**), never a broader ancestor inferred from a file path.

Every harness receives trusted external full-file references normally. Qwen and
OpenCode do not support `--add-dir`, so ctrlyoke passes the absolute reference
without a harness-specific root flag; their existing interactive trust prompts
and user-configured permissions remain authoritative. No harness is blocked or
given a copy/embed fallback merely because it lacks `--add-dir`. Opening a
trusted external file from the UI remains independent of harness support.

`permissions.allowedExternalFileRoots` is the only setting that authorizes
ctrlyoke to read or pass an external prompt reference, and (2026-07-13) is now
also the only source of extra `--add-dir` entries. The previously separate
`permissions.allowedDirs` harness-sandbox setting was removed as duplication:
both settings ultimately fed the same `--add-dir` assembly in
`CliProviderUtils.getWorkspaceDirs()`, so a directory a user wants a harness to
touch now goes through the external-roots trust flow (approval, folder picker)
rather than a second, unguarded list. `permissions.copilotAllowAllPaths` was
removed at the same time — it mirrored Copilot's single `--allow-all-paths`
flag 1:1, which is already reachable via `defaults.additionalArgs["copilot-cli"]`.

References that already require ctrlyoke-side expansion—such as `#selection`,
`#sym`, and `@dir/`—remain normal excerpt/directory attachment behavior. The
policy authorizes the read first; no additional sanitization is performed and no
temporary copy is created solely because the source is external.

## Implementation Plan

### Phase 1: Policy and Settings

1. Add settings schema entries.
2. Update settings types/defaults/store sync.
3. Add `ConfigurationUtils` helpers, including a dedicated union of user- and
   workspace-scoped external roots rather than the ordinary array-replacement
   config merge.
4. Validate configured roots are existing directories and canonicalize them with
   `fs.realpath`. Canonicalize existing candidates before comparison; compare a
   nonexistent candidate's resolved lexical path against canonical roots.
5. Implement the user-local workspace external-root approval store and its VS
   Code/CLI approval flows before workspace-scoped roots can take effect.
6. Implement `FileAccessPolicy` with unit tests for:
   - workspace child
   - trusted external child
   - sibling prefix attack (`/logs2` vs `/logs`)
   - Windows case-insensitive matching
   - symlink/realpath behavior where practical

### Phase 2: Safe Open File Flow

1. Refactor `WebviewMessageRouter.handleOpenFile()` to use `FileAccessPolicy`.
2. Add confirmation flow for outside-trusted-root paths.
3. Add trust-parent-folder persistence.
4. Keep existing normalization for Windows web-safe link forms.
5. Add router tests or focused unit coverage around access decisions.

### Phase 3: Prompt Attachment Reads

1. Update `ContextExpander` to accept allowed external roots.
2. Pass configured roots from call sites:
   - CLI harness prompt preparation
   - dashboard token count preview
   - any chat/native attachment path
3. Keep trusted external full-file refs in `directFileRefs` and pass their
   canonical allowed roots through the shared `--add-dir` assembly for Claude,
   Codex, Copilot, and Antigravity. Pass the same absolute references normally
   to Qwen and OpenCode, whose own interactive/user-configured trust systems
   govern their filesystem access.
4. Update `AttachmentBuilders.buildDirectoryAttachmentXml()` (`@dir/` refs) with
   the same `FileAccessPolicy` check it currently does inline against the
   workspace root only (added by the 2026-07-04 security fix) — directory
   listings need external-root support too, and today's fix didn't anticipate
   that path since it only closes the workspace-only hole.
5. Add tests for external absolute refs:
   - trusted full file
   - trusted selection
   - trusted directory listing
   - untrusted blocked (file and directory)

### Phase 4: Editor Links and UX

1. Update `PromptLinkProvider` to understand absolute refs.
2. Route untrusted external link clicks through the same confirmation command.
3. Add settings UI for allowed roots and confirmation toggle.
4. Add "Add external file/folder" flows if not already available from the editor.

### Phase 5: Documentation

Document:

- Workspace files are trusted by default.
- External roots are opt-in.
- How to add common harness log directories.
- Why `offerTrustForUntrustedFileLinks` does not disable the trust boundary.
- Recommended quoted absolute reference syntax.

## Files Likely Changed

| File                                                          | Change                                                                                                                                                         |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemas/settings-schema.json`                                | Add `permissions.allowedExternalFileRoots` and `ui.offerTrustForUntrustedFileLinks`                                                                            |
| `schemas/settings-schema.yaml`                                | Regenerated via `npm run generate-schema`                                                                                                                      |
| `src/types/CtrlYokeSettings.ts`                               | Add settings types and defaults                                                                                                                                |
| `src/types/WebviewMessageTypes.ts`                            | Include settings payload fields if needed                                                                                                                      |
| `src/utils/ConfigurationUtils.ts`                             | Add config keys, the scope-union helper, and link-trust-offer helper                                                                                           |
| `src/cli.ts`, `src/cli/**`                                    | Add the explicit `trust-external-roots` command and its interactive/noninteractive behavior                                                                    |
| `src/platform/**` or a new shared trust-store service         | Persist user-local workspace/root approvals and denials; never write these approvals into workspace config                                                     |
| `src/utils/PathSecurity.ts`                                   | Already exists (2026-07-04 security fix); reuse `isPathWithinDirectory`/`isPathWithinAnyDirectory` as the containment primitives underlying `FileAccessPolicy` |
| `src/utils/FileAccessPolicy.ts`                               | New shared path access policy helper, built on `PathSecurity.isPathWithinAnyDirectory`                                                                         |
| `src/utils/ContextExpander.ts`                                | Already accepts a `trustedRoots` list (multi-root fix, 2026-07-04); extend that list with `allowedExternalFileRoots` instead of hard-rejecting outside it      |
| `src/utils/AttachmentBuilders.ts`                             | Already accepts an `additionalTrustedRoots` list (multi-root fix, 2026-07-04); extend it with `allowedExternalFileRoots` the same way                          |
| `src/core/harness/{claude,codex,copilot,antigravity}/**`       | Pass effective approved external roots through the shared `--add-dir` argument assembly                                                                        |
| `src/completions/PromptLinkProvider.ts`                       | Resolve trusted absolute refs and route untrusted refs through confirmation                                                                                    |
| `src/ui/WebviewMessageRouter.ts`                              | Enforce policy for `OPEN_FILE` and trust-folder flow                                                                                                           |
| `src/ui/WebviewSettingsSync.ts`                               | Sync new settings to webview                                                                                                                                   |
| `src/ui/webview-react/store/settingsStore.ts`                 | Add webview defaults/types                                                                                                                                     |
| `src/ui/webview-react/components/settings/GeneralSection.tsx` | Add settings UI                                                                                                                                                |
| `src/test/**`                                                 | Policy, expander, router/link-provider tests                                                                                                                   |

## Testing

- Unit test `FileAccessPolicy` thoroughly; this is the security-critical primitive.
- Unit test `ContextExpander` with absolute external refs.
- Unit test or integration test `PromptLinkProvider` for:
  - workspace refs
  - trusted external refs
  - untrusted external refs routed through command
- UI test settings store defaults and settings panel controls.
- Manual tests:
  - Add `~/.codex/sessions` as an external root, attach a session file, and run a
    prompt.
  - Click an AI output link to a workspace file: opens without prompt.
  - Click an AI output link to an untrusted external file: prompts.
  - Choose "Trust Parent Folder": root is persisted and subsequent links open.
  - Try a sibling-prefix path attack: trusted `/tmp/logs` must not allow
    `/tmp/logs2/file.log`.
- Approve 127 workspace-configured external roots in one dialog; verify a
  subsequent workspace config change prompts once for only the added roots.
- Run `ctrlyoke trust-external-roots` interactively and verify a normal
  noninteractive CLI workflow stays fail-closed until that approval exists.

## Decisions (2026-07-04)

The open questions below are resolved. This section replaces "Open Questions."

- **"Trust Parent Folder" trusts the immediate parent only and writes it to user
  scope.** No picker for a
  higher-level root in v1. If a user wants a broader root trusted, they add it
  explicitly via the Settings UI folder picker (see "Settings UI").
- **No automatic redaction or trust expiration.** Automatic redaction would mean
  transforming file contents (for example, masking apparent secrets), and trust
  expiration would remove an allowed root after time passes. Neither is part of
  v1. Users explicitly manage roots and their contents are passed unchanged.
- **No one-time grants in v1.** Every external attachment read and every
  external file-link open requires a persisted trusted root — either "Trust
  Parent Folder" or an explicit Settings UI entry. There is no "Open/Attach
  Once" action. Simplify the confirmation dialogs in "Prompt Editor UX" and
  "File Link Opening Flow" accordingly: **Trust Parent Folder** / **Cancel**
  only, not **Attach Once** / **Open Once**.
- **No harness log directory suggestions in the UI.** Don't special-case or
  pre-populate common harness log paths (e.g. `~/.codex/sessions`) in the
  Settings UI. Users add roots manually via the folder picker.
- **Trusted external roots are both user-scope and workspace-scope**, not
  user-scope only. A workspace's `.ctrlyoke/settings.json` (or equivalent
  workspace-level config) and the user's global settings each contribute
  entries; the effective allowlist is the **union** of both — matching how
  `CtrlYokeConfigService`'s layered config generally works, and consistent
  with the fact that this is an _allow_-list, so a union is safe rather than
  the two scopes needing precedence rules on top of each other.

  **New consideration this raises:** unlike most ctrlyoke settings, workspace-
  scoped entries here directly widen what content the extension will silently
  read from the local filesystem and embed into prompts. A workspace config
  file can be committed to and shared through a repo. A malicious/compromised
  repo could therefore ship a workspace setting that adds e.g. the user's SSH
  key directory to `allowedExternalFileRoots`, paired with a bundled prompt
  file that references a file in it — reading and exfiltrating it to the AI
  backend with **no per-file confirmation at all**, since "no one-time grants"
  means a persisted trusted root is sufficient on its own. Mitigate this before
  shipping workspace-scope: require a one-time "This workspace wants to trust
  external folder(s): `<list>` — Allow / Deny" prompt before a workspace's
  _own_ `allowedExternalFileRoots` entries take effect. This is separate from
  the already-rejected per-reference one-time grants. The concrete behavior is
  resolved below.

## Additional Decisions (2026-07-13)

- **Batch workspace-root approval, never per-root popups.** The first time a
  workspace requests external roots, show one scrollable, reviewable dialog
  listing every canonical root and offering **Trust all N listed folders** or
  **Keep blocked**. This remains one decision even for a workspace with 127
  requested roots. Later configuration changes prompt once for the newly added
  roots only, again as a batch.
- **Persist decisions locally per canonical root and workspace identity.** Keep
  allow and deny records in user-local state, never in the workspace or its
  repository. Per-root records make an added root untrusted by default while
  avoiding repeated prompts for roots the user already reviewed. Denied roots
  remain blocked without nagging until the user changes the decision in Settings.
- **Follow VS Code's grouping model, but keep the trust boundaries distinct.**
  VS Code trusts a multi-root workspace as a unit and prompts when an untrusted
  folder is later added; ctrlyoke mirrors that initial-batch/later-additions UX.
  VS Code Workspace Trust is a prerequisite: a Restricted Mode workspace cannot
  activate workspace-scoped external roots. It is not permission for ctrlyoke
  to read arbitrary paths outside the workspace; the external-root approval is
  always still required. See [VS Code Workspace Trust](https://code.visualstudio.com/docs/editing/workspaces/workspace-trust).
- **Standalone CLI gets an explicit trust command before this feature ships.**
  `ctrlyoke trust-external-roots` reads the current workspace's requested roots,
  prints their normalized paths, and asks for one batch approval. It writes the
  same user-local approval records as VS Code. `--yes` is supported only on
  this dedicated trust command for deliberate automation. Ordinary
  noninteractive workflow execution fails closed when required workspace-root
  approval is absent and tells the user to run this command.

## Recommended Initial Scope

Ship the smallest secure version:

1. Both user-scope and workspace-scope `permissions.allowedExternalFileRoots`
   (dedicated union), with batched, user-local approval for workspace-scoped
   entries and the explicit CLI trust command.
2. No one-time grants for prompt execution or file-link opening.
3. Dashboard output links prompt with `Trust Parent Folder` / `Cancel` only.
4. Context expansion requires a trusted root for external files.
5. External full-file refs are passed directly to every harness. Claude, Codex,
   Copilot, and Antigravity also receive all effective approved roots through
   `--add-dir`; Qwen and OpenCode use their own trust mechanisms.
   Existing selection/symbol/directory references continue using their normal
   ctrlyoke-side excerpt expansion.

This solves the developer-log use case while keeping AI-generated output links and
prompt attachment reads behind an explicit local trust boundary.

## Multi-Root Workspace Support (implemented ahead of this plan, 2026-07-04)

The "inside the workspace" half of the trust boundary now already accounts for
multi-root `.code-workspace` folders, fixed as a follow-up to the security
patch referenced at the top of this document:

- **The bug:** `ContextExpander`/`AttachmentBuilders` originally checked
  containment against the single window-wide `.ctrlyoke` root
  (`getVsCodeWorkspaceRoot()`). For a saved multi-root `.code-workspace`, that
  root is the directory _containing the `.code-workspace` file_ — which VS
  Code does not require to be an ancestor of the actual folders (e.g. folders
  on different drives entirely). Any `@file`/`@dir/` reference into a folder
  that wasn't a descendant of that directory was wrongly hard-blocked as
  "outside the workspace."
- **The fix:** `src/utils/PathSecurity.ts` now also exports
  `isPathWithinAnyDirectory(candidate, directories[])`. `ContextExpander` and
  `AttachmentBuilders.buildDirectoryAttachmentXml` both take an optional list
  of additional trusted roots (`trustedRoots`/`additionalTrustedRoots`) and
  check containment against the full set. `PlatformAdapter` gained
  `getWorkspaceRoots(): string[]` (VS Code: `getVsCodeTrustedWorkspaceRoots()`
  = the primary root plus every `vscode.workspace.workspaceFolders` entry,
  deduped; CLI: `[getWorkspaceRoot()]`). `HarnessIntegration`/`CliIntegration`
  and `WebviewMessageRouter.handleAttachmentTokenCountRequest` now pass this
  list through when constructing `ContextExpander`.
- **What this means for implementing external roots:** `FileAccessPolicy`'s
  "inside workspace" branch should call the now-existing
  `getWorkspaceRoots()`/`getVsCodeTrustedWorkspaceRoots()` (or
  `isPathWithinAnyDirectory` directly against that list) rather than
  re-deriving multi-root handling — that part of the "workspace vs. external"
  split is already done. `FileAccessPolicy` only needs to add the
  `"trustedExternalRoot"` branch on top.
- Test coverage: `src/test/unit/PathSecurity.test.ts`,
  `src/test/unit/WorkspaceRootResolver.test.ts` (`resolveTrustedWorkspaceRoots`
  suite), and multi-root suites in `src/test/contextExpander.test.ts` and
  `src/test/attachmentBuilders.test.ts`.
