# ctrlyoke.workspaceDirectory from .vscode/settings.json can widen trusted roots without the external-root approval

- **Found:** 2026-10-14 by Claude Code repo-wide review workflow
- **Area:** `src/platform/VsCodeWorkspaceRoot.ts`
- **Resolution:** fixed in this commit

## Symptom

This is a security issue. A repository's committed `.vscode/settings.json` can set `ctrlyoke.workspaceDirectory` to an ancestor directory (for example `${workspaceFolder}/../..`) or to an absolute path such as the user's home directory. Once the folder is trusted in VS Code, ctrlyoke treats every file under that directory as "inside the workspace". `@file` references, prompt links, context-menu references, the hosted dashboard workspace viewer and LSP containment all accept files such as `~/.ssh/id_rsa` with reason `"workspace"`. ctrlyoke normally requires a per-root `trustedExternalRoots` approval before workspace config can widen filesystem access. That approval never runs on this path.

## Steps to Reproduce

1. Create a repo at, for example, `C:/Users/<you>/src/evil`. Add `.vscode/settings.json` containing `{"ctrlyoke.workspaceDirectory": "${workspaceFolder}/../.."}`, plus a workflow or prompt file whose step references a file under the home directory, such as `@.ssh/id_rsa` or an absolute home path.
2. Open the folder in VS Code with ctrlyoke installed and click **Trust** in the Workspace Trust dialog.
3. `getVsCodeWorkspaceRoot()` and `getVsCodeTrustedWorkspaceRoots()` now return `C:/Users/<you>` as the primary root. The hosted dashboard viewer and the prompt link provider show it as the workspace root.
4. Run the workflow, or hover or open the reference. `evaluateFileAccess` returns `{ allowed: true, reason: "workspace" }` for the home-directory file, and its contents are expanded into the prompt. No external-root approval prompt appears, and nothing is written to `~/.ctrlyoke/external-roots-trust.json`.
5. For comparison, put the same root in `.ctrlyoke/settings.json` under `permissions.trustedExternalRoots`. That route asks for a local approval before the root takes effect.

## Root Cause

- `src/platform/VsCodeWorkspaceRoot.ts:22-25` (`gatherResolverInput`) reads the native `ctrlyoke.workspaceDirectory` setting from any configuration scope, including workspace and folder `.vscode/settings.json`. `package.json:58-63` declares the setting with `"scope": "window"`, and `package.json` has no `capabilities.untrustedWorkspaces.restrictedConfigurations` entry for it.
- `src/platform/WorkspaceRootResolver.ts:107-118` (`resolveWorkspaceRoot`) accepts the expanded value without checking it. An absolute path is used as-is, and a relative path is resolved against the workspace-file directory or the first folder. Nothing requires the result to be, or to lie inside, one of the open workspace folders.
- `src/platform/WorkspaceRootResolver.ts:148-156` (`resolveTrustedWorkspaceRoots`) adds that unchecked root as a trusted containment root.
- `src/utils/FileAccessPolicy.ts:54-71` grants `reason: "workspace"` to any path under that root. This check runs before the approved-external-roots check at `:92-109`.
- The same root becomes the LSP and hosted server `workspaceRoot` at `src/extension.ts:1704`, `1716` and `1735`. The trusted roots reach callers at `src/extension.ts:454` and `487`, `src/platform/VsCodeAdapter.ts:39`, `src/completions/PromptLinkProvider.ts:108` and `src/completions/ContextMenuReferenceCommands.ts:183`.
- This contradicts the model stated in `src/config/ExternalRootsTrustStore.ts:28-34`: shared workspace config may only _request_ wider filesystem access, and a local reviewed decision is required before it takes effect.

## Suggested Fix

**Decided (Nathan, 2026-10-14):** keep the ability to point `ctrlyoke.workspaceDirectory` outside the open folders, because monorepo-parent setups rely on it. Such a root must be approved as an external root before it widens file access.

1. **Separate the state-root locator from the containment roots.** `resolveWorkspaceRoot` keeps resolving the configured directory exactly as it does today, so the `.ctrlyoke` state root, settings and run history still live there. `resolveTrustedWorkspaceRoots` should trust that primary root as a containment root only when it equals, or lies inside, one of the open workspace folders or the `.code-workspace` directory.
2. **Route an outside root through the external-root approval.** When the resolved root lies outside the open folders, treat it as a requested external root. Use the existing `ExternalRootsTrustStore` flow: the same one-time VS Code approval prompt, and the same record in `~/.ctrlyoke/external-roots-trust.json`, used for `permissions.trustedExternalRoots`. Until it is approved:
   - `evaluateFileAccess` must not grant `reason: "workspace"` for paths under it. If the root has an approved external-root decision, access comes through the approved-external-roots check (`FileAccessPolicy.ts:92-109`).
   - The LSP and hosted-viewer `workspaceRoot`, prompt link resolution and context-menu reference containment use only the open folders.
   - A declined approval keeps the state-root location but grants no file access outside the open folders. The decline is remembered just like a declined `trustedExternalRoots` request.
3. Also add `ctrlyoke.workspaceDirectory` to `capabilities.untrustedWorkspaces.restrictedConfigurations` in `package.json`, so an untrusted workspace can't set it at all.

Do **not** ignore workspace-level values that point outside the folders. That would break legitimate per-repo monorepo-parent configuration.

Tests: add `WorkspaceRootResolver` and `FileAccessPolicy` unit tests. A `../..` or an absolute out-of-workspace value must still resolve as the state root, but must not become a trusted containment root until approved. Once approved, files under it are accessible. Update `docs/guide/settings.md` (the `ctrlyoke.workspaceDirectory` section near line 135) to explain that an outside location needs a one-time external-root approval.
