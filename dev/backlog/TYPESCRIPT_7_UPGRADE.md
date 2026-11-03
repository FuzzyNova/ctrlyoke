# TypeScript 7 Upgrade

**Status:** Blocked. Dependabot ignores TypeScript majors (`.github/dependabot.yml`).

## Blocker

`@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser` 8.72.1 declare the peer
`typescript: ">=4.8.4 <6.1.0"`. With `typescript@7`, `npm ci` fails with `ERESOLVE` before
anything compiles (Dependabot PR #8, closed 2026-11-02).

Check with `npm view @typescript-eslint/eslint-plugin peerDependencies`. Unblocked once a
release accepts `typescript@7`.

## When unblocked

1. Delete the `typescript` entry under `ignore:` in `.github/dependabot.yml`. The
   `typescript-major` group then opens one PR covering `/`, `/landing` and `/media`.
2. Bump typescript-eslint in the same change if the TS 7-compatible release is a new major.
3. Check the other TypeScript API consumers too: `@astrojs/check` in `/landing`, and
   any build script that imports `typescript` directly (`scripts/`).
4. Run `npm test`, `npm run lint`, `npm run typecheck`, and the landing and media builds.
