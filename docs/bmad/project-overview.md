# FlightPath - Project Overview

> **Automate GitHub Copilot with structured prompt workflows**

## Executive Summary

FlightPath is a VS Code extension that enables developers to create automated, sequential workflows using GitHub Copilot through JSON-based prompt files with programmable end conditions. It provides zero-interaction automation with proven reliability, allowing users to "press Take Off and walk away."

## Project Identity

| Attribute      | Value                           |
| -------------- | ------------------------------- |
| **Name**       | FlightPath                      |
| **Version**    | 0.1.0 (Pre-release)             |
| **Type**       | VS Code Extension               |
| **Status**     | Active Development              |
| **Repository** | github.com/nhickster/flightpath |
| **License**    | MIT                             |

## Core Value Proposition

1. **Zero-Interaction Automation**: True "set-and-forget" Copilot Chat integration
2. **Structured Workflows**: Define multi-step AI workflows using JSON files
3. **Programmable Validation**: End condition scripts verify AI outputs with automatic retry
4. **Dynamic Queue Extension**: Copilot can autonomously extend workflows at runtime
5. **Real-Time Monitoring**: WebView dashboard with live CLI output streaming

## Technology Stack

| Category              | Technology            | Version  |
| --------------------- | --------------------- | -------- |
| **Language**          | TypeScript            | 5.9.2    |
| **Runtime**           | Node.js               | 22.17.0  |
| **Platform**          | VS Code Extension API | ^1.85.0  |
| **Build System**      | esbuild               | ^0.25.10 |
| **Schema Validation** | AJV                   | ^8.17.1  |
| **Test Framework**    | Mocha                 | ^11.7.2  |

## Architecture Type

**Layered Architecture** with clear separation of concerns:

```
┌─────────────────────────────────────────────────────────────┐
│                    UI Layer                                  │
│  (FlightPathDashboardProvider, StatusBarManager)            │
├─────────────────────────────────────────────────────────────┤
│                 Orchestration Layer                          │
│  (FlightPathManager)                                        │
├─────────────────────────────────────────────────────────────┤
│                  Execution Layer                             │
│  (WorkflowExecutor, PromptQueue, EndConditionHandler)       │
├─────────────────────────────────────────────────────────────┤
│                 Integration Layer                            │
│  (CopilotIntegration → CLI / Chat implementations)          │
├─────────────────────────────────────────────────────────────┤
│                  Validation Layer                            │
│  (PromptFileParser, EndConditionEvaluator, AJV)             │
└─────────────────────────────────────────────────────────────┘
```

## Key Features

### Dual Integration Modes

1. **CLI Mode** (Default): Deterministic completion via Copilot CLI
   - Model selection support (4 models)
   - Session management for multi-turn conversations
   - Structured output parsing with token statistics

2. **Chat Mode** (Fallback): UI-based automation via Copilot Chat window
   - Log-based response detection
   - Full model support (22 models)
   - Native file attachment via VS Code API

### File Format Support

- **`.prompt.json`**: Single prompt files for simple tasks
- **`.flightpath.json`**: Multi-prompt workflows for complex automation
- **`.prompt.md`**: Markdown-based single prompts (no JSON needed)

### End Condition System

- Script-based validation (Python, JavaScript, TypeScript, Bash, PowerShell)
- Automatic retry with customizable prompts
- Template placeholders for script output, error messages, retry counts

### Dynamic Queue Extension

- Copilot can add prompts to workflow during execution
- Safety guardrails: max queue size, execution time limits
- Prompt identity tracking prevents duplicate execution

## Requirements

- **VS Code**: Version 1.85.0 or higher
- **Node.js**: Version 18+ (for end condition scripts)
- **GitHub Copilot**: Recommended (extension works without it in limited mode)

## Commands (22 Total)

| Category         | Commands                                                      |
| ---------------- | ------------------------------------------------------------- |
| **Core**         | Take Off, Pause, Resume, Stop, Create Prompt File, Open Panel |
| **Integration**  | Show Copilot Status, Test Automation, Retry Detection         |
| **Context Menu** | Send to CLI, Send to Chat                                     |
| **Testing**      | Various test commands for automation validation               |

## Configuration Settings (25+ Settings)

Key settings include:

- `flightpath.copilotIntegrationMode`: CLI (default) or Chat
- `flightpath.copilotCliModel`: Default model for CLI mode
- `flightpath.enableDynamicQueue`: Enable autonomous workflow extension
- `flightpath.maxQueueSize`: Safety limit for dynamic queues (1-1000)
- `flightpath.scriptTimeout`: End condition script timeout

## Test Coverage

- **215+ automated tests** (Mocha + VS Code Test Harness)
- Unit tests for core components
- Integration tests for CLI mode
- Manual test files for edge cases

## Links

- **Documentation Index**: [docs/bmad/index.md](./index.md)
- **Quick Start**: [QUICK_START.md](../../QUICK_START.md)
- **Architecture Details**: [architecture.md](./architecture.md)
- **API Reference**: [docs/COPILOT_CLI_DESIGN.md](../COPILOT_CLI_DESIGN.md)
