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

## A. Drop `vite-plugin-static-copy` — done 2026-10-05

Replaced by the in-repo `src/ui/webview-react/build/staticCopyPlugin.ts`: a
target is a file (copied into `dest` under its own name) or a directory (its
contents copied recursively), so the old glob + `stripBase` options are gone. It
copies in `writeBundle`, registers sources as watch files for
`vite build --watch`, and serves the same paths from the `dev:webview` server.
Verified: the non-bundle files in `out/ui/webview-react/` are byte-identical to
the old plugin's output (14 files), and the dev server serves them. `npm audit`
went 11 → 10; `chokidar@3` stays in the tree via Tailwind 3 until B lands.

---

## B. Tailwind CSS 3 → 4 — done 2026-10-05, visually inspected 2026-10-06

`tailwindcss` 4.3, `@tailwindcss/vite` 4.3, and `eslint-plugin-tailwindcss` 4.4;
`autoprefixer`, `postcss` (now only transitive), `postcss.config.js`, and
`tailwind.config.js` are gone. `npm audit` went 10 → 2 (only the KaTeX finding
in C remains).

- The JS config was ported straight to `@theme` in
  `src/ui/webview-react/styles/globals.css` — no `@config` bridge. The theme,
  `@source` list (explicit, `source(none)`), and custom variants all live there;
  `.github/instructions/webview-react.instructions.md` has the sharp edges.
- `npx @tailwindcss/upgrade` (run from `src/ui/webview-react/` with a temporary
  `@config` line, since `landing/` confuses it from the repo root) did the bulk
  of the `.tsx` renames. Its stylesheet output was discarded: it duplicated every
  color as a `--border-color-*` token and turned every `@layer components` rule
  into `@utility` — including `bg-btn-bg` and `codicon`, which would have merged
  HC overrides into real utilities.
- It skips classes it cannot parse confidently inside template literals. The
  leftovers (`flex-shrink-0`, bare `rounded`, `bg-opacity-*`, `border-opacity-*`,
  `placeholder-opacity-*`) were fixed by hand or by
  `tailwindcss/enforces-canonical-classname --fix`, which is now an `error`.
  `enforces-shorthand` (321 hits) and `no-unnecessary-arbitrary-value` (66) are
  left off as a separate style pass.
- Verified by building a v3 stylesheet from `HEAD` and diffing its class
  selectors against the v4 build: every class the source still names is
  generated. Per-file token counts confirmed each v3 `-sm` radius/shadow/blur
  became `-xs`. Behaviour kept from v3 on purpose: `hover:` without the
  `(hover: hover)` media gate (phone row actions), class-based `dark:`, default
  border color, placeholder color, and `:disabled { cursor: default }`.

**Rendering that changes** (checked in the visual pass):

- Opacity modifiers on `var()` colors now apply. v3 generated no CSS for them, so
  ~45 classes that were silent no-ops (`bg-editor-bg/90`, `bg-list-hover-bg/50`,
  `bg-(--status-*)/15`, the `border-*-fg/30|40` warning/error boxes, Streamdown's
  `bg-muted/40` and `bg-background/80`) start rendering as tints.
- `space-y-*` children with their own vertical margin: v3's sibling selector
  overrode the child's margin, v4's zero-specificity one does not. The cases are
  the settings sections (`h3 … mb-3` under `space-y-4` is 12px, was 16px;
  `pt-3 border-t mt-3` dividers under `space-y-1` are 12px, were 4px;
  `-mt-2` descriptions in Commit/Harnesses now pull up 8px) and the Server
  section's icon-color box. The two tool-output lists whose `m-0` would have
  zeroed their sibling gap had the redundant `m-0` removed.
- **Browser floor:** Safari 16.4+ / Chrome 111+ / Firefox 128+. Fine for the VS
  Code webview; the hosted dashboard on phones now needs iOS 16.4+.
- Visual QA passed (2026-10-06): no regressions found. `npm test` passes (all
  three suites).

---

## C. KaTeX (via mermaid) — waiting on upstream, no override

Decision (2026-10-05): **accept the low finding and wait for mermaid**, rather
than adding an `overrides` pin.

- KaTeX is reached only through mermaid: our code never imports it, and
  mermaid lazily imports it when a diagram label contains `$$…$$` math. It
  calls `katex.renderToString(c, { throwOnError, displayMode, output })`,
  using `output: "mathml"` wherever MathML is supported.
- `mermaid@12.1.0` and mermaid's `develop` branch still declare
  `katex ^0.16.47`. The bump is open as
  [mermaid-js/mermaid#8216](https://github.com/mermaid-js/mermaid/pull/8216)
  (`^0.18.0`, released as a mermaid minor). Once a 12.x release includes it,
  `npm update` clears the finding.
- If we ever do need the pin, it is safe: KaTeX's 0.17–0.19 breaking changes
  (internal `__defineFunction`, prefixed CSS classes, `symbolNotInFont` strict
  reporting) do not touch mermaid's call. A side-by-side `renderToString` of
  0.16.47 vs 0.19.0 gave identical-length `mathml` output. Scope it to mermaid:
  `"overrides": { "mermaid": { "katex": "^0.19.0" } }`.

---

## D. mermaid 11 → 12 — done 2026-10-05, visually inspected 2026-10-06

`mermaid` 12.1.0. We only call `initialize({ startOnLoad, theme })` and
`render()` (`MarkdownText.tsx`), so of 12.0's four breaking changes,
`defaultRenderer` and the internal layout exports don't touch us. The two
that do:

- **ELK is now the default layout** for flowchart, state, class, ER,
  requirement and use-case diagrams. Kept on purpose: we set no `layout`, so
  these diagrams render with ELK. `mermaid.initialize({ layout: "dagre" })` is
  the escape hatch. `elkjs` is a new mermaid dependency and ships as a lazy
  `elk-*.js` chunk: production webview JS went 9.57 MB → 11.22 MB, with
  `dashboard.js` unchanged.
- **Browser floor: ES2024 / Safari 17.4+.** Vite downlevels syntax but does
  not polyfill ES2024 built-ins, so the hosted dashboard on phones now
  effectively needs iOS 17.4+ for diagrams (Tailwind 4 alone needed 16.4). The
  VS Code webview is unaffected.
- Does not change the KaTeX finding (see C). `npm test` passes (all three
  suites).
- Visual QA passed (2026-10-06): every diagram type, KaTeX math labels, and
  the 12.1 error diagram (now shows the real parse error) render correctly.
  One known ELK quirk, upstream rather than ours: two labelled edges running
  in opposite directions between the same neighbours (`A -- pass --> B` plus
  `B -- next pass --> C`, routed through the same gap) can get their labels
  drawn on top of each other. A diagram can opt out with `layout: dagre` in
  its front matter.

---

## E. Vitest 4 → 5 + jest-dom 6 → 7 — done 2026-10-06

`vitest` 5.0.3, `@vitest/coverage-v8` 5.0.3, `@testing-library/jest-dom` 7.0.1.
No config or test changes were needed: all 3433 UI tests pass, and
`test:ui:coverage` still reports on `store/`, `hooks/`, `utils/`, and
`components/` despite vitest 5's stricter relative `coverage.include` matching.
jest-dom 7's new required peer, `@testing-library/dom` 10, was already
installed.

- **Temporary type shim:** `src/ui/webview-react/test/jestDomVitest.d.ts`.
  jest-dom 7 still augments Vitest 4's one-parameter `Assertion<T>`, which
  doesn't merge with Vitest 5's `Assertion<R, T>`, so every jest-dom matcher
  vanished from `expect()`'s type (1903 `tsc` errors, though they all ran fine).
  The shim augments `Matchers<R, T>` instead. **Delete it** once
  [testing-library/jest-dom#742](https://github.com/testing-library/jest-dom/pull/742)
  (fixes [#738](https://github.com/testing-library/jest-dom/issues/738))
  ships, then re-run `npm run typecheck:webview`.
- Vitest 5 behaviour now in effect: `clearMocks` defaults to `true`;
  unawaited `resolves`/`rejects` fail the test; `vi.mock()` outside module top
  level throws; `-t` patterns match names joined with `' > '`.

---

## F. chalk 6, gpt-tokenizer 4, vscode-jsonrpc 9 — done 2026-10-06

- **`gpt-tokenizer` 4.0.0:** the only break is dropped UMD bundles. `encode()`
  output is token-for-token identical to 3.4.0 (checked on `README.md` and
  `src/cli.ts`), and special tokens like `<|endoftext|>` still throw.
- **`chalk` 6.0.1:** Node 22 floor, which we already require. It also dropped the
  top-level `types` field and now resolves its types only through `exports`.
- **`vscode-jsonrpc` 9.0.3:** `CopilotQuotaClient`'s APIs
  (`createMessageConnection`, stream reader/writer, `sendRequest`,
  `ErrorCodes`) are unchanged; the package is now `exports`-only.
- **Root `tsconfig.json`: `module: commonjs` → `node20`.** `commonjs` implied
  the legacy `node10` resolver, which ignores `exports`, so `tsc` couldn't find
  chalk's or vscode-jsonrpc's types. `node20` uses Node's real resolution and
  still emits CommonJS. Side effect: `tsc` now emits a lazy `import()` as native
  `import()` instead of `require()`. The five relative lazy imports
  (`src/cli.ts` ×3, `CtrlYokeWebviewProvider.ts` ×2) gained the `.js` extension
  Node's resolver requires, and esbuild still inlines them (no relative
  `import()` is left in `out/cli.js`, `out/extension.js`, or
  `out/mcp-server.js`). This also removes the `node10` resolver ahead of the
  TypeScript 6 pass.
- `npm test` passes (all three suites).

---

## Other majors available (no vulnerabilities — upgrade opportunistically)

All of these are compatible with our `>=22.12.0` Node floor.

| Package      | Current → Latest | prod/dev | Risk    | Notes                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ---------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `typescript` | 5.9 → 6.0        | dev      | High    | Carried over. `@typescript-eslint` 8.71 supports `>=4.8.4 <6.1.0`, so **6.0 is unblocked**. Expect new strictness errors and deprecations — dedicated typecheck-cleanup pass.                                                                                                                                                                                                                       |
| `typescript` | 6.0 → 7.0        | dev      | Blocked | TS 7 is the native (Go) compiler and is now `latest` on npm. Blocked on `@typescript-eslint` support, and on our use of the TS compiler JS API in `scripts/find-dead-methods.mjs`, `scripts/find-hardcoded-strings.mjs`, `scripts/check-a11y-names.mjs`, `src/test/unit/SourceAuditCounters.test.ts`, and `src/ui/webview-react/test/components/settings/settingsCatalog.test.ts`. Go to 6.0 first. |

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
3. ~~**B** — Tailwind 4 + `eslint-plugin-tailwindcss` 4~~ — done and visually
   inspected. `npm audit` now shows only the KaTeX finding.
4. ~~**D** — mermaid 12~~ — done and visually inspected. **C** waits on
   mermaid#8216.
5. ~~**E** — vitest 5 + jest-dom 7~~ — done; drop the type shim when
   jest-dom#742 ships.
6. ~~**F** — `chalk` 6, `gpt-tokenizer` 4, `vscode-jsonrpc` 9~~ — done, with
   the root `tsconfig.json` moved to `module: node20`.
7. **TypeScript 6.0** dedicated pass. TypeScript 7 stays parked until the
   tooling supports it.
