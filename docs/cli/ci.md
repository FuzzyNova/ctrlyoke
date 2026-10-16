# CLI in CI

The `ctrlyoke` CLI runs the same workflow files in a pipeline that the extension runs in VS Code.
This page covers what's different on a CI runner. [`ctrlyoke`](/cli/ctrlyoke) is the full command
reference.

## Install

CI runners have no VS Code, so use the npm package. Pin the version so a pipeline doesn't change
underneath you, and match the extension version your team uses:

```bash
npx --yes ctrlyoke@0.1.2 --version
```

or install it once per job:

```bash
npm install -g ctrlyoke@0.1.2
```

The runner needs Node.js 22.12 or later, plus the harness CLI your workflow uses, installed and
signed in (see [Harness sign-in](#harness-sign-in)).

## Validate workflows as a gate

`validate` never starts a harness, so it needs no credentials and costs nothing. It fits a pull
request check or a pre-commit hook:

```bash
ctrlyoke validate workflows/review.ctrlyoke.yaml --json
ctrlyoke validate workflows/review.ctrlyoke.yaml --harness claude-cli --strict lossy
```

It exits `0` when the file is valid, `2` when it fails schema or semantic validation, and `1`
when compatibility analysis fails. `--strict lossy|unverified|all` also fails on compatibility
warnings for the chosen harness. See [`ctrlyoke validate`](/cli/ctrlyoke#ctrlyoke-validate).

## Run headless

Without a TTY, `ctrlyoke run` runs headless automatically; `--headless` sets
the workflow default explicitly. A step's own `executionMode` takes precedence
in a TTY; without a TTY, interactive steps are clamped to headless. Use
`--headless --force headless` to apply headless mode to every step.
Add `--json` for one machine-readable result line on stdout:

```bash
ctrlyoke run workflows/fix-tests.ctrlyoke.yaml --headless --json > result.json
```

With `--json`, decorative output is suppressed, and diagnostics go to
`.ctrlyoke/logs/ctrlyoke-cli-<timestamp>.log`, never to stdout. Upload that folder as a build
artifact when you need to debug a failed run.

### Exit codes

| Code | Meaning                                                                       | Typical CI action                       |
| ---- | ----------------------------------------------------------------------------- | --------------------------------------- |
| `0`  | Success                                                                       | Continue                                |
| `1`  | A step or end condition failed (also: harness sign-in failures)               | Fail the job; read the JSON result      |
| `2`  | Usage or parse error, unapproved external roots or secret grants, newer state | Fix the pipeline configuration          |
| `3`  | The harness CLI could not be found                                            | Install it or fix `PATH`                |
| `4`  | A step timed out outside a configured execution guardrail                     | Inspect the step failure                |
| `5`  | Interrupted (`SIGINT`/`SIGTERM`, for example a cancelled job)                 | Nothing; the runner lock is freed       |
| `6`  | A configured execution guardrail stopped the run                              | Inspect `stopReason` in the JSON result |

A harness that is installed but not signed in fails its step, so the run exits `1`, not `3`.
Exit code `3` means only that the harness's executable wasn't found.

### The JSON result

`run --json` writes one object (`schemaVersion: 1`) when the run ends:

| Field                      | Meaning                                                                                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `success`                  | `true` only when the run completed and every step passed                                                                                           |
| `status`                   | Final execution state, for example `completed`, `error` or `stopped`                                                                               |
| `workflowFile`             | The file you ran, or `null` for `--prompt`                                                                                                         |
| `workflowKey`, `runRef`    | Address of this run for `history show`, `rerun`, `append`, `continue` and `step`                                                                   |
| `harness`, `model`         | What the run used                                                                                                                                  |
| `startedAt`, `completedAt` | ISO-8601 timestamps; `durationMs` is the elapsed time                                                                                              |
| `varNames`                 | Names of the workflow variables (never their values)                                                                                               |
| `summary`                  | Step counts: `total`, `completed`, `failed`, `skipped`                                                                                             |
| `steps[]`                  | Per step: `status`, `success`, `attempts`, `sessionId`, `preCondition`, `endCondition`, `filesChanged`, `script` output, `failureKind` and `error` |
| `finalStep`                | The final step's result, `passCount`, and its last pass (`lastPass`), or `null`                                                                    |
| `error`                    | `{ step, pass, attempt, message }` for the failure that ended the run, or `null`; `pass` is the 1-based final-step pass (as in `--step final:N`)   |

Secret values are redacted from the result. Check `success` rather than parsing `status` or
`error.message`, since message text can change.

Example: fail the job with a readable summary.

```bash
ctrlyoke run workflows/fix-tests.ctrlyoke.yaml --headless --json > result.json
status=$?
node -e 'const r=require("./result.json"); console.log(r.status, JSON.stringify(r.summary)); if (r.error) console.log(r.error.message)'
exit $status
```

## Tool permissions

On a CI runner nobody can answer an approval prompt, so decide permissions up front. The CLI
resolves them exactly as the extension does: the step's `toolPermissions`, then the workflow's,
then the `defaults.toolPermissions` setting.

The setting's default mode is `allowAll`: every tool is allowed except the deny list. That means
the agent can run any shell command you haven't denied, with the job's credentials. For CI:

- Set `toolPermissions` in the workflow, so the file carries its own policy wherever it runs.
- Or set workflow permissions for one run with `--permission-mode`, `--allow-tool` and
  `--deny-tool`. Step-level permission values still take precedence; use
  `--force <flag>` to apply a supplied permission flag to every step.
- A mode that can still ask for approval can stall an unattended run on that prompt.

See [Tool permissions](/cli/ctrlyoke#tool-permissions) and the
[`defaults.toolPermissions`](/reference/settings#defaults-toolpermissions) setting. Codex and
Antigravity don't enforce allow and deny lists.

## Approvals on a fresh runner

Trust decisions (external directory roots, secret grants, workspace settings that run programs) are recorded per machine, so a fresh
runner has none. With no terminal to ask in, `run` exits `2` and names the missing approval. Record approvals in the job
before running, with `--yes`, and only for workflow files your repository controls:

The root trust commands require a terminal unless `--yes` is supplied; without
one they list pending roots on stderr and exit `2` without recording a decision.

```bash
ctrlyoke trust-external-roots --yes
ctrlyoke trust-workflow-external-roots workflows/release.ctrlyoke.yaml --yes
ctrlyoke trust-secret-grants workflows/release.ctrlyoke.yaml --yes
ctrlyoke trust-workspace-settings --yes
```

## Secrets

CI runners usually have no OS credential store, so don't use `ctrlyoke secret set` there. Export
each secret the workflow declares as an environment variable of the same name. ctrlyoke resolves
declared names from the environment:

```bash
export DEPLOY_TOKEN="$DEPLOY_TOKEN_FROM_CI"
ctrlyoke secret check workflows/deploy.ctrlyoke.yaml   # fails fast if a name is missing
ctrlyoke run workflows/deploy.ctrlyoke.yaml --headless --json
```

`secret check` exits `1` when the only problem is a missing environment or managed
secret value. It exits `2` for unapproved grants or other configuration errors
(and reports missing values too when both problems exist), so it can run before
the expensive part of the job.

## Harness sign-in

Each harness CLI signs in its own way, and the interactive browser sign-in you use on a
workstation doesn't work on a runner. Use the non-interactive credential the harness documents
for headless use, usually an API key in an environment variable, stored as a CI secret. See
your harness's page under [Harnesses](/harnesses/).

## State on the runner

The CLI keeps run history under `~/.ctrlyoke` (move it with `CTRLYOKE_HOME`), and reads
`~/.ctrlyoke/settings.json` and the repository's `.ctrlyoke/settings.json`. On an ephemeral
runner all of that starts empty, so put the settings a pipeline depends on in the committed
`.ctrlyoke/settings.json`, or in the workflow itself.

## GitHub Actions example

This job validates every workflow on each pull request, then runs a workflow with Claude Code.
Swap in your own harness, its install command and its credential.

```yaml
name: ctrlyoke

on:
  pull_request:

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - name: Validate workflows
        run: |
          for f in workflows/*.ctrlyoke.yaml; do
            npx --yes ctrlyoke@0.1.2 validate "$f"
          done

  fix-tests:
    needs: validate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v5
        with:
          node-version: "22"
      - name: Install ctrlyoke and the harness
        run: npm install -g ctrlyoke@0.1.2 @anthropic-ai/claude-code
      - name: Run the workflow
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          ctrlyoke run workflows/fix-tests.ctrlyoke.yaml \
            --harness claude-cli --headless --json > result.json
      - name: Upload logs and result
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: ctrlyoke
          path: |
            result.json
            .ctrlyoke/logs/
```

A workflow that edits files leaves those edits in the job's checkout. Commit them, open a pull
request, or upload a diff as a later step. ctrlyoke doesn't push anything itself.
