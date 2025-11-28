# FlightPath Documentation Index

> **BMAD-Generated Documentation for AI-Assisted Development**
>
> Generated: 2025-11-28 | Scan Level: Exhaustive | Project Type: VS Code Extension

## Project Overview

- **Type:** Monolith (single cohesive codebase)
- **Primary Language:** TypeScript 5.x (strict mode)
- **Architecture:** Layered architecture with SOLID principles
- **Status:** Pre-release (v0.1.0)

## Quick Reference

| Attribute                | Value                                               |
| ------------------------ | --------------------------------------------------- |
| **Tech Stack**           | TypeScript, Node.js, VS Code Extension API, esbuild |
| **Entry Point**          | `src/extension.ts`                                  |
| **Main Orchestrator**    | `src/flightpath/FlightPathManager.ts`               |
| **Architecture Pattern** | Layered with Strategy + Factory patterns            |

## Generated Documentation

### Core Documentation

- [Project Overview](./project-overview.md) - Executive summary, technology stack, key features
- [Architecture](./architecture.md) - System design, component diagrams, data flow
- [Source Tree Analysis](./source-tree-analysis.md) - Directory structure, critical folders, entry points
- [Component Inventory](./component-inventory.md) - All components with responsibilities and methods
- [Development Guide](./development-guide.md) - Prerequisites, setup, commands, testing

### API & Integration

- [Copilot CLI Design](../COPILOT_CLI_DESIGN.md) - Copilot CLI flags, implementation status
- [Claude CLI Design](../CLAUDE_CLI_DESIGN.md) - Claude Code CLI integration reference
- [Dynamic Queue Usage](../DYNAMIC_QUEUE_USAGE.md) - Autonomous workflow extension
- [End Conditions](../END_CONDITIONS.md) - Script-based validation system

### Guides & Best Practices

- [XML Prompting Guidelines](../XML_PROMPTING_GUIDELINES.md) - XML prompting patterns
- [Chat Mode Limitations](../CHAT_MODE_LIMITATIONS.md) - Known limitations

### Testing

- [Testing Strategy](../TESTING.md) - Test approach and structure
- [Manual Testing](../MANUAL_TESTING.md) - Manual test procedures
- [Automated Testing Plan](../AUTOMATED_TESTING_PLAN.md) - Test automation roadmap

### Process

- [Release Guide](../RELEASE_GUIDE.md) - Release process documentation

## Existing Documentation

The following documentation existed prior to this scan:

| File                                                                  | Description                             |
| --------------------------------------------------------------------- | --------------------------------------- |
| [ARCHITECTURE.md](../ARCHITECTURE.md)                                 | ASCII diagrams of system architecture   |
| [COPILOT_CLI_DESIGN.md](../COPILOT_CLI_DESIGN.md)                     | Copilot CLI integration reference       |
| [CLAUDE_CLI_DESIGN.md](../CLAUDE_CLI_DESIGN.md)                       | Claude Code CLI integration reference   |
| [DYNAMIC_QUEUE_USAGE.md](../DYNAMIC_QUEUE_USAGE.md)                   | Dynamic queue user guide (356 lines)    |
| [DYNAMIC_QUEUE_IMPLEMENTATION.md](../DYNAMIC_QUEUE_IMPLEMENTATION.md) | Implementation details                  |
| [END_CONDITIONS.md](../END_CONDITIONS.md)                             | End condition documentation (253 lines) |
| [XML_PROMPTING_GUIDELINES.md](../XML_PROMPTING_GUIDELINES.md)         | XML prompting patterns (286 lines)      |
| [AGENT_SUPPORT_IMPLEMENTATION.md](../AGENT_SUPPORT_IMPLEMENTATION.md) | Agent support details                   |
| [CONTEXT_ATTACHMENT.md](../CONTEXT_ATTACHMENT.md)                     | File attachment documentation           |
| [ALL_VSCODE_COMMANDS.md](../ALL_VSCODE_COMMANDS.md)                   | VS Code command reference               |

## Getting Started

### For New Developers

1. Read [Project Overview](./project-overview.md) for context
2. Review [Architecture](./architecture.md) for system design
3. Follow [Development Guide](./development-guide.md) for setup
4. Explore [Source Tree Analysis](./source-tree-analysis.md) for code navigation

### For AI-Assisted Development

When using GitHub Copilot or other AI assistants:

1. Reference this index for project context
2. Include relevant component files in prompts
3. Use `#file:` references to specific source files
4. Refer to [XML Prompting Guidelines](../XML_PROMPTING_GUIDELINES.md) for prompt structure

### For UI-Only Features

Reference:

- `src/ui/FlightPathDashboardProvider.ts` - WebView panel
- `src/ui/webview/` - Dashboard HTML/CSS/JS
- `src/ui/StatusBarManager.ts` - Status bar

### For Integration Features

Reference:

- `src/flightpath/base/CopilotIntegration.ts` - Abstract base
- `src/flightpath/cli/CopilotCommandLineIntegration.ts` - CLI mode
- `src/flightpath/chat/CopilotChatIntegration.ts` - Chat mode

### For Workflow Features

Reference:

- `src/flightpath/FlightPathManager.ts` - Orchestration
- `src/flightpath/WorkflowExecutor.ts` - Execution loop
- `src/flightpath/PromptQueue.ts` - State management

## Brownfield PRD Command

When planning new features, use this documentation as context:

```
Reference: docs/bmad/index.md
```

For UI features: Include `architecture.md` + component inventory UI section
For API features: Include `architecture.md` + integration layer + CLI design docs
For full-stack: Include all architecture docs + relevant existing docs

---

**Documentation generated by BMAD Document Project workflow**

**State file:** `docs/bmad/project-scan-report.json`
