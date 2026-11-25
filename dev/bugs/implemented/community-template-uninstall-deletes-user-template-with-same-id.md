# Community template "Uninstall" deletes the user's own template that shares the id

- **Found:** 2026-11-25 by bug-hunt workflow final step (Claude subagent, reproduced against compiled `out/`)
- **Area:** `src/ui/webview-react/components/settings/CommunityTemplatesPage.tsx` (~87-90, 228, 318-321, 358-364), `src/ui/CommunityTemplateService.ts` (`handleUninstall` ~146), `src/core/TemplateManager.ts` (`uninstallCustomTemplate` ~990-1000, `getCustomTemplateExtension` ~444), `src/utils/CommunityTemplateClient.ts` (~42)
- **Resolution:** fixed in this commit

## Symptom

Settings → Templates → community library marks a library entry as installed whenever
any custom template with the same id exists in the active scope — including one the user
wrote themselves. The row then offers **Uninstall from <scope>**. Confirming deletes the
user's file. The confirm dialog names the library's file (e.g.
`.ctrlyoke/templates/review-branch.ctrlyoke.yaml`) while the file actually deleted can be a
different one (`review-branch.ctrlyoke.json`). With "Also clear its saved values" ticked,
the user's saved variable values are wiped too.

Since e90920625 dropped the author prefix, library ids are plain slugs (`review-branch`),
so a clash with a user template is likely.

## Steps to Reproduce

1. Create your own workspace template `review-branch` (e.g. `TemplateManager.createCustomTemplate("review-branch", "workspace", "json")` → `.ctrlyoke/templates/review-branch.ctrlyoke.json`).
2. Open the community templates page while the library contains an entry `review-branch`
   (file `review-branch.ctrlyoke.yaml`). The entry shows the Workspace badge and an
   Uninstall button.
3. Click Uninstall and confirm (sends `{ id: "review-branch", scope: "workspace" }` to
   `CommunityTemplateService.handleUninstall`).
4. Observed: success; the log says it deleted `.../review-branch.ctrlyoke.json`; the user's
   template is gone. Expected: a template the user wrote is never presented as a
   community install and cannot be deleted from this page.

### Related, low severity

A library entry whose file is `.ctrlyoke.yml` (accepted by `CommunityTemplateClient.ts`
~42) is written as `.ctrlyoke.yaml` (`getCustomTemplateExtension`), but the install
tooltip (`CommunityTemplatesPage.tsx` ~233) and the uninstall dialog (~361) show the
`.yml` path. Latent while the library only publishes `.ctrlyoke.yaml`.

## Root Cause

ctrlyoke never records which templates came from the library. The page derives
"installed" from `installedIds.has(buildCustomTemplateId(activeScope, entry.id))` over the
whole catalog, and the backend `uninstallCustomTemplate` deletes the first
`<id>.ctrlyoke.{yaml,yml,json}` it finds without checking that it is the file the dialog
named or that it came from the library. `handleUninstall` deliberately skips the index so
a template that has left the library can still be removed, so nothing upstream checks
either. `dev/implemented/COMMUNITY_TEMPLATES_PLAN.md` (~365) only planned a disabled
"Installed" state for a same-id template; Uninstall (97d1bc402) was added without a
provenance check.

## Suggested Fix

- Backend: uninstall must delete only the exact file the library installed
  (`<scope dir>/<id>` plus the extension install actually writes), and must refuse when the
  file there is not a library install. Record provenance at install time, e.g. an
  additive optional field under the template's `_templateMeta` (an additive optional
  schema field needs `npm run schema:update`, not a bump), or a small per-scope record
  (a new persisted file needs a `schemaVersion`). Templates installed by 0.9.0/0.10.0 have no marker: treat a file
  whose contents byte-match the library's current file as a library install, and otherwise
  refuse with a message telling the user to delete it by hand.
- UI: show a same-id template that is not a library install as "Name taken" (disabled
  install, no Uninstall, no scope badge).
- Build the displayed install/uninstall path from the extension that is actually written.
- Tests: a user-authored same-id template is not offered for uninstall and the backend
  refuses to delete it; a library install still uninstalls.
