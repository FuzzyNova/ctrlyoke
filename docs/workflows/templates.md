# Templates

Templates are reusable workflow skeletons with fill-in-the-blank variables. ctrlyoke ships these built-in templates: Blank, Template Starter, Simple Feature, Parallel Research, Fix Tests, Full Feature Pipeline, Spec-Driven Loop, Bug Hunt Loop, and Bug Drain Loop. You can add your own templates under `.ctrlyoke/templates/` in the workspace or under `~/.ctrlyoke/templates/` for your user account. When you run **New Workflow from Template**, ctrlyoke prompts for each variable, substitutes the values, and creates a ready-to-run workflow.

## Create a workflow from a template {#create-from-template}

Open the **Create Workflow from Template** dialog in any of these ways:

- the arrow beside **New** in the dashboard header, then **New From Template...**;
- **Create from Template** in the steps panel of an empty workflow;
- the **ctrlyoke: New Workflow from Template** command (`Ctrl+Shift+T`, or
  `Cmd+Shift+T` on macOS).

![The Create Workflow from Template dialog with Full Feature Pipeline selected. Under its description, the Variables form has featureDescription "Add tag filtering and pagination to GET /notes" in a multi-line box, planDocument "plans/notes-tags.md", reviewHarness set to Codex in a harness picker, testCommand "npm test" and formatCommand "npm run format", each with helper text. Workflow Name is "notes-tags", and the footer has Set as Default, Cancel, Create and Create & Run](/screenshots/template-modal-full-feature-840x1123.png)

1. Pick a template under **Template**. The list groups **Built-in Templates**,
   **Custom Templates (Workspace)** and **Custom Templates (User)**. It starts on
   your default template.
2. Read the description under the picker, then fill in the **Variables**. Each
   field's helper text comes from the template, and fields with a `default`
   start filled in. The control depends on the variable's type:

   | Type                   | Control                                                                                                                                                                                  |
   | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | text                   | A single-line box, or a resizable multi-line box with `multiline: true`.                                                                                                                 |
   | file, directory        | A box with a **Browse…** button. In VS Code it opens your system's file or folder picker. In the [browser dashboard](/guide/remote-dashboard) it opens a file browser for the workspace. |
   | select                 | A dropdown of the template's `options`.                                                                                                                                                  |
   | harness                | The harness picker, showing which harnesses are installed.                                                                                                                               |
   | model (with a harness) | A model picker beside its harness, listing that harness's models.                                                                                                                        |

3. Enter a **Workflow Name**. It is required, and some characters aren't
   allowed in it.
4. Click **Create** to open the new workflow without running it, or **Create &
   Run** to start it right away. `Enter` in a single-line field creates the
   workflow, and `Ctrl+Enter` in any text field creates and runs it.

**Set as Default** makes the selected template the one the dialog starts on
next time. It saves [`general.defaultTemplate`](/reference/settings#general-defaulttemplate)
at the scope chosen by the dialog's User/Workspace toggle. When the selected
template is already the default, the footer reads **Default template** instead,
with the scope it comes from when it is a saved setting. See
[Defaults and blank fields](#defaults-and-blank-fields).

**New template...** under the picker creates a custom template from the
selected one. See [Custom templates](#custom-templates).

## Saved variable values {#saved-variable-values}

Open **Settings → Templates** to choose the default template and save variable values for any
built-in or custom template. The drawer's **User** scope stores values for your own use across
workspaces; **Workspace** stores values with the project. When both scopes save the same
variable, the Workspace value wins in that workspace. Linked harness and model values are saved together.

Each saved value is used to pre-fill the matching field in **New Workflow**. Choose **Add
template** and **Add value** to add a value from Settings, or pin a value while creating a
workflow. Blank text clears a saved value. **Clear all** removes every saved value for that
template at the selected scope, returning fields to the other scope or the variable default
authored by the template. Missing templates and variables that have since been removed remain
visible until cleared, so stale settings can be cleaned up.

## Bug Hunt Loop and Bug Drain Loop {#bug-loops}

Both templates are [dynamic-queue](/workflows/dynamic-queue) loops that keep bug reports as Markdown files in your repo, one file per bug, rather than in an issue tracker. They have no steps up front. Their final step reviews the fixes that landed since its previous pass, then queues new fix steps; the loop ends on the first pass that queues nothing.

| Template       | Each pass                                                                                   | Ends when                                            |
| -------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Bug Hunt Loop  | Finds and files at least two new bugs, then queues fixes for the ones it is confident about | A pass finds nothing, you stop it, or the step limit |
| Bug Drain Loop | Queues fixes for every report already in the backlog directory. Never files new bugs        | The backlog is empty                                 |

Both ask for the same directories, so the hunt can fill a backlog that the drain later clears:

- **`bugBacklogDir`** (default `bugs/backlog`): where open bug reports are filed.
- **`bugImplementedDir`** (default `bugs/implemented`): where a fix step moves its report once the bug is fixed.

Put a README or template in the backlog directory, or the directory above it, that describes your bug report format. The hunter follows it, so every report has the same sections. Without one, it writes a title, severity, reproduction steps, expected and actual behavior, evidence, and a suggested fix.

Both templates also ask for `testCommand`, which every queued fix must pass, and a harness and model for each of two roles: the final step that reviews and queues, and the fix steps. Give the final step your most capable model; a cheaper model is usually enough for the fix steps, because each one gets a self-contained description of its fix. The defaults are `opus` on Claude Code for the final step and `gpt-6-luna` on Codex CLI for the fixes. Each model picker sits beside its harness and lists that harness's models; changing the harness switches the model to that harness's default model. Bug Hunt Loop has no natural end, so set `maxSteps` on the workflow or the `queue.maxSteps` setting if you want to cap how much it runs.

## Variables in the body

A variable is a `{placeholder}` token in a prompt (or any string field). The token form sets its default input type:

| Token in the body | Input type | UI                              |
| ----------------- | ---------- | ------------------------------- |
| `{name}`          | text       | single-line input               |
| `{text:name}`     | text       | single-line input (explicit)    |
| `{file:name}`     | file       | input with a **Browse…** button |

Variable names must start with a lowercase letter and contain only letters and digits. Condition output references (`$preCondition:<field>` and `$endCondition:<field>`) are runtime values and never treated as template variables. `$preCondition:*` works in step and retry prompts; `$endCondition:*` is only available in retry prompts.

The `{file:…}` / `{text:…}` inline prefixes only cover those two types. For a `directory`, `select`, `harness`, or `model` variable, write a plain `{name}` token in the body and declare its type in `_templateMeta` (below).

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
| `type`             | any             | `text` (default), `file`, `directory`, `select`, `harness`, or `model`.                                                |
| `harness`          | model           | Name of the `harness` variable whose models this variable offers. Required for `model`.                                |
| `options`          | select          | The dropdown choices (e.g. `[debug, info, warn]`). The first option is used as the default unless `default` is set.    |
| `default`          | any             | Pre-fills the input; substituted when the field is left blank.                                                         |
| `description`      | any             | Helper text shown under the input.                                                                                     |
| `multiline`        | text            | Renders a resizable textarea instead of a single-line input.                                                           |
| `fileFilter`       | file            | Glob patterns for the file picker (e.g. `["**/*.md"]`).                                                                |
| `autoFillFilename` | file, directory | Seeds the new workflow's filename from the picked file/folder basename. Only the first variable that declares it wins. |

Input controls by type: **text** → single-line input (or textarea with `multiline`); **file** → input + Browse (file picker); **directory** → input + Browse (folder picker); **select** → dropdown of `options`; **harness** → the harness picker (no `options` needed; defaults to `claude-cli` when no `default` is set); **model** → a model picker on the same row as its harness, listing that harness's models. Changing the harness switches the model to that harness's default model, and a model with no `default` starts on it too.

Pair a model with its harness so a template can run each role on its own harness and model:

```yaml
_templateMeta:
  variables:
    reviewHarness:
      type: harness
      default: codex-cli
    reviewModel:
      type: model
      harness: reviewHarness
```

Use both in the body, for example `harness: "{reviewHarness}"` and `model: "{reviewModel}"` on the step they configure.

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

You can save a field's current value as a **variable default** from the template picker. The User/Workspace toggle in the title bar selects where **Save as default** writes; it also selects where **Set as Default** writes the default template setting. The toggle starts on Workspace until a save succeeds, then remembers the scope of the last successful save. With no workspace open, it stays on User.

Saved values override the value declared in the template. Workspace values take precedence over User values, which take precedence over the template's authored value. This is resolved per variable, so a template can use some values saved in Workspace and others saved in User. A **Saved (User)** or **Saved (Workspace)** marker shows the source, and **Clear saved value** removes the value from that scope so the next value in the precedence order applies. Saving the value already inherited at the selected scope clears that scope's override instead of keeping a redundant saved value.

A harness and its linked model fields are one unit: they are saved, marked, and cleared together, and resolve from the same scope. Multiline text fields cannot be saved as variable defaults.

## Custom templates {#custom-templates}

Custom templates are `*.ctrlyoke.yaml`, `*.ctrlyoke.yml`, or `*.ctrlyoke.json` files in `.ctrlyoke/templates/` (workspace) or `~/.ctrlyoke/templates/` (user). They use the same `_templateMeta` schema as the built-ins. A file name must be unique within its location, regardless of format.

There are two ways to create one:

- In the template picker, click **New template...**, or run the **Create New Custom Template** command, which opens the same form. Choose a name, a location (workspace or user), and a format (YAML or JSON). ctrlyoke copies the currently selected template as the starting point, carrying any saved variable values into the copy as its authored defaults. Select **Template Starter** first to get an example of every variable type.
- In the Save Workflow dialog, turn on **Save as Template**. This saves the workflow's current values as-is; edit the file afterward to replace fixed values with `{placeholder}` variables.
