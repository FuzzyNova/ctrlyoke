---
name: ctrlyoke-mcp-tools
description: Use when MCP config is disabled by policy and you need to inspect or extend a ctrlyoke workflow queue.
---

# ctrlyoke MCP tools

ctrlyoke is a workflow engine that runs structured, sequential prompts through AI coding harnesses. This skill provides the queue-management tools when the harness cannot load ctrlyoke's MCP configuration because MCP config is disabled by policy.

Run a tool through ctrlyoke's CLI entrypoint with this shape:

```sh
node "<mcp-server.js path>" --tool <tool-name> --args '<json-object>' --workspace "<workspace path>" --working-file "<working-file path>"
```

Pass the workspace and working-file as explicit `--workspace` and `--working-file` flags on every invocation. Do not rely on environment inheritance: the harness's shell tool does not reliably carry ctrlyoke's environment variables into a spawned process. The working file identifies the workflow run that the tools operate on.

## Reading the result

A tool either did what you asked or it failed — it never half-succeeds
quietly. Check which before you act on the outcome:

- **Failure**: the process exits non-zero and writes one explanatory sentence
  to stderr. Nothing was changed. The message names the tool and says why, so
  read it rather than retrying the same call.
- **Success**: the process exits zero and writes a JSON object to stdout. For
  the queue-mutating tools (`append_step`, `edit_step`, `remove_step`,
  `reorder_steps`) that object carries `changed`. `changed: false` means the
  call was accepted but wrote nothing because the step list already matched
  what you asked for — treat it as "already done", not as a change you made.
  Some responses also carry a `note` field explaining a partial or empty
  result; it is part of the answer, not decoration.

Two refusals are worth recognizing, because retrying will not help:

- _"the attached ctrlyoke workflow run is no longer executing"_ — the workflow
  this session belongs to has finished. Its queue is now history, and steps
  added to it would never run. Report the remaining work in your reply and let
  the user start a new workflow.
- _"no ctrlyoke workflow run is attached"_ — this session is not running inside
  a ctrlyoke workflow at all, so there is no queue to inspect or extend.
