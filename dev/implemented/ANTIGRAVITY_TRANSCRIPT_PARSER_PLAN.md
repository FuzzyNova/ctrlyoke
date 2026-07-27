# Antigravity Transcript Parser

**Status: Implemented**

The Antigravity log parser now consumes the rich per-session transcript
incrementally and exposes the same `CliEvent` vocabulary used by the other CLI
providers. Both interactive and headless execution use this log parser; the
headless path tails it through `HeadlessLogTail`.

## Sources and authority

- The Go `cli-*.log` remains the source for conversation/session discovery and
  the top-level `clearing ResponsePending` completion marker.
- `brain/<conversationId>/.../transcript_full.jsonl` is the authoritative
  transcript. `transcript.jsonl` is selected only when the full file does not
  exist; both files are never read together.

This avoids duplicate user events and preserves typed tool arguments and full
content that the compact transcript can truncate or encode as strings.

## Incremental reader

`AntigravityTranscriptReader` tails the selected JSONL file with a byte offset.
It parses complete appended lines in file order, retains an incomplete trailing
line until the next poll, and resets its offset when the file is replaced or
truncated. Each line is emitted once; malformed or unknown entries are ignored
without stopping the stream.

`AntigravityLogParser` maps entries as they arrive. Planner text, thinking,
tool calls/results, checkpoints, errors, and user input become structured
`CliEvent`s. Response extraction consumes this mapped stream, so completion does
not perform a separate scan for a “latest response”.

## Planner/result pairing

The planner line contains the tool call and the following transcript line holds
its result. Pairing is therefore adjacent and file-order based. `step_index` is
only an identity hint: it can be sparse and non-monotonic, so it is never used
to locate a result by arithmetic or to reorder the stream.

The mapper preserves command text, file-write content, structured replacement
chunks, MCP targets, exit codes, and unified diff blocks. A command that exits
non-zero is emitted as a failed `BASH_COMMAND`; a `CODE_ACTION` diff is parsed
through the shared unified-diff helper.

## Background tasks and completion

Antigravity writes background launches and completions as separate entries:

- `MODEL` / `RUN_COMMAND` / `RUNNING` is a launch with a task ID and remains
  unchanged in the append-only transcript.
- `SYSTEM` / `SYSTEM_MESSAGE` / `DONE` reports the matching task ID's success or
  failure.

The parser matches those IDs through the shared
`BackgroundFollowUpState`. A resumed planner response closes the pending hold;
the parser uses the same stale-stop guard as Copilot because a completion and
the resumed turn can be observed in one monitor poll.

## User input

Only the authoritative transcript is examined for user input. The parser
unwraps Antigravity's `<USER_REQUEST>` envelope before comparing it with the
prompt dispatched by ctrlyoke, so the injected prompt is not misclassified as a
human steer. Genuine steer messages remain available to the workflow.

## Verification

Behavior is covered by `src/test/unit/AntigravityLogParser.test.ts`, including:

- full-transcript authority and compact-file fallback;
- incremental reads split at a partial JSONL line;
- adjacent planner/result pairing with non-monotonic step indexes;
- rich file, command, MCP, checkpoint, and error events;
- separate background launch/completion matching and resumed-turn gating.

The parser is integrated through `CliLogMonitor` and the shared
`SessionActivityWatcher`; no completion-time transcript hack remains.
