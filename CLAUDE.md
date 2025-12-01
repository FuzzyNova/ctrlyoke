# FlightPath Project Memory

## Core Project Context

Always read the main project instructions:

@.github/copilot-instructions.md

## Selective Instruction Files

The `.github/instructions/` directory contains detailed implementation guidelines organized by file scope. Read the relevant instruction file(s) based on which files you're working with:

### File Scope Mapping

When editing or analyzing files, read the corresponding instruction file:

| File Pattern                           | Instruction File                                       | When to Read                                                            |
| -------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| `src/flightpath/*.ts` (top-level only) | `.github/instructions/flightpath-core.instructions.md` | FlightPathManager, PromptQueue, PromptFileParser, EndConditionEvaluator |
| `src/flightpath/base/**`               | `.github/instructions/flightpath-base.instructions.md` | CopilotIntegration abstract base class                                  |
| `src/flightpath/chat/**`               | `.github/instructions/flightpath-chat.instructions.md` | CopilotChatIntegration (UI automation)                                  |
| `src/flightpath/cli/**`                | `.github/instructions/flightpath-cli.instructions.md`  | CopilotCommandLineIntegration, ClaudeCommandLineIntegration             |
| `src/ui/**`                            | `.github/instructions/ui.instructions.md`              | Status bar, dashboard, settings webview providers                       |
| `src/types/**`                         | `.github/instructions/types.instructions.md`           | Type definitions and data structures                                    |
| `src/templates/**`                     | `.github/instructions/templates.instructions.md`       | End condition script templates                                          |
| `src/test/**`                          | `.github/instructions/test.instructions.md`            | Testing patterns and conventions                                        |
| `src/completions/**`                   | `.github/instructions/completions.instructions.md`     | IntelliSense providers                                                  |
| `src/utils/**`                         | `.github/instructions/utils.instructions.md`           | Utility functions and helpers                                           |
| `src/ui/webview/**`                    | `.github/instructions/webview.instructions.md`         | Dashboard/Settings HTML/CSS/JS                                          |

### How to Use

**Before editing files in a specific directory:**

1. Identify which pattern matches the files you're working on
2. Read the corresponding instruction file using `@.github/instructions/[filename]`
3. Apply the patterns and conventions described in that file

**Examples:**

- Working on `src/flightpath/FlightPathManager.ts`?
  - Read: `@.github/instructions/flightpath-core.instructions.md`

- Working on `src/ui/FlightPathDashboardProvider.ts`?
  - Read: `@.github/instructions/ui.instructions.md`

- Working on `src/flightpath/cli/CopilotCommandLineIntegration.ts`?
  - Read: `@.github/instructions/flightpath-cli.instructions.md`

- Working on multiple files across different directories?
  - Read all relevant instruction files for those directories

## Claude Code-Specific Guidance

### Context Inclusion Strategy

- **Always available**: Main instructions (`.github/copilot-instructions.md`) are imported at the top of this file
- **On-demand**: Specific instruction files should be read when working with files in their scope
- **Dynamic**: Use `@` syntax to import instruction files as needed during the conversation

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

- **SOLID principles**: Strict separation of concerns
- **TypeScript strict mode**: Comprehensive type safety
- **Single source of truth**: No hardcoded string duplication across files
- **Security first**: Workspace-scoped operations, process isolation for scripts
