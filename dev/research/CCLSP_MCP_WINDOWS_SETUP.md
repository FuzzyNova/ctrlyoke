# cclsp MCP Setup on Windows

cclsp is an MCP server that bridges LSP (Language Server Protocol) servers to AI coding tools,
exposing tools like `find_definition`, `find_references`, `rename_symbol`, `get_diagnostics`, etc.

## Windows-Specific Gotchas

### Gotcha 1: npm global binaries can't be spawned directly

When Node.js `spawn()` executes a command without a shell, it can't resolve npm's `.cmd` wrapper
scripts. This affects two layers:

| Layer | Problem | Fix |
|---|---|---|
| AI tool → cclsp | `cmd /c cclsp` dies silently after ~7 min | Use `node path/to/cclsp/dist/index.js` directly |
| cclsp → typescript-language-server | `spawn EINVAL` on `.cmd` files | Use `cmd /c typescript-language-server` in `cclsp.json` |

The fix is asymmetric: cclsp itself is invoked via `node` directly (bypassing the shell entirely),
but the LSP servers *inside* cclsp still need `cmd /c` since cclsp uses Node.js `spawn()` internally.

### Gotcha 2: The official `typescript-lsp` Claude plugin is broken

The `typescript-lsp@claude-plugins-official` plugin installs only a `LICENSE` and `README.md` —
no actual configuration. Disable it and use cclsp instead:

```json
// ~/.claude/settings.json
"enabledPlugins": {
  "typescript-lsp@claude-plugins-official": false
}
```

### Gotcha 3: MCP config must include `"type": "stdio"`

Claude Code's `~/.claude.json` requires `"type": "stdio"` in MCP server entries. Without it,
the transport is `undefined` and the connection closes immediately before `tools/list` is called.

---

## Installation

```bash
npm install -g cclsp
npm install -g typescript-language-server typescript
```

Verify:
```bash
node C:/Users/<you>/AppData/Roaming/npm/node_modules/cclsp/dist/index.js
typescript-language-server --version
```

---

## cclsp.json (shared across all tools)

Location: `C:/Users/<you>/.config/claude/cclsp.json`

```json
{
  "servers": [
    {
      "extensions": ["js", "ts", "jsx", "tsx"],
      "command": ["cmd", "/c", "typescript-language-server", "--stdio"],
      "rootDir": "."
    }
  ]
}
```

Note: `cmd /c typescript-language-server` is required here because cclsp spawns LSP servers
via Node.js `spawn()` without a shell, so the `.cmd` wrapper won't resolve otherwise.

---

## Claude Code

Config location: `~/.claude.json` under `mcpServers`.

```json
"mcpServers": {
  "cclsp": {
    "type": "stdio",
    "command": "node",
    "args": ["C:/Users/<you>/AppData/Roaming/npm/node_modules/cclsp/dist/index.js"],
    "env": {
      "CCLSP_CONFIG_PATH": "C:/Users/<you>/.config/claude/cclsp.json"
    }
  }
}
```

Note: `"type": "stdio"` is required. Using `"command": "cmd"` with `"/c", "cclsp"` appears to work
initially but the process dies silently after several minutes. Use `node` with the absolute path.

---

## GitHub Copilot CLI

Config location: `~/.copilot/mcp-config.json` (create if it doesn't exist).

```json
{
  "mcpServers": {
    "cclsp": {
      "type": "local",
      "command": "node",
      "args": ["C:/Users/<you>/AppData/Roaming/npm/node_modules/cclsp/dist/index.js"],
      "env": {
        "CCLSP_CONFIG_PATH": "C:/Users/<you>/.config/claude/cclsp.json"
      }
    }
  }
}
```

Note: Copilot uses `"type": "local"` instead of `"type": "stdio"`.

---

## OpenCode

Config location: `~/.config/opencode/opencode.json` (add `mcp` key to existing config).

```json
{
  "mcp": {
    "cclsp": {
      "type": "local",
      "command": [
        "node",
        "C:/Users/<you>/AppData/Roaming/npm/node_modules/cclsp/dist/index.js"
      ],
      "environment": {
        "CCLSP_CONFIG_PATH": "C:/Users/<you>/.config/claude/cclsp.json"
      },
      "enabled": true
    }
  }
}
```

Note: OpenCode uses `"environment"` (not `"env"`) and `"command"` is an array (not a string + `"args"`).

---

## Codex CLI

Add via CLI (writes to `~/.codex/config.toml`):

```bash
codex mcp add cclsp \
  --env "CCLSP_CONFIG_PATH=C:/Users/<you>/.config/claude/cclsp.json" \
  -- node "C:/Users/<you>/AppData/Roaming/npm/node_modules/cclsp/dist/index.js"
```

Resulting TOML:

```toml
[mcp_servers.cclsp]
command = "node"
args = ["C:/Users/<you>/AppData/Roaming/npm/node_modules/cclsp/dist/index.js"]

[mcp_servers.cclsp.env]
CCLSP_CONFIG_PATH = "C:/Users/<you>/.config/claude/cclsp.json"
```

---

## Available Tools (once connected)

| Tool | Description |
|---|---|
| `find_definition` | Find where a symbol is defined |
| `find_references` | Find all usages of a symbol across the workspace |
| `rename_symbol` | Rename a symbol across the codebase |
| `rename_symbol_strict` | Rename at a specific line/character position |
| `get_diagnostics` | Get LSP errors and warnings for a file |
| `get_hover` | Get type info / docs for a symbol at a position |
| `find_workspace_symbols` | Search for symbols by name across all files |
| `find_implementation` | Find implementations of an interface or abstract method |
| `prepare_call_hierarchy` | Set up for incoming/outgoing call queries |
| `get_incoming_calls` | Find callers of a function |
| `get_outgoing_calls` | Find functions called by a function |
| `restart_server` | Restart LSP servers (useful after config changes) |
