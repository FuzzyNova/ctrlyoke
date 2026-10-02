# Offline license `.lic` download is hidden by the import command's file filter

- **Found:** 2026-10-01 by bug-hunt final step (claude-cli)
- **Area:** `src/extension.ts` (`ACTIVATE_OFFLINE_PRO`), `landing/src/pages/license/offline.astro`, `docs/pro/index.md`
- **Resolution:** fixed in this commit

## Symptom

The offline-license page downloads the certificate as `ctrlyoke-<id>.lic`
(`offline.astro` ~302). The **ctrlyoke: Activate Offline (Air-Gapped) License**
command opens a file picker whose default filter is
`"ctrlyoke License": ["license", "txt", "json"]` (`src/extension.ts` ~751), so
the downloaded file does not appear until the user switches to "All Files". An
air-gapped user following the instructions sees an empty folder.

The page's step 4 also says "Choose the file, or paste the complete certificate
text shown above", but the command only opens a file picker; pasting is only
available in the License settings tab.

## Steps to Reproduce

1. Download a certificate from `/license/offline` (saved as `.lic`).
2. Run **ctrlyoke: Activate Offline (Air-Gapped) License** and browse to the
   download folder.
3. The `.lic` file is not listed under the default "ctrlyoke License" filter.

## Root Cause

The filter's extension list was never updated to match the extension the
landing page writes.

## Suggested Fix

- Add `lic` to the "ctrlyoke License" filter (and to any other license-import
  file picker, e.g. one in the License settings tab or the hosted dashboard, so
  every import surface accepts the same extensions; single-source the list if
  more than one place needs it).
- Correct `offline.astro` step 4 to describe what the command does (choose the
  file), and point to the License settings tab for pasting the certificate text.
- Check `docs/pro/index.md` (~96-98) still reads correctly.
