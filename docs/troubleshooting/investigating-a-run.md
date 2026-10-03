# Investigating a run

Use the CLI's JSON output when an agent is inspecting a run. Rendered history
text can contain nested ctrlyoke boxes copied from tool output, so its visual
step headers are ambiguous.

Start by finding active workflows and their runner liveness:

```bash
ctrlyoke status --json
```

Each row's `liveness.reason` says why a run is `alive` or `stale`, for example
`stale-dead-pid` when the runner process has exited.

Use the workflow key and run reference from the status result, then inspect the
step overview. It is sourced from the run's working file and stays small even
when `events.jsonl` contains large outputs:

```bash
ctrlyoke history steps --workflow <key> --run <ref> --json
```

Every step's `selector` (a zero-based index, or `final:N` for a final-step
pass) can be passed straight to `--step`. Read a selected step's prompt and
answer first with a compact record:

```bash
ctrlyoke history show --workflow <key> --run <ref> --step <N> --kind prompt response --json --summary
```

If you need more context, read the last 4,000 response characters. Paging
reads one attempt; for a retried step it reads the latest attempt unless you
pass `--attempt <n>`:

```bash
ctrlyoke history show --workflow <key> --run <ref> --step <N> --json --summary --tail 4000
```

The page bounds the whole record, so the output stays near 4,000 characters
however large the step's events are. A forward page from `--limit` returns a
`nextCursor`; pass it back with `--cursor` to continue.

Use `--json --events` when you need individual tool or file events. Each NDJSON
line carries the target and attempt indices so consumers can stream or filter
records without parsing terminal formatting.
