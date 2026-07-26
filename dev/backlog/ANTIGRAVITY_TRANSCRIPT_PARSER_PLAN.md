# Antigravity Transcript Parser — Full-Fidelity Rewrite

**Status:** Proposal (not started)
**Relationship to other work:** **Prerequisite** for the Antigravity phase of `PARSER_UNIFICATION_PLAN.md`. That plan assumed log-sourcing Antigravity would yield structured tool/text events; it will not, because the current log parser produces exactly one TEXT event regardless of source. This is the work that makes the assumption true. It is independently valuable and can ship on its own.

---

## What the parser does today

`AntigravityLogParser` reads **two different files for two different purposes**, and the split is not what the class name suggests:

| Source | Read by | Produces |
| --- | --- | --- |
| `~/.gemini/antigravity-cli/log/cli-*.log` (Go server log) | `discoverSessionLog()`, `readNewLines()` | `session.created`, `response.completed`, and untyped `log.line` noise |
| `brain/<sessionId>/.system_generated/logs/transcript*.jsonl` | `readNewUserSteerEvents()`, `hasPendingBackgroundWork()`, `getFinalEventsOnCompletion()` | `user_input` steers, background-task state, and **one** `response.text` |

The tailed "log file" carries no response content at all. It exists to detect completion (`clearing ResponsePending`) and to scrape a session UUID.

All actual response content arrives through **one call at the very end**: `getFinalEventsOnCompletion()` → `readLatestResponseFromTranscript()`, which scans the transcript and keeps only the **last** `MODEL/PLANNER_RESPONSE/DONE` entry with non-empty content. `extractResponse()` then joins the resulting `response.text` events — of which there is exactly one — into a single `CLI_EVENT_TYPES.TEXT`.

**Consequence:** Antigravity output is one undifferentiated text blob, delivered at completion. Every file edit, command, and file read the model performed is discarded. This is the same fidelity as `AntigravityResponseParser` (59 LOC, wraps all stdout in one TEXT event) — which is why swapping one for the other gains nothing.

---

## What the transcript actually contains

Verified against `brain/a1eb7caf-9b06-4429-b0d0-01254f99731b/.system_generated/logs/transcript_full.jsonl` (a real `agy` run: create a file, edit 5 lines, delete it) plus a `source/type/status` census across every session currently in `~/.gemini/antigravity-cli/brain/`.

Entry shape: `{ step_index, source, type, status, created_at, content }`, plus `exit_code` on `RUN_COMMAND`.

### Observed vocabulary (all sessions on disk)

| Count | `source/type/status` | Maps to |
| --- | --- | --- |
| 180 | `MODEL/PLANNER_RESPONSE/DONE` | `TEXT` (skip empty-content placeholders) |
| 66 | `USER_EXPLICIT/USER_INPUT/DONE` | prompt echo or `USER_STEER` — see classification bug below |
| 58 | `SYSTEM/CONVERSATION_HISTORY/DONE` | drop (always empty) |
| 56 | `SYSTEM/CHECKPOINT/DONE` | `COMPACTION` (content is a context-truncation notice) |
| 29 / 14 | `MODEL/RUN_COMMAND/DONE` / `RUNNING` | `BASH_COMMAND` + `TOOL_RESULT` (carries `exit_code`, stdout, stderr) |
| 26 | `MODEL/VIEW_FILE/DONE` | `FILE_READ` (File Path, Total Lines, Total Bytes, line-numbered body) |
| 14 | `SYSTEM/SYSTEM_MESSAGE/DONE` | background-task completion (already consumed by `hasPendingBackgroundWork`) |
| 13 / 1 | `MODEL/GENERIC/DONE` / `RUNNING` | `TOOL_CALL` |
| 7 | `MODEL/LIST_DIRECTORY/DONE` | `TOOL_CALL` |
| 6 | `SYSTEM/ERROR_MESSAGE/DONE` | error surfacing |
| 6 | `MODEL/CODE_ACTION/DONE` | `FILE_WRITE` or `FILE_EDIT` — see below |
| 4 | `MODEL/MCP_TOOL/DONE` | `MCP_TOOL_CALL` |
| 2 / 1 | `MODEL/LIST_RESOURCES`, `MODEL/READ_RESOURCE` | `MCP_TOOL_CALL` |

### `CODE_ACTION` carries a real unified diff

Two content shapes, both parseable:

**Create** — no body, so `FILE_WRITE` will have an empty `content`:
```
Created file file:///c:/dev/ctrlyoke/temp.txt with requested content.
```

**Edit** — a genuine unified diff between `[diff_block_start]` / `[diff_block_end]` markers (confirmed both markers present):
```
The following changes were made by the replace_file_content tool to: c:\dev\ctrlyoke\temp.txt.
[diff_block_start]
@@ -1,10 +1,10 @@
 Line 1: Initial content
-Line 3: Initial content
+Line 3: Edited content
...
[diff_block_end]
```

The hunk body feeds `CliParseUtils.parseUnifiedDiff()` (today `CliResponseParser.parseUnifiedDiff`) unchanged — the same helper Codex and Copilot already use. So `FILE_EDIT` with a working `structuredPatch`, and therefore working undo, is directly achievable.

**No native delete event exists.** In the sample run the delete was performed via `RUN_COMMAND` (`Remove-Item`), so it correctly renders as a bash command, not `FILE_DELETE`. Do not synthesize a `FILE_DELETE` from command text.

---

## Two confirmed bugs (reproduced)

Both are visible in a single real run's rendered output and are independent of the rewrite — worth fixing first as small, verifiable changes.

### 1. Every user message renders twice

`readNewUserSteerEvents()` reads **both** `transcript_full.jsonl` and `transcript.jsonl`. In the sample these files are near-identical (7390 vs 7276 bytes, same 12 entries), and both contain the same `USER_EXPLICIT/USER_INPUT` entry with byte-identical content.

`seenUserInputLineIndices` is keyed **per transcript path**, so it dedupes within each file but never across the pair. The same logical entry is emitted twice.

**Fix:** dedupe across both files on a stable identity — `step_index` is present on every entry and is the natural key — or read only one transcript and treat the other as a fallback (the pattern `getFinalEventsOnCompletion` already uses via `??`).

### 2. ctrlyoke's own injected prompt is misclassified as a human steer

`classifyUserEvent()` compares `normalizedLogged.includes(normalizedDispatched)` on 100-character prefixes. But `agy` wraps the prompt in `<USER_REQUEST>` / `<ADDITIONAL_METADATA>` / `<USER_SETTINGS_CHANGE>` tags, and `normalizePromptForMatching()` only lowercases, trims, and swaps backslashes (`BaseLogParser.ts:692`) — it does not strip tags.

Reproduced exactly:

```
dispatched[0..100] → "follow instructions in c:/dev/ctrlyoke/.ctrlyoke/temp/1785094780-file-edit-test-1.prompt.md"
logged[0..100]     → "<user_request>\nfollow instructions in c:/dev/ctrlyoke/.ctrlyoke/temp/1785094780-file-edit-test-1.pro"

nl.includes(nd) === false   →  "human-steer"  →  rendered as "● User message"
```

The 15-character `<USER_REQUEST>\n` prefix pushes the prompt tail past the 100-char window, so the substring test can never succeed. It is not a near-miss — this misfires on **every** Antigravity prompt.

**Fix:** unwrap the `<USER_REQUEST>…</USER_REQUEST>` body before comparing, and compare on the extracted body rather than a fixed-width prefix of the raw entry. Combined with bug 1, this is why the sample output shows the injected prompt twice before the response.

---

## Critical implementation constraint: the transcript is not append-only

`MODEL/RUN_COMMAND/RUNNING` and `MODEL/GENERIC/RUNNING` both appear in the census alongside their `DONE` counterparts. That strongly implies entries are **rewritten in place** as a step progresses — a `RUNNING` entry at a given `step_index` later becomes `DONE` at the same index.

This is consistent with how the existing transcript readers are written: both `readNewUserSteerEventsFromTranscript()` and `hasPendingTaskInTranscript()` re-read the **whole file** and track line indices or set membership, rather than using the byte-offset `lastReadPosition` incremental read that `BaseLogParser.readNewLines()` provides.

**Therefore:** the new parser must key on `(step_index, status)` and re-read the file, not track byte offsets. A `lastReadPosition`-style tail would emit corrupted partial JSON and would never observe a `RUNNING → DONE` transition.

**Verify before building:** watch a live `agy` run and confirm whether `RUNNING` entries are rewritten in place or superseded by a later appended line. This single fact determines the whole read strategy, so establish it first.

---

## Implementation sketch

1. **Fix the two bugs above.** Small, independently testable, immediately visible in the UI.
2. **Confirm the rewrite-in-place question.** Gate on this.
3. **Add `readTranscriptEntries(sessionId)`** — whole-file read of `transcript_full.jsonl` (falling back to `transcript.jsonl`), parsed into typed entries keyed by `step_index`, with a seen-set on `(step_index, status)` so each state transition emits at most once.
4. **Map entries to `CliEvent`s** per the vocabulary table. Emit INITIATED on `RUNNING` and COMPLETED/FAILED on `DONE` so the timeline shows lifecycle pairs like the other harnesses. Use `created_at` for timestamps; parse the `Completed At:` line in content where present.
5. **Move the tail from the Go log to the transcript.** The cli log keeps only its two real jobs — session-UUID discovery and the `clearing ResponsePending` completion signal. Response content comes from the transcript, polled on the same trigger.
6. **Delete `readLatestResponseFromTranscript()` and the `getFinalEventsOnCompletion()` last-response hack.** Once entries stream, the final response is just the last `PLANNER_RESPONSE` among already-emitted events.
7. **Rewrite `extractResponse()`** to assemble from all mapped events rather than joining `response.text`.

---

## Testing

- Fixture-driven unit tests over a checked-in copy of a real `transcript_full.jsonl` — assert the full event sequence, not just the final text.
- Pin the `CODE_ACTION` edit case: `[diff_block_start]`/`[diff_block_end]` extraction → `parseUnifiedDiff` → `FILE_EDIT.structuredPatch` → undo reverse-patches cleanly.
- Pin both bug fixes: one `USER_INPUT` entry present in both transcripts emits exactly one event, classified `injected-prompt` (suppressed) when it matches the dispatched prompt.
- `RUN_COMMAND` `exit_code !== 0` produces a failed `BASH_COMMAND`.
- When running `agy` for verification, **always pass `--model "Gemini 3.5 Flash (Low)"`** — see `harness-cli-providers.instructions.md`; the default Sonnet tier can exhaust a day's quota in one run.

---

## Open questions

1. Is the transcript rewritten in place or append-only? Gates the read strategy (see above).
2. `transcript_full.jsonl` vs `transcript.jsonl` — what actually differs? In the sample they are near-identical. If one is authoritative, read only it and drop the dual-read entirely, which also dissolves bug 1.
3. Does `CODE_ACTION` "Created file" ever carry the written content? If not, `FILE_WRITE.content` stays empty and the diff view falls back to the `WorkspaceSnapshot` patch (see the `getDisplayStructuredPatch` note in `harness-cli-providers.instructions.md`).
4. Under parallel workflows in one workspace, is the per-session `brain/<sessionId>/` directory sufficient isolation? It should be — unlike the shared `cli-*.log`, transcripts are per-session, which is a further argument for moving the tail onto them.
