# A template copied from an installed community template inherits its install marker, so Uninstall deletes the copy

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli subagent, confirmed by probe against `out/`)
- **Area:** `src/core/TemplateManager.ts`, `src/ui/webview-react/components/settings/CommunityTemplatesPage.tsx`
- **Severity:** high (deletes a user-authored template; the protection b99a0b8c8 added is bypassed)

## Symptom

A custom template created from an installed community template is treated as
a community install. Settings → Templates offers **Uninstall from <scope>** on
the user's own copy, and uninstalling deletes it, including any edits made to
it since.

## Steps to Reproduce

1. Install community template `review-branch` to Workspace scope.
2. New Workflow → pick `custom:workspace:review-branch` → **New template...**
   (`TemplateModal.tsx`), name it `review-branch`, User scope, YAML format.
3. Edit the new User-scope copy.
4. Settings → Templates, User scope: the row shows a User badge and
   **Uninstall from User** instead of **Name taken**.
5. Uninstall: the user's edited copy is deleted.

Variant: create the copy in JSON format. The file is
`review-branch.ctrlyoke.json` but its `_templateMeta.communityInstallFile` is
still `review-branch.ctrlyoke.yaml`. The page compares the marker with the
catalog's expected file and offers Uninstall; `uninstallCommunityTemplate`
compares it with the file on disk and refuses with "is not recorded as a
community install". The UI and backend disagree.

## Root Cause

- `TemplateManager.createCustomTemplate` (`src/core/TemplateManager.ts:865-868`)
  builds the copy's meta as `{ ...existingMeta, name }`, so
  `communityInstallFile` is carried over from the base template. The same
  helper path is shared with `saveWorkflowAsTemplate` (see the comment at
  `TemplateManager.ts:729`); check whether it carries the marker too.
- `uninstallCommunityTemplate` (`TemplateManager.ts:1100-1127`) trusts the
  marker whenever it equals `<name><ext>`.
- `discoverTemplatesInDir` (`TemplateManager.ts:~1201`) puts the marker on the
  wire verbatim, and `CommunityTemplatesPage.tsx:232-240` compares it with the
  catalog's expected file name rather than with the discovered file.

## Suggested Fix

1. Strip `communityInstallFile` from the meta whenever ctrlyoke writes a new
   template from an existing one (`createCustomTemplate`, and
   `saveWorkflowAsTemplate` if it copies meta).
2. In `discoverTemplatesInDir`, report `communityInstallFile` only when it
   equals the discovered file's basename, so the dashboard and
   `uninstallCommunityTemplate` apply the same test.
3. Tests: a copy of an installed community template has no marker and cannot
   be uninstalled; a template whose marker names another extension is not
   reported as installed.
