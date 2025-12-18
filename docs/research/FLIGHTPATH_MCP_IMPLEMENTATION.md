# FlightPath MCP Server Implementation Guide

**Date**: December 17, 2025  
**Status**: Implementation Planning  
**Related**: [QUEUE_APPEND_FEATURE.md](QUEUE_APPEND_FEATURE.md), [QUEUE_EXTENSION_OPTIONS_ANALYSIS.md](QUEUE_EXTENSION_OPTIONS_ANALYSIS.md)

## Executive Summary

This document provides a complete implementation guide for FlightPath's Model Context Protocol (MCP) server, which enables AI agents (Copilot CLI, Claude CLI, Codex CLI, VS Code Chat) to extend workflow queues during Dynamic Queue execution.

**Key Architectural Decisions**:

- MCP servers using **stdio transport are spawned on-demand** by the MCP client (CLI or VS Code), NOT as persistent background services. This simplifies deployment dramatically.
- **Copilot CLI supports session-specific MCP configuration** via `--additional-mcp-config` flag, enabling programmatic setup without modifying user's global config.
- **Codex CLI supports session-specific MCP configuration** via `-c` flag with inline TOML, enabling zero-configuration workflow extension.
- **Built-in GitHub MCP server** is pre-configured in Copilot CLI, providing GitHub integration out-of-the-box.

---

## CLI Platform Comparison

Quick reference for MCP configuration across supported CLI platforms:

| Feature                   | Copilot CLI                     | Claude CLI               | Codex CLI                     |
| ------------------------- | ------------------------------- | ------------------------ | ----------------------------- |
| **Vendor**                | GitHub                          | Anthropic                | OpenAI                        |
| **Config Format**         | JSON                            | JSON                     | TOML                          |
| **Global Config**         | `~/.copilot/mcp-config.json`    | `~/.claude/mcp.json`     | `~/.codex/config.toml`        |
| **Session-Specific Flag** | `--additional-mcp-config @file` | `--mcp-config file`      | `-c 'mcp_servers.name={...}'` |
| **Config Generation**     | File required                   | File required            | Inline TOML (no file!)        |
| **FlightPath Method**     | Generate temp JSON file         | Generate temp JSON file  | Generate TOML string          |
| **Built-in Servers**      | GitHub MCP (enabled by default) | None                     | None                          |
| **Approval Policy**       | Per-tool prompts                | Per-tool prompts         | Global policy setting         |
| **Tool Filtering**        | Pattern-based allow/deny        | Pattern-based allow/deny | Array-based enable/disable    |
| **Status**                | Stable                          | Stable                   | Experimental                  |

**Recommendation**: All three CLIs are viable targets for FlightPath MCP integration. Codex CLI offers the cleanest integration path with inline TOML configuration (no file generation needed).

---

## Table of Contents

1. [MCP Architecture Overview](#mcp-architecture-overview)
2. [Transport Mechanisms](#transport-mechanisms)
3. [FlightPath MCP Server Design](#flightpath-mcp-server-design)
4. [Implementation by Platform](#implementation-by-platform)
5. [VS Code Extension Integration](#vs-code-extension-integration)
6. [Automated Setup](#automated-setup)
7. [Security Considerations](#security-considerations)
8. [Implementation Phases](#implementation-phases)

---

## MCP Architecture Overview

### What is MCP?

**Model Context Protocol (MCP)** is a standardized JSON-RPC protocol for connecting AI models to external tools, data sources, and services. It defines:

- **Tools**: Functions the AI can invoke (like FlightPath queue management)
- **Resources**: Data/content the AI can read (like queue state)
- **Prompts**: Pre-configured prompt templates
- **Sampling**: AI can make sub-requests to other models

### Key Concepts

**MCP Server**: Process that exposes tools/resources via JSON-RPC
**MCP Client**: AI platform (Copilot CLI, Claude CLI, VS Code) that invokes tools
**Transport**: Communication mechanism (stdio, HTTP, SSE)

---

## Transport Mechanisms

MCP supports three transport types:

### 1. stdio (Standard Input/Output) ⭐ RECOMMENDED

**How it works**:

- MCP client spawns server as child process
- Communication via stdin/stdout using JSON-RPC
- Server lifetime tied to client session
- **No persistent background service needed**

**Configuration Example**:

```json
{
  "command": "node",
  "args": ["/path/to/flightpath-mcp-server.js"]
}
```

**Process Flow**:

```
1. User starts CLI session: copilot or claude
2. CLI reads config: ~/.copilot/mcp-config.json or ~/.claude/mcp.json
3. CLI spawns server: child_process.spawn('node', ['server.js'])
4. Handshake: CLI ↔ Server (initialize, list tools)
5. Tools available to AI during session
6. Session ends: Server process exits
```

**Pros**:

- ✅ **Simple**: No service management, no ports
- ✅ **Secure**: Process isolation, no network exposure
- ✅ **Cross-platform**: Works on Windows, macOS, Linux
- ✅ **Auto-restart**: Each CLI session gets fresh server

**Cons**:

- ⚠️ **Cannot be shared**: Each CLI session spawns own server
- ⚠️ **Setup required**: User must add to config file

---

### 2. HTTP (Remote Server)

**How it works**:

- MCP server runs as HTTP service (persistent)
- Client connects via REST API
- Requires URL and optional auth

**When to use**: Multi-user deployments, cloud-hosted tools

**Not recommended for FlightPath**: Overkill for local queue management

---

### 3. SSE (Server-Sent Events)

**How it works**: HTTP with streaming updates

**Status**: Legacy, not recommended

---

## FlightPath MCP Server Design

### Server Architecture

```
┌─────────────────────────────────────────────┐
│         FlightPath MCP Server               │
│         (Node.js stdio process)             │
├─────────────────────────────────────────────┤
│  MCP SDK (@modelcontextprotocol/sdk)       │
│  ├─ StdioServerTransport                    │
│  └─ JSON-RPC message handling               │
├─────────────────────────────────────────────┤
│  Tool Handlers:                             │
│  ├─ flightpath_append_queue()               │
│  ├─ flightpath_get_queue_status()           │
│  └─ flightpath_list_queue()                 │
├─────────────────────────────────────────────┤
│  Queue Operations:                          │
│  ├─ Read working file (.queue.json)         │
│  ├─ Validate & merge prompts                │
│  ├─ Atomic write (temp + rename)            │
│  └─ Return result                           │
└─────────────────────────────────────────────┘
```

### Tool Definitions

#### 1. `flightpath_append_queue`

**Description**: Append prompts to the current FlightPath workflow queue

**Input Schema**:

```json
{
  "type": "object",
  "properties": {
    "prompts": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "prompt": { "type": "string" },
          "model": { "type": "string", "optional": true },
          "endCondition": { "type": "object", "optional": true }
        },
        "required": ["prompt"]
      },
      "description": "Array of prompts to add to queue"
    },
    "position": {
      "type": "string",
      "enum": ["next", "end"],
      "description": "Where to insert prompts (next = after current, end = at end of queue)"
    },
    "source": {
      "type": "string",
      "description": "Source identifier (e.g., 'AI Agent - Testing Tasks')"
    }
  },
  "required": ["prompts", "position"]
}
```

**Output**:

```json
{
  "success": true,
  "promptsAdded": 2,
  "newQueueSize": 8,
  "insertIndex": 3,
  "workingFile": ".flightpath/.queue/bugfix-123.queue.json"
}
```

---

#### 2. `flightpath_get_queue_status`

**Description**: Get current queue execution status

**Output**:

```json
{
  "workflowName": "bugfix-authentication",
  "currentIndex": 2,
  "totalPrompts": 6,
  "completedPrompts": 2,
  "state": "running",
  "maxQueueSize": 100,
  "remainingSlots": 94,
  "workingFile": ".flightpath/.queue/bugfix-123.queue.json"
}
```

---

#### 3. `flightpath_list_queue`

**Description**: List all prompts in queue with their status

**Output**:

```json
{
  "prompts": [
    {
      "index": 0,
      "prompt": "Analyze authentication module",
      "status": "completed",
      "model": "claude-sonnet-4.5"
    },
    {
      "index": 1,
      "prompt": "Identify security vulnerabilities",
      "status": "completed"
    },
    {
      "index": 2,
      "prompt": "Implement fixes",
      "status": "running"
    },
    {
      "index": 3,
      "prompt": "Write unit tests",
      "status": "pending"
    }
  ]
}
```

---

## Implementation by Platform

### 1. Copilot CLI (GitHub)

#### How MCP Works in Copilot CLI

**Configuration Locations**:

- **Global**: `~/.copilot/mcp-config.json` (customizable via `XDG_CONFIG_HOME`)
- **Session-specific**: `--additional-mcp-config` flag (JSON string or file path with `@` prefix)

**Built-in MCP Servers**:

- **GitHub MCP Server**: Pre-configured and enabled by default
  - Provides GitHub integration (merge PRs, manage issues, etc.)
  - Disable with: `--disable-builtin-mcps`
  - Enable all tools: `--enable-all-github-mcp-tools` (default uses CLI subset)

**Server Lifecycle**:

1. User runs `copilot` in terminal
2. Copilot CLI reads `~/.copilot/mcp-config.json` + `--additional-mcp-config` if provided
3. For each configured server, CLI spawns child process: `spawn(command, args)`
4. Handshake: Server sends capabilities, CLI requests tool list
5. Tools available for entire session
6. **User approval required** for each tool invocation (security)
7. User exits: CLI kills server processes

**Adding FlightPath MCP Server**:

**Method 1: Interactive** (manual setup - ⚠️ NOT used by FlightPath automation):

```bash
copilot  # Start CLI session

# Inside session:
/mcp add

# Fill in form:
# Name: flightpath
# Command: node
# Args: ~/.vscode/extensions/flightpath-<version>/out/mcp-server.js
# (or wherever FlightPath installs its MCP server)

# Save (Ctrl+S)

# Other /mcp commands:
# /mcp show [server-name]  - View configuration
# /mcp edit [server-name]  - Edit configuration
# /mcp delete [server-name] - Remove server
# /mcp disable [server-name] - Temporarily disable
# /mcp enable [server-name] - Re-enable server
```

> **Note**: This method requires manual user input and is NOT viable for FlightPath's automated workflow extension. Documented for reference only.

**Method 2: Session-Specific** (✅ ONLY method used by FlightPath):

```bash
# Using JSON string
copilot --additional-mcp-config '{"mcpServers":{"flightpath":{"command":"node","args":["path/to/mcp-server.js"]}}}'

# Using config file (recommended)
copilot --additional-mcp-config @/path/to/flightpath-mcp-config.json
```

> **FlightPath Implementation**: The extension automatically generates the config file and provides the complete command to users. No manual editing required.

**Method 3: Persistent Global Config** (manual setup - ⚠️ NOT used by FlightPath automation):

```json
{
  "mcpServers": {
    "flightpath": {
      "command": "node",
      "args": [
        "C:\\Users\\Nathan\\.vscode\\extensions\\nathanfriemel.flightpath-<ver>\\out\\mcp-server.js"
      ],
      "env": {
        "FLIGHTPATH_WORKSPACE": "${workspaceFolder}"
      }
    }
  }
}
```

> **Note**: This method modifies the user's global config and is NOT viable for FlightPath's automated workflow extension. Documented for reference only.

**Tool Invocation** (AI perspective with user approval):

```
User: "Analyze the auth module and extend the workflow with testing tasks"

Copilot (internal):
1. Analyzes auth module
2. Decides to extend queue
3. Requests approval: "May I use flightpath_append_queue to add tasks?"
4. User approves (Yes / Yes for session / No)
5. Invokes tool: flightpath_append_queue({
     prompts: [{prompt: "Write unit tests for auth module"}],
     position: "next",
     source: "AI-generated follow-up"
   })
6. Server reads working file, appends prompt, writes atomically
7. Returns success
8. Copilot reports: "I've added testing tasks to your FlightPath queue"
```

**Tool Permission Patterns**:

```bash
# Allow specific FlightPath tools
copilot --allow-tool 'flightpath(flightpath_append_queue)'

# Allow all FlightPath tools (recommended)
copilot --allow-tool 'flightpath'

# Deny specific tool but allow others
copilot --allow-tool 'flightpath' --deny-tool 'flightpath(flightpath_delete_queue)'
```

---

### 2. Claude CLI (Anthropic)

#### How MCP Works in Claude CLI

**Configuration Locations**:

- **User-level**: `~/.claude/mcp.json` (Mac/Linux) or `%APPDATA%/Claude/mcp.json` (Windows)
- **Project-level**: `.mcp.json` in project root (shared with team via git)
- **Session-specific**: `--mcp-config` flag (JSON file or string)

**Built-in Features**:

- **Claude Code MCP Server**: Can expose Claude's tools to other applications via `claude mcp serve`
- **Permission Modes**: `acceptEdits`, `bypassPermissions`, `default`, `delegate`, `dontAsk`, `plan`
- **Tool Control**: `--allowed-tools` and `--disallowed-tools` flags for fine-grained permissions

**Server Lifecycle**:

1. User runs `claude` in terminal
2. Claude CLI reads MCP configs from all sources (unless `--strict-mcp-config` used)
3. For each configured server, CLI spawns child process: `spawn(command, args)`
4. Handshake: Server sends capabilities, CLI requests tool list
5. Tools available for entire session
6. **User approval required** for each tool invocation (unless bypassed)
7. User exits: CLI kills server processes

**Adding FlightPath MCP Server**:

**Method 1: Interactive CLI** (manual setup - ⚠️ NOT used by FlightPath automation):

```bash
# Using claude mcp add command
claude mcp add --transport stdio flightpath --env FLIGHTPATH_WORKSPACE=. -- node /path/to/mcp-server.js

# Using JSON format
claude mcp add-json flightpath '{
  "type": "stdio",
  "command": "node",
  "args": ["/absolute/path/to/mcp-server.js"],
  "env": {
    "FLIGHTPATH_WORKSPACE": "."
  }
}'

# Other mcp commands:
# claude mcp list               - List all configured servers
# claude mcp get flightpath     - View specific server config
# claude mcp remove flightpath  - Remove server
```

> **Note**: This method requires manual user input and is NOT viable for FlightPath's automated workflow extension. Documented for reference only.

**Method 2: Session-Specific** (✅ ONLY method used by FlightPath):

```bash
# Using JSON string
claude --mcp-config '{"mcpServers":{"flightpath":{"type":"stdio","command":"node","args":["path/to/mcp-server.js"]}}}'

# Using config file (recommended)
claude --mcp-config /path/to/flightpath-mcp-config.json

# With strict mode (ignores other MCP configs)
claude --strict-mcp-config --mcp-config @flightpath-mcp-config.json
```

> **FlightPath Implementation**: The extension automatically generates the config file and provides the complete command to users. No manual editing required.

**Method 3: Persistent User/Project Config** (manual setup - ⚠️ NOT used by FlightPath automation):

Edit `~/.claude/mcp.json` (user-level):

```json
{
  "mcpServers": {
    "flightpath": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/mcp-server.js"],
      "env": {
        "FLIGHTPATH_WORKSPACE": "."
      }
    }
  }
}
```

Or create `.mcp.json` in project root (project-level):

```json
{
  "mcpServers": {
    "flightpath": {
      "type": "stdio",
      "command": "node",
      "args": ["${CLAUDE_PLUGIN_ROOT}/out/mcp-server.js"]
    }
  }
}
```

> **Note**: These methods modify persistent config files and are NOT viable for FlightPath's automated workflow extension. Documented for reference only.

**Tool Permission Patterns**:

```bash
# Allow specific FlightPath tools
claude --allowed-tools 'flightpath(flightpath_append_queue)'

# Allow all FlightPath tools (recommended)
claude --allowed-tools 'flightpath'

# Deny specific tool but allow others
claude --allowed-tools 'flightpath' --disallowed-tools 'flightpath(flightpath_delete_queue)'

# Bypass all permission checks (use with caution!)
claude --dangerously-skip-permissions
```

**Output Formats** (useful for automation):

```bash
# Stream JSON output (real-time)
claude --print --output-format stream-json "Your prompt here"

# Regular JSON output
claude --print --output-format json "Your prompt here"

# Text output (default)
claude --print "Your prompt here"
```

---

### 3. Codex CLI (OpenAI)

#### How MCP Works in Codex CLI

**Configuration Locations**:

- **Global**: `~/.codex/config.toml` (TOML format, customizable via `CODEX_HOME`)
- **Session-specific**: `-c` flag with inline TOML configuration (recommended for FlightPath)

**Built-in Features**:

- **Experimental MCP support**: MCP integration is currently marked as experimental
- **OAuth support**: Available for streamable HTTP servers with `rmcp_client = true` feature flag
- **Flexible configuration**: Supports both stdio and streamable HTTP transports

**Server Lifecycle**:

1. User runs `codex` in terminal
2. Codex CLI reads `~/.codex/config.toml` + `-c` flag overrides if provided
3. For each configured server, CLI spawns child process: `spawn(command, args)`
4. Handshake: Server sends capabilities, CLI requests tool list
5. Tools available for entire session
6. **User approval required** for each tool invocation (configurable via `approval_policy`)
7. User exits: CLI kills server processes

**Adding FlightPath MCP Server**:

**Method 1: Interactive CLI** (manual setup - ⚠️ NOT used by FlightPath automation):

```bash
# Using codex mcp add command
codex mcp add flightpath -- node /path/to/mcp-server.js

# With environment variables
codex mcp add flightpath --env FLIGHTPATH_WORKSPACE=. -- node /path/to/mcp-server.js

# Other mcp commands:
# codex mcp list               - List all configured servers
# codex mcp list --json        - List servers in JSON format
# codex mcp get flightpath     - View specific server config
# codex mcp get flightpath --json - View server config in JSON format
# codex mcp remove flightpath  - Remove server
# codex mcp login flightpath   - OAuth login for streamable HTTP servers (requires rmcp_client feature)
# codex mcp logout flightpath  - OAuth logout
```

> **Note**: This method requires manual user input and is NOT viable for FlightPath's automated workflow extension. Documented for reference only.

**Method 2: Session-Specific** (✅ RECOMMENDED method for FlightPath):

Codex CLI uses TOML configuration format with the `-c`/`--config` flag:

```bash
# Using inline TOML (recommended for FlightPath)
codex -c 'mcp_servers.flightpath={command="node",args=["path/to/mcp-server.js"]}'

# With environment variables
codex -c 'mcp_servers.flightpath={command="node",args=["path/to/mcp-server.js"],env={FLIGHTPATH_WORKSPACE="."}}'

# With additional options
codex -c 'mcp_servers.flightpath={command="node",args=["path/to/mcp-server.js"],startup_timeout_sec=20,tool_timeout_sec=60}'
```

**TOML Configuration Details**:

- **Key syntax**: Use dotted paths like `mcp_servers.flightpath.command`
- **Value format**: TOML format, not JSON: `{a = 1, b = 2}` instead of `{"a": 1, "b": 2}`
- **Quotes**: Values are TOML strings, so `command=node` is equivalent to `command="node"`
- **Arrays**: Use TOML array syntax: `args=["arg1", "arg2"]`

> **FlightPath Implementation**: The extension automatically generates the inline TOML configuration and provides the complete command string to users. No config file generation needed - just append flags to the `codex` command.

**Method 3: Persistent Global Config** (manual setup - ⚠️ NOT used by FlightPath automation):

Edit `~/.codex/config.toml`:

```toml
# Global MCP server configuration
[mcp_servers.flightpath]
command = "node"
args = ["/absolute/path/to/mcp-server.js"]
env = { FLIGHTPATH_WORKSPACE = "." }
startup_timeout_sec = 20  # Optional: override default 10s
tool_timeout_sec = 60     # Optional: override default 60s
enabled = true            # Optional: disable without removing
enabled_tools = ["flightpath_append_queue"]  # Optional: whitelist specific tools
```

> **Note**: This method modifies the user's global config and is NOT viable for FlightPath's automated workflow extension. Documented for reference only.

**Tool Invocation** (AI perspective with user approval):

```
User: "Analyze the auth module and extend the workflow with testing tasks"

Codex (internal):
1. Analyzes auth module
2. Decides to extend queue
3. Requests approval: "May I use flightpath_append_queue to add tasks?"
4. User approves (based on approval_policy setting)
5. Invokes tool: flightpath_append_queue({
     prompts: [{prompt: "Write unit tests for auth module"}],
     position: "next",
     source: "AI-generated follow-up"
   })
6. Server reads working file, appends prompt, writes atomically
7. Returns success
8. Codex reports: "I've added testing tasks to your FlightPath queue"
```

**Approval Policy Configuration**:

```bash
# Run with automatic approval (never prompt)
codex -c 'approval_policy="never"' -c 'mcp_servers.flightpath={...}'

# Run with on-failure approval (default)
codex -c 'approval_policy="on-failure"' -c 'mcp_servers.flightpath={...}'

# Run with on-request approval (let model decide)
codex -c 'approval_policy="on-request"' -c 'mcp_servers.flightpath={...}'

# Run with untrusted approval (prompt for untrusted commands)
codex -c 'approval_policy="untrusted"' -c 'mcp_servers.flightpath={...}'
```

**Feature Flags** (enable experimental features):

```bash
# Enable OAuth support for streamable HTTP MCP servers
codex --enable rmcp_client -c 'mcp_servers.flightpath={...}'

# Enable multiple features
codex --enable rmcp_client --enable unified_exec -c 'mcp_servers.flightpath={...}'
```

**Tool Permission Configuration**:

Unlike Copilot/Claude which use tool-specific patterns, Codex uses approval policies and per-server tool filtering:

```toml
# In config.toml or via -c flag
[mcp_servers.flightpath]
command = "node"
args = ["/path/to/mcp-server.js"]
enabled_tools = ["flightpath_append_queue", "flightpath_get_queue_status"]  # Whitelist
disabled_tools = ["flightpath_delete_queue"]  # Blacklist (applied after whitelist)
```

**Output Formats** (useful for automation):

Codex CLI output is primarily designed for terminal interaction. For programmatic use, check the exit code and parse terminal output.

**Key Differences from Copilot/Claude**:

1. **Configuration Format**: Uses TOML instead of JSON
2. **Inline Config Syntax**: `-c 'key={value}'` instead of `--additional-mcp-config` or `--mcp-config`
3. **Feature Flags**: Uses `--enable <feature>` for experimental features
4. **Approval Policies**: Global approval policy instead of per-tool patterns
5. **Tool Filtering**: Uses `enabled_tools`/`disabled_tools` arrays instead of pattern matching

---

### 4. VS Code Chat (Different Approach!)

#### VS Code Extension Can Register MCP Server Directly

**Key Difference**: VS Code extensions can register MCP servers **programmatically** using the Extension API, **OR** use the **Language Model Tools API** (even better).

#### Option A: Register MCP Server via Extension API

```typescript
// In FlightPath extension activation
import * as vscode from "vscode";

export async function activate(context: vscode.ExtensionContext) {
  // Register FlightPath MCP server with VS Code
  const mcpServer = vscode.mcp.registerServer({
    name: "flightpath",
    transport: {
      type: "stdio",
      command: "node",
      args: [context.asAbsolutePath("out/mcp-server.js")],
    },
    capabilities: {
      tools: true,
    },
  });

  context.subscriptions.push(mcpServer);
}
```

**Benefits**:

- ✅ **Auto-registered**: No user setup required
- ✅ **Auto-updated**: New extension versions = new server
- ✅ **Portable**: Works across all user workspaces

---

#### Option B: Language Model Tools API ⭐ RECOMMENDED for VS Code

**Best approach for VS Code Chat**: Skip MCP entirely and use the **Language Model Tools API** directly.

```typescript
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext) {
  // Register tool directly with Language Model API
  const queueAppendTool = vscode.lm.registerTool(
    "flightpath-append-queue",
    {
      name: "flightpath-append-queue",
      description: "Append prompts to the current FlightPath workflow queue",
      inputSchema: {
        type: "object",
        properties: {
          prompts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                prompt: { type: "string" },
              },
            },
          },
          position: {
            type: "string",
            enum: ["next", "end"],
          },
        },
        required: ["prompts", "position"],
      },
    },
    async (input, token) => {
      // Direct integration with FlightPathManager
      const manager = getFlightPathManager(); // Get singleton
      const result = await manager.appendPromptsToQueue(
        input.prompts,
        "AI Agent",
        "tool-invocation",
        input.position
      );

      return {
        success: true,
        promptsAdded: result.count,
        newQueueSize: result.queueSize,
      };
    }
  );

  context.subscriptions.push(queueAppendTool);
}
```

**Why This is Better for VS Code Chat**:

- ✅ **Direct integration**: No separate MCP server process
- ✅ **Full VS Code API access**: Can use extension APIs directly
- ✅ **Simpler**: No JSON-RPC, no child process management
- ✅ **Better performance**: In-process tool invocation

---

## VS Code Extension Integration

### Architecture Decision: Dual Approach

**For VS Code Chat**: Use Language Model Tools API ⭐ (no MCP server needed)

**For Copilot CLI/Claude CLI/Codex CLI**: Provide MCP server as separate entry point

**Important Distinction: Copilot CLI vs Copilot Coding Agent**

GitHub Copilot has **two separate MCP implementations**:

| Feature                | Copilot CLI                             | Copilot Coding Agent                  |
| ---------------------- | --------------------------------------- | ------------------------------------- |
| **Environment**        | Local terminal                          | GitHub-hosted automation              |
| **Configuration**      | `~/.copilot/mcp-config.json`            | Repository settings on GitHub.com     |
| **Setup**              | `/mcp add` or `--additional-mcp-config` | Admin configures in repo JSON editor  |
| **Security**           | User approval per tool invocation       | Autonomous (no approval prompts)      |
| **Use Case**           | Local development workflows             | Automated coding via issue assignment |
| **FlightPath Support** | ✅ Primary target                       | ⚠️ Future enhancement                 |

**FlightPath focuses on Copilot CLI** for local workflow extension. Copilot Coding Agent integration would require repository-level configuration and is not currently supported.

```
FlightPath Extension
├── src/
│   ├── extension.ts                   # Main extension (Chat tools)
│   ├── mcp-server.ts                  # MCP server entry point (CLI)
│   └── flightpath/
│       └── FlightPathManager.ts       # Shared queue logic
├── out/
│   ├── extension.js                   # Compiled extension
│   └── mcp-server.js                  # Compiled MCP server (for CLI)
└── package.json
```

### MCP Server Entry Point

**Create `src/mcp-server.ts`**:

```typescript
#!/usr/bin/env node
/**
 * FlightPath MCP Server
 *
 * Provides queue management tools for Copilot CLI and Claude CLI.
 * Spawned as child process via stdio transport.
 *
 * Usage:
 * node mcp-server.js
 *
 * Environment Variables:
 * - FLIGHTPATH_WORKSPACE: Workspace root directory
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs/promises";
import * as path from "path";

interface PromptItem {
  prompt: string;
  model?: string;
  endCondition?: any;
}

interface WorkingQueueFile {
  originalFile: string;
  workflowName: string;
  sessionId: string;
  startTime: Date;
  prompts: PromptItem[];
  completed: number[];
  currentIndex: number;
  appendSegments: any[];
}

class FlightPathMCPServer {
  private server: Server;
  private workspaceRoot: string;

  constructor() {
    this.workspaceRoot = process.env.FLIGHTPATH_WORKSPACE || process.cwd();

    this.server = new Server(
      {
        name: "flightpath",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "flightpath_append_queue",
          description:
            "Append prompts to the current FlightPath workflow queue. Use when you want to extend the workflow with additional tasks.",
          inputSchema: {
            type: "object",
            properties: {
              prompts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    prompt: { type: "string" },
                    model: { type: "string" },
                  },
                  required: ["prompt"],
                },
                description: "Array of prompts to add to the queue",
              },
              position: {
                type: "string",
                enum: ["next", "end"],
                description:
                  "Where to insert prompts: next (after current) or end (at end of queue)",
              },
              source: {
                type: "string",
                description:
                  'Source identifier (e.g., "AI Agent - Testing Tasks")',
              },
            },
            required: ["prompts", "position"],
          },
        },
        {
          name: "flightpath_get_queue_status",
          description: "Get the current status of the FlightPath queue",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "flightpath_list_queue",
          description: "List all prompts in the queue with their status",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    }));

    // Handle tool invocations
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      try {
        switch (name) {
          case "flightpath_append_queue":
            return await this.handleQueueAppend(args);
          case "flightpath_get_queue_status":
            return await this.handleQueueStatus();
          case "flightpath_list_queue":
            return await this.handleQueueList();
          default:
            throw new Error(`Unknown tool: ${name}`);
        }
      } catch (error: any) {
        return {
          content: [
            {
              type: "text",
              text: `Error: ${error.message}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private async handleQueueAppend(args: any) {
    const { prompts, position, source } = args;

    // Find active working file
    const workingFile = await this.findActiveWorkingFile();
    if (!workingFile) {
      throw new Error("No active FlightPath workflow found");
    }

    // Read current queue state
    const queueState: WorkingQueueFile = JSON.parse(
      await fs.readFile(workingFile, "utf8")
    );

    // Calculate insert index
    const insertIndex =
      position === "next"
        ? queueState.currentIndex + 1
        : queueState.prompts.length;

    // Insert prompts
    queueState.prompts.splice(insertIndex, 0, ...prompts);

    // Track segment
    queueState.appendSegments.push({
      segmentId: this.generateId(),
      startIndex: insertIndex,
      count: prompts.length,
      source: source || "MCP Tool",
      timestamp: new Date().toISOString(),
      sourceType: "mcp-tool",
    });

    // Write atomically
    const tempFile = workingFile + ".tmp";
    await fs.writeFile(tempFile, JSON.stringify(queueState, null, 2));
    await fs.rename(tempFile, workingFile);

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              success: true,
              promptsAdded: prompts.length,
              newQueueSize: queueState.prompts.length,
              insertIndex,
              workingFile,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleQueueStatus() {
    const workingFile = await this.findActiveWorkingFile();
    if (!workingFile) {
      throw new Error("No active FlightPath workflow found");
    }

    const queueState: WorkingQueueFile = JSON.parse(
      await fs.readFile(workingFile, "utf8")
    );

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              workflowName: queueState.workflowName,
              currentIndex: queueState.currentIndex,
              totalPrompts: queueState.prompts.length,
              completedPrompts: queueState.completed.length,
              workingFile,
            },
            null,
            2
          ),
        },
      ],
    };
  }

  private async handleQueueList() {
    const workingFile = await this.findActiveWorkingFile();
    if (!workingFile) {
      throw new Error("No active FlightPath workflow found");
    }

    const queueState: WorkingQueueFile = JSON.parse(
      await fs.readFile(workingFile, "utf8")
    );

    const prompts = queueState.prompts.map((p, index) => ({
      index,
      prompt: p.prompt,
      status: queueState.completed.includes(index)
        ? "completed"
        : index === queueState.currentIndex
          ? "running"
          : "pending",
      model: p.model,
    }));

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ prompts }, null, 2),
        },
      ],
    };
  }

  private async findActiveWorkingFile(): Promise<string | null> {
    const queueDir = path.join(this.workspaceRoot, ".flightpath", ".queue");

    try {
      const files = await fs.readdir(queueDir);
      const queueFiles = files.filter((f) => f.endsWith(".queue.json"));

      if (queueFiles.length === 0) return null;

      // Get most recently modified file
      const fileStats = await Promise.all(
        queueFiles.map(async (f) => ({
          path: path.join(queueDir, f),
          mtime: (await fs.stat(path.join(queueDir, f))).mtime,
        }))
      );

      fileStats.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
      return fileStats[0].path;
    } catch (error) {
      return null;
    }
  }

  private generateId(): string {
    return Math.random().toString(36).substr(2, 9);
  }

  async start() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("FlightPath MCP Server started"); // stderr for logging
  }
}

// Start server
const server = new FlightPathMCPServer();
server.start().catch((error) => {
  console.error("Failed to start MCP server:", error);
  process.exit(1);
});
```

### Package Configuration

**Update `package.json`**:

```json
{
  "bin": {
    "flightpath-mcp": "./out/mcp-server.js"
  },
  "scripts": {
    "compile:mcp": "tsc src/mcp-server.ts --outDir out"
  }
}
```

---

## Automated Setup

### Challenge: Users Must Manually Configure MCP

**Problem**: Users need to run `/mcp add` in CLI or edit config files manually.

**Solution**: FlightPath extension can automate this!

### Auto-Configuration Strategy

#### 1. Detect Active CLI

```typescript
// In FlightPath extension
async function detectActiveCLI(): Promise<
  "copilot" | "claude" | "codex" | null
> {
  // Check if copilot CLI is installed
  const copilotInstalled = await checkCommandExists("copilot");

  // Check if claude CLI is installed
  const claudeInstalled = await checkCommandExists("claude");

  // Check if codex CLI is installed
  const codexInstalled = await checkCommandExists("codex");

  // Return which CLI is most recently used (check config timestamps)
  if (copilotInstalled) return "copilot";
  if (claudeInstalled) return "claude";
  if (codexInstalled) return "codex";
  return null;
}
```

#### 2. Auto-Configuration Options

**Option A: Session-Specific Config (RECOMMENDED for Copilot CLI)**

Leverage `--additional-mcp-config` flag for zero-configuration experience:

```typescript
async function generateCopilotMCPConfigFile(): Promise<string> {
  const mcpServerPath = this.context.asAbsolutePath("out/mcp-server.js");
  const configPath = path.join(
    this.context.globalStorageUri.fsPath,
    "copilot-mcp-config.json"
  );

  const config = {
    mcpServers: {
      flightpath: {
        command: "node",
        args: [mcpServerPath],
        env: {
          FLIGHTPATH_WORKSPACE:
            vscode.workspace.workspaceFolders?.[0].uri.fsPath,
        },
      },
    },
  };

  await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

// When launching Copilot CLI integration
async function launchCopilotWithMCP() {
  const configPath = await generateCopilotMCPConfigFile();

  // User can now run:
  // copilot --additional-mcp-config @<configPath>

  vscode.window.showInformationMessage(
    `FlightPath MCP ready! Use: copilot --additional-mcp-config @${configPath}`,
    "Copy Command"
  );
}
```

**Benefits of Session-Specific Config**:

- ✅ No modification of user's global config
- ✅ Workspace-specific configuration
- ✅ Automatic cleanup (temp file)
- ✅ No CLI restart required

**Option A2: Session-Specific Config for Codex CLI (RECOMMENDED)**

Leverage inline TOML configuration for zero-configuration experience:

```typescript
async function generateCodexMCPConfigString(): Promise<string> {
  const mcpServerPath = this.context.asAbsolutePath("out/mcp-server.js");
  const workspace = vscode.workspace.workspaceFolders?.[0].uri.fsPath || ".";

  // Generate inline TOML configuration string
  const configStr = `mcp_servers.flightpath={command="node",args=["${mcpServerPath.replace(/\\/g, "\\\\")}"],env={FLIGHTPATH_WORKSPACE="${workspace.replace(/\\/g, "\\\\")}"}}'`;

  return configStr;
}

// When launching Codex CLI integration
async function launchCodexWithMCP() {
  const configStr = await generateCodexMCPConfigString();
  const fullCommand = `codex -c '${configStr}'`;

  vscode.window
    .showInformationMessage(
      `FlightPath MCP ready! Use: ${fullCommand}`,
      "Copy Command"
    )
    .then((selection) => {
      if (selection === "Copy Command") {
        vscode.env.clipboard.writeText(fullCommand);
      }
    });
}
```

**Benefits of Inline TOML Config**:

- ✅ No config file generation needed
- ✅ No modification of user's global config
- ✅ Workspace-specific configuration via env var
- ✅ Zero file system operations
- ✅ Self-contained command string

**Option B: Persistent Global Config**

```typescript
async function updateCopilotMCPConfig(serverPath: string) {
  const configPath = path.join(os.homedir(), ".copilot", "mcp-config.json");
  let config: any = {};

  try {
    config = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    // File doesn't exist, start fresh
  }

  if (!config.mcpServers) config.mcpServers = {};

  // Add FlightPath MCP server
  config.mcpServers["flightpath"] = {
    command: "node",
    args: [serverPath],
    env: {
      FLIGHTPATH_WORKSPACE: "${workspaceFolder}",
    },
  };

  await fs.writeFile(configPath, JSON.stringify(config, null, 2));

  vscode.window.showInformationMessage(
    "FlightPath MCP server configured for Copilot CLI! Restart your CLI session to activate."
  );
}
```

#### 3. Notification & Guidance

```typescript
// On first Dynamic Queue enable or workflow start
if (!mcpConfigured && (usingCopilotCLI || usingClaudeCLI || usingCodexCLI)) {
  // FlightPath uses ONLY session-specific config (no manual setup required)
  let command: string;

  if (usingCodexCLI) {
    // Codex uses inline TOML configuration
    const configStr = await generateCodexMCPConfigString();
    command = `codex -c '${configStr}'`;
  } else if (usingCopilotCLI) {
    // Copilot uses config file reference
    const configPath = await generateCopilotMCPConfigFile();
    command = `copilot --additional-mcp-config @${configPath}`;
  } else {
    // Claude uses config file
    const configPath = await generateClaudeMCPConfigFile();
    command = `claude --mcp-config ${configPath}`;
  }

  await vscode.env.clipboard.writeText(command);

  const cliName = usingCodexCLI
    ? "Codex"
    : usingCopilotCLI
      ? "Copilot"
      : "Claude";
  const action = await vscode.window.showInformationMessage(
    `FlightPath MCP ready for ${cliName}! Command copied to clipboard.`,
    "Show Command",
    "Open Terminal"
  );

  if (action === "Show Command") {
    // Show command in info message or quick pick
    vscode.window.showInformationMessage(command);
  } else if (action === "Open Terminal") {
    // Open integrated terminal and paste command
    const terminal = vscode.window.createTerminal(
      `FlightPath MCP (${cliName})`
    );
    terminal.show();
    terminal.sendText(command, false); // false = don't execute, let user review
  }
}
```

---

## Security Considerations

### MCP Server Security

1. **Workspace Scoping**
   - Server only accesses `.flightpath/.queue/` directory
   - No ability to read/write arbitrary files
   - Validate all file paths before operations

2. **Input Validation**
   - Validate prompt structure (no code injection)
   - Enforce queue size limits (maxQueueSize setting)
   - Reject malicious file paths (path traversal)

3. **Process Isolation**
   - MCP server runs as separate process
   - Killed when CLI session ends
   - No persistent state or background services

4. **User Approval** (handled by CLI)
   - Copilot/Claude ask permission before tool use
   - User can deny or approve per-session
   - FlightPath should document what tools do

### Trust Model

**Copilot CLI**: Prompts user to trust directory on first launch
**Claude CLI**: Project-scoped servers require approval
**VS Code Chat**: Extension-registered tools are trusted by default

---

## Implementation Phases

### Phase 1: MCP Server Core (Week 1) ✅ HIGH PRIORITY

**Goal**: Working MCP server for CLI usage

**Tasks**:

1. Install MCP SDK: `npm install @modelcontextprotocol/sdk`
2. Create `src/mcp-server.ts` with stdio transport
3. Implement three tools:
   - `flightpath_append_queue`
   - `flightpath_get_queue_status`
   - `flightpath_list_queue`
4. Add file operations (read/write working queue file)
5. Compile to `out/mcp-server.js`
6. Test manually: `node out/mcp-server.js`

**Testing**:

- Manual invocation with test JSON-RPC messages
- Verify tool discovery (list tools request)
- Test queue append with sample working file

---

### Phase 2: VS Code Language Model Tools (Week 1) ✅ HIGH PRIORITY

**Goal**: Direct tool integration for VS Code Chat

**Tasks**:

1. Register tools with `vscode.lm.registerTool()`
2. Reuse FlightPathManager queue logic
3. Handle tool invocations directly (no MCP server needed)
4. Update dashboard when tools are invoked

**Testing**:

- Test in VS Code Chat with Copilot
- Verify tool shows in Chat tool list
- Confirm queue extends correctly

---

### Phase 3: Auto-Configuration (Week 2) ⭐ NICE-TO-HAVE

**Goal**: Automated MCP setup for CLI users

**Tasks**:

1. Detect installed CLIs (copilot/claude/codex)
2. Generate session-specific config (Copilot: file, Codex: inline TOML, Claude: file)
3. Show setup prompts on first Dynamic Queue use
4. Provide manual setup documentation

**Testing**:

- Test on fresh install (no prior config)
- Test with Copilot CLI (config file method)
- Test with Codex CLI (inline TOML method)
- Test with Claude CLI (config file method)
- Verify all CLIs detect server after config

---

### Phase 4: Documentation & Polish (Week 2)

**Goal**: User-facing documentation and error handling

**Tasks**:

1. Write user guide: "Setting up FlightPath MCP"
2. Add troubleshooting section
3. Improve error messages (when server not configured)
4. Add logging for debugging

---

## Example: End-to-End Flow

### Scenario: User Runs FlightPath Workflow with Copilot CLI

**1. Initial Setup** (one-time):

```bash
# FlightPath extension auto-configures on first use:
# Writes to ~/.copilot/mcp-config.json
{
  "servers": {
    "flightpath-queue": {
      "command": "node",
      "args": ["~/.vscode/extensions/.../out/mcp-server.js"]
    }
  }
}
```

**2. Start FlightPath Workflow**:

```bash
# User starts workflow in VS Code
FlightPath: Run bugfix-authentication.flightpath.json

# FlightPath creates working file:
.flightpath/.queue/bugfix-123.queue.json
```

**3. User Starts Copilot CLI**:

```bash
cd ~/project
copilot

# Copilot CLI:
# - Reads ~/.copilot/mcp-config.json
# - Spawns: node out/mcp-server.js (stdio)
# - Handshake: Server announces flightpath_queue_append tool
# - Tool is now available
```

**4. User Gives Prompt with Dynamic Queue Enabled**:

```
> Analyze the authentication module and suggest improvements

Copilot (thinking):
- Analyzing code...
- Found issues: X, Y, Z
- Should extend workflow with testing tasks
- Invoking tool: flightpath_queue_append({
    prompts: [{prompt: "Write unit tests for auth module"}],
    position: "next"
  })

MCP Server:
- Reads .flightpath/.queue/bugfix-123.queue.json
- Inserts prompt at position 3
- Writes atomically
- Returns: {success: true, promptsAdded: 1}

Copilot: "I've added follow-up testing tasks to your FlightPath queue."
```

**5. FlightPath Detects Change**:

```typescript
// FileSystemWatcher in FlightPathManager detects change
// Reloads queue from working file
// Dashboard updates: "Queue extended (+1 prompt)"
// Continues execution
```

**6. Workflow Continues**:

- FlightPath executes original prompts
- Reaches AI-added prompt: "Write unit tests"
- Executes via Copilot CLI
- Completes workflow

---

## Conclusion

**Key Takeaways**:

1. ✅ **No persistent service**: MCP servers are spawned on-demand by CLI clients
2. ✅ **Simple stdio transport**: Just a Node.js script, no network, no ports
3. ✅ **VS Code is different**: Use Language Model Tools API for Chat (better integration)
4. ✅ **Session-specific config**: Copilot CLI's `--additional-mcp-config` enables zero-config experience
5. ✅ **Auto-configuration is possible**: Extension can write MCP config files
6. ✅ **Universal solution**: Same server works for Copilot CLI and Claude CLI
7. ⚠️ **Copilot CLI ≠ Copilot Coding Agent**: Different systems with different configuration approaches

**Implementation Recommendation**:

- **Week 1**: Implement MCP server + VS Code Language Model Tools
- **Week 2**: Add auto-configuration and docs
- **Week 3**: Polish and test across all platforms

The MCP approach provides **predictable, standardized tool invocation** with **automatic error handling** and **type safety**, making it superior to custom scripts for AI-driven queue extension.

---

## References

- [VS Code MCP Developer Guide](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [MCP SDK Documentation](https://github.com/modelcontextprotocol/sdk)
- [Copilot CLI MCP Setup](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli#add-an-mcp-server)
- [Claude CLI MCP Setup](https://code.claude.com/docs/en/mcp)
- [QUEUE_APPEND_FEATURE.md](QUEUE_APPEND_FEATURE.md)
- [QUEUE_EXTENSION_OPTIONS_ANALYSIS.md](QUEUE_EXTENSION_OPTIONS_ANALYSIS.md)
