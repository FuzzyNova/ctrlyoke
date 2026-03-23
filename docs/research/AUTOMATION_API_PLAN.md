# Automation API & Power User Scripting Plan

## The Question: Do We Need an SDK?

Short answer: **not yet, and maybe never** — but two targeted CLI enhancements close the
gap for almost every automation use case. A Python/JS SDK only makes sense later, built
thin on top of the MCP server once the standalone server exists.

---

## What Power Users Actually Need

The canonical use cases:

1. **Multi-repo batch execution** — run the same security or cleanup workflow against 50
   repos, collect results, report failures.
2. **Conditional chaining** — run a research workflow, inspect what it found, then
   conditionally run a follow-up workflow.
3. **Parametrized workflows** — same YAML, different target (repo URL, branch, component
   name, environment).
4. **CI/CD integration** — trigger FlightPath from a GitHub Actions or Jenkins pipeline,
   fail the build if the AI workflow fails.
5. **Result inspection** — after a run, programmatically examine which files were changed,
   what the AI output was, whether end conditions passed.

---

## What Already Works

```bash
# Run a workflow headlessly
flightpath run security-scan.flightpath.yaml --headless

# Get JSON output  (--json flag already exists in cli.ts)
flightpath run security-scan.flightpath.yaml --headless --json

# CI/CD: non-zero exit on failure (already works)
flightpath run workflow.yaml --headless || echo "workflow failed"
```

The building blocks are already there. The gaps are **parametrization** and **structured
output richness**.

---

## Why YAML Conditionals/Loops Are the Wrong Answer

Adding `if/then/else` or `loop` constructs to the FlightPath YAML schema is tempting but
creates a mini-language nobody wants. Consider:

- GitHub Actions YAML expressions (`${{ if condition }}`) are universally hated for
  anything beyond trivial cases
- Helm templates (`{{- if .Values.enabled }}`) are notoriously hard to read and debug
- Ansible's `when:` + `with_items:` + `loop:` grew into a full scripting system nobody
  can remember the syntax for

Users already know Python, bash, and JavaScript. The right answer is to give them a
clean programmatic surface and let them use the tools they already know.

---

## The Right Answer: Two CLI Enhancements

### Enhancement 1 — Variable Substitution (`--var`)

Allow `{{varName}}` placeholders anywhere in workflow YAML/JSON (prompt text, model,
harness, endCondition script path). Pass values from the CLI with `--var key=value`.

```bash
# Run the same workflow against different repos
for repo in repos/*.txt; do
  flightpath run security-scan.yaml \
    --headless \
    --var "repoPath=$(cat $repo)" \
    --var "reportDir=./reports/$(basename $repo .txt)"
done
```

```yaml
# security-scan.flightpath.yaml
prompts:
  - id: scan
    prompt: |
      Scan the repository at {{repoPath}} for security vulnerabilities.
      Write a report to {{reportDir}}/security-report.md.
```

**Implementation:**
- `PropertyResolver` already handles three-tier precedence. A fourth tier — CLI vars —
  sits at the top (highest precedence).
- Substitution runs on the resolved prompt text before sending to the AI CLI.
- `--var` can be passed multiple times: `--var a=1 --var b=2`
- Vars are also available in `endCondition.script` invocations as env vars
  (`FLIGHTPATH_VAR_REPOPATH`, etc.) so scripts can branch on them.
- Missing vars with no default: fail fast with a clear error message.

**Schema addition (optional):**
```yaml
vars:
  repoPath: "."          # workflow-level defaults; overridden by --var at runtime
  reportDir: "./reports"
```

### Enhancement 2 — Richer `--json` Output

The `--json` flag already exists. Expand the output schema to include everything a script
needs to branch and inspect:

```jsonc
{
  "success": true,
  "workflowFile": "security-scan.flightpath.yaml",
  "startedAt": "2026-03-23T10:00:00Z",
  "completedAt": "2026-03-23T10:04:32Z",
  "durationMs": 272000,
  "vars": { "repoPath": "/home/user/myrepo" },
  "steps": [
    {
      "id": "scan",
      "index": 0,
      "success": true,
      "attempts": 1,
      "sessionId": "abc-123",
      "filesChanged": ["src/auth.ts", "src/db.ts"],
      "endCondition": { "passed": true, "script": "npm test", "output": "..." }
    }
  ],
  "error": null    // or { "step": "scan", "message": "...", "attempt": 2 }
}
```

**In scripts:**
```python
import subprocess, json, sys

result = json.loads(subprocess.check_output([
    "flightpath", "run", "security-scan.yaml",
    "--headless", "--json", "--quiet",
    "--var", f"repoPath={repo}"
]))

if not result["success"]:
    print(f"Scan failed at step {result['error']['step']}")
    sys.exit(1)

changed = [s["filesChanged"] for s in result["steps"]]
print(f"Modified {sum(len(f) for f in changed)} files")
```

This is ergonomic in bash, Python, JavaScript, or any language that can parse JSON from
stdout. No SDK required.

---

## When Would a Python/JS SDK Be Worth It?

A dedicated SDK adds value only when:

1. **The programmatic surface is rich enough** — once the standalone server exists, the
   WebSocket API gives full real-time access to streaming output, mid-workflow events, and
   interactive control. A Python/JS client for that is genuinely useful.
2. **Type safety matters** — an SDK with typed response objects (`WorkflowResult`,
   `StepResult`) is nicer than parsing raw JSON.
3. **There is user demand** — build the CLI enhancements first, see if users ask for more.

**If built, the SDK should be a thin wrapper over the MCP server or HTTP API** from
`STANDALONE_SERVER_PLAN.md` — not a reimplementation of workflow execution logic. The
SDK never runs workflows itself; it communicates with a running FlightPath server.

```python
# Future SDK (post-standalone-server)
from flightpath import FlightPathClient

async with FlightPathClient("http://localhost:3847") as fp:
    run = await fp.run("security-scan.yaml", vars={"repoPath": repo})
    async for event in run.events():
        if event.type == "file_edit":
            print(f"  Modified {event.data.path}")
    result = await run.wait()
```

This is worth building — but only after the standalone server exists.

---

## What About the MCP Server?

`flightpath-mcp` already exposes `flightpath_queue_status` and `flightpath_append_queue`
as MCP tools. For users who live in an AI coding assistant, this is already a powerful
automation API — they can tell their AI to append steps to a running FlightPath queue or
inspect its state.

Enhancements worth adding to the MCP server:
- `flightpath_run_workflow` — trigger a full workflow run and return structured results
- `flightpath_get_step_output` — retrieve the output of a specific completed step
- `flightpath_set_var` — set a runtime variable on a running workflow

---

## Recommendation

| Enhancement | Priority | Complexity |
|------------|---------|-----------|
| `--var key=value` CLI substitution | **High** | Low — PropertyResolver extension |
| Richer `--json` output schema | **High** | Low — output is already collected |
| Workflow-level `vars:` defaults | Medium | Low — schema + PropertyResolver |
| Python/JS SDK | Low | Medium — build after standalone server |
| MCP server `flightpath_run_workflow` | Medium | Low — wraps existing CLI logic |
| YAML `if/when/loop` constructs | **Do not build** | — |

The two high-priority items together give power users everything they need for the
multi-repo batch, CI/CD, and conditional chaining use cases, with tools they already know.
