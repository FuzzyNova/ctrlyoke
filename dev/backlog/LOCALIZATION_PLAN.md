# Localization Plan

**Related plans:** [`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`](VSCODE_DEPENDENCY_DECOUPLING_PLAN.md),
[`STANDALONE_SERVER_PLAN.md`](../active/STANDALONE_SERVER_PLAN.md),
[`BROWSER_USER_FEEDBACK_PLAN.md`](../implemented/BROWSER_USER_FEEDBACK_PLAN.md).
**This plan must not reintroduce a `vscode` dependency into any file the
decoupling plan classifies as shared/reusable** — see "Interaction with the
decoupling and standalone-server plans" below before implementing Phase 2.

## Overview

ctrlyoke currently has zero localization infrastructure — no `vscode.l10n`, no
`package.nls.json`, no i18n library in the React dashboard, no `l10n` field in
`package.json`. All ~39 command titles and ~17 configuration
descriptions/markdownDescriptions in `package.json` are hardcoded English, and
user-facing strings are inlined directly as JSX text across ~265 `.tsx` files
under `src/ui/webview-react/`.

This is **not** a single-`resx`-file problem the way the C# experience was.
ctrlyoke has **three distinct surfaces**, each with a different localization
mechanism, and no single tool covers all three:

1. **Extension manifest** (`package.json` `contributes.commands/configuration/menus`)
   — resolved by VS Code itself before any of our code runs.
2. **Extension host TypeScript** (`src/extension.ts`, `src/core/**`, notifications,
   QuickPicks, error messages surfaced via `vscode.window.showErrorMessage`, etc.)
   — runs in Node, has full access to the `vscode` module.
3. **React dashboard** (`src/ui/webview-react/`) — this bundle is dual-served:
   as a VS Code **webview** (see `src/ui/CtrlYokeWebviewProvider.ts`) *and* as a
   plain static bundle served over HTTP/WS by the standalone hosted dashboard
   (`src/server/CtrlYokeHostedServer.ts` → `buildHtml()`, serving the same
   `webviewDist` via `express.static`). **The hosted dashboard has no `vscode`
   API available at all** — it's just a browser tab hitting an Express server —
   so any solution that depends on `vscode.l10n` inside React code is a
   non-starter for that surface. Whatever we pick for #3 must work identically
   in both contexts.

## Research Findings

### VS Code's own recommendation (surfaces #1 and #2 only)

VS Code's documented mechanism (`vscode.l10n` API, `@vscode/l10n-dev` tooling,
`@vscode/l10n` runtime package) is the standard, and it's a good fit for the
extension host:

- **Manifest strings** (`package.json`): replace literal `title`/`description`
  values with `%key%` placeholders, add an `l10n` root file (e.g.
  `"l10n": "./l10n"`), and provide `package.nls.json` (default/English) plus
  `package.nls.<locale>.json` per additional language. VS Code resolves these
  automatically based on the user's display language — no runtime code needed.
- **Extension host code**: replace `"Some string"` literals with
  `vscode.l10n.t("Some string")`. `@vscode/l10n-dev` extracts these calls into
  an XLF/JSON bundle (`l10n/bundle.l10n.json`) that a translation vendor fills
  in per locale (`bundle.l10n.<locale>.json`); `vscode.l10n` picks the right
  bundle at runtime based on `vscode.env.language`.
- VS Code ships a pseudo-locale (`qps-ploc`) specifically to catch strings that
  were missed during extraction — run the extension with
  `--locale qps-ploc` and look for any text that *didn't* get pseudo-translated.

This part is well-trodden and low-risk. **It does not touch the React webview
at all** — `vscode.l10n.t()` only exists in the extension host process, not in
webview/browser JS.

### React dashboard (surface #3) — no VS Code-native answer

Webviews run in an isolated `vscode-webview://` origin, and the hosted
dashboard runs as a normal page over `http(s)://`. Neither has access to the
`vscode` module. The community-standard pattern (used in the official
`vscode-extension-samples/l10n-sample` and documented by VS Code extension
authors covering exactly this "React inside a webview" scenario) is:

1. Keep translation resource JSON completely separate from the extension
   host's `l10n/` bundles — different runtime, different loading mechanism.
2. Use a standard web i18n library inside the React app —
   **`react-i18next`** is the de facto choice (React hooks API, mature,
   works fine bundled by Vite/esbuild, no dependency on `vscode`).
3. Resolve the active locale differently per surface, then feed it to the
   same `i18next.init()` call:
   - **Webview**: the extension host already knows `vscode.env.language`.
     Pass it into the webview the same way other webview-only globals are
     injected today (see `CtrlYokeWebviewProvider`'s HTML templating).
   - **Hosted dashboard**: `buildHtml()` in `CtrlYokeHostedServer.ts` already
     does exactly this kind of placeholder-substitution for the standalone
     bundle (theme vars, icon URIs, CSP, body class — see lines ~1334-1400).
     The same pattern extends naturally to injecting a resolved locale
     (e.g. `Accept-Language` header, falling back to a user-configurable
     setting) as another `{{placeholder}}` substituted into `index.html`
     before it's sent.
4. Ship one flat JSON resource file per locale (e.g.
   `src/ui/webview-react/locales/en.json`, `es.json`, …), loaded at bundle
   build time or fetched lazily — either is fine at ctrlyoke's current UI
   string volume.

This is genuinely a good amount of engineering effort — there is no
"automatic extraction" shortcut for JSX. Every user-facing string in the
~265 `.tsx` files needs to be pulled into a `t("key")` call by hand (or with
heavy tool assistance — see Tooling below). This is the part of the C#
`resx` experience that *doesn't* have a magic equivalent in React: the payoff
of `react-i18next` is runtime locale-switching and translator-friendly JSON,
not less refactoring work up front.

### Browser "Translate this page" — does **not** help the webview, *might* help the hosted dashboard, but shouldn't be relied on

This was the most important question to settle, since it changes how much
custom work is actually required:

- **VS Code webview**: Chrome/Edge's built-in translate feature triggers on
  top-level browser navigations with page-language detection. A VS Code
  webview is an `<iframe>`-like surface rendered inside Electron using the
  `vscode-webview://` custom scheme, not a real top-level browser navigation —
  there is no omnibox, no translate-page icon, and VS Code does not expose one
  for extension webviews. **This will not "just work" for the packaged
  extension**, and we should verify this empirically (load the panel, check
  DevTools for any translate affordance) before ruling it out entirely, but
  don't plan around it appearing.
- **Hosted dashboard**: this *is* a real `https://` page loaded in the user's
  own browser tab, so Chrome/Edge's automatic translate UI plausibly could
  appear unprompted for hosted-dashboard users. However, relying on it as a
  strategy has real problems even there:
  - It's fully out of our control — quality, availability by language, and
    whether it triggers at all (some browsers only offer it for whole-page
    language mismatches, not SPA content that mutates after initial load via
    React's virtual DOM patches, which is *most* of this dashboard's content).
  - It does not translate `aria-label`/`title`/`alt` attributes consistently,
    hurting accessibility for non-English users specifically.
  - It provides no path for the VS Code webview surface, which will remain
    the primary way most users interact with ctrlyoke.
  - We can't control terminology consistency (harness names, workflow
    vocabulary) the way a curated glossary/TM can.

**Conclusion: treat browser auto-translate as a nice-to-have fallback that
may already work for some hosted-dashboard users today, not as a
localization strategy.** It doesn't reduce the scope of the `react-i18next`
work described above.

## Interaction with the decoupling and standalone-server plans

`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` and `STANDALONE_SERVER_PLAN.md` change
where "extension host TS code" (surface #2 above) is allowed to live, and that
directly narrows Phase 2 of this plan. **`vscode.l10n` cannot be treated as a
general-purpose mechanism for extension-host strings** — it can only be used
in files the decoupling plan explicitly keeps as native VS Code integrations.

### Why `vscode.l10n` is a hard no for shared/reusable code, not a style choice

`vscode.l10n.t()` only works when the real `vscode` module is resolvable —
i.e. inside the extension host process. The standalone `ctrlyoke server` is a
plain Node process with **no VS Code runtime at all**, and
`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` Phase 8 explicitly plans to
**"fail CI if the Node bundle graph contains the `vscode` package or a VS
Code-only source path."** Once that lands, a `vscode.l10n.t()` call anywhere
in the standalone-reachable graph is a build break, not just a runtime no-op.

### Phase 2 (as originally scoped) targets the wrong files

Most of what looks like "extension-host user-facing strings" — the
`vscode.window.showErrorMessage`/`showWarningMessage`/`showInformationMessage`
calls in `WorkflowInstance`, `WorkflowExecutor`, `PromptFileParser`,
`EndConditionHandler`, `CliIntegration`, `WorkflowCommandHandler`,
`McpManagerService`, etc. — is exactly the code `BROWSER_USER_FEEDBACK_PLAN.md`
(already implemented) migrated **off** native `vscode` calls and onto the
shared `UserFeedback` → `notifyUserFeedback()`/`notifyUser()` →
`UserFeedbackMessage` pipeline (`src/core/UserFeedbackSink.ts`,
`src/ui/webview-react/utils/notifyUser.ts`), specifically so the same
operational message reaches the VS Code panel, the VS Code-hosted browser
dashboard, *and* the eventual standalone server identically. Wrapping those
call sites in `vscode.l10n.t()` would reintroduce the exact `vscode`
dependency the decoupling plan is purging from that file list, and would
silently stop working the moment those files run in the standalone process.

**`vscode.l10n.t()` should only be used in the files
`VSCODE_DEPENDENCY_DECOUPLING_PLAN.md` classifies as "VS Code boundary files —
calls may remain"**: `src/platform/VsCodeAdapter.ts`,
`src/ui/ExternalFileTrustPrompt.ts`, `src/ui/StatusBarManager.ts`,
`src/ui/NotificationManager.ts`, `src/completions/*`, `src/scm/ScmCommitCommand.ts`,
`src/dev/DevCommands.ts`, `src/extension.ts`, `src/ui/CtrlYokeWebviewProvider.ts`.
These are genuinely native-only surfaces (VS Code QuickPick text, the trust
prompt, the status bar item) with no browser/standalone equivalent, so a
hard `vscode` dependency there is already accepted by the decoupling plan and
costs nothing extra.

### The bigger catch: `UserFeedback.message` is already a baked English string, not JSX

`UserFeedback` (`src/core/UserFeedbackSink.ts`) and `UserFeedbackMessage`
(`src/types/WebviewMessageTypes.ts`) both type `message` as a plain `string`,
assembled deep in orchestration code — e.g.
`` `Failed to export MCP servers: ${getErrorMessage(error)}` `` in
`src/ui/WorkflowStepHandlers.ts`. This string is already fully rendered
English by the time it reaches `notifyUser()`/the React toast. **My original
Phase 4 plan (sweep `.tsx` JSX literals) would completely miss this
category** — these are never JSX text nodes, they're payload data crossing a
WebSocket/postMessage boundary.

To localize this category, the `UserFeedback`/`UserFeedbackMessage` contract
needs to change from `message: string` to a stable `code` plus structured
`params` (e.g. `{ code: "mcp.exportFailed", params: { error: "..." } }`), with
the human sentence assembled only at the render layer:

- React toast (webview, VS Code-hosted browser, standalone browser) resolves
  `code`/`params` via `react-i18next`'s `t(code, params)` using the browser
  bundle from Phase 3/4 below.
- The one remaining native path (`ShowNativeFeedbackMessage` /
  `VsCodeAdapter`, if a truly native rendering path is kept) resolves the same
  `code`/`params` via `vscode.l10n.t(code, params)`.

This is not a parallel effort — it's the same direction
`BROWSER_USER_FEEDBACK_PLAN.md` already pushed (raw strings → typed
results/scoped replies), extended one step further to code+params. Do this
refactor **once**, shared by both localization mechanisms, rather than
authoring the English text twice.

### Net effect on phasing

- **Phase 1** (`package.json` → `package.nls.json`) is unaffected — manifest
  contributions (`contributes.commands/configuration`) are a pure VS Code
  concept with no standalone equivalent (the CLI has its own `--help` text),
  so there's no conflict with the decoupling plan here.
- **Phase 2** shrinks to the small, explicitly-native boundary file list above
  — not a broad sweep of extension-host notifications.
- **Phase 3/4** (React i18n infra + string migration) grows to include the
  `UserFeedback`/`notifyUser` message-code refactor, since that's where most
  of the "extension-host" strings actually need to land. Sequence this work
  after (or alongside) `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`'s narrowing of
  `PlatformAdapter`/feedback sinks — it touches the same call sites, so doing
  it twice would waste effort.
- Add "no `vscode.l10n` import outside the boundary-file list" as a check
  alongside whatever automated dependency-boundary tooling the decoupling
  plan introduces (its Phase 8 already wants CI to fail on stray `vscode`
  imports in the standalone graph — this is the same check, just phrased for
  the l10n-specific case as an early warning before Phase 8 actually ships).

## Recommended Architecture

| Surface | Mechanism | Key artifact |
|---|---|---|
| `package.json` contributions (commands, config, menus) | VS Code `package.nls.json` + `%key%` refs | `package.nls.json`, `package.nls.<locale>.json` |
| Extension host TS (`src/extension.ts`, `src/core/**`, notifications, errors) | `vscode.l10n.t()` + `@vscode/l10n-dev` extraction | `l10n/bundle.l10n.json`, `l10n/bundle.l10n.<locale>.json` |
| React dashboard (webview **and** hosted server, same bundle) | `react-i18next` with locale resolved per-surface at HTML-build time | `src/ui/webview-react/locales/<locale>.json` |

Keep these three completely decoupled — different runtime, different tooling,
different translator handoff. Don't try to force a single shared key
namespace between the extension host and the React bundle; they're translated
independently and by different tools.

### Locale resolution flow

- **Webview**: `CtrlYokeWebviewProvider` already builds the webview's HTML.
  Add `vscode.env.language` as another value injected into that HTML (same
  place other webview-only config gets threaded through), and read it in
  `main.tsx`/`i18n.ts` before `i18next.init()`.
- **Hosted server**: extend `buildHtml()` in `CtrlYokeHostedServer.ts` — it
  already does exactly this kind of request-time HTML patching (theme vars,
  CSP, icon URIs). Resolve locale from (in priority order) an explicit
  per-user dashboard setting → `Accept-Language` request header → `en`
  fallback, and substitute it the same way `themeBodyClass` is substituted
  into `<body class="...">` today.
- Both paths converge on the same `i18n.init({ lng, resources })` call inside
  the shared React bundle — the React code never needs to know which surface
  it's running in for locale purposes.

## Tooling for the Translation Handoff

Mirroring the old resx → translation-vendor → resx-back workflow:

1. **Extraction**: `i18next-parser` (or a small custom AST script) scans
   `.tsx` files for `t("...")` calls and produces/updates the base `en.json`
   resource file automatically — no manual key-bookkeeping once strings are
   wrapped.
2. **Vendor handoff**: flat JSON is accepted by virtually every TMS
   (Crowdin, Lokalise, POEditor, or a one-off machine-translation pass via
   DeepL/an LLM followed by human review) — same shape as XLF-based
   `@vscode/l10n-dev` output on the extension-host side, just a different
   file format.
3. **Guardrails against regression**: add an ESLint rule
   (`eslint-plugin-i18next`'s `no-literal-string`, scoped to
   `src/ui/webview-react/components/**`) so newly written components can't
   reintroduce hardcoded JSX text once the initial migration is done. Without
   this, the "sprinkled everywhere" problem just comes back within a few PRs.
4. **Verification**: exercise VS Code's `qps-ploc` pseudo-locale for the
   extension-host/manifest strings, and add an equivalent pseudo-locale
   resource (`{{qps: prefix/suffix marks}}`) for the React bundle so both
   surfaces can be visually scanned for missed strings in one pass.

## Non-Goals (this plan)

- **RTL layout support.** Translating text doesn't require mirroring flex/grid
  layouts; that's a separate, larger effort (CSS logical properties audit)
  that should only be scheduled once actual RTL-language demand exists.
- **Localizing developer-facing surfaces**: `.ctrlyoke/logs/*.log`, CLI
  `--help` output, MCP tool descriptions, and end-condition script content
  stay English-only — these are developer/automation-facing, not end-user UI.
- **Marketplace listing translation** (`README.md`, extension description
  shown in the Marketplace) — handled separately via the Marketplace's own
  localized-listing mechanism if/when it becomes a priority.
- **Machine-translating on the fly at runtime.** All locales are pre-built,
  reviewed resource bundles, not live-translated — consistent terminology and
  predictable output matter more than covering every language instantly.

## Effort Estimate / Phasing

This is a multi-phase effort, not a single PR:

1. **Phase 1 — Manifest** (`package.json` → `package.nls.json`): small,
   mechanical, ~39 command titles + ~17 config descriptions. Good first PR to
   validate the toolchain works end-to-end for at least one non-English
   locale.
2. **Phase 2 — Extension host**: wrap `vscode.window.show*Message`,
   QuickPick titles/placeholders, and other host-side user-visible strings in
   `vscode.l10n.t()`. Moderate size, mechanical, low risk (compiler catches
   most mistakes since these are just string literals in TS).
3. **Phase 3 — React dashboard infrastructure**: add `react-i18next`,
   `i18n.ts` setup, locale-injection plumbing for both webview and hosted-server
   HTML paths, the pseudo-locale, and the ESLint guardrail — *before* touching
   component code, so new components written during Phase 4 don't add to the
   backlog.
4. **Phase 4 — React string migration**: the bulk of the work — sweep
   `src/ui/webview-react/components/**` (and hooks/toasts that construct
   user-visible message strings) replacing literals with `t("key")` calls,
   file by file or feature-area by feature-area. This is large enough to be
   its own tracked initiative once Phase 3 lands; do not attempt it in one PR.
5. **Phase 5 — First translated locale + vendor/tooling validation**: pick one
   target locale, run it through the full extraction → translation →
   integration pipeline for all three surfaces, and use it to validate the
   whole system (including runtime locale switching in the hosted dashboard)
   before deciding whether to invest in more languages.

## Implementation Checklist

- [ ] Phase 1: Convert `package.json` `contributes.commands/configuration/menus` literal strings to `%key%` + `package.nls.json`; add `"l10n": "./l10n"` root field
- [ ] Phase 1: Verify with `--locale qps-ploc` that manifest strings pseudo-translate
- [ ] Phase 2: Add `@vscode/l10n-dev` + `@vscode/l10n` deps; wrap strings **only** in the VS Code boundary files (`VsCodeAdapter.ts`, `ExternalFileTrustPrompt.ts`, `StatusBarManager.ts`, `NotificationManager.ts`, `completions/*`, `ScmCommitCommand.ts`, `DevCommands.ts`, `extension.ts`, `CtrlYokeWebviewProvider.ts`) in `vscode.l10n.t()` — do not touch `WorkflowInstance`/`WorkflowExecutor`/`PromptFileParser`/`EndConditionHandler`/`CliIntegration`/`WorkflowCommandHandler`/`McpManagerService`
- [ ] Phase 2: Generate `l10n/bundle.l10n.json` via extraction script; document the translator handoff format
- [ ] Phase 3: Refactor `UserFeedback`/`UserFeedbackMessage` from `message: string` to `{ code, params }`, coordinating with `VSCODE_DEPENDENCY_DECOUPLING_PLAN.md`'s `PlatformAdapter`/feedback-sink narrowing so the call sites are only touched once
- [ ] Phase 3: Add a lint/CI check that `vscode.l10n` (and `vscode` generally) is never imported outside the boundary-file list, ahead of the decoupling plan's Phase 8 CI gate
- [ ] Phase 3: Add `react-i18next` (+ `i18next`) to `src/ui/webview-react/`; create `src/ui/webview-react/locales/en.json` and `i18n.ts` bootstrap
- [ ] Phase 3: Thread `vscode.env.language` into the webview HTML template (mirrors existing webview-only config injection)
- [ ] Phase 3: Extend `CtrlYokeHostedServer.buildHtml()` to resolve and inject a locale placeholder (setting → `Accept-Language` → `en` fallback), following the existing `themeBodyClass`/icon-URI substitution pattern
- [ ] Phase 3: Add `eslint-plugin-i18next` `no-literal-string` rule scoped to `src/ui/webview-react/components/**`
- [ ] Phase 3: Add a pseudo-locale resource bundle for the React side and a documented way to load it for visual QA
- [ ] Phase 4: Migrate component strings to `t()` calls, area by area (track as its own set of follow-up PRs/issues)
- [ ] Phase 5: Pick pilot locale, run full extraction → translation → integration for manifest + host + React, validate runtime switching end-to-end
- [ ] Empirically confirm (DevTools/manual test) whether browser auto-translate ever surfaces for the hosted dashboard, and note the finding here — informs whether it's worth mentioning to users as an interim fallback
