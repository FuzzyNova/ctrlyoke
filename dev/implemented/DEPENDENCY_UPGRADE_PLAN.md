# Dependency Upgrade Plan

Tracking doc for major-version dependency bumps. Created 2026-06-21 after an
`npm audit` pass (commit dropped 21 → 7 findings; remaining are dev-only with no
non-breaking fix). Batch 1 below was completed on 2026-06-21. Minor/patch bumps are not tracked here — just run
`npm update` / `npm outdated` periodically for those.

## How to read this

- **Current → Latest** is the major jump under consideration.
- **prod** = ships in the published extension / CLI runtime; **dev** = build/test
  tooling only (no runtime exposure).
- Risk reflects code impact _and_ the runtime floor (some majors raise the
  minimum Node version, which matters most for the standalone CLI binary in
  `src/cli.ts`).

Our only declared engine is `vscode: ^1.104.0` (VS Code 1.104 ships Node 22). The
CLI binary, however, runs on the **user's** system Node, so raising the Node floor
there is a user-facing decision, not just an internal one.

---

## Low risk — do soon

These are isolated, have stable APIs we already use narrowly, and don't raise the
Node floor beyond what we already require (Node 20+).

Status: completed 2026-06-21.

| Package       | Current → Latest | prod/dev | Notes                                                                                                                                                                                                        |
| ------------- | ---------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `js-yaml`     | 4 → 5            | prod     | Completed. Required small compatibility fixes: `DEFAULT_SCHEMA` → `CORE_SCHEMA`, `quotingType` → `quoteStyle`, and ESM script imports must use namespace import syntax. Verified via full build/test pass.   |
| `diff`        | 8 → 9            | prod     | Completed. No source changes required beyond the version bump. Verified via full build/test pass.                                                                                                            |
| `esbuild`     | 0.27 → 0.28      | dev      | Completed. Direct dependency advisory is gone, but `npm audit` still reports an `esbuild` advisory through `vitepress`'s pinned `vite` tree, so the remaining finding is no longer in our direct build path. |
| `cross-env`   | 7 → 10           | dev      | Completed. No script changes required.                                                                                                                                                                       |
| `jsdom`       | 26 → 29          | dev      | Completed. UI test suite passed under the new DOM environment.                                                                                                                                               |
| `@types/node` | 25 → 26          | dev      | Completed. No code changes required beyond resolving new type surfaces from the other bumps.                                                                                                                 |

---

## Moderate risk — do deliberately, with a focused test

Isolated blast radius but either a real API change or a Node-floor bump that needs
a conscious decision.

| Package                 | Current → Latest | prod/dev | Notes                                                                                                                                                                                                                                                                                           |
| ----------------------- | ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `commander`             | 14 → 15          | prod     | **Requires Node ≥22.12.0.** The API we use (`.command` / `.option` / `.action` / `.parse`) is stable, so the code change is trivial — the real decision is whether to raise the **CLI's minimum Node to 22**. Do this only once we're comfortable dropping Node 20 users of the standalone CLI. |
| `selfsigned`            | 2 → 5            | prod     | Used only in mobile-TLS cert generation (`WebviewSettingsSync.ts`, dynamic import). Big version jump (Node `>=18`). The `generate()` options shape may have shifted — verify the generated CA still has `basicConstraints cA:true` and installs/trusts on iOS. Isolated to one feature.         |
| `@vscode/test-electron` | 2 → 3            | dev      | Extension test harness. **Requires Node ≥22.** Test infra only — bump alongside any CI Node upgrade.                                                                                                                                                                                            |

---

## High risk — should do eventually, needs a dedicated pass

Whole-surface migrations. Each deserves its own branch + QA cycle; do not bundle
with other upgrades.

| Package       | Current → Latest | prod/dev    | Notes                                                                                                                                                                                                                                                                                                                                               |
| ------------- | ---------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tailwindcss` | 3 → 4            | dev (build) | Major migration: new Oxide engine, CSS-first config replacing `tailwind.config`, `@import "tailwindcss"` replacing the `@tailwind` directives in `src/ui/webview-react/styles/globals.css`, the PostCSS plugin moving to `@tailwindcss/postcss`, and some utility renames. Affects **all** webview styling — needs full visual QA of the dashboard. |
| `typescript`  | 5.9 → 6.0        | dev         | New compiler major. Likely surfaces new/stricter type errors across the whole codebase and requires a `@typescript-eslint` release that officially supports TS 6 (we're on 8.61 — confirm support before bumping). Plan a dedicated typecheck-cleanup pass.                                                                                         |

---

## Explicitly leave alone

- `node-pty` — we're pinned to `1.2.0-beta.13`, which is **newer** than the latest
  stable `1.1.0`. The beta is intentional (xterm/node-pty architecture); do not
  "downgrade" to the stable shown by `npm outdated`.

---

## Suggested order

1. **Batch 1 (low risk):** `js-yaml`, `diff`, `esbuild`, `cross-env`, `jsdom`,
   `@types/node` — one PR, run full `npm test` + build.
2. **Batch 2 (Node-floor decision):** decide CLI min Node = 22, then `commander`,
   `@vscode/test-electron`, `selfsigned` together with a CI Node bump.
3. **Batch 3 (dedicated branches):** `typescript` 6, then `tailwindcss` 4 —
   separately, each with its own QA.
