# Dependency Upgrade Plan (2026-10)

Successor to `dev/implemented/DEPENDENCY_UPGRADE_PLAN_2026_06.md`. That plan's Batch 1
(low risk) and Batch 2 (`commander` 15, `selfsigned` 5, `@vscode/test-electron` 3,
Node floor raised to `>=22.12.0`) shipped, but its Batch 3 — `typescript` and
`tailwindcss` — never did. Both are carried over here, along with every major
bump that has appeared since.

Minor/patch bumps are not tracked here; `npm update` handles them (as of
2026-10-05 it covers `@modelcontextprotocol/sdk`, `@typescript-eslint/*`,
`eslint`, `vite`, `ws`, `postcss`, `mocha`, `js-yaml`, and others in the
`Wanted` column of `npm outdated`).

- **prod** = ships in the extension / CLI / dashboard bundle; **dev** = build,
  lint, or test tooling only.

---

## Audit snapshot (2026-10-05, after `npm audit fix`)

`npm audit`: **11 findings (7 high, 2 moderate, 2 low)**. They all come from
just **three advisories**, and every high/moderate one is dev/build-only:

| Advisory                                                                                                    | Severity | Vulnerable package                 | Patched release?               | How we pull it in                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) — stack-exhaustion DoS             | high     | `braces` `<=3.0.3`                 | **None** (3.0.3 is the latest) | `tailwindcss@3` → `chokidar@3` / `micromatch` / `fast-glob`; `eslint-plugin-tailwindcss@3` → `fast-glob` → `micromatch`; `vite-plugin-static-copy` → `chokidar@3` |
| [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) — quadratic selector parsing       | moderate | `postcss-selector-parser` `<7.1.6` | Yes (7.1.6)                    | `tailwindcss@3` directly and via `postcss-nested@6`                                                                                                               |
| [GHSA-238p-pmpm-9mq7](https://github.com/advisories/GHSA-238p-pmpm-9mq7) — prototype-pollution trust bypass | low      | `katex` `<0.18.2`                  | Yes (0.18.2+, now 0.19.0)      | `mermaid` (prod) pins `katex ^0.16.47` — **still true in `mermaid@12.1.0`**                                                                                       |

Because `braces` has no fixed release, no override or `npm audit fix` can clear
the high findings. The only fix is to **stop depending on the packages that
pull in `chokidar@3` / `fast-glob@3`**. (`mocha`, `sass`, and `@vscode/test-cli`
already use `chokidar@5`, which has no `braces` dependency.)

`npm audit fix --force` should **not** be used: it would install Tailwind 4
without the migration, and "fix" `katex` by **downgrading** `mermaid` to 10.8.0.

### What clears each finding

| Work item                                                           | Clears                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| A. Replace `vite-plugin-static-copy` with an in-repo copy plugin    | `braces` via `chokidar@3` (the remaining path once Tailwind is gone)                                                           |
| B. Tailwind 3 → 4 **plus** `eslint-plugin-tailwindcss` 3 → 4        | `tailwindcss`, `chokidar`, `micromatch`, `fast-glob`, `postcss-nested`, `postcss-selector-parser`, `eslint-plugin-tailwindcss` |
| C. Override `katex` to `^0.18.2` (or wait for `mermaid` to bump it) | `katex`, `mermaid`                                                                                                             |

**A + B together bring the audit to zero high/moderate findings.** Neither
alone does: `vite-plugin-static-copy`'s latest release (4.1.1) still depends on
`chokidar ^3.6.0`, and the Tailwind chain is the bulk of the rest.

---

## A. Drop `vite-plugin-static-copy` — low risk, do first

| Package                   | Change | prod/dev | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vite-plugin-static-copy` | remove | dev      | Used only in `src/ui/webview-react/vite.config.ts` to copy a fixed list of files at build time (dictionaries, `typo.js`, codicon CSS/TTF, generated custom-icon CSS, hosted icons). We use none of its watch/dev-server features. Replace with a small Vite plugin that copies the same targets in `closeBundle`/`generateBundle` using `fs.cp` plus Node 22's `fs.glob` (or `tinyglobby`, already in the tree). Preserve the `stripBase` layouts exactly — verify by diffing the webview `dist/` file list before and after. |

Not blocked on anything and removes one of the two remaining `braces` paths.

---

## B. Tailwind CSS 3 → 4 — high risk, dedicated pass

| Package                     | Current → Latest | prod/dev    | Notes                                                                                                                                                                                                                                                                                 |
| --------------------------- | ---------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tailwindcss`               | 3.4 → 4.3        | dev (build) | Whole-surface styling migration.                                                                                                                                                                                                                                                      |
| `eslint-plugin-tailwindcss` | 3.18 → 4.4       | dev         | v4 has a `tailwindcss ^4` peer dependency, so it must move in the same change. It drops `fast-glob` and moves to `postcss-nested@7`. Re-check that our rule config in `eslint.config.mjs` (the `settings.tailwindcss.config` path, the disabled rules) still maps onto v4's rule set. |
| `autoprefixer`              | remove           | dev         | Tailwind 4 does vendor prefixing itself (Lightning CSS).                                                                                                                                                                                                                              |

Scope in this repo:

- `src/ui/webview-react/tailwind.config.js` is **455 lines** of JS config. v4 is
  CSS-first (`@theme` in CSS). Option: use `@config "./tailwind.config.js"` as an
  interim bridge to land the engine bump first, then port the theme to `@theme`
  as a follow-up.
- `src/ui/webview-react/postcss.config.js` uses the v3 `tailwindcss` PostCSS
  plugin. Since the webview is built by Vite, prefer `@tailwindcss/vite` over
  `@tailwindcss/postcss` — `landing/` already runs Tailwind 4 that way
  (`landing/astro.config.mjs`, `landing/src/styles/global.css`) and is the
  in-repo reference.
- `src/ui/webview-react/styles/globals.css`: `@tailwind` directives →
  `@import "tailwindcss"`; 14 `@apply` uses to re-check.
- ~390 `.tsx` files under `src/ui/webview-react/`. Start with
  `npx @tailwindcss/upgrade` for utility renames (e.g. `shadow-sm`→`shadow-xs`,
  `rounded`→`rounded-sm`, `outline-none`→`outline-hidden`, default border color
  now `currentColor`, default ring width 1px).
- **Browser floor:** Tailwind 4 requires Safari 16.4+ / Chrome 111+ / Firefox
  128+. The VS Code webview is fine; the **hosted dashboard on phones** (older
  iOS Safari) is the case to decide on consciously.
- QA: full visual pass of the dashboard in both the VS Code webview and the
  hosted browser, light/dark/high-contrast themes; run `npm run test:ui`.

---

## C. KaTeX (via mermaid) — low risk, low severity

| Package | Change                 | prod/dev | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------- | ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `katex` | `overrides`: `^0.18.2` | prod     | Low-severity advisory, only exploitable in combination with an existing prototype-pollution bug. `mermaid` 11 and 12 both pin `katex ^0.16.47`, so upgrading mermaid does not help. Overriding forces mermaid onto a KaTeX major it hasn't declared support for; only worth doing if a smoke test of mermaid rendering (including a diagram with `$$…$$` math) in the dashboard passes. Otherwise accept the finding and re-check on the next mermaid release. |

---

## Other majors available (no vulnerabilities — upgrade opportunistically)

All of these are compatible with our `>=22.12.0` Node floor.

| Package                          | Current → Latest | prod/dev | Risk     | Notes                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------- | ---------------- | -------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vitest` + `@vitest/coverage-v8` | 4.1 → 5.0        | dev      | Moderate | Must move in lockstep. UI test runner only; run `npm run test:ui` and `npm run test:ui:coverage`.                                                                                                                                                                                                                                                                                                   |
| `@testing-library/jest-dom`      | 6.9 → 7.0        | dev      | Low      | Node ≥22. Bump alongside vitest 5.                                                                                                                                                                                                                                                                                                                                                                  |
| `mermaid`                        | 11.17 → 12.1     | prod     | Moderate | Dashboard diagram rendering (`MarkdownText.tsx`, `outputRows.ts`). Does **not** fix the KaTeX advisory. Visual check of rendered diagrams.                                                                                                                                                                                                                                                          |
| `chalk`                          | 5.6 → 6.0        | prod     | Low      | CLI output coloring. Node ≥22.                                                                                                                                                                                                                                                                                                                                                                      |
| `gpt-tokenizer`                  | 3.4 → 4.0        | prod     | Low–Mod  | Token counting; check for API/encoding-name changes and verify counts in the existing tests.                                                                                                                                                                                                                                                                                                        |
| `vscode-jsonrpc`                 | 8.2 → 9.0        | prod     | Moderate | Check every import site for protocol/API changes before bumping.                                                                                                                                                                                                                                                                                                                                    |
| `typescript`                     | 5.9 → 6.0        | dev      | High     | Carried over. `@typescript-eslint` 8.71 supports `>=4.8.4 <6.1.0`, so **6.0 is unblocked**. Expect new strictness errors and deprecations — dedicated typecheck-cleanup pass.                                                                                                                                                                                                                       |
| `typescript`                     | 6.0 → 7.0        | dev      | Blocked  | TS 7 is the native (Go) compiler and is now `latest` on npm. Blocked on `@typescript-eslint` support, and on our use of the TS compiler JS API in `scripts/find-dead-methods.mjs`, `scripts/find-hardcoded-strings.mjs`, `scripts/check-a11y-names.mjs`, `src/test/unit/SourceAuditCounters.test.ts`, and `src/ui/webview-react/test/components/settings/settingsCatalog.test.ts`. Go to 6.0 first. |

---

## Explicitly leave alone

- `node-pty` — pinned to a `1.2.0-beta.*` release, **newer** than the stable
  `1.1.0` that `npm outdated` reports as "latest". Intentional; don't downgrade.
- `vitepress` — we're on `2.0.0-alpha.*`; `npm outdated`'s "latest" `1.6.4` is
  a downgrade.

---

## Suggested order

1. **`npm update`** for minor/patch, full `npm test`.
2. **A** — replace `vite-plugin-static-copy`. Small, unblocked.
3. **B** — Tailwind 4 + `eslint-plugin-tailwindcss` 4, on its own with full
   visual QA. After A + B, `npm audit` should show only the KaTeX finding.
4. **C** — try the KaTeX override; keep it if mermaid smoke test passes.
5. **vitest 5 + jest-dom 7** together; then `chalk`, `gpt-tokenizer`,
   `vscode-jsonrpc`, `mermaid` one at a time.
6. **TypeScript 6.0** dedicated pass. TypeScript 7 stays parked until the
   tooling supports it.
