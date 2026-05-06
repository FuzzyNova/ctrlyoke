# Context references

FlightPath prompt files support structured references that help you attach the right project context without pasting everything manually.

## File and directory references

```text
@src/extension.ts
@src/flightpath/
@"path with spaces/file.ts"
```

- `@file` attaches a full file
- `@dir/` attaches directory structure
- paths with spaces are quoted

## Snippet references

```text
#selection:src/cli.ts:45-103
#sym:src/flightpath/WorkflowExecutor.ts:runLoop:88
```

- `#selection:` attaches a line range
- `#sym:` attaches a symbol definition using file, symbol name, and line number

## Git references

```text
~diff
~staged
~stash:0
~a1b2c3d4
```

Use these when a prompt should reason over local changes, staged work, a stash entry, or a specific commit.

## Prior output references

```text
$previous
$all
$finalStep
$allFinalStep
$step:1,3-5
```

These let a prompt pull prior FlightPath output into the prompt text.

## Tips

1. Use `@` for whole files and directories.
2. Use `#selection:` and `#sym:` when the full file would be noisy.
3. Prefer prior-output references over repeating large summaries by hand.
