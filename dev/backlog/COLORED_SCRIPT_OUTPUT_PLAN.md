# Colored Script Output — preserve terminal color/formatting in the Output pane

> **Status:** Not implemented. Builds on
> [`SCRIPT_OUTPUT_UNIFICATION_PLAN.md`](../implemented/SCRIPT_OUTPUT_UNIFICATION_PLAN.md)
> (implemented 2026-07-25), which unified script/pre-condition/end-condition output onto one
> `CliOutput` pipeline but always renders plain, ANSI-stripped text.

## Problem

Script step and condition output in the Output pane never shows color, even though a script
like `npm test` or `eslint` would print red/green/yellow output if run directly in a terminal.
Three independent gaps compound, and any real fix has to address all three or it does nothing
visible:

### 1. Most scripts never emit color in the first place

`CliProcessManager.spawn` (`src/utils/CliProcessManager.ts:87-101`) launches the child with
`stdio: [options.stdin ?? "ignore", "pipe", "pipe"]` — piped, non-TTY stdout/stderr. This is
also the code path `EndConditionEvaluator` uses for script steps, pre-conditions, and
end-conditions. Well-behaved CLIs (npm, eslint, jest, vitest, tsc, most Node tooling) detect
`!process.stdout.isTTY` and disable their own color output. **No amount of preserving ANSI
codes downstream helps if the child process never wrote any.** The one place ctrlyoke already
runs scripts through a real PTY is *interactive* script steps
(`WorkflowExecutor.ts:1193-1214`, via `context.spawnScriptPty` →
`WorkflowInstance.ts:3722-3741` → `node-pty`), and that raw, colored PTY output already reaches
the webview live through a `TERMINAL_OUTPUT` postMessage rendered by a separate `@xterm/xterm`
terminal view (`TerminalInstance.tsx`) — a different surface from the Output pane's `CliOutput`
rows entirely. The dashboard's own `CliOutput.response` for that same interactive run is built
from `sanitizeTerminalOutput(outputChunks.join(""))` (`WorkflowExecutor.ts:1228`), so even the
one place color already exists today gets thrown away before it reaches this pane.

### 2. The sanitizer strips all ANSI indiscriminately

`stripAnsiCodes` (`src/utils/TerminalOutputSanitizer.ts:1-2, 14-20`) uses one blanket pattern —
`/\x1B(?:\[[0-?]*[ -/]*[@-~]|\][\s\S]*?(?:\x07|\x1B\\)|[@-Z\\-_])/g` — that matches CSI, OSC,
and single-char escapes alike and deletes all of them. It does not distinguish SGR color/style
codes (`\x1B[31m`, `\x1B[38;5;208m`) from cursor-movement, clear-screen, or terminal-title
sequences. `sanitizeTerminalOutput` (`:75-97`) is called at every boundary that currently
matters for display: the streaming-chunk publisher (`ScriptExecutionReporter.ts:211`) and the
final aggregated response text (`ScriptExecutionReporter.ts:265-270`), plus the interactive-PTY
capture path noted above.

### 3. Rendering is plain text, and comparisons must stay ANSI-free

`OutputRow.tsx` renders `response` as plain React children inside `whitespace-pre-wrap`
containers (e.g. `:250, :286, :372, :405, :1579`) — no `dangerouslySetInnerHTML`, no terminal
emulator. Raw ANSI bytes would currently render as literal garbage glyphs, not color. Separately,
`highlightText`/`outputFind.ts` (`:94-98` and `outputRows.ts:1086-1115`) already slice the same
string into highlighted-match spans for find-in-page; any color-span layer has to compose with
that, not fight it. And critically: `EndConditionEvaluator.checkResult`/`evaluateSuccess` compare
`actual` (derived from stdout/stderr) against `returns` for `substring`/`exact`/`numericGte`
match rules. If a fix forces color into a script's stdout, gate comparisons on that same stdout
must keep comparing the **color-stripped** text, or existing `compareSource: stdout` conditions
silently break the day this ships.

## Why this isn't a quick fix

Restoring color is not "stop stripping ANSI codes." It requires: (a) actually getting the child
process to emit color despite non-TTY stdio, (b) a sanitizer that keeps SGR sequences while
still stripping genuinely unsafe/meaningless-in-a-log control sequences (cursor movement, clear
screen, alternate-screen-buffer toggles), (c) carrying that color-preserving text through
streaming + persistence without regressing find/search or virtualization row-height estimates,
(d) a render-time ANSI→React converter, and (e) guaranteeing verdict/gate comparisons are
unaffected. Each of these touches a different layer (spawn options, extension-host sanitizer,
webview rendering, persisted JSON shape) and has its own failure mode, which is why this is a
backlog plan rather than a same-session patch.

## Goals

- Script step, pre-condition, and end-condition output rendered in the Output pane visually
  matches, as closely as practical, what the user would see running the same command in a real
  terminal — ANSI colors and basic SGR styling (bold/dim/underline), not full terminal emulation.
- Gate/condition pass-fail logic (`compareSource: stdout`/`stderr`, `substring`/`exact`/
  `numericGte`/`boolean` match rules) is provably unaffected — it must keep operating on
  color-stripped text regardless of what's forced into the child process's env.
- Find-in-page search and highlighting keep working against colored output.
- No regression to virtualization row-height estimation (`outputRows.ts` `estimateSize`) or to
  the existing `sanitizeTerminalOutput` LRU cache behavior for callers that still want plain text
  (row-height estimation, condition status summaries via `summarizeStatusError`, timeline logs).
- Opt-in or safely-defaulted: a tool whose output happens to contain byte sequences that only
  *look* like SGR codes must not corrupt rendering, and forcing color must not be sprung on users
  who rely on today's plain-text behavior without warning.

Non-goals: full terminal emulation (cursor addressing, alternate screens, interactive TUIs) —
that already exists via the separate PTY/xterm terminal view for interactive script steps and is
out of scope for the Output pane's `CliOutput` rows. Also non-goal: coloring AI-harness
(Claude/Codex/etc.) CLI response text — `CliResponseCollector.ts:197` sanitizes those for a
different reason (they're prose, not shell output) and are not part of this plan.

## Target model

### Forcing color out of non-TTY child processes

`CliProcessManager.spawn` and `EndConditionEvaluator`'s script/condition execution path need an
opt-in `forceColor` option that sets `FORCE_COLOR: "1"` (recognized by chalk, and by extension
most Node-based tooling: npm scripts wrapping jest/vitest/eslint/tsc, since they all read the
same `supports-color`/`chalk` convention) in the spawned child's `env`. This covers the large
majority of the tooling ctrlyoke users actually gate on. Explicitly out of scope for a first
pass: non-Node CLIs with their own color-forcing conventions (`git -c color.ui=always`,
`CLICOLOR_FORCE` for BSD tools, `--color=always` flags) — document this as a known gap rather
than trying to special-case every tool.

This must be gated by a new setting (see `schemas/settings-schema.json` /
`CtrlYokeSettings.ts` — the only settings surface per this repo's conventions), e.g.
`scriptOutput.forceColor: boolean` (default likely `false` initially, revisit after real-world
testing), read through `CtrlYokeConfigService`/`ConfigurationUtils` like every other setting.
Forcing color changes the exact bytes a script or gate observes, so this cannot be silently
always-on.

### A color-preserving sanitizer variant

Add `stripAnsiCodesPreservingColor` (or similar) alongside `stripAnsiCodes` in
`TerminalOutputSanitizer.ts`, and a `sanitizeTerminalOutputPreservingColor` alongside
`sanitizeTerminalOutput`. The new pattern must classify CSI sequences instead of blanket-matching
them: keep `\x1B[...m` (SGR — color/bold/underline/reset) and drop everything else (cursor
movement `A-H`, erase `J`/`K`, OSC title/hyperlink sequences, alternate-screen-buffer toggles).
The existing `CRLF_CR_OR_CONTROL_PATTERN` control-byte cleanup still applies unchanged — that
part isn't about color at all.

Keep the fully-stripped `sanitizeTerminalOutput` as the default and as what feeds:

- `EvaluationResult`/verdict comparisons (`EndConditionEvaluator.ts` `checkResult`/
  `evaluateSuccess`) — **always** compare against fully color-stripped text, never the
  color-preserving variant, regardless of the `forceColor` setting.
- `summarizeStatusError` (`ScriptExecutionReporter.ts:92-97`) — the one-line status summary has
  no use for color.
- Row-height estimation and any other caller that only needs plain text.

The color-preserving variant feeds only `CliOutput.response` and the streaming chunk pipeline
when the color-output feature is enabled.

### Streaming and persistence: keep it a string

Do **not** bake parsed color spans into persisted JSON. `CliOutput.response` stays a plain
`string`, just with SGR codes intact instead of stripped — this keeps `run-<timestamp>/` history
files, `OutputHistoryManager`, and `StreamingHistoryBuffer` untouched, and keeps old runs
(persisted before this feature existed) trivially compatible: no SGR codes in old data just means
nothing to parse, which is the same as today's plain-text rendering. `StreamChunkCoalescer`
(`ScriptExecutionReporter.ts:245`) already joins chunks before sanitizing specifically so a
split escape sequence isn't corrupted at a packet boundary — that guarantee must hold for SGR
sequences too, since terminal writers can flush mid-escape-code.

Parse ANSI → styled spans at **render time** in the webview, not at persistence time. This means
every render of the same string re-parses it, so the parse needs to be cheap and should reuse the
same LRU-cache pattern `TerminalOutputSanitizer.ts` already uses for repeated calls against the
same row's text.

### Rendering: structured spans, not HTML strings

Do not use `dangerouslySetInnerHTML` for this — ctrlyoke's own coding principles favor explicit,
type-checked structure over string-blob rendering, and stdout is attacker-adjacent-ish (a
malicious/compromised script's output is untrusted content the user is viewing). Prefer a small
ANSI→structured-segments parser (e.g. the `anser` package, which returns
`{ content, fg, bg, decoration }[]` rather than an HTML string) and map segments to `<span
style={...}>` in a new render helper, likely alongside `OutputRow.tsx`'s existing response
rendering (`:250, :286, :372, :405, :1579`) or as a small new component next to `BashOutput.tsx`.
`chalk` is already a dependency (`package.json:776`) but is a *generator* of ANSI codes for the
CLI's own console output, not a parser — it doesn't help here.

### Composing with find-in-page highlighting

`highlightText`/`outputFind.ts` currently slice plain strings by character offset to insert
highlight spans. Once the same string can also carry SGR codes that must be stripped from the
*displayed* text but whose surrounding color must still apply to the visible characters, offset
math has two independent transforms fighting over the same string. The safest approach: parse
ANSI into segments first (each segment: plain text + style), then run the existing find/highlight
offset logic per-segment against each segment's plain text, re-splitting a segment further only
where a match boundary falls inside it. This is very similar in shape to how tool-call/diff
rendering already splits text into styled sub-ranges — reuse that pattern rather than inventing a
new offset-merging scheme, whichever component (`toolCallLayout.ts`, diff rendering) does it most
cleanly today.

### Virtualization

`estimateSize` (`outputRows.ts:1232` and friends) must estimate off the *displayed* character
count (post-ANSI-strip length), not the raw string length — a heavily-colored line has
significantly more bytes than visible characters, and estimating off raw length would
systematically over-estimate row height and cause scroll jump. This is the same class of risk the
unification plan already flagged for the verdict block ("a verdict block that measures 3× its
estimate causes scroll jump").

## Phasing

**Phase 0 — feasibility spike.** Confirm `FORCE_COLOR=1` actually changes output for the
project's own real usage (`npm test`, `eslint`, `tsc`, a couple of user-authored gate scripts).
If most real-world gates people write are simple non-Node shell commands that don't honor
`FORCE_COLOR`, the value of this whole feature needs re-assessing before investing further.

**Phase 1 — opt-in color forcing + settings.** `forceColor` spawn option in
`CliProcessManager`/`EndConditionEvaluator`, threaded from the new setting. No display change
yet — verify via raw log output that color bytes now exist in captured stdout when enabled.

**Phase 2 — color-preserving sanitizer.** `stripAnsiCodesPreservingColor` /
`sanitizeTerminalOutputPreservingColor`, wired into `ScriptExecutionReporter.ts:211/265` and the
interactive-PTY capture in `WorkflowExecutor.ts:1207/1228` behind the same setting. Verdict/gate
comparison paths explicitly re-verified to still use the fully-stripped variant — add a
regression test asserting a `compareSource: stdout` / `substring` condition still matches
correctly when `forceColor` is on and the compared text contains SGR codes.

**Phase 3 — render-time parsing and display.** Add the ANSI→segments dependency, new render
helper, wire into `OutputRow.tsx`/`BashOutput.tsx` response rendering, fix `estimateSize` to use
display-length.

**Phase 4 — find-in-page composition.** Segment-aware highlight offset logic.

**Phase 5 — tests.** Extension host: `CliProcessManager`/`EndConditionEvaluator` force-color
option; `TerminalOutputSanitizer` SGR-preserving vs. cursor/OSC-stripping cases; a
`scriptExecutionReporter`-level test that verdict comparison is unaffected by color forcing.
Webview: ANSI segment parsing unit tests (colors, bold/underline, resets, nested/malformed
sequences), `OutputRow` render tests for a colored response, `outputFind` tests for a match that
spans a color-segment boundary.

## Risks

- **Gate correctness regression** is the sharpest risk in this whole plan: if the
  color-preserving text ever leaks into a comparison path, existing workflows with
  `compareSource: stdout` conditions can start failing (or start silently passing) the moment a
  user enables color forcing. Phase 2's regression test is not optional.
- **Malformed/adversarial ANSI.** A script's output is not trusted input. The SGR-preserving
  regex and the render-time parser must both be defensive against pathological sequences
  (unterminated escapes, deeply nested SGR codes, huge repeated color-change spam designed to
  bloat span count) — cap segment count per row the same way `outputTruncation`'s
  `buildCollapsedOutputPreview` already caps long text.
- **Cross-platform color support.** `FORCE_COLOR` behavior and terminal capability differ across
  Windows/macOS/Linux and shell (`cmd.exe` vs PowerShell vs POSIX shells) — verify on Windows
  specifically, since that's this project's primary dev/test platform per environment context.
- **Feature value vs. cost.** Given Phase 0's feasibility question, this could turn out to help
  only a minority of scripts (Node-tooling-based ones) while adding real complexity to the
  sanitizer, streaming, rendering, and find-in-page paths. Re-scope down to "Node-tooling color
  only, everything else stays plain" if Phase 0 shows narrow real-world benefit, rather than
  chasing every possible color-forcing mechanism.
