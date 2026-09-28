# `ctrlyoke-mcp`

`ctrlyoke-mcp` is ctrlyoke's built-in MCP server: a Node stdio process (`out/mcp-server.js`) that gives a harness the [MCP tools](/reference/mcp-tools) for inspecting and extending its own run.

## You rarely start it yourself

When a workflow or step includes `mcpServers: ["ctrlyoke"]`, ctrlyoke launches a server for each harness launch and pins it to the executing run. It runs as `node <path>/out/mcp-server.js` with this environment:

| Variable                                            | Meaning                                                                |
| --------------------------------------------------- | ---------------------------------------------------------------------- |
| `CTRLYOKE_WORKING_FILE`                             | The run's `workflow.ctrlyoke.json`. The only thing that attaches a run |
| `CTRLYOKE_WORKSPACE`                                | Workspace (state) root used to find run history and `.ctrlyoke/`       |
| `CTRLYOKE_EXECUTION_ROOT`                           | Checkout the step runs in (the worktree, when the run uses one)        |
| `CTRLYOKE_MAX_STEPS`, `CTRLYOKE_MAX_PARALLEL_STEPS` | Step-count and parallelism limits from the `queue` settings            |
| `CTRLYOKE_HOME`, `CTRLYOKE_RUN_HISTORY_LOCATION`    | Where run history lives                                                |
| `CTRLYOKE_DIAGNOSTIC_LOGS`                          | `true` writes `ctrlyoke-mcp-<timestamp>.log` under `.ctrlyoke/logs/`   |

Each harness receives the server in its own configuration format:

| Harness           | How the server is attached                                          |
| ----------------- | ------------------------------------------------------------------- |
| `claude-cli`      | Generated JSON file passed with `--mcp-config`                      |
| `copilot-cli`     | Generated JSON file passed with `--additional-mcp-config @<file>`   |
| `codex-cli`       | Inline TOML overrides (`-c mcp_servers.ctrlyoke=...`)               |
| `qwen-cli`        | Inline JSON passed with `--mcp-config`                              |
| `opencode-cli`    | Inline config in the `OPENCODE_CONFIG_CONTENT` environment variable |
| `antigravity-cli` | Temporary entry in the workspace `.agents/mcp_config.json`          |

Temporary config files live under `.ctrlyoke/temp/`. ctrlyoke pre-approves the server's tools wherever the harness supports it, so unattended runs do not stop at a tool-approval prompt.

## Using it from an external MCP client

The server serves exactly one workflow run, identified only by `CTRLYOKE_WORKING_FILE`. Started without it — for example from your own MCP client config — the workflow tools refuse to run. Only `global_status` and the coordination tools (`post_note`, `read_notes`, `claim_paths`, `release_paths`) work, and on the coordination board the client appears as an unattested external participant, labeled `unattested external session` (allowed unless `coordination.allowExternalParticipants` is `false`; `CTRLYOKE_PARTICIPANT_LABEL` sets its display name).

To drive ctrlyoke from outside a workflow — start, append to, or continue runs — use the [`ctrlyoke` CLI](/cli/ctrlyoke) instead (`ctrlyoke run`, `ctrlyoke append`, `ctrlyoke step`).

## One-shot tool mode

With `--tool`, the server calls a single tool, prints its JSON result to stdout, and exits (exit code `1` and a message on stderr on failure). This is what the built-in skills use when the `execution.ctrlyokeMcpMode` setting is `skill`; they invoke the same script as `node <path>/out/mcp-server.js`.

```sh
ctrlyoke-mcp --tool workflow_status --args '{}' \
  --workspace "<workspace>" --working-file "<run>/workflow.ctrlyoke.json"
```

| Flag                       | Meaning                                                                      |
| -------------------------- | ---------------------------------------------------------------------------- |
| `--tool <name>`            | Tool to call (required)                                                      |
| `--args <json>`            | Tool arguments as JSON (default `{}`)                                        |
| `--workspace <path>`       | Sets `CTRLYOKE_WORKSPACE`                                                    |
| `--working-file <path>`    | Sets `CTRLYOKE_WORKING_FILE`, attaching the run                              |
| `--execution-root <path>`  | Checkout for coordination tools (default: current directory)                 |
| `--step-index <n>`         | Zero-based step index for coordination tools                                 |
| `--parallel-group-id <id>` | Parallel group of that step; required with coordination tools inside a group |
| `--commit-output <path>`   | Destination for `submit_commit_message`                                      |

When `--working-file` is given, coordination calls must address a live step of that run. Participants joined this way expire after `coordination.cliParticipantTtlMinutes`.
