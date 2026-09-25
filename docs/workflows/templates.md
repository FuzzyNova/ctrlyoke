# Templates

Templates are reusable workflow skeletons with fill-in-the-blank variables. ctrlyoke ships these built-in templates: Blank, Template Starter, Simple Feature, Parallel Research, Fix Tests, Full Feature Pipeline, and Spec-Driven Loop. You can add your own templates under `.ctrlyoke/templates/` in the workspace or under `~/.ctrlyoke/templates/` for your user account. When you run **New Workflow from Template**, ctrlyoke prompts for each variable, substitutes the values, and creates a ready-to-run workflow.

## Variables in the body

A variable is a `{placeholder}` token in a prompt (or any string field). The token form sets its default input type:

| Token in the body | Input type | UI                              |
| ----------------- | ---------- | ------------------------------- |
| `{name}`          | text       | single-line input               |
| `{text:name}`     | text       | single-line input (explicit)    |
| `{file:name}`     | file       | input with a **Browse…** button |

Variable names must start with a lowercase letter and contain only letters and digits. Condition output references (`$preCondition:<field>` and `$endCondition:<field>`) are runtime values and never treated as template variables. `$preCondition:*` works in step and retry prompts; `$endCondition:*` is only available in retry prompts.

The `{file:…}` / `{text:…}` inline prefixes only cover those two types. For a `directory`, `select`, or `harness` variable, write a plain `{name}` token in the body and declare its type in `_templateMeta` (below).

Put a file variable in prompt text as `@{file:name}`. Keep the `@` outside the braces so the substituted value becomes a normal file reference.

Placeholders are allowed in fields that normally accept only fixed values, such as `harness: "{harness}"`, but only in a file that has a `_templateMeta` block. Quote such values in YAML.

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
| `type`             | any             | `text` (default), `file`, `directory`, `select`, or `harness`.                                                         |
| `options`          | select          | The dropdown choices (e.g. `[debug, info, warn]`). The first option is used as the default unless `default` is set.    |
| `default`          | any             | Pre-fills the input; substituted when the field is left blank.                                                         |
| `description`      | any             | Helper text shown under the input.                                                                                     |
| `multiline`        | text            | Renders a resizable textarea instead of a single-line input.                                                           |
| `fileFilter`       | file            | Glob patterns for the file picker (e.g. `["**/*.md"]`).                                                                |
| `autoFillFilename` | file, directory | Seeds the new workflow's filename from the picked file/folder basename. Only the first variable that declares it wins. |

Input controls by type: **text** → single-line input (or textarea with `multiline`); **file** → input + Browse (file picker); **directory** → input + Browse (folder picker); **select** → dropdown of `options`; **harness** → the harness picker (no `options` needed; defaults to `claude-cli` when no `default` is set).

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

If a variable declares a `default`, that value is pre-filled in the UI and used when the field is left empty. A `select` variable without a default starts on its first option. A text, file, or directory variable with **no** default that is never filled in stays in the output as a literal `{token}` — so give optional inputs a sensible default, and treat description/required inputs as fields the user must fill.

## Custom templates

Custom templates are `*.ctrlyoke.yaml`, `*.ctrlyoke.yml`, or `*.ctrlyoke.json` files in `.ctrlyoke/templates/` (workspace) or `~/.ctrlyoke/templates/` (user). They use the same `_templateMeta` schema as the built-ins. A file name must be unique within its location, regardless of format.

There are two ways to create one:

- In the template picker, click **New template...**, or run the **Create New Custom Template** command, which opens the same form. Choose a name, a location (workspace or user), and a format (YAML or JSON). ctrlyoke copies the currently selected template as the starting point. Select **Template Starter** first to get an example of every variable type.
- In the Save Workflow dialog, turn on **Save as Template**. This saves the workflow's current values as-is; edit the file afterward to replace fixed values with `{placeholder}` variables.
