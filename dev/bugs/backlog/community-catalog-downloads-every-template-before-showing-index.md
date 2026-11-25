# The community template catalog downloads every library template before it shows the index

- **Found:** 2026-11-25 by bug-hunt workflow final step (review of 5a6d6686d)
- **Area:** `src/ui/CommunityTemplateService.ts` (`handleRequestIndex` ~78-130)
- **Severity:** medium (the library page gets slower as the library grows, and waits up to the per-request download timeout per entry when the CDN is slow)

## Symptom

Opening the community template library, or refreshing it, shows nothing until ctrlyoke has
downloaded every template in the library, one after another. This happens on every
`REQUEST_COMMUNITY_TEMPLATE_INDEX`, even when the index itself came from the in-memory
cache and even when the user has never installed a single community template.

## Steps to Reproduce

1. Open the dashboard's community template library with no community templates installed.
2. Watch the network traffic (or add a `Log.debug` in `CommunityTemplateClient.fetchTemplate`).
3. One `fetchTemplate` request runs per library entry, sequentially, before
   `COMMUNITY_TEMPLATE_INDEX_RESULT` is emitted. Reopening the page repeats all of them.

## Root Cause

5a6d6686d added the legacy-install migration directly into `handleRequestIndex`. The loop
awaits `this.client.fetchTemplate(entry)` for every entry with a recognised format, and
only then calls `TemplateManager.markLegacyCommunityInstall` for the User and Workspace
scopes. `markLegacyCommunityInstall` (`src/core/TemplateManager.ts` ~997) returns `false`
straight away when no file exists at the expected install path, or when the file already
carries an install marker (its bytes then differ from the library copy), so nearly every
download is wasted. The index result waits for the whole loop.

The new service tests (`src/test/unit/CommunityTemplateService.test.ts` ~167-215) record
the installer's legacy checks into `legacyChecks` but never assert on them, so the
service-side wiring has no test that fails without it.

## Suggested Fix

- Only download an entry when one of its scopes holds an unmarked local file at
  `getCommunityInstallFileName(entry.id, entry.file)`: add a cheap installer check (for
  example `TemplateManager.hasUnmarkedCommunityInstallCandidate(name, scope, file)`, which
  stats the path and checks for the marker without the library content), and skip the
  download otherwise.
- Emit `COMMUNITY_TEMPLATE_INDEX_RESULT` first, then run the (now rare) migration
  downloads in parallel, and call `refreshTemplateCatalog` if any copy was marked.
- Tests: no local files means no `fetchTemplate` calls and the index is emitted; one
  unmarked matching file in each scope is checked with the downloaded content and
  triggers `refreshTemplateCatalog`; a failing download still leaves the index emitted.
