# Major Dependency Upgrades

Deliberate, one-package-at-a-time major-version bumps for ctrlyoke's dependencies.

Unlike [`CHORES.md`](CHORES.md) — safe, automatable maintenance meant to run
unattended on a schedule via `npm run chores -- --task all` — **nothing in this
document is wired into `scripts/chores.mjs`, and nothing here should be.** A
major-version bump can carry breaking changes (new strict-mode type errors,
changed APIs, changed build output, changed config format) that only surface
once you actually run the upgrade, so each one needs its own review pass
instead of a blanket, unattended update.

## Why these are separate from CHORES.md

`npm update` (used by the `update-deps` chore) only moves a package within the
semver range already declared in `package.json` — it never silently jumps a
major version. Getting past that range requires either forcing an install
(`npm install <pkg>@latest`) or a source migration, which is why it belongs
here as a manual, deliberate task instead of a periodic chore.

## How to find what's behind

```bash
npm outdated
```

Compare the `Current` and `Latest` columns — any row where the major version
differs is a candidate for this doc. `Wanted` staying equal to `Current` while
`Latest` is higher (e.g. typescript) is `npm`'s own signal that the
`package.json` range intentionally caps it there.

This list is **not** kept in sync automatically — re-run `npm outdated` to
check current state before acting on anything written here.

## Upgrade steps (per package)

1. Pick **one** package from a fresh `npm outdated`.
2. Read its changelog/migration guide for the major version jump.
3. `npm install <pkg>@latest` (or `--save-dev` for devDependencies).
4. `npm run compile && npm test && npm run lint` — fix whatever the upgrade
   surfaces before moving on. TypeScript major bumps in particular tend to
   surface new strict-mode type errors project-wide.
5. Commit that package's upgrade on its own
   (`chore: upgrade <pkg> to vX`) — don't bundle multiple major upgrades into
   one commit, so a regression is easy to bisect.
6. Repeat for the next package, or stop here — there's no obligation to clear
   the whole list in one sitting.

## Explicitly out of scope for `npm run chores`

`scripts/chores.mjs` intentionally has no task that runs any `@latest`
install or major-version migration. If you build periodic/unattended
automation around `CHORES.md`, keep it that way — this document exists
precisely so that automation has a hard line it doesn't cross.
