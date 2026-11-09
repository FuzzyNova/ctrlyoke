# `secret check` and the trust commands hide why a workflow failed to load

- **Found:** 2026-11-09 by bug-hunt final step (pass 16), running the built CLI
- **Area:** `src/cli/SecretCommands.ts`, `src/cli.ts` (`trustWorkflowExternalRootsCommand`)
- **Severity:** low

## Symptom

`ctrlyoke secret check <file>`, `ctrlyoke trust-secret-grants <file>` and
`ctrlyoke trust-workflow-external-roots <file>` print a generic message when the
workflow can't be loaded. They drop the parser's reason, so a missing file, a
YAML syntax error and a schema violation all look the same:

```
$ ctrlyoke secret check nope.yaml            # file does not exist
Error: Workflow failed validation: /private/tmp/cyhunt/nope.yaml
$ ctrlyoke trust-secret-grants bad.ctrlyoke.yaml --json   # has `promptt:` typo
{"schemaVersion":1,"success":false,"error":{"message":"Workflow failed validation: /private/tmp/cyhunt/bad.ctrlyoke.yaml"}}
$ ctrlyoke trust-workflow-external-roots bad.ctrlyoke.yaml
Error: Failed to load workflow file: /private/tmp/cyhunt/bad.ctrlyoke.yaml
```

For the same files, `ctrlyoke validate` reports `File not found: …` and the full
`Validation failed: /steps/0/promptt: Unknown property …` list. A missing file
reported as "failed validation" is actively misleading.

## Steps to Reproduce

1. In an empty directory, write `bad.ctrlyoke.yaml` containing
   `steps:\n  - promptt: hi`.
2. Run `ctrlyoke secret check bad.ctrlyoke.yaml` and
   `ctrlyoke secret check missing.yaml`.
3. Both print only `Error: Workflow failed validation: <path>` (exit 2).

## Root Cause

`PromptFileParser.parsePromptFile` returns `null` on failure and records the
reason on `parser.lastParseError` / `parser.lastNewerSchemaError`. These callers
build their own parser and ignore both fields:

- `checkSecretsCommand` and `trustSecretGrantsCommand` in
  `src/cli/SecretCommands.ts` (`new PromptFileParser(dependencies.platform).parsePromptFile(filePath)`,
  then `Workflow failed validation: ${filePath}`);
- `trustWorkflowExternalRootsCommand` in `src/cli.ts` (keeps
  `lastNewerSchemaError` but not `lastParseError`).

`parseCliPromptFile` in `src/cli/CliPromptFile.ts` already exists for exactly
this. It throws an error carrying `lastNewerSchemaError ?? lastParseError`.

## Suggested Fix

Have all three commands load the workflow through `parseCliPromptFile` (keep
`SecretCommandDependencies.parseWorkflow` as the test seam). Report the thrown
message through the existing `writeSecretError` / `reportCliError` path with
the same exit code (2). Add tests for each command covering a missing file and
a schema-invalid file in both text and `--json` mode, asserting that the
parser's reason appears. Add a `CHANGELOG.md` **Fixed** entry.
