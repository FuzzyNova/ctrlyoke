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
