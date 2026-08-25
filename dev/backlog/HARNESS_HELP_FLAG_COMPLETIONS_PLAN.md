# Additional Args Completions from Live `--help` Output

> **Status:** Steps 1–2 implemented; message plumbing and webview rollout remain.
>
> Referenced as a follow-up from
> [`ALLOW_DENY_LIST_EDITOR_PLAN.md`](ALLOW_DENY_LIST_EDITOR_PLAN.md#3-other-free-text-fields-in-workflowpropertiespaneltsx-worth-the-same-treatment),
> which recommended _against_ completions for Additional Args on the
> assumption it would mean hand-maintaining a per-harness flag list. This
> plan proposes something different — parsing the actual installed CLI's
> `--help` output live — which sidesteps that objection. See "Reconsidering
> the earlier pushback" below.

## Goal

Auto-complete `--flag` names (and, where the help text makes it easy, their
value hints) in every Additional Args field, sourced by running the
currently-selected harness's own `--help` and parsing its flag table —
always in sync with whatever version of that CLI is actually installed,
with no ctrlyoke-maintained flag list to go stale.

## Why

Today, getting an Additional Args value right means leaving ctrlyoke,
running `copilot --help` (or `claude --help`, etc.) in a terminal, finding
the flag by eye, and typing it back in freehand — every time, because
nothing in the field remembers what was found last time or which harness
it's even for. This is exactly the workflow the user described: "I almost
always have to manually run `copilot --help`... oh yeah it's
`--reasoning-effort high`."

## Reconsidering the earlier pushback

The prior plan's objection to Additional Args completions was specifically
about a **hand-maintained** list: "flags belong to external CLI tools
ctrlyoke doesn't control or version-pin... a stale suggestion here is
actively misleading." That objection doesn't apply to this design — parsing
`--help` from the exact binary `resolveCliCommand()` would actually launch
means the completion list _is_ the installed version's real flag set, not a
snapshot that can drift. If anything, this is more accurate than a
human remembering flags from the last time they checked. The remaining
risk is different in kind: not staleness, but **parse fidelity** — whether
the text-scraping correctly extracts every flag from six CLIs that don't
share a help-output format. That's addressed below, not dismissed.

## Current State

Two call sites, both plain text inputs, no assistance at all:

| Surface                             | File                                                    | Commit behavior                                           |
| ----------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| Workflow-level Additional Args      | `WorkflowPropertiesPanel.tsx` (~L1579–L1591)            | on blur (local `useState` + `handleAdditionalArgsChange`) |
| Per-harness default Additional Args | `components/settings/HarnessesSection.tsx` (~L127–L147) | on blur (`LocalTextInput`)                                |

Both store a single space-separated flag string
(`WorkflowProperties.additionalArgs` / `globalSettings.harnessDefaultAdditionalArgs[harnessId]`),
already parsed at execution time with the shared, dependency-free
`parseArgString()` (`src/utils/CliArgParser.ts`) — quote-aware
whitespace tokenizing, no vscode/Node imports, safe to reuse in the webview
for finding which token the cursor sits in.

The six harness binaries and their existing version-check convention
(one `CliProviderUtils.checkCliAvailability("<bin> --version")` /
`getCliVersion("<bin> --version")` call per provider) are the model to
follow:

| Harness           | Binary     |
| ----------------- | ---------- |
| `copilot-cli`     | `copilot`  |
| `claude-cli`      | `claude`   |
| `codex-cli`       | `codex`    |
| `opencode-cli`    | `opencode` |
| `qwen-cli`        | `qwen`     |
| `antigravity-cli` | `agy`      |

## Proposed Design

### 1. Extension-host: run and cache `--help` — implemented

Add a sibling to `CliProviderUtils.runVersionCommand()` — e.g.
`runHelpCommand(helpCommand: string, options?)` — reusing the exact same
machinery that already exists for version checks:

- `resolveCliCommand()` (`CliLauncherResolver.ts`) for launcher resolution
  (shell/PATH/WSL handling), so this doesn't reinvent process spawning.
- `execFileAsync` with a timeout (mirror `CLI_VERSION_CHECK_TIMEOUT_MS`;
  `--help` may print more output than `--version` but should still return
  well under a second for every CLI in this list — measure per harness
  during implementation and give `--help` its own constant if it needs
  more headroom).
- A dedicated `RetryableAsyncCache<string>` instance, separate from
  `versionCommandCache` (different result shape, and no reason to share
  invalidation with version lookups), keyed by harness id. One successful
  `--help` per harness per extension-host session is enough — flags don't
  change mid-session, and the cache already exists precisely to coalesce
  concurrent lookups the way it does for version checks today.
- Reuse the existing Windows-file-lock retry option
  (`retryWindowsFileLockErrors`) for the same reason version checks use it —
  an updater mid-write shouldn't produce a hard failure.

Each `*CliProvider.ts` already single-sources its own binary name in its
`"<bin> --version"` string; add the matching `"<bin> --help"` string next to
it (or, better, extract the bare binary name to one constant per provider
that both the version and help commands build from, closing a small
existing duplication rather than adding a third copy of `"copilot"` /
`"claude"` / etc.).

#### Step 1 landed

- `CliProviderUtils.runHelpCommand()` now uses launcher resolution,
  `execFileAsync`, Windows file-lock retries, and its own retryable cache.
- Help probes reuse `CLI_VERSION_CHECK_TIMEOUT_MS` (30 seconds). Measured
  `--help` runs for all six installed CLIs completed in approximately
  0.1–1.3 seconds, leaving ample headroom without introducing another
  timeout constant.
- Each provider now builds public version/help command constants from one
  private binary-name constant.
- Captured fixtures: `claude-cli`, `codex-cli`, `copilot-cli`, `opencode-cli`,
  `qwen-cli`, and `antigravity-cli`.

### 2. Parsing `--help` into flag completions

This is the part the user correctly flagged as needing real design — six
CLIs, not one predictable format. Structure it as a generic parser plus
per-harness overrides, not a single regex assumed to fit everything:

- **Generic default parser**: scan lines for the common two-column shape
  most CLI flag tables share regardless of underlying framework
  (Commander/yargs-style Node CLIs, Rust `clap`, Python `argparse` all
  produce some variant of `  -x, --flag-name <value>    Description text`).
  Extract: the long flag (`--flag-name`), an optional short alias, an
  optional bracketed/angle-bracket value placeholder, and the description
  column (used as completion `detail`).
- **Per-harness override hook**: when a harness's actual output doesn't fit
  the generic shape (expect at least one or two of the six to need this —
  won't know which until real `--help` output is captured), give that
  harness its own parse function. Same shape as
  `IToolPermissionMapper`/per-harness tool mappers in this codebase — one
  default implementation, explicit per-harness overrides where reality
  disagrees, not one regex trying to special-case everything inline.
- **Value hints are best-effort, not required.** Directly addresses the
  user's `--reasoning-effort high` example: if a description column spells
  out an enum inline (e.g. `(choices: "low", "medium", "high")`, a common
  yargs/argparse rendering), parse it into secondary completions offered
  after the flag is typed. If a harness's help text doesn't make this easy,
  ship flag-name-only completions for it rather than holding up the whole
  feature on 100% value-hint coverage.
- **Test fixtures are load-bearing here.** Capture real `--help` output from
  each installed CLI into `src/test/fixtures/harness-help/<harness>.txt` (or
  similar) during implementation, and unit-test the parser against those
  snapshots — this is a text-scraping feature; without fixture-backed tests
  it will silently break the next time any of the six CLIs reformats its
  help output, and nobody would notice until a user reports "completions
  stopped working."
- **Fail soft, always.** An unparseable or errored `--help` (CLI not
  installed, unexpected format, timeout) must resolve to an empty
  completion list, never throw into the completion round trip or block the
  field. This mirrors how `checkCliAvailability` already swallows failures
  into a boolean.

#### Step 2 landed

- `HarnessFlagCompletionProvider.ts` has a generic, fail-soft parser for the
  shared two-column option table. It handles short aliases, multiple long
  aliases, angle/bracket value placeholders, wrapped descriptions, and
  flag-only rows.
- All six captured fixtures parse acceptably with the generic parser, so no
  per-harness override was added: `copilot-cli`, `claude-cli`, `codex-cli`,
  `opencode-cli`, `qwen-cli`, and `antigravity-cli` all use the default path.
  Codex's wider option indentation and wrapped `Possible values` blocks are
  handled by the same parser rather than a harness-specific rule.
- Value hints are available wherever the help text exposes an unambiguous
  enum: Antigravity (`--effort`, `--input-format`, `--mode`,
  `--output-format`), Claude (`--autocompact`, `--cloud`, `--effort`,
  `--input-format`, `--output-format`, `--permission-mode`,
  `--prompt-suggestions`, `--setting-sources`), Codex (`--sandbox`,
  `--ask-for-approval`), Copilot (`--bash-env`, `--context`,
  `--reasoning-effort`, `--log-level`, `--mode`, `--mouse`,
  `--output-format`, `--stream`), OpenCode (`--log-level`), and Qwen
  (`--output-format`). Other parsed flags intentionally remain flag-name-only.
- Fixture-backed unit tests cover every captured file, plus empty/malformed
  input, aliases, wrapped descriptions, and hand-written enum formats.

### 3. Message plumbing + webview completion source

Same shape as `ScriptCommandEditor`/the allow-deny list plan's completion
source:

- New `HARNESS_FLAG_COMPLETIONS_REQUEST`/`_RESPONSE` message types
  (`DashboardConstants.ts` / `WebviewMessageTypes.ts`), registered in
  `WebviewMessageRouter.ts`, handled by a new
  `PromptEditorSupportService.handleHarnessFlagCompletionRequest(harnessId)`
  that calls the new extension-host parser and emits the response.
- New `AdditionalArgsEditor.tsx` in `components/shared/`, wrapping
  `SingleLineCompletionEditor` directly (single-line is correct here — this
  is one line of space-separated flags, not the multiline case the
  allow-deny list plan adds). Its completion source:
  - Finds the token containing the cursor by tokenizing the line the same
    way `parseArgString` does (or a lighter cursor-aware variant of the
    same whitespace/quote rules), so a partially-typed `--reaso` mid-string
    filters correctly instead of matching against the whole field value.
  - Requests `HARNESS_FLAG_COMPLETIONS_REQUEST` with the caller-supplied
    harness id and offers flag-name completions filtered by prefix; when
    the token after an already-typed flag is being edited and that flag has
    a parsed value hint, offers those as a second completion set.
  - Takes `harnessId` as a required prop so both call sites — one resolving
    it from `effectiveHarness` (workflow-level), one iterating a fixed
    `harnessId` per row (`HarnessesSection.tsx`) — pass it in explicitly
    rather than the component re-deriving it from store state.

### 4. Roll out to both call sites

- `WorkflowPropertiesPanel.tsx` (~L1579–L1591): swap the `<input>` for
  `<AdditionalArgsEditor harnessId={effectiveHarness} ...>`. Re-request
  completions when `effectiveHarness` changes (the field already lives next
  to the harness dropdown, so a harness switch should invalidate any
  in-flight/cached completion set for the field currently shown).
- `HarnessesSection.tsx` (~L127–L147): swap the `LocalTextInput` for
  `<AdditionalArgsEditor harnessId={harnessId} ...>`, one instance per
  harness row — `harnessId` is already fixed per row here, so no
  change-detection needed, just pass it straight through.

## Affected Components

| Component                                                        | Planned role                                                                     |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `CliProviderUtils.ts`                                            | New `runHelpCommand()` + dedicated `RetryableAsyncCache<string>` for help output |
| `*CliProvider.ts` (all six)                                      | Single-sourced binary name feeding both `--version` and `--help` commands        |
| `src/core/harness/shared/HarnessFlagCompletionProvider.ts` (new) | Generic + per-harness `--help` parsers → `{flag, valueHints?, detail}[]`         |
| `PromptEditorSupportService.ts`                                  | New `handleHarnessFlagCompletionRequest()`                                       |
| `WebviewMessageRouter.ts`                                        | Registers `HARNESS_FLAG_COMPLETIONS_REQUEST`                                     |
| `DashboardConstants.ts` / `WebviewMessageTypes.ts`               | New message type + payload contracts                                             |
| `components/shared/AdditionalArgsEditor.tsx` (new)               | Wraps `SingleLineCompletionEditor` + the completion source                       |
| `WorkflowPropertiesPanel.tsx`                                    | Workflow-level Additional Args field                                             |
| `components/settings/HarnessesSection.tsx`                       | Per-harness default Additional Args fields                                       |
| `src/test/fixtures/harness-help/*.txt` (new)                     | Captured real `--help` output per harness, backing parser unit tests             |

## Decisions Deferred to Implementation

- Exact generic-parser regex and which harnesses (if any) need a full
  per-harness override — can't be known without capturing real `--help`
  output from all six installed CLIs first.
- Whether value-hint parsing ships in the first version or is a fast-follow
  once flag-name completion is working end-to-end. Flag names alone already
  deliver most of the value in the user's own example (`--reasoning-effort`
  is the hard-to-remember part; `high` is not).
- Cache lifetime: session-lifetime (matching `versionCommandCache`'s
  contract) vs. keyed by resolved binary path so a mid-session CLI upgrade
  is picked up without an extension reload. Lean toward session-lifetime
  for simplicity unless testing shows this is actually annoying in
  practice.
- Whether completions prefetch on harness change (workflow-level field) or
  stay purely lazy (fetched on first focus/keystroke) — affects perceived
  latency on first use vs. unnecessary process spawns for harnesses the
  user never touches Additional Args for.

## Non-Goals

- Validating/linting an already-typed Additional Args value against the
  parsed flag set. These are pass-through flags to a tool ctrlyoke doesn't
  own; flagging a flag as "unknown" risks false positives the moment the
  parser misses something the real CLI supports. Completions only, same
  stance the allow-deny list plan takes for its own "unrecognized bare
  name" rule.
- Positional (non-flag) argument completion — out of scope; `--help` flag
  tables don't describe these in a form worth parsing.
- Any change to how Additional Args values are applied to the actual CLI
  invocation at execution time — this plan only touches authoring-time
  assistance.
