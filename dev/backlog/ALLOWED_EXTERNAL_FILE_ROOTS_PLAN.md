# Allowed External File Roots Plan

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
  or after a one-time confirmation.
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

Add a separate UI confirmation toggle:

```json
"confirmExternalFileLinks": {
  "type": "boolean",
  "description": "Show a confirmation dialog before opening AI-generated file links outside the workspace unless the path is under an allowed external file root.",
  "default": true
}
```

Important: `confirmExternalFileLinks: false` should not mean "trust all external
paths." It should only skip prompts for already trusted external roots. Unknown
external roots remain blocked or require an explicit trust action.

Run `npm run generate-schema` after editing the JSON schema. Do not hand-edit the
generated YAML schema.

### Types and Defaults

Update:

- `src/types/CtrlYokeSettings.ts`
  - `permissions.allowedExternalFileRoots: string[]`
  - `ui.confirmExternalFileLinks: boolean`
  - Defaults: `[]` and `true`
- `src/types/WebviewMessageTypes.ts`
  - Add the new settings to global settings payloads if needed.
- `src/ui/webview-react/store/settingsStore.ts`
  - Add webview defaults.
- `src/utils/ConfigurationUtils.ts`
  - Add `CONFIG_KEYS.PERMISSIONS_ALLOWED_EXTERNAL_FILE_ROOTS`
  - Add `CONFIG_KEYS.UI_CONFIRM_EXTERNAL_FILE_LINKS`
  - Add helpers:

```ts
getAllowedExternalFileRoots(): string[]
shouldConfirmExternalFileLinks(): boolean
```

## Shared Path Policy Helper

Create a single extension-host helper, e.g. `src/utils/FileAccessPolicy.ts`.

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
): Promise<FileAccessDecision>
```

Use this helper anywhere ctrlyoke reads or opens user-referenced files. Do not
duplicate path containment logic in UI/router/expander files.

## Prompt Attachment Flow

### ContextExpander

Update `src/utils/ContextExpander.ts` so file reads use the shared policy helper.

Current behavior is ambiguous because `path.resolve(workspaceRoot, absolutePath)`
returns the absolute path unchanged. Make this explicit:

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
   - **Attach Once**: insert the quoted absolute ref for this prompt only; execution
     may still require one-time read permission unless the attachment flow carries
     a transient grant.
   - **Trust Parent Folder**: add the parent directory to
     `permissions.allowedExternalFileRoots` and insert the ref.
   - **Cancel**

For the first implementation, prefer **Trust Parent Folder** and **Cancel** only.
One-time grants are useful but require transient workflow/runtime state and can be
added later.

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
4. If outside trusted roots and `confirmExternalFileLinks` is true: show modal.
5. If outside trusted roots and confirmations are disabled: still block, because
   the path is not trusted.

Suggested VS Code modal actions:

- **Open Once**
- **Trust Parent Folder**
- **Cancel**

If "Trust Parent Folder" is selected, persist that folder to
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

- `Confirm external file links`
  - Toggle matching `ui.confirmExternalFileLinks`
  - Description must clarify that untrusted roots are still blocked.

This setting belongs in the extension host and settings sync layer, not only the
webview store.

## Harness Permission Alignment

ctrlyoke can embed external file content into prompt XML after reading it itself.
That does not require the harness to have file-system access to the external path.

However, direct full-file `@absolute/path` references passed to a harness do require
the harness to read that path. For split context:

- If the ref is inside the workspace, keep existing direct-file behavior.
- If the ref is external, prefer embedding content as XML instead of passing the
  absolute path through as a direct harness ref.
- If direct external refs are ever passed through, warn if the active harness sandbox
  does not include the same root.

This avoids a confusing case where ctrlyoke trusts the path but Codex/Claude cannot
read it because their sandbox is narrower.

## Implementation Plan

### Phase 1: Policy and Settings

1. Add settings schema entries.
2. Update settings types/defaults/store sync.
3. Add `ConfigurationUtils` helpers.
4. Implement `FileAccessPolicy` with unit tests for:
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
3. For external full-file refs in `expandContextSplit()`, embed content instead of
   adding to `directFileRefs`.
4. Add tests for external absolute refs:
   - trusted full file
   - trusted selection
   - untrusted blocked

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
- Why `confirmExternalFileLinks` does not disable the trust boundary.
- Recommended quoted absolute reference syntax.

## Files Likely Changed

| File | Change |
| --- | --- |
| `schemas/settings-schema.json` | Add `permissions.allowedExternalFileRoots` and `ui.confirmExternalFileLinks` |
| `schemas/settings-schema.yaml` | Regenerated via `npm run generate-schema` |
| `src/types/CtrlYokeSettings.ts` | Add settings types and defaults |
| `src/types/WebviewMessageTypes.ts` | Include settings payload fields if needed |
| `src/utils/ConfigurationUtils.ts` | Add config keys and helpers |
| `src/utils/FileAccessPolicy.ts` | New shared path access policy helper |
| `src/utils/ContextExpander.ts` | Enforce policy for file reads and external refs |
| `src/completions/PromptLinkProvider.ts` | Resolve trusted absolute refs and route untrusted refs through confirmation |
| `src/ui/WebviewMessageRouter.ts` | Enforce policy for `OPEN_FILE` and trust-folder flow |
| `src/ui/WebviewSettingsSync.ts` | Sync new settings to webview |
| `src/ui/webview-react/store/settingsStore.ts` | Add webview defaults/types |
| `src/ui/webview-react/components/settings/GeneralSection.tsx` | Add settings UI |
| `src/test/**` | Policy, expander, router/link-provider tests |

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

## Open Questions

- Should "Trust Parent Folder" trust the immediate parent only, or offer a picker to
  choose a higher-level root?
- Should one-time external file grants be supported in v1, or should all external
  attachment execution require a persisted trusted root?
- Should common harness log directories be suggested in the UI without being
  automatically trusted?
- Should trusted external roots be user-scope only, or can workspaces define them?
  User-scope is safer for machine-specific absolute paths; workspace-scope may be
  useful for team-shared mounted paths but can become surprising.

## Recommended Initial Scope

Ship the smallest secure version:

1. User-scope `permissions.allowedExternalFileRoots`.
2. No one-time grants for prompt execution.
3. Dashboard output links prompt with `Open Once`, `Trust Parent Folder`, `Cancel`.
4. Context expansion requires a trusted root for external files.
5. External full-file refs are embedded, not passed through as direct harness refs.

This solves the developer-log use case while keeping AI-generated output links and
prompt attachment reads behind an explicit local trust boundary.
