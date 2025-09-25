# FlightPath VS Code Extension - GitHub Copilot Instructions

## Project Overview

FlightPath is a VS Code extension that automates GitHub Copilot through structured prompt workflows. The extension enables developers to create JSON-based prompt sequences with programmable end conditions for automated development workflows.

Core Purpose: Orchestrate GitHub Copilot Chat interactions through automated prompt queues with validation scripts and context awareness.

## Architecture & Technical Stack

### Technology Stack (2025 Best Practices)

- **TypeScript 5.x** with strict configuration and modern language features
- **Node.js 18+** (project uses v22.17.0) for runtime compatibility
- **esbuild** for fast bundling and development (not webpack)
- **VS Code Extension API** with Chat integration capabilities
- **JSON Schema validation** (AJV) for prompt file validation and IntelliSense
- **Child process execution** for end condition script validation
- **Chokidar** for file system monitoring

### Build System

- **esbuild**: Primary bundler with watch mode and problem matchers
- **TypeScript Strict Mode**: All strict flags enabled for type safety
- **ESLint + Prettier**: Code quality and formatting enforcement
- **Mocha**: Testing framework for VS Code extension testing
- **npm scripts**: Standard build, watch, test, and package workflows

## Code Architecture Principles

### SOLID Principles Implementation

- Single Responsibility: Each component has one well-defined purpose
  - FlightPathManager: Orchestration only
  - PromptQueue: Queue management only
  - CopilotIntegration: Chat API interface only
- Open/Closed: Extensible for new prompt formats and end condition types
- Liskov Substitution: Abstract interfaces for prompt types and execution strategies
- Interface Segregation: Focused interfaces (ICopilotIntegration, IEndConditionEvaluator)
- Dependency Inversion: Abstract VS Code API dependencies and external integrations

### Code Quality Standards

- DRY: Eliminate duplication through shared utilities and abstractions
- KISS: Maintain simplicity, avoid over-engineering
- Modular Architecture: Clean separation between core logic, UI, and integrations
- Error Boundaries: Comprehensive error handling with user feedback
- Type Safety: Leverage TypeScript's strict mode for compile-time safety

## Project Structure

```
FlightPath/
├── src/
│   ├── extension.ts              # Extension activation and command registration
│   ├── flightpath/               # Core business logic
│   │   ├── FlightPathManager.ts      # Main orchestration controller
│   │   ├── PromptQueue.ts            # Queue management and execution
│   │   ├── CopilotIntegration.ts     # GitHub Copilot Chat API (stub)
│   │   ├── PromptFileParser.ts       # JSON prompt parsing with validation
│   │   └── EndConditionEvaluator.ts  # Script execution and validation
│   ├── ui/
│   │   └── StatusBarManager.ts       # VS Code status bar integration
│   ├── utils/
│   │   ├── FileSystemUtils.ts        # File operations and monitoring
│   │   ├── ValidationUtils.ts        # Schema validation helpers
│   │   └── LoggingUtils.ts           # Structured logging system
│   ├── types/
│   │   ├── FlightPathTypes.ts        # Core type definitions
│   │   └── CopilotTypes.ts           # Copilot integration types
│   └── schemas/
│       ├── prompt-schema.json        # Single prompt validation
│       └── flightpath-schema.json    # Workflow validation
├── .flightpath/examples/         # Example prompt and workflow files
└── test/                         # Unit and integration tests
```

## Core Components

### FlightPathManager (Main Controller)

- Purpose: Central orchestrator for all extension functionality
- Responsibilities: Command handling, lifecycle management, component coordination
- Key Methods: `takeOff()`, `pauseExecution()`, `resumeExecution()`, `stopExecution()`
- State Management: Maintains current execution state and queue references

### PromptQueue (Execution Engine)

- Purpose: Manages sequential prompt execution with state tracking
- Features: Pause/resume/cancel, progress tracking, error recovery
- State Persistence: Queue state maintained across VS Code sessions
- Integration: Coordinates with CopilotIntegration for chat interactions

### CopilotIntegration (Chat Interface)

- Current Status: Stub implementation with clipboard fallback
- Future: GitHub Copilot Chat API integration
- Fallback Strategy: Copy prompts to clipboard when Chat API unavailable
- Error Handling: Graceful degradation for API failures

### PromptFileParser (JSON Processing)

- Schema Validation: Uses AJV for strict JSON schema validation
- File Types: `.prompt.json` (single) and `.flightpath.json` (workflow)
- Context Processing: Handles file inclusion and workspace context
- Error Reporting: Detailed validation error messages

### EndConditionEvaluator (Script Execution)

- Security: Path validation and process isolation
- Languages: Python, JavaScript, shell scripts
- Timeout Management: Configurable execution timeouts
- Safety: No direct file system access from scripts

## File Formats & Schema

### Single Prompt Format (`.prompt.json`)

```json
{
  "prompt": "Analyze and improve this code",
  "context": {
    "includeCurrentFile": true,
    "includeSelection": false
  },
  "endCondition": {
    "script": "validate_improvements.py",
    "returns": "true",
    "timeout": 30000
  }
}
```

### Workflow Format (`.flightpath.json`)

```json
{
  "prompts": [
    {
      "prompt": "Step 1: Analyze code structure",
      "endCondition": { "script": "check_analysis.js", "returns": "true" }
    },
    {
      "prompt": "Step 2: Implement improvements",
      "endCondition": { "script": "verify_changes.py", "returns": "true" }
    }
  ]
}
```

## Commands & Features

### VS Code Commands (7 registered)

- `flightpath.takeOff`: Start prompt workflow execution
- `flightpath.pause`: Pause current execution
- `flightpath.resume`: Resume paused execution
- `flightpath.stop`: Stop and reset current workflow
- `flightpath.debug`: Debug current workflow state
- `flightpath.createPromptFile`: Create new prompt file
- `flightpath.showStatus`: Display current status

### Status Bar Integration

- Icon: Rocket symbol ($(rocket)) for FlightPath branding
- States: Idle, Running, Paused, Error with visual indicators
- Interactive: Click to show status, right-click for context menu

## Testing Strategy

### Test Structure

- Unit Tests: Core logic components with mocking
- Integration Tests: VS Code API interactions
- File System Tests: Prompt file parsing and validation
- Mock Framework: VS Code test utilities and Mocha

### Test Files

- `extension.test.ts`: Extension lifecycle and command registration
- `flightpath.test.ts`: Core functionality and component integration
- Fixture files in `test/fixtures/` for parsing validation

## Security & Safety

### Script Execution Safety

- Path Validation: Only allow scripts in `.flightpath/` directory
- Process Isolation: Scripts run in separate child processes
- Timeout Protection: Configurable execution timeouts (default: 30s)
- No Network Access: Scripts cannot make external network calls

### File System Security

- Workspace Boundary: All operations within workspace scope
- Read-Only Context: Scripts cannot modify workspace files directly
- Validation: All JSON files validated against strict schemas

## Development Workflow

### Development Environment

- F5 Debugging: Extension Development Host with breakpoint support
- Watch Mode: `npm run watch` for automatic compilation
- Live Testing: Commands available in Command Palette during development
- Build Verification: `npm run compile` for production builds

### Code Style & Quality

- TypeScript Strict: All strict compiler options enabled
- ESLint Rules: Consistent code quality enforcement
- Prettier Formatting: Automatic code formatting on save
- Import Organization: Clear module boundaries and dependencies

## Current Implementation Status

### Phase 2 Complete (Core Architecture)

- All core components implemented and tested
- Command registration and lifecycle management working
- JSON schema validation with VS Code IntelliSense
- Status bar integration with real-time updates
- File system monitoring for `.flightpath/` directory
- End condition script execution framework
- Comprehensive error handling and logging
- Basic unit test coverage

### Current Phase (Enhancement & Integration)

- WebView UI panel for visual workflow management
- Enhanced GitHub Copilot Chat API integration
- Advanced context awareness features
- Comprehensive test coverage expansion
- Performance optimization for large workspaces

## Development Guidelines

### When Adding New Features

1. Follow SOLID principles - single responsibility per component
2. Add TypeScript types - leverage strict mode for safety
3. Include error handling - comprehensive user feedback
4. Write tests first - TDD approach for reliability
5. Update schemas - maintain JSON validation for prompt files
6. Document changes - keep README and examples current

### Code Review Focus Areas

- Type Safety: Proper TypeScript usage with strict mode
- Error Boundaries: All external operations must have error handling
- Security: Script execution and file system access validation
- Performance: Avoid blocking operations in extension host
- User Experience: Clear feedback and status communication

### Performance Considerations

- Async Operations: Use async/await for all I/O operations
- Memory Management: Clean up watchers and subscriptions
- Large Files: Stream processing for large workspace file inclusion
- Background Tasks: Use background execution for long-running scripts

## Extension Goals & Vision

FlightPath aims to bridge the gap between manual AI assistance and full automation by providing:

- Structured Automation: Repeatable workflows through JSON configuration
- Intelligent Validation: Script-based verification of AI outputs
- Developer Control: Fine-grained control over AI interaction sequences
- Workspace Integration: Seamless VS Code integration with context awareness
- Safety First: Secure script execution with clear boundaries

This extension represents a modern approach to AI-assisted development, emphasizing structure, safety, and developer control over AI interactions.
