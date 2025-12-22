# FlightPath Custom Templates

This document describes FlightPath's template system for end condition scripts, custom agents, and workflow templates.

## Workspace Folder Structure

FlightPath organizes user files in a structured `.flightpath/` directory:

```
.flightpath/
├── scripts/       # Validation scripts (end conditions)
├── prompts/       # Draft prompts (*.prompt.md)
├── templates/     # Workflow templates with {placeholder} variables
└── workflows/     # Ready-to-run workflows (*.flightpath.json, *.flightpath.yaml)
```

## Overview

FlightPath provides three types of templates:

| Template Type             | Purpose                          | Destination              | Command                               |
| ------------------------- | -------------------------------- | ------------------------ | ------------------------------------- |
| **End Condition Scripts** | Validation scripts for workflows | `.flightpath/scripts/`   | `flightpath.createEndConditionScript` |
| **Custom Agents**         | AI agents for CLI integration    | `.github/agents/`        | `flightpath.importAgents`             |
| **Workflow Templates**    | Pre-built prompt workflows       | `.flightpath/templates/` | `flightpath.importWorkflowTemplates`  |

---

## End Condition Scripts

Pre-built validation script templates in multiple languages.

### Available Templates

| Language   | File                  | Use Case               |
| ---------- | --------------------- | ---------------------- |
| JavaScript | `check_condition.js`  | Node.js projects       |
| Python     | `check_condition.py`  | Python projects        |
| Bash       | `check_condition.sh`  | Unix/Linux systems     |
| PowerShell | `check_condition.ps1` | Windows/cross-platform |
| Batch      | `check_condition.bat` | Windows legacy         |

### Usage

1. Run command: `FlightPath: Create End Condition Script`
2. Select script type from QuickPick
3. Script copied to `.flightpath/scripts/` and opened for editing
4. Reference in workflow: `"script": "scripts/check_condition.js"`

### File Structure

```
src/templates/
├── agents/
│   ├── manifest.json
│   └── flightpath-orchestrator.agent.md
├── workflows/
│   ├── manifest.json
│   ├── simple-feature.flightpath.json
│   ├── fix-tests.flightpath.json
│   └── full-feature.flightpath.json
├── check_condition.js
├── check_condition.py
├── check_condition.sh
├── check_condition.ps1
└── check_condition.bat
```

### Script Requirements

- Output expected value to stdout (`"true"`, `"false"`, etc.)
- Exit code 0 = success, non-zero = error
- No network access or file modifications recommended
- Include shebang for Unix scripts

---

## Custom Agents

FlightPath ships pre-built agents that work with Copilot CLI, Claude CLI, and VS Code Copilot Chat.

### Agent Location Requirements

| CLI/Tool         | Agent Location                    | Notes                                 |
| ---------------- | --------------------------------- | ------------------------------------- |
| **Copilot CLI**  | `.github/agents/`                 | Required location                     |
| **Claude CLI**   | Any path (via `--agent` flag)     | Most flexible                         |
| **VS Code Chat** | `.github/agents/` or user profile | Profile agents work but no automation |

**Recommendation**: Import agents to `.github/agents/` for maximum compatibility.

### Available Agents

#### FlightPath Orchestrator

Creates structured FlightPath workflow files from feature requests.

**Purpose**: Takes a feature request and generates a complete `.flightpath.json` workflow with:

1. **PLAN Phase** - Analyze codebase, design approach
2. **IMPLEMENT Phase** - Execute implementation tasks
3. **REVIEW Phase** - Validate with tests/linters
4. **DOCS Phase** - Update documentation
5. **COMMIT Phase** - Generate commit message

**Usage**: The agent creates the workflow file, then you run it with FlightPath.

### Planned Agents

| Agent                 | Purpose                                                 |
| --------------------- | ------------------------------------------------------- |
| `flightpath-planner`  | Analyzes requirements and creates implementation plans  |
| `flightpath-dev`      | Main implementation agent - writes code following plans |
| `flightpath-reviewer` | Code review, testing, and quality validation            |
| `flightpath-writer`   | Updates documentation and generates commit messages     |

### Importing Agents

1. Run command: `FlightPath: Import FlightPath Agents`
2. Select agents from QuickPick (multi-select supported)
3. Agents copied to `.github/agents/`
4. Existing files prompt for overwrite confirmation

### Agent File Format

Agents use the standard `.agent.md` format with YAML frontmatter:

```markdown
---
name: agent-name
description: Brief description shown in agent picker
---

# Agent Instructions

Agent behavior and guidelines using XML structure...

<purpose>
What this agent does
</purpose>

<guidelines>
How the agent should operate
</guidelines>
```

**Note**: Model and tool selection is controlled by the user or FlightPath workflow settings, not in the agent file itself.

### Agent Manifest

The `manifest.json` lists available agents:

```json
{
  "version": "1.0",
  "description": "FlightPath custom agents",
  "agents": [
    {
      "id": "flightpath-orchestrator",
      "label": "FlightPath Orchestrator",
      "description": "Creates workflow files from feature requests",
      "file": "flightpath-orchestrator.agent.md",
      "tags": ["workflow", "planning", "automation"],
      "icon": "$(rocket)"
    }
  ]
}
```

### Source Location

Agent templates are stored in:

- **Source**: `src/templates/agents/`
- **Build output**: `out/templates/agents/`
- **Runtime access**: `context.extensionPath + "/out/templates/agents/"`

---

## Build System

Templates are copied during build via esbuild plugins:

```javascript
// copyTemplatesPlugin - copies scripts
// copyAgentTemplatesPlugin - copies agents
// copyWorkflowTemplatesPlugin - copies workflows (future)
```

Source files in `src/templates/` → Output in `out/templates/`

---

## Related Documentation

- [Workflow Templates](./WORKFLOW_TEMPLATES_DESIGN.md) - Pre-built workflow patterns
- [End Conditions](./END_CONDITIONS.md) - Validation script documentation
- [XML Prompting Guidelines](./XML_PROMPTING_GUIDELINES.md) - XML structure for agents
