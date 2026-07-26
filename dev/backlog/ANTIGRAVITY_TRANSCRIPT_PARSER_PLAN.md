# Antigravity Transcript Parser — Full-Fidelity Rewrite

**Status:** Proposal (not started) — **all blocking open questions resolved 2026-07-26; ready to build**
**Relationship to other work:** **Prerequisite** for the Antigravity phase of `PARSER_UNIFICATION_PLAN.md`. That plan assumed log-sourcing Antigravity would yield structured tool/text events; it will not, because the current log parser produces exactly one TEXT event regardless of source. This is the work that makes the assumption true. It is independently valuable and can ship on its own.

---

## What the parser does today

`AntigravityLogParser` reads **two different files for two different purposes**, and the split is not what the class name suggests:

| Source                                                       | Read by                                                                                  | Produces                                                                |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `~/.gemini/antigravity-cli/log/cli-*.log` (Go server log)    | `discoverSessionLog()`, `readNewLines()`                                                 | `session.created`, `response.completed`, and untyped `log.line` noise   |
| `brain/<sessionId>/.system_generated/logs/transcript*.jsonl` | `readNewUserSteerEvents()`, `hasPendingBackgroundWork()`, `getFinalEventsOnCompletion()` | `user_input` steers, background-task state, and **one** `response.text` |

The tailed "log file" carries no response content at all. It exists to detect completion (`clearing ResponsePending`) and to scrape a session UUID.

All actual response content arrives through **one call at the very end**: `getFinalEventsOnCompletion()` → `readLatestResponseFromTranscript()`, which scans the transcript and keeps only the **last** `MODEL/PLANNER_RESPONSE/DONE` entry with non-empty content. `extractResponse()` then joins the resulting `response.text` events — of which there is exactly one — into a single `CLI_EVENT_TYPES.TEXT`.

**Consequence:** Antigravity output is one undifferentiated text blob, delivered at completion. Every file edit, command, and file read the model performed is discarded. This is the same fidelity as `AntigravityResponseParser` (59 LOC, wraps all stdout in one TEXT event) — which is why swapping one for the other gains nothing.

---

## What the transcript actually contains

Verified against `brain/a1eb7caf-9b06-4429-b0d0-01254f99731b/.system_generated/logs/transcript_full.jsonl` (a real `agy` run: create a file, edit 5 lines, delete it) plus a `source/type/status` census across every session currently in `~/.gemini/antigravity-cli/brain/`.

Entry shape: `{ step_index, source, type, status, created_at, content }`, plus `exit_code` on `RUN_COMMAND` and — **critically, and missed by the first draft of this plan** — `thinking` and `tool_calls` on `PLANNER_RESPONSE` (see next section).

### Observed vocabulary (61 `transcript_full.jsonl` files on disk, 2026-07-26)

| Count  | `source/type/status`                          | Maps to                                                                                                                                                            |
| ------ | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 189    | `MODEL/PLANNER_RESPONSE/DONE`                 | `TEXT` **and/or** the tool call itself — see next section. Do _not_ skip empty-content entries: 103 of these 189 have empty `content`, but 112 carry `tool_calls`. |
| 68     | `USER_EXPLICIT/USER_INPUT/DONE`               | prompt echo or `USER_STEER` — see classification bug below                                                                                                         |
| 60     | `SYSTEM/CONVERSATION_HISTORY/DONE`            | drop (always empty)                                                                                                                                                |
| 58     | `SYSTEM/CHECKPOINT/DONE`                      | `COMPACTION` (content is a context-truncation notice)                                                                                                              |
| 30     | `MODEL/RUN_COMMAND/DONE`                      | `BASH_COMMAND` result — `exit_code`, stdout, stderr. **No command text**; see next section.                                                                        |
| 26     | `MODEL/VIEW_FILE/DONE`                        | `FILE_READ` (File Path, Total Lines, Total Bytes, line-numbered body)                                                                                              |
| 15     | `MODEL/RUN_COMMAND/RUNNING`                   | background-task launch — **terminal status, never becomes `DONE`**                                                                                                 |
| 15     | `SYSTEM/SYSTEM_MESSAGE/DONE`                  | background-task completion (already consumed by `hasPendingBackgroundWork`)                                                                                        |
| 14 / 1 | `MODEL/GENERIC/DONE` / `RUNNING`              | `TOOL_CALL` (permission grants, background-task status checks)                                                                                                     |
| 8      | `MODEL/CODE_ACTION/DONE`                      | `FILE_WRITE` or `FILE_EDIT` — see below                                                                                                                            |
| 7      | `MODEL/LIST_DIRECTORY/DONE`                   | `TOOL_CALL`                                                                                                                                                        |
| 6      | `SYSTEM/ERROR_MESSAGE/DONE`                   | error surfacing (includes malformed-tool-call errors)                                                                                                              |
| 4      | `MODEL/MCP_TOOL/DONE`                         | `MCP_TOOL_CALL`                                                                                                                                                    |
| 2 / 1  | `MODEL/LIST_RESOURCES`, `MODEL/READ_RESOURCE` | `MCP_TOOL_CALL`                                                                                                                                                    |
| 1      | `MODEL/SEARCH_WEB/DONE`                       | `WEB_SEARCH` — summary text plus a numbered `Sources:` list of URLs                                                                                                |

(`MODEL/GREP_SEARCH/DONE` also exists but appears only in one pre-`transcript_full` legacy session; expect it from live runs too.)

### `PLANNER_RESPONSE` carries the structured tool call — this is the richest source in the file

The first draft of this plan advised skipping empty-content `PLANNER_RESPONSE` placeholders. **That would discard the single most useful field in the transcript.** Those entries are not placeholders — they carry two extra keys:

- **`thinking`** — the model's reasoning prose for that step (36 of 189 entries). Maps to a `THINKING` event.
- **`tool_calls`** — an array of `{ name, args }` with **fully structured, natively typed arguments** (112 of 189 entries).

Observed `tool_calls[].name` vocabulary: `run_command` (46), `view_file` (29), `list_dir` (9), `list_permissions` (6), `ask_permission` (5), `call_mcp_tool` (5), `write_to_file` (4), `multi_replace_file_content` (3), `list_resources` (2), `replace_file_content` (2), `schedule` (1), `search_web` (1), `read_resource` (1), `manage_task` (1).

This resolves gaps the `content`-only approach cannot:

| Need                                       | Where it lives                                                                                                                                                                         |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The **command text** for a `BASH_COMMAND`  | `run_command.args.CommandLine` (+ `Cwd`, `WaitMsBeforeAsync`). The `RUN_COMMAND/DONE` entry's `content` has only exit code, stdout and stderr — the command itself is **never** in it. |
| **`FILE_WRITE.content`** (open question 3) | `write_to_file.args.CodeContent` holds the full written body, plus `TargetFile` and `Overwrite`. The `CODE_ACTION` entry only says "Created file … with requested content."            |
| Structured edits without diff-scraping     | `multi_replace_file_content.args.ReplacementChunks[]` = `{ StartLine, EndLine, TargetContent, ReplacementContent, AllowMultiple }`                                                     |
| Absolute path for a `FILE_READ`            | `view_file.args.AbsolutePath`                                                                                                                                                          |
| MCP call target                            | `call_mcp_tool` / `ask_permission.args.Target` (e.g. `ctrlyoke/queue_status`)                                                                                                          |

**Pairing rule:** the `PLANNER_RESPONSE` at step _N_ holds the _call_; the entry that follows holds the _result_. Because `step_index` is not file order (see the ordering gotchas below), pair by **adjacent line position**, not by arithmetic on `step_index`.

Every `args` object also carries `toolAction` and `toolSummary` — short human-written labels ("Deleting temporary file" / "Delete temp.txt") that are ready-made timeline captions.

### `CODE_ACTION` carries a real unified diff

Two content shapes, both parseable:

**Create** — no body in the `CODE_ACTION` entry itself, so take `FILE_WRITE.content` from the preceding `PLANNER_RESPONSE`'s `write_to_file.args.CodeContent` instead (see above):

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

**Fix — read `transcript_full.jsonl` only** (open question 2, now resolved). The two files are not peers; `transcript.jsonl` is a strictly lossy variant of the same stream. Verified across all 61 sessions that have both:

- **Entry count matches in 60/61**, and in the one exception `transcript_full.jsonl` is a **strict superset** (it has a `LIST_RESOURCES` entry the compact file omits entirely).
- **`tool_calls` args are double-encoded in the compact file.** `transcript_full.jsonl` stores natively typed values (`WaitMsBeforeAsync: 5000`, `Overwrite: true`, `ReplacementChunks: [ … ]`); `transcript.jsonl` stores every arg as a JSON-encoded _string_ (`"5000"`, `"true"`, `"[{\"AllowMultiple\":false, …}]"`). Parsing it means a second `JSON.parse` per arg with no schema telling you which ones need it.
- **The compact file truncates content**, flagging it with a `truncated_fields: ["content"]` key. Across all sessions: 6 truncated entries in `transcript.jsonl`, **0** in `transcript_full.jsonl`.

Keep `transcript.jsonl` only as an existence fallback, never as a second read. It matters for exactly one legacy case: the single session on disk lacking a `transcript_full.jsonl` dates to 2026-05-21, before the oldest `transcript_full.jsonl` (2026-06-18) — so `transcript_full.jsonl` is a newer agy feature and a live parser will always find it.

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

## RESOLVED: the transcript **is** strictly append-only

The earlier draft of this plan assumed entries were rewritten in place, because `RUNNING` and `DONE` both appear in the census. **That assumption was wrong.** Verified empirically (2026-07-26) by two live `agy --print` runs snapshotted at 100 ms, plus a full-disk census of 121 transcript files:

| Check                                                                           | Result |
| ------------------------------------------------------------------------------- | ------ |
| Byte-level append-only violations across all snapshots                          | **0**  |
| Snapshots where the file shrank                                                 | **0**  |
| Already-written lines that changed (any byte)                                   | **0**  |
| Duplicate `step_index` within one file (121 files)                              | **0**  |
| `RUNNING` entries that ever gained a `DONE` at the same `step_index` (30 found) | **0**  |

`RUNNING` is **not a transient state**. Every one of the 30 `RUNNING` entries on disk is a **background-task launch** — content always matches `Tool is running as a background task with task id: <sessionId>/task-N`. It is a **terminal status**: that line is never touched again, and completion arrives later as a _separate_ `SYSTEM/SYSTEM_MESSAGE/DONE` entry at a higher `step_index`. This is exactly the model `hasPendingTaskInTranscript()` already implements.

The decisive observation: a run whose only tool call was `Start-Sleep -Seconds 25` wrote `MODEL/RUN_COMMAND/RUNNING` at t=13.3 s, then the file stayed **byte-identical for 24 seconds** while the task ran, and at t=37.3 s the next entry was _appended_ after it. The `RUNNING` line is still `RUNNING` in the final file.

**Therefore the read strategy is the opposite of what this plan originally specified:**

- A byte-offset incremental tail (`BaseLogParser`'s `lastReadPosition`) **is** safe and is the right approach. There is no rewrite to miss and no partial-JSON hazard beyond the ordinary "last line may be mid-write" case, which a trailing-newline check handles.
- Do **not** build `(step_index, status)` seen-set bookkeeping to catch `RUNNING → DONE` transitions. That transition does not exist.
- Do **not** emit INITIATED-on-`RUNNING` / COMPLETED-on-`DONE` lifecycle pairs. A `DONE` entry arrives already complete and is the _only_ entry for its step; a `RUNNING` entry is a background launch that never completes in place. Emitting a lifecycle pair would leave every non-background tool call permanently "initiated" and every background call permanently pending.

### Two ordering gotchas that do survive

1. **`step_index` is not file order.** Confirmed in several sessions: `transcript_full.jsonl` may hold step 3 on line 2 and step 2 on line 3 — a tool-result entry can be written _before_ the `PLANNER_RESPONSE` that requested it. Line order is arrival order; sorting by `step_index` would reorder the timeline. Key on line position, and use `step_index` only as an identity/join key.
2. **`step_index` values are sparse.** Gaps are normal (steps are consumed by work that produces no transcript entry). Never treat `step_index` as a dense counter or infer "missing entries" from a gap.

---

## Implementation sketch

1. **Fix the two bugs above.** Small, independently testable, immediately visible in the UI. Bug 1's fix is now simply "read `transcript_full.jsonl`, stop reading the pair".
2. ~~Confirm the rewrite-in-place question.~~ **Done — see the RESOLVED section above. Append-only; no gate remains.**
3. **Add `readTranscriptEntries(sessionId)`** — an **incremental line-append read** of `transcript_full.jsonl` (byte offset, as `BaseLogParser.readNewLines()` already does), parsed into typed entries in **file order**. No `(step_index, status)` seen-set is needed. The only re-read guard required is the ordinary partial-line case: if the tail does not end in a newline, hold the fragment back until the next poll rather than parsing it.
4. **Map entries to `CliEvent`s** per the vocabulary table, joining each `PLANNER_RESPONSE`'s `tool_calls` to the result entry on the adjacent line. Emit each mapped event **once, already complete** — no INITIATED/COMPLETED pairs (see the RESOLVED section for why). Use `created_at` for timestamps; parse the `Completed At:` line in content where present. Treat `RUN_COMMAND/RUNNING` as a background-task launch, not an in-flight command.
5. **Move the tail from the Go log to the transcript.** The cli log keeps only its two real jobs — session-UUID discovery and the `clearing ResponsePending` completion signal. Response content comes from the transcript, polled on the same trigger.
6. **Delete `readLatestResponseFromTranscript()` and the `getFinalEventsOnCompletion()` last-response hack.** Once entries stream, the final response is just the last `PLANNER_RESPONSE` among already-emitted events.
7. **Rewrite `extractResponse()`** to assemble from all mapped events rather than joining `response.text`.

---

## Testing

- Fixture-driven unit tests over a checked-in copy of a real `transcript_full.jsonl` — assert the full event sequence, not just the final text.
- Pin the `CODE_ACTION` edit case: `[diff_block_start]`/`[diff_block_end]` extraction → `parseUnifiedDiff` → `FILE_EDIT.structuredPatch` → undo reverse-patches cleanly.
- Pin both bug fixes: one `USER_INPUT` entry present in both transcripts emits exactly one event, classified `injected-prompt` (suppressed) when it matches the dispatched prompt.
- `RUN_COMMAND` `exit_code !== 0` produces a failed `BASH_COMMAND`.
- **Pin the `tool_calls` join**: a `BASH_COMMAND` event must carry the command text from the preceding `PLANNER_RESPONSE`'s `run_command.args.CommandLine`, and a `FILE_WRITE` must carry `write_to_file.args.CodeContent`. A fixture with a **non-monotonic `step_index`** (result line before its call line — real sessions do this) guards against pairing by `step_index` arithmetic instead of line adjacency.
- **Pin the append-only assumption itself**: feed the parser a fixture in two chunks split mid-line and assert no duplicate or dropped events. This is the regression test for the incremental-read strategy if agy ever changes the format.
- When running `agy` for verification, **always pass a Gemini Flash model** — see `harness-cli-providers.instructions.md`; the default Sonnet tier can exhaust a day's quota in one run. `--model` accepts **either** form: the ID `agy models` prints (`gemini-3.5-flash-low`) or the label agy's own error message lists (`"Gemini 3.5 Flash (Low)"`, which is what `ANTIGRAVITY_CLI_MODELS` stores). Both verified exit 0; an unrecognized model is rejected with exit 1 and never silently falls back to the default.

---

## Open questions — all four resolved 2026-07-26

1. ~~Is the transcript rewritten in place or append-only?~~ **Strictly append-only.** Zero mutations across two snapshotted live runs and zero duplicate `step_index` across 121 files on disk. `RUNNING` is a terminal status for background-task launches, not a transient state. Use an incremental byte-offset read. Full evidence in the RESOLVED section above.
2. ~~`transcript_full.jsonl` vs `transcript.jsonl` — what differs?~~ **`transcript_full.jsonl` is authoritative; read only it.** The compact file double-encodes every `tool_calls` arg as a JSON string, truncates long `content` (flagged via `truncated_fields`), and in one session omits an entry the full file has. See bug 1 above.
3. ~~Does `CODE_ACTION` "Created file" ever carry the written content?~~ **No — but the content is available anyway**, from the preceding `PLANNER_RESPONSE`'s `write_to_file.args.CodeContent`. `FILE_WRITE.content` can be populated properly; no `WorkspaceSnapshot` fallback needed for creates.
4. Under parallel workflows in one workspace, is the per-session `brain/<sessionId>/` directory sufficient isolation? **Still open**, but nothing found contradicts it — every transcript observed lives under exactly one session id, and unlike the shared `cli-*.log` there is no cross-session file. A further argument for moving the tail onto transcripts.

### New question raised by this investigation

5. `PLANNER_RESPONSE.thinking` was present on only 36 of 189 entries, all from Gemini-tier models. Does the field appear at all on Claude-tier models under agy, and should `THINKING` events be emitted when it is absent? Cheap to answer, but do it on Flash-adjacent runs only — the Sonnet quota warning above applies.
