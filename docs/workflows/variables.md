# Variables

Workflow variables let you write a workflow once and change a few values per
run, such as a target directory, a ticket number or a model. Declare defaults
under `vars`, reference them as <code v-pre>{{name}}</code>, and override them
from the CLI with `--var`.

```yaml
vars:
  module: src/parser
  ticket: ABC-123

steps:
  - name: fix
    prompt: Fix ticket {{ticket}}. Keep changes inside @{{module}}/.

  - name: test
    type: script
    script: npm test -- {{module}}
```

```sh
ctrlyoke run fix-ticket.ctrlyoke.yaml --var ticket=ABC-456 --var module=src/lexer
```

## Declaring variables

`vars` is a workflow-level map of names to **string** values. It can only be
set at the workflow root, not on a step.

- Names may contain letters, digits and underscores (`^\w+$`).
- Names must be unique ignoring case: `Module` and `module` can't both be
  declared, because each variable is also exported as an upper-case environment
  variable (see [below](#environment-variables)).
- Quote values that YAML would otherwise read as a number or boolean, such as
  `"8080"` or `"true"`.

In the dashboard, edit them under **Variables** on the
[Context tab](/workflows/properties-panel#context) of the workflow properties
drawer.
**Bulk edit** takes several `name=value` lines at once.

## Where <code v-pre>{{name}}</code> is substituted {#where-substituted}

ctrlyoke replaces <code v-pre>{{name}}</code> just before each step runs, in
these fields only:

| Where                                   | Fields                                                   |
| --------------------------------------- | -------------------------------------------------------- |
| Prompt steps                            | prompt text, `model`, `additionalArgs`                   |
| [Script steps](/workflows/script-steps) | `script`, `env` values                                   |
| Pre-conditions                          | `script`, `env` values                                   |
| End conditions                          | `script`, `env` values, `retryPrompt`, `passRetryPrompt` |
| Hooks                                   | `command`, `env` values                                  |
| [Worktrees](/workflows/worktrees)       | the `setup` command                                      |

Anything else, such as a step's `name`, `harness` or `agent`, is used as
written.

### Placeholders that are left alone

- **Undefined names.** A <code v-pre>{{name}}</code> with no matching variable
  is left in the text as-is, and the run shows a warning naming the placeholder
  and the field it was found in. The step still runs, so a workflow that talks
  about <code v-pre>{{name}}</code> syntax in a prompt keeps working.
- **Fenced code blocks.** Nothing inside a fenced code block (` ``` `) in prompt
  text is substituted. Use a fence when a prompt needs to show the literal
  syntax.
- **Inline code is not protected.** <code v-pre>`{{module}}`</code> in single
  backticks _is_ substituted. Scripts use backticks for command substitution,
  so authors deliberately put variables inside them.

The prompt editor highlights exactly the placeholders that will be substituted,
so what you see there matches what runs.

### Variables can't create secret references

A variable value may not contain `${secret:`. A step whose substituted text
would gain a managed-secret reference from a variable fails before anything
runs. Reference secrets directly in `env` instead; see
[Secrets](/workflows/secrets).

## Overriding from the CLI

`ctrlyoke run` takes `--var key=value`, repeatable. A CLI value replaces the
workflow's own default for that name, and new names are added:

```sh
ctrlyoke run release.ctrlyoke.yaml --var version=2.4.0 --var channel=beta
```

Everything after the first `=` is the value, so values may contain `=`. A
missing `=` or an invalid name exits with code 2 before the run starts. See
[`ctrlyoke run`](/cli/ctrlyoke).

## Environment variables {#environment-variables}

Every script ctrlyoke runs itself — script steps, pre-conditions, end
conditions and worktree setup — also gets each variable as an environment variable
named `CTRLYOKE_VAR_<NAME>`, with the name upper-cased. This happens whether or
not the script text uses <code v-pre>{{name}}</code>:

```yaml
vars:
  module: src/parser

steps:
  - name: lint module
    type: script
    script: node scripts/lint.js # reads process.env.CTRLYOKE_VAR_MODULE
```

Reading the environment variable is the safer choice when a value might
contain quotes, spaces or shell metacharacters, because it is never spliced
into a command line. A key in a step's own `env` with the same name wins over
the exported variable, and the editor warns when one shadows the other.

## Variables vs template placeholders

[Templates](/workflows/templates) use single braces, `{name}`, and are a
different mechanism:

|                       | Template `{name}`                                | Workflow <code v-pre>{{name}}</code> |
| --------------------- | ------------------------------------------------ | ------------------------------------ |
| Filled in             | Once, when you create a workflow from a template | Every run, just before each step     |
| Values from           | The New Workflow from Template form              | `vars`, overridden by `--var`        |
| In the saved workflow | Replaced by the value you entered                | Kept as a placeholder                |

A template can contain <code v-pre>{{name}}</code> placeholders; they pass
through untouched and become variables of the generated workflow.

## See also

- [`vars` in the workflow schema](/reference/workflow-schema#workflow-file-vars)
- [Script steps](/workflows/script-steps): how scripts run and receive their environment.
- [Secrets](/workflows/secrets): passing credentials without putting them in variables.
