# Queue Extension Options Analysis: MCP, Skills, and Custom Scripts

**Date**: December 17, 2025  
**Status**: Research & Decision Document  
**Related**: [QUEUE_APPEND_FEATURE.md](QUEUE_APPEND_FEATURE.md)

## Executive Summary

This document investigates **how AI agents can extend FlightPath's workflow queue** during Dynamic Queue execution, comparing three approaches:

1. **MCPs (Model Context Protocol)** - Standardized tool servers
2. **Claude Skills** - Markdown instructions + helper scripts
3. **Custom Scripts** - FlightPath-specific queue management scripts

**Key Finding**: MCPs and Skills have limited CLI support, but **custom scripts invoked via shell commands** offer the most practical solution for both Copilot CLI and Claude CLI.

---

## Research Findings

### 1. MCP Support in CLIs

#### Copilot CLI

**Official MCP Support**: ✅ **FULLY SUPPORTED**

Copilot CLI has native MCP integration via slash commands:

```bash
# In interactive session
/mcp add    # Opens form to add MCP server
```

**Configuration**:

- MCP servers stored in `~/.copilot/mcp-config.json`
- Location customizable via `XDG_CONFIG_HOME` environment variable
- GitHub MCP server pre-configured by default
- Same JSON structure as Copilot Coding Agent

**Features**:

- **Add MCP servers** interactively during session
- **Tool invocation** - Copilot can call MCP tools autonomously
- **GitHub MCP** - Pre-installed for repo operations
- **Custom MCP servers** - Add any stdio/remote MCP server

**Source**: [Using GitHub Copilot CLI - Add an MCP Server](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/use-copilot-cli#add-an-mcp-server)

**Implications**:

- ✅ Copilot CLI **CAN invoke MCP tools** via configured servers
- ✅ **Same capability as Claude CLI** for MCP integration
- ✅ FlightPath could implement MCP server for queue management

---

#### Claude CLI

**Official MCP Support**: ✅ **FULLY SUPPORTED**

Claude CLI has comprehensive MCP integration:

```bash
# Add MCP server
claude mcp add-json server-name '{"type":"stdio","command":"npx","args":["..."]}'

# Add server from file
claude mcp add shared-server --scope project /path/to/server

# List configured servers
claude mcp list

# Connect to servers in session
> /mcp connect
```

**Features**:

- **Local MCP servers** (stdio-based processes)
- **Remote MCP servers** (HTTP/WebSocket)
- **Project-scoped** (`.mcp.json` files) and **user-scoped** servers
- **Tool discovery** - AI automatically sees available tools
- **Approval prompts** - Security for project-scoped servers

**Source**: [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp)

**Implications**:

- Claude CLI could theoretically invoke FlightPath MCP tools
- Would require FlightPath to implement an MCP server
- MCP server would run as separate process (stdio or HTTP)

---

### 2. Claude Skills

**What are Skills?**

Skills are **filesystem-based instruction packages** for Claude:

```
.claude/
└── skills/
    └── flightpath-queue/
        ├── SKILL.md           # Instructions (Markdown)
        ├── queue_append.py    # Helper script (optional)
        └── examples/          # Reference materials (optional)
```

**How Skills Work**:

1. **Discovery**: Claude scans `.claude/skills/` directory
2. **Trigger**: Skill description determines when Claude loads it
3. **Load**: Claude reads `SKILL.md` into context window using bash
4. **Execute**: Claude follows instructions, optionally runs helper scripts

**Example SKILL.md**:

````markdown
# FlightPath Queue Management

**Description**: Use this skill when you need to extend the current FlightPath workflow by adding new prompts to the queue.

**When to use**:

- User asks for follow-up tasks
- You identify additional work needed
- Current workflow should continue with new steps

**How to use**:

1. Run the queue append script: `python .claude/skills/flightpath-queue/queue_append.py`
2. Pass prompt details as JSON via stdin
3. Script updates the working queue file atomically

**Script interface**:

```bash
echo '{"position":"next","prompts":[{"prompt":"Write tests"}]}' | python queue_append.py
```
````

**Always validate** that prompts were added by checking script output.

````

**Key Characteristics**:
- ✅ **CLI native** - Works in Claude CLI out of the box
- ✅ **No external server** - Just files in filesystem
- ✅ **Shell access** - Can run any script (Python, Node, bash)
- ✅ **Contextual** - Instructions live with project
- ⚠️ **Claude-only** - Not supported by Copilot

**Source**: [Claude Skills Documentation](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)

---

### 3. Custom Script Approach

**Concept**: FlightPath provides queue management scripts that AI agents invoke via shell commands.

#### Implementation Design

**1. FlightPath Queue Management Scripts**

```bash
# Install scripts to workspace
.flightpath/
└── scripts/
    ├── queue-append.js      # Node.js script (cross-platform)
    ├── queue-append.py      # Python alternative
    └── queue-append.sh      # Bash wrapper
````

**2. Script Interface (JSON stdin/stdout)**

```bash
# Input: JSON via stdin
echo '{
  "action": "append",
  "position": "next",
  "prompts": [
    {"prompt": "Write unit tests for authentication module"}
  ]
}' | node .flightpath/scripts/queue-append.js

# Output: JSON result
{
  "success": true,
  "promptsAdded": 1,
  "newQueueSize": 6,
  "workingFile": ".flightpath/.queue/bugfix-1734480000.queue.json"
}
```

**3. Script Implementation (Node.js)**

```javascript
#!/usr/bin/env node
// .flightpath/scripts/queue-append.js

const fs = require("fs");
const path = require("path");

async function main() {
  try {
    // Read JSON from stdin
    const input = await readStdin();
    const request = JSON.parse(input);

    // Validate request
    if (!request.action || !request.prompts) {
      throw new Error("Invalid request: missing action or prompts");
    }

    // Find active working file
    const workingFile = findActiveWorkingFile();
    if (!workingFile) {
      throw new Error("No active FlightPath workflow found");
    }

    // Read current queue state (atomic read)
    const queueState = JSON.parse(fs.readFileSync(workingFile, "utf8"));

    // Append prompts
    const insertIndex =
      request.position === "next"
        ? queueState.currentIndex + 1
        : queueState.prompts.length;

    queueState.prompts.splice(insertIndex, 0, ...request.prompts);

    // Track append segment
    queueState.appendSegments.push({
      segmentId: generateId(),
      startIndex: insertIndex,
      count: request.prompts.length,
      source: "AI Agent",
      timestamp: new Date().toISOString(),
      sourceType: "script-append",
    });

    // Write back atomically (write to temp, then rename)
    const tempFile = workingFile + ".tmp";
    fs.writeFileSync(tempFile, JSON.stringify(queueState, null, 2));
    fs.renameSync(tempFile, workingFile);

    // Return success
    console.log(
      JSON.stringify({
        success: true,
        promptsAdded: request.prompts.length,
        newQueueSize: queueState.prompts.length,
        workingFile: workingFile,
      })
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        success: false,
        error: error.message,
      })
    );
    process.exit(1);
  }
}

function findActiveWorkingFile() {
  const queueDir = path.join(process.cwd(), ".flightpath", ".queue");
  if (!fs.existsSync(queueDir)) return null;

  const files = fs
    .readdirSync(queueDir)
    .filter((f) => f.endsWith(".queue.json"))
    .map((f) => ({
      path: path.join(queueDir, f),
      mtime: fs.statSync(path.join(queueDir, f)).mtime,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return files.length > 0 ? files[0].path : null;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

main();
```

**4. How AI Agents Use Scripts**

**In Copilot CLI**:

```bash
copilot --model claude-sonnet-4.5

> "Analyze the authentication module and suggest improvements"

# Copilot (internal monologue):
# User wants improvements. I'll analyze first, then extend the queue with testing tasks.

# Uses built-in shell tool:
shell(command: "echo '{\"action\":\"append\",\"position\":\"next\",\"prompts\":[{\"prompt\":\"Write unit tests\"}]}' | node .flightpath/scripts/queue-append.js")

# Response from script:
# {"success":true,"promptsAdded":1,"newQueueSize":6}

"I've analyzed the authentication module and queued follow-up tasks for testing."
```

**In Claude CLI**:

```bash
claude --model sonnet

> "Analyze the authentication module and suggest improvements"

# Claude can use bash tool:
bash(command: "echo '{...}' | node .flightpath/scripts/queue-append.js")

# Or with Skills:
# Skill triggers automatically when context suggests extending workflow
# Reads SKILL.md instructions, runs helper script
```

---

## Comparison Matrix

| Feature                  | MCP (Copilot CLI) | MCP (Claude CLI)  | Claude Skills     | Custom Scripts              |
| ------------------------ | ----------------- | ----------------- | ----------------- | --------------------------- |
| **Copilot CLI Support**  | ✅ Via /mcp add   | ❌ N/A            | ❌ N/A            | ✅ Via shell tool           |
| **Claude CLI Support**   | ❌ N/A            | ✅ Full support   | ✅ Native         | ✅ Via bash tool            |
| **VS Code Chat Support** | ✅ Via settings   | ✅ Via settings   | ❌ CLI-only       | ✅ Via Language Model Tools |
| **Setup Complexity**     | High (MCP server) | Medium (add-json) | Low (file drop)   | Low (install scripts)       |
| **Error Handling**       | Standardized      | Standardized      | Manual            | Manual                      |
| **Atomic Operations**    | Yes (if designed) | Yes (if designed) | Depends on script | Yes (if designed)           |
| **Cross-Platform**       | Yes               | Yes               | Yes               | Yes (Node.js/Python)        |
| **Debugging**            | MCP logs          | MCP logs          | Script output     | Script output               |
| **Predictability**       | High              | High              | Medium            | High                        |
| **Tool Discovery**       | Automatic         | Automatic         | Description-based | Prompt-based                |

---

## Detailed Analysis

### Option 1: MCP Server (Claude CLI Only)

**Architecture**:

```
FlightPath Extension
       ↓
   (spawns)
       ↓
   Claude CLI ────────→ MCP Server (stdio)
                           ↓
                    Queue Management
                           ↓
                    Working File (.queue.json)
```

**Implementation**:

1. **Create MCP Server**: Implement Node.js MCP server using `@modelcontextprotocol/sdk`
2. **Register Tools**:
   - `flightpath_queue_append(prompts, position)`
   - `flightpath_queue_status()`
   - `flightpath_queue_clear()`
3. **Configure in Claude CLI**:
   ```bash
   claude mcp add-json flightpath '{
     "type": "stdio",
     "command": "node",
     "args": [".flightpath/mcp-server/index.js"]
   }'
   ```
4. **Dynamic Queue Instructions** (in prompt):

   ```xml
   <criticalInstruction>
   You have access to FlightPath queue management via MCP tools:
   - flightpath_queue_append: Add prompts to queue
   - flightpath_queue_status: Check current queue state

   Use these tools to extend the workflow as needed.
   </criticalInstruction>
   ```

**Pros**:

- ✅ **Standardized protocol** - Well-defined tool interface
- ✅ **Automatic discovery** - Claude sees available tools
- ✅ **Type safety** - JSON Schema validation
- ✅ **Error handling** - MCP error responses
- ✅ **Extensible** - Can add more tools easily

**Cons**:

- ⚠️ **Additional process** - MCP server adds complexity
- ⚠️ **Setup required** - Users must configure MCP (`/mcp add` in CLI sessions)
- ⚠️ **VS Code Chat different** - Uses Language Model Tools API, not mcp-config.json
- ⚠️ **User configuration** - Each user must add FlightPath MCP server to their config

**Verdict**: ✅ **VIABLE for both CLIs** - MCP is now a strong contender

---

### Option 2: Claude Skills (Claude CLI Only)

**Architecture**:

```
FlightPath Extension
       ↓
   (spawns)
       ↓
   Claude CLI
       ↓
   (reads SKILL.md on trigger)
       ↓
   Executes helper script
       ↓
   Updates working file
```

**Implementation**:

1. **Create Skill Directory**:

   ```bash
   .claude/skills/flightpath-queue/
   ├── SKILL.md
   └── queue_helper.py
   ```

2. **Write SKILL.md** (see example in "Claude Skills" section above)

3. **Helper Script** (`queue_helper.py`):

   ```python
   #!/usr/bin/env python3
   import sys, json, os

   def append_prompts(position, prompts):
       # Find working file
       # Read, modify, write atomically
       pass

   if __name__ == '__main__':
       request = json.load(sys.stdin)
       result = append_prompts(request['position'], request['prompts'])
       print(json.dumps(result))
   ```

4. **Dynamic Queue Instructions** (in prompt):

   ```xml
   <criticalInstruction>
   You can extend this workflow using the FlightPath Queue Management skill.

   When you need to add follow-up prompts:
   1. Activate the skill (it's in .claude/skills/flightpath-queue/)
   2. Follow the instructions in SKILL.md
   3. The skill will handle queue updates safely
   </criticalInstruction>
   ```

**Pros**:

- ✅ **No external server** - Filesystem-based
- ✅ **Simple setup** - Drop files in directory
- ✅ **Contextual** - Skills live with project
- ✅ **Flexible** - Can include complex logic
- ✅ **Native Claude feature** - Well-integrated

**Cons**:

- ❌ **Claude CLI only** - Not supported by Copilot
- ❌ **No automatic discovery** - Relies on description matching
- ❌ **Less predictable** - Skill triggering is heuristic
- ❌ **Manual error handling** - No standardized error protocol

**Verdict**: ⚠️ **Good for Claude CLI, but not universal**

---

### Option 3: Custom Scripts (Universal)

**Architecture**:

```
FlightPath Extension
       ↓
   (spawns)
       ↓
   Copilot/Claude CLI
       ↓
   (shell/bash tool)
       ↓
   Queue Management Script
       ↓
   Working File (.queue.json)
```

**Implementation**:

See "Custom Script Approach" section above for full implementation.

**Key Points**:

- Scripts installed to `.flightpath/scripts/` on workflow start
- AI agents invoke via `shell` (Copilot) or `bash` (Claude) tools
- JSON stdin/stdout for structured communication
- Atomic file operations (write to temp, rename)
- Cross-platform (Node.js is already a FlightPath dependency)

**Pros**:

- ✅ **Universal** - Works with both Copilot CLI and Claude CLI
- ✅ **Predictable** - Explicit script invocation
- ✅ **Simple** - No external servers or protocols
- ✅ **Atomic** - File operations are safe
- ✅ **Debuggable** - Script output visible in CLI
- ✅ **Extensible** - Easy to add new operations
- ✅ **VS Code Chat compatible** - Can use Language Model Tools to wrap scripts

**Cons**:

- ⚠️ **Not standardized** - Custom FlightPath protocol
- ⚠️ **Manual discovery** - AI must be told about scripts in prompt
- ⚠️ **Shell dependency** - Requires shell tool access

**Verdict**: ✅ **RECOMMENDED - Best balance of simplicity and universality**

---

## Hybrid Approach: Scripts + Skills + MCP

**Recommendation**: Implement **Custom Scripts as the foundation**, with optional Skills and MCP wrappers.

### Implementation Strategy

**1. Core: Custom Queue Management Scripts** (always present)

- Install to `.flightpath/scripts/` on workflow start
- JSON interface (stdin/stdout)
- Node.js implementation (cross-platform)
- Works with both CLIs via shell commands

**2. Claude Skill Wrapper** (optional, auto-installed for Claude CLI)

```
.claude/skills/flightpath-queue/
├── SKILL.md          # Instructions + triggers
└── queue_helper.js   # Thin wrapper around core script
```

**SKILL.md** references core scripts:

````markdown
# FlightPath Queue Management

Use this skill to extend the current FlightPath workflow.

**How to use**:

```bash
node .flightpath/scripts/queue-append.js <<EOF
{"action":"append","position":"next","prompts":[...]}
EOF
```
````

See `.flightpath/scripts/README.md` for full API.

````

**3. MCP Server Wrapper** (optional, future enhancement)

- Thin MCP server that wraps core scripts
- Provides standardized tool interface
- Only for advanced users who want MCP benefits

---

## Communication with VS Code Extension

**Challenge**: How does FlightPath extension detect when AI modifies the queue?

### Solution: File Watcher + FileSystemWatcher

**Implementation**:

```typescript
// In FlightPathManager or QueueWorkingFileManager
private setupFileWatcher(): void {
  if (!this.workingFilePath) return;

  // Watch working queue file for changes
  this.fileWatcher = vscode.workspace.createFileSystemWatcher(
    this.workingFilePath
  );

  this.fileWatcher.onDidChange(async (uri) => {
    console.log('Working file changed by external process');

    // Reload queue from file
    await this.reloadQueueFromWorkingFile();

    // Update dashboard
    this.dashboard.sendMessage({
      type: MESSAGE_TYPES.QUEUE_EXTENDED,
      payload: {
        newPromptCount: this.queue.getState().prompts.length,
        source: 'AI Agent'
      }
    });
  });
}
````

**How it works**:

1. FlightPath creates working file: `.flightpath/.queue/bugfix-123.queue.json`
2. FlightPath watches file with `FileSystemWatcher`
3. AI agent (Copilot/Claude) runs script: `node queue-append.js`
4. Script atomically updates working file
5. FileSystemWatcher fires `onDidChange` event
6. FlightPath reloads queue and updates UI

**Benefits**:

- ✅ **No polling** - Event-driven
- ✅ **Cross-process** - Works regardless of how file is modified
- ✅ **Reliable** - VS Code's FileSystemWatcher is robust
- ✅ **Universal** - Works with any approach (scripts, Skills, MCP)

---

## Recommended Implementation Plan (REVISED)

### Phase 1: MCP Server Implementation (Week 1-2) ✅ PRIORITY

**Goal**: Standardized queue management via MCP for both CLIs

**Tasks**:

1. Implement MCP server using `@modelcontextprotocol/sdk`
2. Expose tools:
   - `flightpath_queue_append(prompts, position)` - Add prompts to queue
   - `flightpath_queue_status()` - Get current queue state
   - `flightpath_queue_list()` - List all prompts in queue
3. Atomic file operations for working queue file
4. Add FileSystemWatcher in FlightPathManager
5. Create setup guide for users:
   - Copilot CLI: `/mcp add` instructions
   - Claude CLI: `claude mcp add-json` instructions
6. Auto-detect if MCP configured, show setup prompt if not

**Testing**:

- MCP server tool discovery in both CLIs
- Tool invocation and response handling
- File watcher confirms auto-reload
- Error handling and edge cases

---

### Phase 2: Custom Scripts Fallback (Week 2) ⭐ BACKUP

**Goal**: Ensure queue extension works even without MCP setup

**Tasks**:

1. Create `.flightpath/scripts/queue-append.js` (Node.js)
2. Implement same JSON stdin/stdout interface
3. Add to Dynamic Queue instructions as fallback method
4. Document when to use scripts vs MCP

**Testing**:

- Script invocation via shell/bash tools
- Verify file operations match MCP behavior
- Confirm works alongside MCP (if both available)

---

### Phase 3: Claude Skills Wrapper (Future) 🔮 OPTIONAL

**Goal**: Enhanced UX for Claude CLI users via Skills

**Tasks**:

1. Create `.claude/skills/flightpath-queue/` structure
2. Write SKILL.md that references MCP tools
3. Skill triggers MCP tools or falls back to scripts
4. Auto-install when Claude CLI detected

**Testing**:

- Skill discovery and triggering
- MCP tool preference over scripts

---

## Decision: Hybrid Approach (MCP + Scripts Fallback)

**Updated Recommendation**: Implement **MCP as primary mechanism** with **Custom Scripts as fallback**.

**Rationale for Change**:

1. ✅ **Both CLIs support MCP** - Copilot CLI has `/mcp add`, Claude CLI has `claude mcp add-json`
2. ✅ **Standardized protocol** - Well-defined tool interface with automatic discovery
3. ✅ **Better error handling** - MCP protocol includes structured error responses
4. ✅ **Automatic invocation** - AI automatically discovers and uses tools
5. ✅ **Extensible** - Easy to add more queue operations as MCP tools
6. ✅ **Fallback available** - Custom scripts work when MCP not configured

**Implementation Strategy**:

- **Primary**: FlightPath MCP server (stdio-based)
- **Fallback**: Custom scripts (for users who don't configure MCP)
- **Auto-detection**: FlightPath checks if MCP server is configured, guides setup if not

**AI will be instructed to use scripts like this**:

````xml
<criticalInstruction>
You can extend this FlightPath workflow by adding prompts to the queue.

QUEUE MANAGEMENT:
- Working file: {workingFilePath}
- Current position: {currentIndex}/{totalPrompts}
- Max queue size: {maxQueueSize}

TO APPEND PROMPTS:
Use the queue management script:

```bash
echo '{
  "action": "append",
  "position": "next",
  "prompts": [
    {"prompt": "Write unit tests for authentication module"}
  ]
}' | node .flightpath/scripts/queue-append.js
````

SCRIPT RESPONSE:

- success: true if prompts added
- promptsAdded: number of prompts queued
- newQueueSize: total queue size after append
- error: error message if failed

POSITION OPTIONS:

- "next": Insert after current prompt (recommended)
- "end": Append to end of queue

FlightPath will automatically detect the queue extension and continue execution.
</criticalInstruction>

```

---

## Appendix: VS Code Extension ↔ CLI Communication Patterns

### Pattern 1: File-Based (RECOMMENDED)

**How it works**:
- Extension writes state to file
- CLI reads/modifies file
- Extension watches file for changes

**Pros**: Simple, reliable, cross-process
**Cons**: File I/O overhead (minimal)

### Pattern 2: stdio/IPC

**How it works**:
- Extension spawns CLI with IPC channel
- CLI sends messages via `process.send()`
- Extension receives via `child.on('message')`

**Pros**: Real-time, structured messages
**Cons**: Requires CLI modifications, Node.js-specific

### Pattern 3: HTTP Server

**How it works**:
- Extension runs HTTP server on localhost
- CLI makes HTTP requests
- Extension responds with JSON

**Pros**: Language-agnostic, RESTful
**Cons**: Overkill for this use case, security concerns

**Verdict**: **Pattern 1 (File-Based)** is optimal for FlightPath's queue extension feature.

---

## Open Questions

1. **Queue Size Limits**: Should scripts enforce `maxQueueSize` or trust FlightPath's validation on reload?
   - **Recommendation**: Scripts validate, return error if limit exceeded

2. **Concurrent Modifications**: What if user manually edits working file while AI is appending?
   - **Recommendation**: Atomic writes (temp + rename) prevent corruption; last-write-wins

3. **Script Permissions**: Should scripts be restricted (e.g., only append, not clear)?
   - **Recommendation**: Start with append-only, add more operations later if needed

4. **Error Recovery**: What if script fails mid-execution?
   - **Recommendation**: Atomic operations ensure file is never in partial state

5. **VS Code Chat Integration**: Should we implement Language Model Tools API for Chat mode?
   - **Recommendation**: Yes, but as separate implementation (Phase 3)

---

## Conclusion

**Custom Scripts** provide the most practical and universal solution for AI-driven queue extension in FlightPath. By leveraging the built-in shell tools available in both Copilot CLI and Claude CLI, we can implement a reliable, predictable, and debuggable queue management system without the complexity of MCP servers or the platform limitations of Claude Skills.

The file-based communication pattern with FileSystemWatcher enables seamless integration between the FlightPath extension and CLI processes, supporting the unified working file architecture described in QUEUE_APPEND_FEATURE.md.

**Next Steps**:
1. Implement core queue management scripts
2. Add FileSystemWatcher for auto-reload
3. Update Dynamic Queue instructions to reference scripts
4. Test with both Copilot CLI and Claude CLI
5. Consider Claude Skills wrapper as UX enhancement

---

## References

- [GitHub Copilot MCP Documentation](https://docs.github.com/copilot/customizing-copilot/using-model-context-protocol)
- [Claude Code MCP Documentation](https://code.claude.com/docs/en/mcp)
- [Claude Skills Documentation](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [QUEUE_APPEND_FEATURE.md](QUEUE_APPEND_FEATURE.md) - Parent feature document
```
