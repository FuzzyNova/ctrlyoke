# Investigating a run

Use the CLI's JSON output when an agent is inspecting a run. Rendered history
text can contain nested ctrlyoke boxes copied from tool output, so its visual
step headers are ambiguous.

Start by finding active workflows and their runner liveness:

```bash
ctrlyoke status --json
```

Use the workflow key and run reference from the status result, then inspect the
step overview. It is sourced from the run's working file and stays small even
when `events.jsonl` contains large outputs:

```bash
ctrlyoke history steps --workflow <key> --run <ref> --json
```

The overview gives each queue step a zero-based index. Read a selected step's
prompt and answer first with a compact record:

```bash
ctrlyoke history show --workflow <key> --run <ref> --step <N> --kind prompt response --json --summary
```

If you need more context, read the last 4,000 response characters:

```bash
ctrlyoke history show --workflow <key> --run <ref> --step <N> --json --summary --tail 4000
```

Use `--json --events` when you need individual tool or file events. Each NDJSON
line carries the target and attempt indices so consumers can stream or filter
records without parsing terminal formatting.
