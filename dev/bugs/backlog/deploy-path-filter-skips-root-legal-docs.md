# deploy.yml path filter skips the root legal docs, src/license and netlify/

- **Found:** 2026-10-17 by release-ready audit workflow (Claude, landing auditor, confirmed by verifier)
- **Area:** `.github/workflows/deploy.yml` (~L12-27), `.github/workflows/deploy-preview.yml` (~L8-20)
- **Severity:** medium

## Symptom

A commit that changes only `PRIVACY.md` (for example the upcoming DataRep Article 27 contact
details) does not redeploy ctrlyoke.dev, so `/privacy/` keeps serving the old text. The same
applies to `LICENSE.md`, `DPA.md`, `ENTERPRISE_TERMS.md`, `TRUST_PAGE.md`, `src/license/**` (the
checkout URLs and variant IDs the landing imports) and `netlify/**` (webhook functions). The
Enterprise checkout's recorded `terms_versions` is read from those documents at build time, so it
also stays stale until something else triggers a deploy.

## Steps to Reproduce

1. Commit a change to `PRIVACY.md` only and push to `main`.
2. No deploy run starts. `ctrlyoke.dev/privacy/` still shows the previous version.

## Root Cause

The landing pages import these files from outside `landing/`: `privacy.astro`, `terms.astro`, the
`dpa`/`trust` pages and `enterprise/checkout.astro` import the root legal documents and
`src/license/*`. The push `paths:` filter lists only `landing/**`, `docs/**`, `images/**`,
`schemas/**`, `README.md`, a few scripts, `netlify.toml` and `package*.json`. The comment above the
filter mentions `workflow_dispatch` for out-of-filter changes, but the Phase 7 DataRep step in the
checklist does not mention redeploying.

## Suggested Fix

Add `LICENSE.md`, `PRIVACY.md`, `DPA.md`, `ENTERPRISE_TERMS.md`, `TRUST_PAGE.md`, `src/license/**`
and `netlify/**` to the `paths:` of both deploy workflows. Until then, run `deploy.yml` with
`workflow_dispatch` after the DataRep `PRIVACY.md` commit, and check that `/privacy/` shows the new
version.
