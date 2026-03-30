# FlightPath Project Memory

## Core Project Context

Always read the main project instructions:

@.github/copilot-instructions.md

## Selective Instruction Files

The `.github/instructions/` directory contains detailed implementation guidelines organized by file scope. Read the relevant instruction file(s) based on which files you're working with:

### File Scope Mapping

When editing or analyzing files, read the corresponding instruction file:

| File Pattern                           | Instruction File                                             | When to Read                                                                                |
| -------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `src/flightpath/*.ts` (top-level only) | `.github/instructions/flightpath-core.instructions.md`       | HarnessIntegration, WorkflowOrchestrator, PromptQueue, PromptFileParser, EndConditionEvaluator |
| `src/flightpath/harness/chat/**`       | `.github/instructions/flightpath-chat.instructions.md`       | CopilotChatIntegration (UI automation)                                                      |
| `src/flightpath/harness/**`            | `.github/instructions/harness-integrations.instructions.md`  | CliIntegration, Harness providers (Copilot, Claude, Codex)                                  |
| `src/cli.ts`, `src/cli/**`             | `.github/instructions/flightpath-cli-binary.instructions.md` | FlightPath CLI binary, CliAdapter, CliTerminalFormatter                                     |
| `src/ui/**`                            | `.github/instructions/ui.instructions.md`                    | Status bar, dashboard, settings webview providers                                           |
| `src/types/**`                         | `.github/instructions/types.instructions.md`                 | Type definitions and data structures                                                        |
| `src/templates/**`                     | `.github/instructions/templates.instructions.md`             | End condition script templates                                                              |
| `src/test/**`                          | `.github/instructions/test.instructions.md`                  | Testing patterns and conventions                                                            |
| `src/completions/**`                   | `.github/instructions/completions.instructions.md`           | IntelliSense providers                                                                      |
| `src/utils/**`                         | `.github/instructions/utils.instructions.md`                 | Utility functions and helpers                                                               |
| `src/platform/**`                      | `.github/instructions/platform.instructions.md`              | Platform abstraction (PlatformAdapter, CliAdapter, VsCodeAdapter, vscode-shim)              |
| `src/ui/webview-react/**`              | `.github/instructions/webview-react.instructions.md`         | React dashboard (components, stores, hooks)                                                 |

### How to Use

**Before editing files in a specific directory:**

1. Identify which pattern matches the files you're working on
2. Read the corresponding instruction file in `.github/instructions/[filename]`
3. Apply the patterns and conventions described in that file

**Examples:**

- Working on `src/flightpath/WorkflowOrchestrator.ts`?
  - Read: `.github/instructions/flightpath-core.instructions.md`

- Working on `src/ui/FlightPathDashboardProvider.ts`?
  - Read: `.github/instructions/ui.instructions.md`

- Working on `src/flightpath/harness/CliIntegration.ts`?
  - Read: `.github/instructions/harness-integrations.instructions.md`

- Working on multiple files across different directories?
  - Read all relevant instruction files for those directories

### Example Workflow

```
User: "Help me refactor the FlightPathManager"

Claude: Let me read the core FlightPath instructions first.
@.github/instructions/flightpath-core.instructions.md

[Now I have context about FlightPathManager responsibilities, patterns, and architecture]
```

## Project Status

Pre-release - No backward compatibility constraints. Prioritize clean architecture and bold improvements.

## Key Principles

- **SOLID principles**: Separation of concerns, always look for opportunities to single source code and follow the DRY principal.
- **DRY (SINGLE SOURCE)**: Never duplicate code that can be single sourced in a helper function or base class.
- **TypeScript strict mode**: Comprehensive type safety
- **Single source of truth**: No hardcoded string duplication across files
- **Security first**: Workspace-scoped operations, process isolation for scripts
