# FlightPath VS Code Extension

## Core Purpose

Automate GitHub Copilot Chat through structured JSON-based prompt workflows with automated execution, response detection, and context awareness.

## Technical Stack

- TypeScript 5.x (strict mode)
- Node.js 22.17.0
- esbuild (bundling)
- VS Code Extension API (Language Model Tool API, Chat integration)
- JSON Schema validation (AJV)
- Mocha (testing)

## Architecture Principles

**Prompt Format**: Final-form storage - Prompts stored in JSON files are ready to send to Copilot with all context variables (@workspace, #file:path:line-line, slash commands) included directly in the text. No runtime context injection.

SOLID principles with strict separation of concerns:

- FlightPathManager: Orchestration and command handling
- PromptQueue: Sequential execution and state management
- CopilotIntegration: Chat automation and response detection
- PromptFileParser: JSON validation and parsing
- EndConditionEvaluator: Script execution and validation

Code quality: TypeScript strict mode, comprehensive error handling, no duplication.

## Project Structure

```
src/
├── extension.ts                  # Entry point
├── flightpath/                   # Core logic
│   ├── FlightPathManager.ts      # Orchestration
│   ├── PromptQueue.ts            # Execution queue
│   ├── CopilotIntegration.ts     # Chat automation
│   ├── PromptFileParser.ts       # JSON parsing
│   └── EndConditionEvaluator.ts  # Script validation
├── types/                        # Type definitions
├── schemas/                      # JSON schemas
└── test/                         # Tests
```

## Core Components

### FlightPathManager

Main orchestrator handling commands, lifecycle, and workflow execution. Coordinates PromptQueue and CopilotIntegration. Subscribes to status changes and response completion events.

### PromptQueue

Manages sequential prompt execution with pause/resume/cancel. Tracks state and progress. Does not directly handle response detection (delegated to FlightPathManager).

### CopilotIntegration

Implements zero-interaction Copilot Chat automation:

- Direct text insertion: Focus (1000ms) → Clear (300ms) → Type (500ms) → Submit
- Background polling: 5s intervals, 30s max, detects Copilot availability on startup
- States: initializing | waiting | ready | unavailable
- Response detection: Language Model Tool (flightpath_response_complete)
- Automatic prompt augmentation: Adds tool-calling instruction to every prompt
- Submit verification: Clipboard-based retry with exponential backoff
- Streaming detection: Polls chat stability (3 consecutive stable checks)

### Response Completion Detection

Uses hybrid approach combining Language Model Tool + clipboard polling:

**Tool Callback (Intent Signal):**

1. Tool registration: flightpath_response_complete registered after Copilot activates
2. Prompt augmentation: Every prompt gets tool-calling instruction appended automatically
3. Tool invocation: When called, fires responseCompleteEmitter event (ONLY FIRST CALL)
4. Duplicate protection: toolCalledForCurrentPrompt flag ignores subsequent calls in same response

**Clipboard Polling (Verification):**

1. Tool callback triggers streaming detection (not immediate polling)
2. Polls chat content every 500ms via clipboard
3. Requires 3 consecutive stable checks (1.5s) to confirm completion
4. Efficient: only polls after tool indicates "near completion"

**LLM Loop Prevention:**

- LLMs often call tools multiple times (output → tool → output → tool loop)
- Two-layer defense: flag in CopilotIntegration + flag in FlightPathManager
- **Active cancellation**: Calls `workbench.action.chat.cancel` when loop detected
- Stops LLM from continuing to generate unwanted text in the loop
- Saves tokens and prevents workflow disruption

Implementation notes:

- Tool registered only once (isToolRegistered flag prevents duplicates)
- Instruction emphasizes "EXACTLY ONCE" and "FINAL action"
- Single active workflow limitation (no chat session metadata in tool invocations)
- See docs/COPILOT_RESPONSE_HANDLING.md for full research and design decisions

### PromptFileParser

- Schema validation with AJV
- Supports .prompt.json (single) and .flightpath.json (workflow)
- Validates final-form prompts (no runtime context injection)
- Detailed validation error reporting

### EndConditionEvaluator

- Path validation and process isolation
- Supports Python, JavaScript, shell scripts
- Configurable timeouts
- Scripts cannot access file system directly

## File Formats & Schema

**Important: Prompts are stored in final-form format** - All context variables (@workspace, #file:path, slash commands) are included directly in the prompt text.

### Single Prompt Format (`.prompt.json`)

```json
{
  "prompt": "/explain #file:src/extension.ts Analyze and improve this code",
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
      "prompt": "/explain @workspace Step 1: Analyze code structure",
      "endCondition": { "script": "check_analysis.js", "returns": "true" }
    },
    {
      "prompt": "Step 2: Implement improvements",
      "endCondition": { "script": "verify_changes.py", "returns": "true" }
    }
  ]
}
```

## Commands

11 registered commands:

- flightpath.takeOff: Start workflow
- flightpath.openPanel: Open panel
- flightpath.createPromptFile: Create file
- flightpath.pause/resume/stop: Execution control
- flightpath.debugState: Debug state
- flightpath.showCopilotStatus: Show status
- flightpath.testAutomation: Test automation
- flightpath.retryCopilotDetection: Retry polling

Status bar shows: Initializing, Waiting, Ready, Running, Paused, Setup Required

## Testing

- Unit tests: Core logic with mocking
- Integration tests: VS Code API interactions
- Test files: extension.test.ts, flightpath.test.ts
- Framework: Mocha with VS Code test utilities

## Security

Script execution:

- Path validation: Scripts must be in .flightpath/ directory
- Process isolation: Separate child processes
- Timeout protection: Default 30s
- No network access or direct file modification

File system:

- Operations limited to workspace scope
- JSON validated against strict schemas

## Development

- F5 debugging with breakpoints
- npm run watch for compilation
- TypeScript strict mode
- ESLint + Prettier for code quality

## Implementation Status

Completed:

- Zero-interaction Copilot Chat automation
- Language Model Tool for response detection
- Clipboard-based submit verification and streaming detection
- Background polling with progressive activation
- User-configurable chat window location
- Automatic prompt augmentation with tool instructions
- JSON schema validation with IntelliSense
- Command registration and lifecycle management
- Status bar integration with real-time updates
- File system monitoring and prompt discovery

Planned:

- End condition script execution
- WebView UI panel
- Advanced context awareness
- Comprehensive test coverage

## Extension Settings

- flightpath.promptsDirectory (string, default: ".flightpath")
- flightpath.scriptTimeout (number, default: 30000)
- flightpath.chatWindowLocation (enum: "chatPanel" | "newTab" | "newWindow")

When adding settings:

1. Add to package.json under contributes.configuration.properties
2. Use enum with enumDescriptions for dropdowns
3. Set sensible defaults
4. Retrieve: vscode.workspace.getConfiguration("flightpath").get<Type>("settingName", defaultValue)

## Development Guidelines

**Project Status**: Pre-release - No backward compatibility required. Break things freely to improve architecture.

When adding features:

1. Follow SOLID principles - single responsibility per component
2. Add TypeScript types - leverage strict mode for safety
3. Include error handling - comprehensive user feedback
4. Write tests first - TDD approach for reliability
5. Update schemas - maintain JSON validation for prompt files
6. Document changes - keep README and examples current

Code review focus:

- Type safety with strict mode
- Error boundaries for all external operations
- Security validation for script execution and file system access
- Performance: avoid blocking operations, use async/await
- User experience: clear feedback and status communication

**Breaking Changes**: Since this extension is not yet released, prioritize clean architecture over backward compatibility. Make bold improvements without hesitation.

## Extension Goals

FlightPath bridges manual AI assistance and full automation through:

- Structured automation via JSON configuration
- Script-based validation of AI outputs
- Fine-grained control over AI interaction sequences
- Seamless VS Code integration with context awareness
- Secure script execution with clear boundaries
