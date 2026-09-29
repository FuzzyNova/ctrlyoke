# Contributing to ctrlyoke

Thanks for your interest in contributing. ctrlyoke is a source-available VS Code extension — see [`LICENSE.md`](LICENSE.md) for the terms your use and contributions fall under.

## Reporting a security vulnerability

**Don't open a public Issue.** See [`SECURITY.md`](SECURITY.md) — report to `security@ctrlyoke.dev` instead.

## Local setup

```powershell
npm ci
npm run compile   # full build (extension + webview)
npm test          # extension + integration + UI tests
npm run lint
```

The full command reference lives in [`.github/copilot-instructions.md`](.github/copilot-instructions.md#common-commands) — that table is the single source of truth for build/test/lint commands, so check there rather than this file if something here goes stale.

One important guardrail: **never run `npm run test:harness`** unless you have a specific reason to. It runs real AI harnesses, costs money, and takes 30+ minutes. `npm test` (which you should use instead) covers everything else.

## Coding principles

This project follows SOLID/DRY, TypeScript strict mode, and single-sourced constants (no hardcoded strings used for `==`/`switch` flow control — those belong in `src/types/DashboardConstants.ts` or `src/types/CtrlYokeTypes.ts`). The full, current set of principles and architectural conventions lives in [`CLAUDE.md`](CLAUDE.md) and [`.github/copilot-instructions.md`](.github/copilot-instructions.md) — read those before making non-trivial changes, especially the `.github/instructions/*.instructions.md` file matching the area of the codebase you're touching (there's a routing table in `CLAUDE.md`).

## Commit messages

Plain [Conventional Commits](https://www.conventionalcommits.org/) style (`feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, …). **No AI-tool attribution trailers** — no `Co-Authored-By:`, no `Generated with …` footers, no model or tool name, no session URL — regardless of what tooling you used to help write the commit. This applies to every commit and PR description in this repo.

## Submitting a change

1. Fork the repo and branch from `main`.
2. Make your change, adding or updating tests alongside it (`src/test/**` for core/orchestration/harness changes, `src/ui/webview-react/test/**` for React dashboard changes).
3. Run `npm test` and `npm run lint` locally before opening a PR — CI runs the same checks (plus a full Electron extension-test suite periodically) and won't pass a PR that skips this.
4. Open a PR against `main` with a clear description of the change and why it's needed. Fill in the PR template's checklist.

Small, focused PRs are easier to review than large ones — if you're planning something big (a new harness, a major refactor), consider opening an issue first to discuss the approach.

## Changing the schemas

`schemas/workflow-schema.json` and `schemas/settings-schema.json` are published at the URL in their `$id` (`https://ctrlyoke.dev/schema/v<N>/…`) by `deploy.yml` whenever `schemas/**` changes on `main`. Each change is one of two kinds:

- **No bump**: adding an optional field an older ctrlyoke can safely ignore, adding an enum value, or editing descriptions. Edit the schema, run `npm run schema:update` to regenerate the YAML schema, UI descriptions, and reference docs, and commit. `v<N>` is updated in place.
- **Bump**: renaming or removing a field, narrowing a type, changing what a field or its default means, or adding a field an older host must not ignore. Before editing, run `npm run schema:bump -- workflow` (or `settings`) on the committed schema. It freezes the published version into `schemas/archive/v<N>/`, moves the `$id` to `v<N+1>`, re-points cross-schema `$ref`s, bumps `CURRENT_SCHEMA_VERSIONS`, and lists what's left: the breaking edit, the migration in `src/utils/FormatMigrations.ts`, a new fixture, and stale URL references.

Files under `schemas/archive/` stay published forever so old `$schema` links keep resolving; never edit them. The full policy is in `dev/implemented/SCHEMA_RELEASE_READINESS_PLAN.md` §2.6–2.7. Until the first release there are no published users to break, so pre-release changes of either kind go in without a bump.

## Cutting a release (maintainers)

Releases are tag-driven, not branch-driven — `main` stays trunk, and a `vX.Y.Z` tag is what actually ships:

1. One commit that bumps `package.json#version` and renames `CHANGELOG.md`'s `## [Unreleased]` heading to `## [X.Y.Z] - <date>`, moving its contents under the new heading.
2. Tag that commit: `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` picks up the tag, verifies it matches `package.json#version`, packages and publishes the VSIX to the Marketplace, and creates a GitHub Release with the matching `CHANGELOG.md` section attached.

**Pre-release channel:** `vsce publish --pre-release` publishes to the Marketplace's opt-in pre-release channel instead of stable. VS Code's convention is `major.EVEN.patch` for stable and `major.ODD.patch` for pre-release (plain `x.y.z` only — semver suffixes like `-beta.1` aren't supported by the Marketplace). This isn't automated by `release.yml`; run it manually when you want a testable build ahead of a stable release.

**Hotfixing a published version:** if `main` has moved on past what's currently live on the Marketplace and a published version needs a fix, cut a release branch from the tag rather than from `main`:

```powershell
git switch -c release/X.Y vX.Y.Z
# fix, bump the patch version, tag vX.Y.Z+1, push the tag to trigger release.yml
# then cherry-pick the fix back onto main
```

Standing release branches aren't used otherwise — the Marketplace serves one version and clients auto-update, so there's nothing to backport to outside an active hotfix.
