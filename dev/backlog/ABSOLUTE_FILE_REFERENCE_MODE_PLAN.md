# Absolute vs. Relative Path References — Render-Time Conversion

**Status**: Implemented 2026-07-07. Revised same day — earlier draft had completions insert
absolute paths into the prompt text; that made stored workflows machine-specific and has been
dropped (see [Portability principle](#portability-principle-stored-relative-rendered-absolute)).
**Motivated by**: [`ANTIGRAVITY_CLI_HARNESS_PLAN.md`](ANTIGRAVITY_CLI_HARNESS_PLAN.md)'s
`usesAbsoluteFileReferences` workaround (Antigravity resolves relative paths against the
user's home directory instead of the workspace in headless mode) plus a separate,
harness-agnostic problem: **multi-root workspaces have no unambiguous relative-path
syntax** (`@path/to/file` doesn't say which root it's relative to).

**Update (2026-07-07, later same day)**: the Antigravity per-provider hard requirement
(`ICliProvider.config.usesAbsoluteFileReferences`, `CliIntegration.requiresAbsoluteFileReferences()`)
described throughout this doc has been **removed**. Antigravity fixed the underlying
relative-path-resolution bug as long as `--add-dir` is passed (ctrlyoke already does this via
`CliProviderUtils.getWorkspaceDirs()`), so the workaround is no longer needed. Antigravity now
follows the exact same rule as every other harness: `resolveEffectiveAbsoluteReferences(userSetting,
isMultiRoot)` — on if `ui.useAbsolutePathReferences` is true, or unconditionally on in multi-root,
off otherwise. Every mention below of a "provider hard requirement" / `providerRequiresAbsolute`
is historical context for why the design left room for one — the parameter itself no longer exists.

---

## Portability principle: stored relative, rendered absolute

Workflow files are ctrlyoke's shareable artifact: they get committed, shared across a team via
a `.code-workspace`, and re-run months later. An absolute path baked into a workflow at
authoring time (`@c:\users\dev1\root1\src\index.ts`) breaks for every other teammate, breaks
when the repo is moved, and breaks in a git worktree checkout. So:

- **Stored representation** (what completions insert, what lands in `.ctrlyoke.yaml`/prompt
  files): always **relative** — folder-name-prefixed in multi-root (see below). Never
  machine-specific.
- **Rendered representation** (what the harness/model receives in the final prompt text):
  converted to **absolute at prompt-build time** when the setting is on, the workspace is
  multi-root, or the provider requires it (Antigravity).

The render-time machinery already exists and proves the approach: `ContextExpander.
expandContextSplit` resolves every full-file ref to an absolute path internally
(`src/utils/ContextExpander.ts:230`), and `CliIntegration.formatDirectFileRef` /
`formatTempFileRef` (`src/core/harness/CliIntegration.ts:307-332`) decide at render time
whether to emit absolute or convert back to relative, keyed today on the per-provider
`usesAbsoluteFileReferences` flag. Antigravity works today with zero completion changes —
the user types/completes relative, the model receives absolute. This plan widens that
existing render-time flag into a global effective value; it does **not** change what
completions insert (except the multi-root folder prefix below).

---

## Background

`usesAbsoluteFileReferences` exists today as a **per-provider** config flag
(`ICliProvider` config, `src/core/harness/shared/interfaces/ICliProvider.ts:75`), set only
on `AntigravityCliProvider` (`AntigravityCliProvider.ts:66`). It is honored in exactly two
places, both in `CliIntegration.ts` (exposed to `CliPromptPreparer` via its deps interface,
`src/core/harness/shared/CliPromptPreparer.ts:50-51`):

- `CliIntegration.formatDirectFileRef` (`src/core/harness/CliIntegration.ts:307-314`)
- `CliIntegration.formatTempFileRef` (`src/core/harness/CliIntegration.ts:323-332`)

It is **not** honored in `ContextExpander.buildAttachmentXml` /
`buildDirectoryAttachmentXml` (`src/utils/ContextExpander.ts`), which hard-code the
as-typed relative `ref.path` into the excerpt XML's id/description regardless of any flag.
That's the render-time gap this plan closes.

**Multi-root has a second, unconditional bug — resolution, not rendering**:
`ContextExpander.resolveWorkspacePath` (`src/utils/ContextExpander.ts:492-515`) resolves
relative refs against the **primary root only**; `trustedRoots` is used solely for the
path-containment security check. A ref relative to a secondary root resolves against the
primary root, fails `fs.access`, and is silently skipped (`ContextExpander.ts:234`). And on
the authoring side, `getNormalizedWorkspaceRelativePath` (`src/completions/
CompletionHelpers.ts:224-226`) calls `vscode.workspace.asRelativePath(fileUri, false)` —
no folder prefix — so two roots can produce the identical ref for two different files.

---

## Decision

1. **Stored workflow text stays relative, always.** Completions never insert absolute paths;
   no setting changes that. Portability of workflow files across machines/teammates/worktrees
   is non-negotiable.
2. **Multi-root uses folder-name-prefixed relative refs** (`@root2/src/index.ts`) as the
   stored form. `vscode.workspace.asRelativePath(uri, true)` produces exactly this, and folder
   names come from the shared `.code-workspace`, so they're identical for every teammate.
   `FileReferenceParser` needs **zero changes** — `root2/src/index.ts` is already a valid path
   token; only resolution changes (the earlier draft rejected this syntax claiming it needed
   parser support — that claim was wrong).
3. **One global boolean setting** governing *rendering only*: `ui.useAbsolutePathReferences`.
   When effective, the final prompt uses absolute paths uniformly across temp prompt file
   refs, direct `@file` refs, and excerpt XML paths — never mix relative and absolute for the
   same file within one prompt.
4. **Multi-root forces the rendered form to absolute, unconditionally, in VS Code.** The
   harness CLI runs with a single cwd; a `root2/...` ref relative to that cwd would be wrong.
   No user override — the stored form stays portable either way, so nothing is lost.
5. **Single-root: user opt-in**, default `false` (matches today's behavior; only Antigravity
   deviates, via its own hard requirement below).
6. **Applies to all harnesses.** It sits alongside, not instead of, the per-provider
   `usesAbsoluteFileReferences` hard requirement — Antigravity keeps forcing absolute
   rendering regardless of setting or root count.
7. **CLI binary never force-enables it.** `CliAdapter.getWorkspaceRoots()` always returns a
   single root (`src/platform/CliAdapter.ts:117-119`), so the multi-root branch can never
   trigger there; CLI users get the plain user-setting value.

Effective value, computed once per prompt build (not read as a raw setting in each
consumer):

```
effectiveAbsolute = provider.config.usesAbsoluteFileReferences   // hard requirement (Antigravity)
                  || (isMultiRootWorkspace() ? true : userSetting)
```

---

## Design

### Part 1 — Multi-root refs that are both portable and unambiguous

This part is unconditional (no setting involved): it fixes the multi-root correctness bug.

**Insertion** (`src/completions/CompletionHelpers.ts`): in multi-root, build the ref path
with `vscode.workspace.asRelativePath(uri, true)` (folder-name prefix) instead of `false`.
Call sites: `getNormalizedWorkspaceRelativePath` (line 224-226, used by file/dir and
prompt-file completions), symbol completions (line 509), selection completions (line 580).
Single-root keeps today's unprefixed form. Filtering/sorting/labels can keep using the
prefixed path as-is — it's still a normal relative path to the matcher.

**Resolution** (`src/utils/ContextExpander.ts`): teach `resolveWorkspacePath` about named
roots. `ContextExpander` today receives `additionalTrustedRoots: string[]` — paths only —
but folder-name prefixes may be custom names from the `.code-workspace`, not directory
basenames. Extend the constructor to accept named roots (`{ name, fsPath }[]`; the shape
already exists as `ResolverWorkspaceFolder` in `src/platform/WorkspaceRootResolver.ts`).
Resolution order for a relative ref:

1. If the first path segment equals a trusted root's folder name (or, as fallback, its
   basename), resolve the remainder against that root.
2. Otherwise resolve against the primary root, as today.

**No existence-probing fall-through across roots.** Pre-release, there are no legacy
multi-root workflows to keep working — and unprefixed secondary-root refs have never worked
anyway (they resolve against the primary root and are silently skipped,
`ContextExpander.ts:234`). An unprefixed ref simply means "relative to the primary root."
This keeps resolution deterministic and `resolveWorkspacePath` **synchronous** — no async
change needed. Do upgrade the current silent skip to a warning that suggests the
folder-prefixed form when the workspace is multi-root. The path-containment check against
`trustedRoots` is unchanged.

**Directory refs resolve separately**: `buildDirectoryAttachmentXml`
(`src/utils/AttachmentBuilders.ts:85-113`) does its own `path.resolve(workspaceRoot,
normalizedPath)` (line 94-95) — same primary-root-only bug for `@dir/` refs. Give it the
same named-root resolution (accept named roots, or have `ContextExpander` resolve first and
pass the absolute path in).

**Plumbing the names**: `PlatformAdapter.getWorkspaceRoots()` returns `string[]`. Either add
`getNamedWorkspaceRoots(): ResolverWorkspaceFolder[]` to the adapter (VS Code: from
`vscode.workspace.workspaceFolders`; CLI: single `{ name: basename(cwd), fsPath: cwd }`), or
derive basenames when only paths are available. Prefer the former — custom folder names in a
`.code-workspace` are exactly the multi-root case this exists for. `ContextExpander`
construction sites to update: `HarnessIntegration.buildPromptSections`
(`src/core/HarnessIntegration.ts:412-415`) and `WebviewMessageRouter`
(`src/ui/WebviewMessageRouter.ts:2236` — that one is attachment token counting, so it needs
the named roots for correct resolution but **not** the render flag; counts are the same
either way).

**Prompt-file references** (`getPromptFileCompletions`'s `./${relativePath}` insertText,
`CompletionHelpers.ts:880`): these are resolved by ctrlyoke itself, not the harness, so they
stay relative unconditionally. The resolver is `PromptFileParser.resolvePromptFilePath`
(`src/core/PromptFileParser.ts:242-281`), which already tries a candidate chain (absolute →
containing prompt file's directory → workspace root → `.ctrlyoke` dir) — add a
folder-name-match candidate (same rule as `resolveWorkspacePath`) rather than probing every
trusted root, so both resolvers stay consistent and deterministic. Keep the `./` prefix on the inserted text even in multi-root
(`./root2/prompts/x.prompt.md`): `looksLikeFilePath` (`src/utils/promptPathUtils.ts:25-58`)
requires a `./`, `../`, `/`, or drive-letter start to treat the value as a path at all, so
the folder prefix goes after the `./`.

### Part 2 — Render-time absolute conversion (the setting)

#### New helper — `isMultiRootWorkspace()`

Add to `src/platform/VsCodeWorkspaceRoot.ts` (the existing VS Code-only binding module,
alongside `getVsCodeWorkspaceRoot`/`getVsCodeTrustedWorkspaceRoots`):

```ts
export function isMultiRootWorkspace(): boolean {
  return (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
}
```

CLI code must never call this (same rule this file already documents for its siblings).
Completions (Part 1) also use it to pick prefixed vs. unprefixed insertion.

#### New pure helper — resolve the effective flag

A small pure function (in `WorkspaceRootResolver.ts` or a sibling) so the decision logic is
unit-testable without faking `vscode`:

```ts
export function resolveEffectiveAbsoluteReferences(
  userSetting: boolean,
  isMultiRoot: boolean,
  providerRequiresAbsolute?: boolean
): boolean {
  return !!providerRequiresAbsolute || (isMultiRoot ? true : userSetting);
}
```

#### Setting — `ui.useAbsolutePathReferences`

Semantics: "send absolute file paths to the harness/model" — a render preference, invisible
in stored workflow files. Same layer/pattern as the existing
`respectGitignoreForCompletions` (user + workspace scope via `configService`):

- `src/types/CtrlYokeSettings.ts` — add to the `ui` section of `CtrlYokeGlobalSettings`
  (next to `respectGitignoreForCompletions`) and `CTRLYOKE_SETTINGS_DEFAULTS.ui`, default
  `false`.
- `schemas/settings-schema.json` — add the property; run `npm run generate-schema`.
- `src/utils/ConfigurationUtils.ts` — add `shouldUseAbsolutePathReferences(): boolean`
  returning the **raw** setting only (not the multi-root-forced value — keep the pure
  effective-value computation separate so it stays testable and CLI-safe).
- `src/ui/WebviewSettingsSync.ts` / `settingsStore.ts` — sync like other `ui.*` settings,
  plus push whether the workspace is currently multi-root (new — no existing message carries
  this) so the webview can show the toggle as forced-on.
- `src/ui/webview-react/components/settings/GeneralSection.tsx` — new `SettingToggleRow`
  next to the gitignore toggle; when multi-root, render disabled with a note like "Forced on
  — multiple workspace folders are open".

#### Threading the effective flag through prompt building

`HarnessIntegration.buildPromptSections` (`src/core/HarnessIntegration.ts:400-437`) is the
single choke point: it already resolves `workspaceRoot` and `this.getWorkspaceRoots()` and
constructs `ContextExpander`. Compute `effectiveAbsolute` once here per call:

```ts
const effectiveAbsolute = resolveEffectiveAbsoluteReferences(
  ConfigurationUtils.shouldUseAbsolutePathReferences(),
  this.getWorkspaceRoots().length > 1,
  this.provider?.config.usesAbsoluteFileReferences
);
```

then:

- Pass it into `ContextExpander` so `buildAttachmentXml`/`buildDirectoryAttachmentXml`
  render the **resolved absolute path** in the excerpt description when true (they already
  compute it via `resolveWorkspacePath`; today they render the as-typed `ref.path` instead).
  Attachment **ids** keep using the as-typed path — they only need to be stable for
  deduplication within one prompt.
- `CliIntegration.formatDirectFileRef`/`formatTempFileRef` (lines 307-332) currently read
  `this.provider.config.usesAbsoluteFileReferences` directly — change them to consult the
  same computed `effectiveAbsolute`. These methods are invoked through `CliPromptPreparer`'s
  deps, outside `buildPromptSections`, so don't thread the value through call parameters:
  give `CliIntegration` a private `getEffectiveAbsolute()` that calls the same pure helper
  with the same inputs (`ConfigurationUtils.shouldUseAbsolutePathReferences()`,
  `this.platform.getWorkspaceRoots().length > 1`, provider config) — both computations agree
  by construction. `ConfigurationUtils` is backed by the platform-agnostic `configService`
  (no `vscode` import), so this is safe in shared core and the CLI binary.
  (`expandContextSplit`'s `directFileRefs` are already absolute internally; only this
  render-back step is flag-gated.)
- `buildDirectoryAttachmentXml` renders the as-typed `normalizedPath` in its XML id/body —
  when `effectiveAbsolute`, render the resolved absolute directory path in the body (id
  stays as-typed, same rule as file attachments).

#### Provider hard requirement is unchanged

`AntigravityCliProvider`'s `usesAbsoluteFileReferences: true` stays as-is and keeps winning
regardless of the setting or root count — it's a real bug workaround, not a preference.

#### Completions are NOT flag-gated

Deliberately no absolute-path branch in `CompletionHelpers.ts` insertText — that was the
earlier draft's design and it's rejected: it writes machine-specific paths into shareable
workflow files. The only completion change is the multi-root folder prefix (Part 1), which
is unconditional and portable.

---

## Files touched

| File | Change |
| --- | --- |
| `src/completions/CompletionHelpers.ts` | Multi-root: folder-name-prefixed relative insertText (file/dir/symbol/selection/prompt-file) via `asRelativePath(uri, true)` |
| `src/utils/ContextExpander.ts` | Named-root constructor param; folder-name-match resolution in `resolveWorkspacePath` (stays sync); multi-root warning on skipped refs; render absolute excerpt paths when `effectiveAbsolute` |
| `src/utils/AttachmentBuilders.ts` | `buildDirectoryAttachmentXml`: named-root resolution for `@dir/` refs; absolute path in XML body when `effectiveAbsolute` |
| `src/core/PromptFileParser.ts` | `resolvePromptFilePath`: add folder-name-match candidate for multi-root prompt-file refs |
| `src/platform/PlatformAdapter.ts` + `VsCodeAdapter.ts`/`CliAdapter.ts` | `getNamedWorkspaceRoots()` (or equivalent) carrying folder names |
| `src/platform/VsCodeWorkspaceRoot.ts` | Add `isMultiRootWorkspace()` |
| `src/platform/WorkspaceRootResolver.ts` (or sibling) | Add pure `resolveEffectiveAbsoluteReferences()` |
| `src/types/CtrlYokeSettings.ts` | Add `ui.useAbsolutePathReferences` (type + default) |
| `schemas/settings-schema.json` | Add property; regenerate |
| `src/utils/ConfigurationUtils.ts` | Add `shouldUseAbsolutePathReferences()` |
| `src/ui/WebviewSettingsSync.ts`, `settingsStore.ts` | Sync setting + push multi-root state |
| `src/ui/webview-react/components/settings/GeneralSection.tsx` | New toggle, forced-on state when multi-root |
| `src/core/HarnessIntegration.ts` | Compute `effectiveAbsolute` in `buildPromptSections`; pass named roots + flag to `ContextExpander` |
| `src/core/harness/CliIntegration.ts` | `formatDirectFileRef`/`formatTempFileRef` consult computed flag, not just provider config |
| `src/ui/WebviewMessageRouter.ts` | Pass named roots to its `ContextExpander` construction (line 2236; token counting — no render flag needed) |
| `src/test/**` | Unit tests: pure resolver; `ContextExpander` multi-root resolution + both render-flag states; `CliIntegration` format methods; completion prefix behavior |

---

## Non-goals / Open questions

- ~~Root-name-prefixed relative refs rejected as needing new parser support~~ — **reversed**:
  they're the chosen stored form for multi-root. The parser already accepts them as plain
  path tokens; only resolution work is needed, and `asRelativePath(uri, true)` generates the
  form natively.
- **Ambiguity edge case**: in multi-root, a primary-root subdirectory whose name equals
  another folder's name makes step 1 of the resolution order win over a plain-relative
  interpretation. Deterministic and documented; considered acceptable (completions always
  generate the prefixed form in multi-root, so authored refs match step 1 by construction).
- **Token cost**: absolute paths cost more tokens than relative in the *rendered* prompt.
  Accepted — unavoidable for multi-root, opt-in otherwise; stored workflows are unaffected.
- Whether `getWorkspaceRoots().length > 1` (prompt-building path) and `isMultiRootWorkspace()`
  (completion path) agree — both ultimately reflect `vscode.workspace.workspaceFolders.length`
  in VS Code, and `CliAdapter.getWorkspaceRoots()` is hard-coded to one root, so the CLI can
  never accidentally force-enable. Confirm with a test.

---

## Checklist

- [ ] Part 1: named-root plumbing (`getNamedWorkspaceRoots()` or equivalent, both adapters)
- [ ] Part 1: `ContextExpander.resolveWorkspacePath` folder-name-match resolution (+ tests; unprefixed refs resolve against primary root only; multi-root warning suggests prefixed form)
- [ ] Part 1: `buildDirectoryAttachmentXml` named-root resolution for `@dir/` refs
- [ ] Part 1: `PromptFileParser.resolvePromptFilePath` folder-name-match candidate
- [ ] Part 1: `CompletionHelpers.ts` folder-prefixed insertText in multi-root (file/dir/symbol/selection/prompt-file)
- [ ] Part 2: `isMultiRootWorkspace()` + `resolveEffectiveAbsoluteReferences()` (with unit tests)
- [ ] Part 2: `ui.useAbsolutePathReferences` setting: types, schema, `ConfigurationUtils`, defaults
- [ ] Part 2: webview sync (setting + multi-root state); `GeneralSection.tsx` toggle (forced-on styling)
- [ ] Part 2: `HarnessIntegration.buildPromptSections` computes and threads `effectiveAbsolute`
- [ ] Part 2: `ContextExpander` renders absolute excerpt paths when flag is set
- [ ] Part 2: `CliIntegration.formatDirectFileRef`/`formatTempFileRef` consult the computed flag
- [ ] `npm run generate-schema`, `npm run typecheck`, `npm test`
- [ ] Manual: single-root setting off (unchanged); single-root setting on (absolute rendering, relative stored text); multi-root (prefixed completions, forced absolute rendering, toggle disabled, secondary-root refs actually resolve)
