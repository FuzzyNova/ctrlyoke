# Templates

Templates are reusable workflow skeletons with fill-in-the-blank variables. ctrlyoke ships built-in templates (Simple Feature, Full Feature, Fix Tests, Spec-Driven Loop), and you can add your own under `.ctrlyoke/templates/`. When you run **New Workflow from Template**, ctrlyoke prompts for each variable, substitutes them, and writes a ready-to-run workflow file.

## Variables in the body

A variable is a `{placeholder}` token in a prompt (or any string field). The token form sets its default input type:

| Token in the body | Input type | UI                              |
| ----------------- | ---------- | ------------------------------- |
| `{name}`          | text       | single-line input               |
| `{text:name}`     | text       | single-line input (explicit)    |
| `{file:name}`     | file       | input with a **Browse…** button |

Variable names must start with a lowercase letter and contain only letters and digits. Retry-prompt placeholders (`{stdout}`, `{stderr}`, `{exitCode}`, …) are reserved and never treated as template variables.

The `{file:…}` / `{text:…}` inline prefixes only cover those two types. For a `directory` or `select` variable, write a plain `{name}` token in the body and declare its type in `_templateMeta` (below).

## Enriching variables with `_templateMeta`

A top-level `_templateMeta` block names the template, describes it, and adds UI metadata to the variables extracted from the body. It is stripped from the generated workflow — it exists only for authoring.

```yaml
_templateMeta:
  name: Full Feature
  description: "Plan → Implement → Review → Docs → Commit"
  variables:
    featureDescription:
      type: text
      multiline: true
      description: What to build — describe the feature or change.
    planDocument:
      type: text
      default: docs/plan.md
      description: Path where the plan is written and referenced by later steps.

steps:
  - name: plan
    prompt: |
      {featureDescription}

      Write the implementation plan to {planDocument}.
  - name: implement
    prompt: Implement the feature per @{planDocument}.
```

### Variable metadata fields

| Field              | Applies to      | Effect                                                                                                                 |
| ------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `type`             | any             | `text` (default), `file`, `directory`, or `select`.                                                                    |
| `options`          | select          | The dropdown choices (e.g. `[debug, info, warn]`). The first option is used as the default unless `default` is set.    |
| `default`          | any             | Pre-fills the input; substituted when the field is left blank.                                                         |
| `description`      | any             | Helper text shown under the input.                                                                                     |
| `multiline`        | text            | Renders a resizable textarea instead of a single-line input.                                                           |
| `fileFilter`       | file            | Glob patterns for the file picker (e.g. `["**/*.md"]`).                                                                |
| `autoFillFilename` | file, directory | Seeds the new workflow's filename from the picked file/folder basename. Only the first variable that declares it wins. |

Input controls by type: **text** → single-line input (or textarea with `multiline`); **file** → input + Browse (file picker); **directory** → input + Browse (folder picker); **select** → dropdown of `options`.

```yaml
_templateMeta:
  variables:
    logLevel:
      type: select
      options: [debug, info, warn, error]
      default: info
    outputDir:
      type: directory
      description: Where generated artifacts should be written.
```

A key under `_templateMeta.variables` only takes effect if a matching `{token}` exists in the body — the meta block enriches extracted variables, it does not create them.

## Defaults and blank fields

If a variable declares a `default`, that value is pre-filled in the UI and used when the field is left empty. A variable with **no** default that is left blank stays in the output as a literal `{token}` — so give optional inputs a sensible default, and treat description/required inputs as fields the user must fill.

## Custom templates

Run **New Template…** from the template picker to scaffold a starter under `.ctrlyoke/templates/<name>.ctrlyoke.json`. The starter demonstrates a `file` variable (with `fileFilter` + `autoFillFilename`) and a multiline `text` variable (with `default` + `description`). Custom templates use the same `_templateMeta` schema as the built-ins.
