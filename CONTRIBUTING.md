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
3. Run `npm test` and `npm run lint` locally before opening a PR. CI (`.github/workflows/ci.yml`) runs everything `npm test` does, plus typecheck, lint, format and a production build, on every PR, and it must pass before the PR can merge. Workflows on a first-time contributor's PR start only after a maintainer approves them.
4. Open a PR against `main` with a clear description of the change and why it's needed. Fill in the PR template's checklist. Submitting a PR grants the contribution license in [`LICENSE.md` §5(c)](LICENSE.md#c-contributions), and every PR needs a code owner's review.

Small, focused PRs are easier to review than large ones — if you're planning something big (a new harness, a major refactor), consider opening an issue first to discuss the approach.

## Changing the schemas

`schemas/workflow-schema.json` and `schemas/settings-schema.json` are published at the URL in their `$id` (`https://ctrlyoke.dev/schema/v<N>/…`) by `deploy.yml` whenever `schemas/**` changes on `main`. Each change is one of two kinds:

- **No bump**: adding an optional field an older ctrlyoke can safely ignore, adding an enum value, or editing descriptions. Edit the schema, run `npm run schema:update` to regenerate the YAML schema, UI descriptions, and reference docs, and commit. `v<N>` is updated in place.
- **Bump**: renaming or removing a field, narrowing a type, changing what a field or its default means, or adding a field an older host must not ignore. Before editing, run `npm run schema:bump -- workflow` (or `settings`) on the committed schema. It freezes the published version into `schemas/archive/v<N>/`, moves the `$id` to `v<N+1>`, re-points cross-schema `$ref`s, bumps `CURRENT_SCHEMA_VERSIONS`, and lists what's left: the breaking edit, the migration in `src/utils/FormatMigrations.ts`, a new fixture, and stale URL references.

Files under `schemas/archive/` stay published forever so old `$schema` links keep resolving; never edit them. The full policy is in `dev/implemented/SCHEMA_RELEASE_READINESS_PLAN.md` §2.6–2.7. Since the first public release (`0.2.0`), every breaking change needs the bump and its migration; there is no unreleased exemption.

## Deprecations

When a CLI flag, `--json` envelope field, exit code, MCP tool or tool input, command ID or setting key has to go, deprecate it first rather than removing it outright. Keep the old form working, or make it fail with an error that says why, and note the deprecation under **Changed** in `CHANGELOG.md`. Workflow and settings schema fields follow [Changing the schemas](#changing-the-schemas) instead.

A deprecated item can be removed once both of these hold:

1. It has shipped as deprecated in at least one tagged release, with its changelog entry. A deprecation still under `## [Unreleased]` hasn't started its clock.
2. At least six months have passed since that release. The removal then lands in the next minor release (`0.x`) or major release (`1.0` onward), never in a patch.

Record the removal in `CHANGELOG.md` too. When you deprecate something, add a removal plan under `dev/backlog/` whose filename ends with the earliest removal date (for example `REMOVE_ADDITIONAL_ARGS_4-24-27.md`), so overdue removals are easy to spot. If removing an input would let a call silently succeed with the field ignored, keep the explicit rejection after the removal.

## Versions on `main`

`package.json#version` on `main` is the **next** release, not the last one. Right after a release publishes, `main` is bumped to the next patch version (step 7 below), so a build from `main` never reports a version that is already on the Marketplace or npm.

- **A version is released only once its `vX.Y.Z` tag exists**, because pushing the tag is what publishes. `git fetch --tags` and then `git tag --list "v*" --sort=-v:refname` gives the latest release first. `npm view ctrlyoke version` shows what npm serves, which lags the tag until the staged package is approved. Never decide whether a version is released from `package.json` or `CHANGELOG.md`.
- **Changelog entries stay under `## [Unreleased]`** until the release commit. The post-release bump changes only `package.json` and `package-lock.json` and never adds a version heading.
- **When docs or messages name the last version with old behavior** ("runs recorded by ctrlyoke X or earlier"), X is the latest tag. Don't use `package.json`'s version, which isn't released yet.
- The bump assumes the next release is a patch. If it turns out to be a minor or major release, the release commit sets that version instead.

## Cutting a release (maintainers)

Releases are tag-driven, not branch-driven — `main` stays trunk, and a `vX.Y.Z` tag is what actually ships:

0. **Refresh `testedWith`.** Update every harness CLI to its latest release, run `npm run test:harness` once, and set each provider's `config.versionPolicy.testedWith` to the version in the run's report (`.ctrlyoke/logs/test-runs/harness-<time>.json`), then `npm run generate-compatibility-docs`. A failing live case may be the model rather than the CLI: re-run just that case (`npx mocha --ui tdd --timeout 900000 --grep "<case>" "out/test/harness/**/*.test.js"`) before deciding, and never record a `testedWith` that has not passed. `testedWith` never warns users, so this is safe right before a release; `minimum` is moved separately, early in a cycle. See [`dev/reference/HARNESS_VERSION_SUPPORT.md`](dev/reference/HARNESS_VERSION_SUPPORT.md).
1. **Run the pre-release chores** in [`CHORES.md`](CHORES.md): `npm run chores -- --task sync-models`, `--task sync-model-pricing`, `--task sync-skills-snapshot`, and `npm update` + `npm audit`. The skills.sh snapshot needs the Vercel CLI, logged in and linked on this machine, and a fresh token from `vercel env pull .env.local`; see [chore #7](CHORES.md#7-skillssh-top-skills-snapshot) for the one-time setup. Hold back any dependency whose update fails `npm test`, and any native dependency (such as `node-pty`) the harness suite did not run against; say why in the commit message. Then `npm run schema:update` if a schema changed, `npm run format`, and `npm test`.
   - **Nothing may write `out/` while `npm run test:harness` runs**, because the suite drives the compiled CLI. That rules out `npm test`, `npm run schema:update` (its docs step runs `compile-tests`), `npm run compile*`, `npm ci`/`npm update`, and `git push` (the pre-push hook runs `check:fast`, which compiles). The model sync chores only write `src/` and are safe to run alongside.
2. **One release commit** that sets the version (`npm version X.Y.Z --no-git-tag-version --allow-same-version`, which also updates `package-lock.json`; `main` is usually already at `X.Y.Z` from step 7 of the previous release) and renames `CHANGELOG.md`'s `## [Unreleased]` heading to `## [X.Y.Z] - <date>`, moving its contents under the new heading and leaving an empty `## [Unreleased]` above it. Note the refreshed "Tested with" versions under **Changed**. Push `main`.
3. **Tag that commit**: `git tag -a vX.Y.Z -m "vX.Y.Z"` and `git push origin vX.Y.Z`. This publishes; there is no later confirmation step.
4. `.github/workflows/release.yml` picks up the tag. It first runs `ci.yml`, the same gate every PR passes (extension-host, UI and packaging tests, typecheck, lint, format, production build), against the tagged commit, so there is nothing to dispatch by hand beforehand. Only if it passes does it verify the tag matches `package.json#version`, publish the VSIX to the Marketplace, create a GitHub Release with the matching `CHANGELOG.md` section, and stage the npm CLI package. If a gate fails, nothing is published: fix it on `main`, then delete and re-push the tag (`git push origin :refs/tags/vX.Y.Z`, `git tag -d vX.Y.Z`, and tag the fixed commit).
5. **Approve the staged npm package** on npmjs.com → `ctrlyoke` → Staged Packages (or `npm stage approve <id>`, with the id in the release run's "Stage npm CLI package" log). This needs the maintainer's passkey. Do it promptly: until it is approved, the extension's "older CLI" notice and the Install CLI command point npm users at a version that does not exist yet.
6. **Check the release**: the Marketplace lists the new version (it can take a few minutes to validate), `npm view ctrlyoke version` matches the tag, and the GitHub Release has the VSIX attached.
7. **Start the next version**: `npm version X.Y.(Z+1) --no-git-tag-version`, committed alone as `chore: start X.Y.(Z+1) development` and pushed. Do it as soon as `release.yml` has published, and not before: if a gate fails, the fix has to land while `package.json` still matches the tag. This commit only changes `package.json` and `package-lock.json`. `CHANGELOG.md` keeps its empty `## [Unreleased]` heading (see [Versions on `main`](#versions-on-main)).

**Patch release:** a release that only ships bug fixes, with no dependency updates or harness CLI changes, can skip step 0 and step 1's chores. Its `testedWith` values carry over unchanged, so the CHANGELOG gets no "Tested with" note. What remains:

1. `npm test` on `main`.
2. The release commit from step 2: `npm version X.Y.Z --no-git-tag-version --allow-same-version` and the CHANGELOG heading rename.
3. Steps 3–7: tag, let `release.yml` publish, approve the staged npm package, check the release, start the next version.

Run the full checklist again for the next release that updates dependencies or a harness CLI.

**Pre-release channel:** `vsce publish --pre-release` publishes to the Marketplace's opt-in pre-release channel instead of stable. VS Code's convention is `major.EVEN.patch` for stable and `major.ODD.patch` for pre-release (plain `x.y.z` only — semver suffixes like `-beta.1` aren't supported by the Marketplace). This isn't automated by `release.yml`; run it manually when you want a testable build ahead of a stable release.

**Hotfixing a published version:** if `main` has moved on past what's currently live on the Marketplace and a published version needs a fix, cut a release branch from the tag rather than from `main`:

```powershell
git switch -c release/X.Y vX.Y.Z
# fix, bump the patch version, tag vX.Y.Z+1, push the tag to trigger release.yml
# then cherry-pick the fix back onto main
```

Standing release branches aren't used otherwise — the Marketplace serves one version and clients auto-update, so there's nothing to backport to outside an active hotfix.
