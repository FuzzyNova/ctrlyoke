# Community templates installed by 0.9.0/0.10.0 show as "Name taken" and can no longer be managed from the library

- **Found:** 2026-11-25 by bug-hunt workflow final step (review of b99a0b8c8)
- **Area:** `src/ui/webview-react/components/settings/CommunityTemplatesPage.tsx` (~228-243, 315, 332), `src/core/TemplateManager.ts` (`uninstallCommunityTemplate` ~1016), `src/ui/CommunityTemplateService.ts` (`handleUninstall` ~149)
- **Severity:** medium (upgrade regression for every existing community-template user)

## Symptom

b99a0b8c8 fixed same-id user templates being deleted by community **Uninstall** by recording
`_templateMeta.communityInstallFile` at install time and treating only marked files as
library installs. Every template installed from the library by a released ctrlyoke
(community templates and Uninstall shipped in v0.9.0 and v0.10.0; `git tag --contains
97d1bc402`) has no marker. After upgrading, each of those rows:

- shows **Name taken** and a disabled button instead of **Uninstall from <scope>**,
- loses its User/Workspace "Installed in" badges and its **Set defaults** link,
- cannot be reinstalled either, because the file name is occupied.

The user's only way out is the template manager, as the docs now say
(`docs/workflows/templates.md`, "Older copies without install information are left in
place"). The change is recorded under **Fixed** in `CHANGELOG.md`, not **Changed**.

The bug report the fix resolved
(`dev/bugs/implemented/community-template-uninstall-deletes-user-template-with-same-id.md`,
"Suggested Fix") called for this compatibility path: treat an unmarked file whose
contents byte-match the library's current file as a library install. The fix left it out.

## Steps to Reproduce

1. With v0.10.0, install a community template (e.g. `review-branch`) to User scope. The
   file `~/.ctrlyoke/templates/review-branch.ctrlyoke.yaml` is the library file verbatim,
   with no `communityInstallFile`.
2. Upgrade to `main` and open Settings → Templates → community library.
3. Observed: the `review-branch` row says **Name taken**, with no badge, Set defaults, or
   Uninstall. Expected: the row is recognised as installed and can be uninstalled, as before
   the upgrade.

## Root Cause

`CommunityTemplatesPage` derives `installed` only from
`localTemplate?.communityInstallFile === expectedFile`, and
`TemplateManager.uninstallCommunityTemplate` refuses any file without the marker. Nothing
recognises a pre-marker install.

## Suggested Fix

Add the migrate-on-read compatibility path the original report asked for:

- Backend: when a same-id unmarked file exists at the expected install path
  (`getCommunityInstallFileName(id, entry.file)` in the scope's templates dir), and its
  contents byte-match the library's current file for that entry (fetched with
  `CommunityTemplateClient.fetchTemplate`), treat it as a library install. Either let
  uninstall delete it, or (simpler for the UI) stamp the marker into it once. For the UI
  to show it as installed, the catalog needs the verdict: e.g. a
  `CommunityTemplateService` check that runs when the page loads the index and reports
  "legacy install" ids, or a backend stamping pass over unmarked same-id files that byte-
  match their library entry.
- An unmarked file that does not byte-match keeps today's protection (**Name taken**,
  refuse uninstall), because it may be the user's own or an edited copy.
- Move the CHANGELOG line (or add one) under **Changed** describing what still needs manual
  removal.
- Tests: an unmarked file identical to the library content is shown as installed and
  uninstalls; an unmarked file that differs is still refused.
