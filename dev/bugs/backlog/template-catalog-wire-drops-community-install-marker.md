# Template catalog sent to the webview drops `communityInstallFile`, so every community install shows as "Name taken"

- **Found:** 2026-11-25 by bug-hunt workflow final step
- **Area:** `src/ui/WorkflowLibraryHandlers.ts` (`toWireTemplates` ~845), `src/types/WebviewMessageTypes.ts` (`OpenNewWorkflowModalMessage["templates"]` ~1229), `src/ui/webview-react/components/settings/CommunityTemplatesPage.tsx` (~228-243)
- **Severity:** high

## Symptom

After installing any template from **Settings → Templates → Browse community templates**,
the row immediately shows **Name taken** with a disabled button. There is no User/Workspace
"Installed in" badge, no **Set defaults** link and no **Uninstall from &lt;scope&gt;** button,
so a library install can never be managed from the library. The legacy-install migration
from `dev/bugs/implemented/legacy-community-template-installs-shown-as-name-taken.md`
has no visible effect either: it writes the marker to disk, and the refreshed catalog
drops it again.

`docs/workflows/templates.md` (community templates section) says an installed row shows the
scope badge, **Set defaults** and **Uninstall from &lt;scope&gt;**.

Unreleased: the marker was introduced by b99a0b8c8, which no `v*` tag contains yet.

## Steps to Reproduce

1. Open the dashboard, then Settings → Templates → Browse community templates.
2. Choose **Install to User** on any entry (e.g. `review-branch`).
3. The file is written with `_templateMeta.communityInstallFile`. The extension sends
   `INSTALL_RESULT` success and then `TEMPLATE_CATALOG_LOADED`.
4. The row shows **Name taken**, and the button is disabled.

## Root Cause

`TemplateManager.discoverTemplatesInDir` sets `communityInstallFile` on each `TemplateInfo`
(`src/core/TemplateManager.ts` ~1287). But `WorkflowLibraryHandlers.toWireTemplates`
(`src/ui/WorkflowLibraryHandlers.ts` ~845-853) copies only a fixed field list (`id`, `name`,
`description`, `variables`, `isBuiltIn`, `source`) and never copies `communityInstallFile`.
Every template-listing message goes through it, including `TEMPLATE_CATALOG_LOADED`
(~972), which `DashboardMessageRouter.refreshTemplateCatalog` sends after install,
uninstall and migration.

`CommunityTemplatesPage.tsx` treats a row as installed only when
`localTemplate?.communityInstallFile === expectedFile`. Because the field is always
undefined, `installed` is false, and any same-id local template sets `nameTaken`.

The wire type hides the gap. `TemplateCatalogLoadedMessage.templates` reuses
`OpenNewWorkflowModalMessage["templates"]`, which declares neither `communityInstallFile`
nor `source`. Meanwhile `uiStore.TemplateInfo` declares `communityInstallFile?`, so the
code type-checks even though the value is always undefined at runtime.
`CommunityTemplatesPage.test.tsx` seeds `templateCatalog` straight into the store with
the field already set, so the extension → webview path is never tested.

## Suggested Fix

- In `toWireTemplates`, forward the marker:
  `...(t.communityInstallFile ? { communityInstallFile: t.communityInstallFile } : {})`.
- Add `source?` and `communityInstallFile?: string` to the
  `OpenNewWorkflowModalMessage["templates"]` item type. Better still, give the item a named
  exported type, and have `uiStore.TemplateInfo` reuse it so the two cannot drift.
- Add a `WorkflowLibraryHandlers` unit test showing that `handleTemplateCatalogRequest` (or
  whichever handler sends `TEMPLATE_CATALOG_LOADED`) forwards `communityInstallFile` for a
  marked install.
