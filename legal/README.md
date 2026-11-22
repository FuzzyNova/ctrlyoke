# Legal document versions

ctrlyoke has five versioned legal documents. Each lives at the repo root, where the
site, the VSIX and the npm package read it:

| Document                      | Root file             | Current page         | Archived versions              |
| ----------------------------- | --------------------- | -------------------- | ------------------------------ |
| Commercial License (EULA)     | `LICENSE.md`          | `/terms/`            | `/terms/<version>/`            |
| Enterprise Subscription Terms | `ENTERPRISE_TERMS.md` | `/enterprise-terms/` | `/enterprise-terms/<version>/` |
| Privacy Policy                | `PRIVACY.md`          | `/privacy/`          | `/privacy/<version>/`          |
| Data Processing Agreement     | `DPA.md`              | `/dpa/`              | `/dpa/<version>/`              |
| Contributor License Agreement | `CLA.md`              | `/cla/`              | `/cla/<version>/`              |

Every version that has been published stays online at its permanent URL, for example
[ctrlyoke.dev/terms/2.2/](https://ctrlyoke.dev/terms/2.2/). The license ties each copy of
ctrlyoke to the version in effect when it was obtained (EULA §16(e)). Pro and Enterprise
orders record the versions the buyer accepted (`eula@2.3; privacy@1.7; …`), and a
contributor's pull request records the CLA version they agreed to, so those exact texts
must stay retrievable. Both checkouts link the versioned URLs.

## How the archive works

- [`versions.json`](versions.json) lists each document and every published version: its
  publication date and the SHA-256 of its text, oldest first.
- `archive/<document>/<version>.md` is that text, byte for byte as published. Prettier
  ignores this folder, and nothing may edit it.
- `npm run check:legal` (part of `check:fast`, so the pre-push hook and CI run it) and
  the landing build both fail when:
  - a root document changed without a new `**Version:**` (a published version is
    never edited, not even for a typo);
  - a root document's version is not archived yet;
  - an archived text no longer matches its recorded hash, or is missing or unlisted.
- `npm run legal:archive` copies each root document whose version is not archived yet
  into `archive/` and adds it to `versions.json`, dated today (`-- --date YYYY-MM-DD` to
  set another publication date). It never overwrites an archived version.

The rules live in [`scripts/legal-archive.mjs`](../scripts/legal-archive.mjs).

A version counts as published once it is pushed to `main`, which deploys the site. Until
then, an approved but unpushed version may still be replaced: delete its archive file and
`versions.json` entry, update the root document, and run `npm run legal:archive` again.

## Other legal notices

- [`OPEN_MATERIALS_EARLIER_RELEASES.md`](OPEN_MATERIALS_EARLIER_RELEASES.md) (November 21, 2026) extends the MIT-0 grant for Open Materials to releases v0.1.1 through v0.8.0. Dated
  notices like this are never edited; publish a correction as a new dated notice.

## Releasing a new version (for example, license 2.4)

**1. Draft.** Write the draft and the counsel memo in `dev/active/` (for example
`LICENSE_2.4_DRAFT.md` and `LICENSE_2.4_LAWYER_REVIEW.md`). Leave the root document alone
until counsel approves: the check rejects any edit to it that lacks a version bump.

**2. Adopt, in one commit**, once counsel has approved:

1. Copy the approved text into the root document. Set `**Version:**`, set the effective
   or version date to the publication date, and remove any draft banner.
2. Apply any companion changes counsel approved to the other documents. Give each
   changed document its own new version and date.
3. For the license, review `landing/src/legal/license-summary.md` against the new text
   and set its `licenseVersion`. The terms page refuses to build until you do.
4. Run `npm run legal:archive`, then `npm run check:legal`, then build the site
   (`npm run build` in `landing/`).
5. Add a **Changed** entry to `CHANGELOG.md` under `## [Unreleased]`.
6. `git mv` the draft and memo from `dev/active/` to `dev/implemented/`, and note the
   adoption date in the memo.

**3. Publish.** Pushing to `main` deploys the site. The new version becomes the current
page, its permanent URL goes live, and the previous version stays at its own URL marked
as archived. The next release ships the new text in the VSIX and npm package.

**4. Follow up.**

- Place a test-mode Enterprise order and check that it records the new versions.
- Give any notice the documents require. For example, Enterprise Terms changes reach an
  existing Enterprise customer at renewal, after 30 days' notice to its billing contact.
- Work through the open items in the counsel memo's publication checklist.

## Adding a new legal document

1. Give the root document a `**Version:** x.y` line.
2. Add it to `documents` in `versions.json`. In `landing/src/legal/archive.ts`, add it to
   `LegalDocumentId` and to the `currentRaw` glob pattern.
3. Add its current page with `<LegalVersionHistory>` and a `[version].astro` route, copying
   the existing ones (for example `landing/src/pages/cla.astro` and `landing/src/pages/cla/`).
4. Add the root file to the `paths` filters in `.github/workflows/deploy.yml` and
   `deploy-preview.yml`, so a change to it redeploys the site.
5. Run `npm run legal:archive`.
