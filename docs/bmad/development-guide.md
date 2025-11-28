# FlightPath Development Guide

## Prerequisites

### Required

- **Node.js**: 18+ (22.17.0 recommended)
- **VS Code**: 1.85.0 or higher
- **npm**: Comes with Node.js

### Optional

- **GitHub Copilot**: For full automation features
- **Python 3**: For Python end condition scripts
- **Git**: For version control

## Environment Setup

### 1. Clone Repository

```bash
git clone https://github.com/nhickster/flightpath.git
cd flightpath
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Compile TypeScript

```bash
npm run compile
```

### 4. Open in VS Code

```bash
code .
```

## Development Commands

| Command                    | Description                         |
| -------------------------- | ----------------------------------- |
| `npm run compile`          | Type check and build with esbuild   |
| `npm run watch`            | Watch mode (parallel esbuild + tsc) |
| `npm run check-types`      | TypeScript type checking only       |
| `npm run lint`             | Run ESLint                          |
| `npm run lint:fix`         | Fix ESLint issues                   |
| `npm run format`           | Format with Prettier                |
| `npm run format:check`     | Check formatting                    |
| `npm test`                 | Run all tests                       |
| `npm run test:unit`        | Run unit tests only                 |
| `npm run test:integration` | Run integration tests               |
| `npm run package`          | Production build                    |

## Running the Extension

### Debug Mode (F5)

1. Open FlightPath in VS Code
2. Press **F5** or go to Run → Start Debugging
3. A new VS Code window opens with the extension loaded
4. Test commands via Command Palette (`Ctrl+Shift+P`)

### Watch Mode (Development)

```bash
npm run watch
```

This runs both esbuild and tsc in watch mode for fast iteration.

## Testing

### Test Framework

- **Mocha**: Test runner
- **@vscode/test-electron**: VS Code integration tests

### Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests (requires Copilot CLI)
COPILOT_CLI_INTEGRATION_TESTS=1 npm test

# With coverage
npm run test:coverage
```

### Test Structure

```
src/test/
├── runTest.ts              # Test runner configuration
├── extension.test.ts       # Extension activation tests
├── flightpath.test.ts      # FlightPathManager tests
├── promptQueue.test.ts     # PromptQueue tests
├── promptFileParser.test.ts # Parser tests
├── endConditionEvaluator.test.ts # Evaluator tests
├── promptIdentity.test.ts  # Identity tracking tests
├── validationUtils.test.ts # Validation utility tests
├── fixtures/               # Test fixtures
├── integration/            # Integration tests
└── suite/                  # Test suite configuration
```

### Manual Testing

Use files in `manual-test/` directory:

- `dynamic-queue-*.flightpath.json` - Dynamic queue tests
- `retry-*.flightpath.json` - End condition retry tests
- Right-click → Send to CLI or Send to Chat

## Build Process

### Development Build

```bash
npm run compile
```

Uses esbuild for fast bundling with source maps.

### Production Build

```bash
npm run package
```

Minified build without source maps.

### Build Output

```
out/
├── extension.js           # Main entry point
├── extension.js.map       # Source map (dev only)
├── schemas/               # Copied from schemas/
├── templates/             # Copied from src/templates/
└── ui/webview/           # Copied from src/ui/webview/
```

## Code Quality

### TypeScript Strict Mode

The project uses TypeScript strict mode with these settings:

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "strictFunctionTypes": true
  }
}
```

### ESLint Configuration

```bash
npm run lint        # Check for issues
npm run lint:fix    # Auto-fix issues
```

### Prettier Formatting

```bash
npm run format       # Format all files
npm run format:check # Check formatting
```

## Adding Features

### 1. Follow SOLID Principles

- Single responsibility per component
- Open for extension, closed for modification
- Use interfaces and dependency injection

### 2. Add TypeScript Types

All new code should have proper type annotations:

```typescript
interface NewFeatureOptions {
  enabled: boolean;
  timeout: number;
}

async function newFeature(options: NewFeatureOptions): Promise<Result> {
  // Implementation
}
```

### 3. Include Error Handling

Comprehensive error handling with user feedback:

```typescript
try {
  await riskyOperation();
} catch (error) {
  console.error("Operation failed:", error);
  vscode.window.showErrorMessage(`FlightPath: ${error.message}`);
}
```

### 4. Write Tests

Add tests for new functionality:

```typescript
suite("NewFeature Tests", () => {
  test("should do something", async () => {
    const result = await newFeature({ enabled: true, timeout: 1000 });
    assert.ok(result.success);
  });
});
```

### 5. Update Schemas

If adding new prompt fields:

1. Update `schemas/prompt-schema.json`
2. Update `src/types/FlightPathTypes.ts`
3. Update parsing in `PromptFileParser.ts`

### 6. Document Changes

- Update README.md for user-facing changes
- Update docs/ for detailed documentation
- Add inline JSDoc comments

## Configuration Settings

### Adding a New Setting

1. **package.json** - Add to contributes.configuration.properties:

```json
"flightpath.newSetting": {
  "type": "boolean",
  "default": false,
  "description": "Description of the setting",
  "markdownDescription": "**Markdown** description with details"
}
```

2. **ConfigurationUtils.ts** - Add accessor:

```typescript
getNewSetting(): boolean {
  return getConfig().get<boolean>("newSetting", false);
}
```

3. Use in code:

```typescript
const value = ConfigurationUtils.getNewSetting();
```

## Commands

### Adding a New Command

1. **package.json** - Register command:

```json
{
  "command": "flightpath.newCommand",
  "title": "New Command",
  "category": "FlightPath"
}
```

2. **extension.ts** - Implement handler:

```typescript
context.subscriptions.push(
  vscode.commands.registerCommand("flightpath.newCommand", async () => {
    await flightPathManager.newCommand();
  })
);
```

3. **FlightPathManager.ts** - Add method:

```typescript
async newCommand(): Promise<void> {
  // Implementation
}
```

## Debugging Tips

### Console Logging

All components log to Debug Console:

```typescript
console.log("FlightPath: Action taken");
console.error("FlightPath: Error occurred:", error);
```

### Debug State Command

Use `FlightPath: Show Debug State` to inspect:

- Current queue state
- Copilot status
- Loaded prompts

### Output Channel

CLI output visible in Output panel:

- View → Output → Select "FlightPath"

### DevTools

In Extension Development Host:

- Help → Toggle Developer Tools
- Console shows all logs
- Network tab shows VS Code requests

## Project Status

**Pre-release**: No backward compatibility required.

Per project guidelines:

> Break things freely to improve architecture.

Focus on:

- Clean architecture over compatibility
- TypeScript strict mode compliance
- Comprehensive error handling
- SOLID principles
