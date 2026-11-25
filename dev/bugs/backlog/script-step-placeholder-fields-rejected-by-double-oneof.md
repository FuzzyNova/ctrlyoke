# Script step `timeoutSec`/`compareSource`/`operator`/`ignoreCase` reject `{{name}}` placeholders

- **Found:** 2026-11-25 by bug-hunt final step (claude-cli)
- **Area:** `schemas/workflow-schema.json` (`$defs/scriptStep`)
- **Severity:** medium

## Symptom

`docs/workflows/variables.md` ("Where `{{name}}` is substituted") lists
`steps[].timeoutSec`, `steps[].compareSource`, `steps[].operator` and
`steps[].ignoreCase` as dispatch fields that accept a whole-value placeholder,
and the schema descriptions say so too. On a **script step**, every one of them
fails workflow validation instead, so the workflow cannot be loaded at all:

```
ctrlyoke: Failed to parse c.ctrlyoke.yaml: Error: Validation failed: ...
/steps/0/timeoutSec: must match exactly one schema in oneOf, ...
```

The same placeholder in an `endCondition` (which references
`scriptProperties` directly) parses fine, as do the literal values
(`timeoutSec: 5`, `operator: equals`).

## Steps to Reproduce

```yaml
# c.ctrlyoke.yaml
vars:
  v: "5"
steps:
  - type: script
    script: echo hi
    expected: hi
    timeoutSec: "{{v}}" # likewise compareSource/operator/ignoreCase
```

1. `ctrlyoke run c.ctrlyoke.yaml --dry-run`
2. Validation fails with `/steps/0/timeoutSec: must match exactly one schema in oneOf`.

## Root Cause

`$defs/scriptProperties/properties/{timeoutSec,compareSource,operator,ignoreCase}`
are already `oneOf: [<literal type>, { $ref: "#/$defs/varPlaceholder" }]`
(e.g. `schemas/workflow-schema.json:1438`). `$defs/scriptStep/properties`
wraps each of them _again_ (`schemas/workflow-schema.json:1112-1134` and the
`operator`/`ignoreCase` entries after them):

```json
"timeoutSec": {
  "oneOf": [
    { "$ref": "#/$defs/scriptProperties/properties/timeoutSec" },
    { "$ref": "#/$defs/varPlaceholder" }
  ]
}
```

A `"{{v}}"` string matches both branches (the referenced property accepts it
through its own placeholder branch), so `oneOf` fails. The duplicated sentence
"A whole-value {{name}} placeholder is coerced and validated before dispatch."
in those four descriptions (shown twice in IntelliSense hovers and in the
generated `docs/reference/workflow-schema.md`) is the same double wrap.

A quick scan of every `oneOf` with more than one branch that can reach
`varPlaceholder` finds exactly these four paths:
`#/$defs/scriptStep/properties/{compareSource,timeoutSec,operator,ignoreCase}`.

## Suggested Fix

Make the four `scriptStep` properties plain
`{ "$ref": "#/$defs/scriptProperties/properties/<name>" }` like its sibling
`shell`/`script`/`env` entries (or keep a wrapper but drop its extra
`varPlaceholder` branch), removing the duplicated description sentence. This
only widens what validates, so no `schema:bump` is needed. Run
`npm run schema:update` to regenerate the YAML schema, `SchemaDescriptions.ts`,
`WorkflowSchemaOutline.ts` and the reference docs. Add a parser test that a
script step with a whole-value placeholder in each of the four fields loads and
substitutes at dispatch, plus a schema-level guard test that no `oneOf` has
more than one branch reaching `varPlaceholder`, so a future generator or edit
cannot reintroduce the overlap. If a script generated these wrappers (see
commit `722f8b349`, "feat: add dispatch value variable substitution"), fix it
there too.
