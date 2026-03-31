# Dev Commands Handling

## Problem

VS Code requires all commands to be declared in `package.json` for Command Palette discovery. However, FlightPath has development-only commands (test utilities, diagnostics) that should not appear in production builds.

**The issue:** esbuild strips TypeScript implementation code (`src/dev/DevCommands.ts`), but `package.json` command declarations remain, causing errors when users try to run them.

## Solution: Build-Time package.json Stripping

We use a build script (`scripts/strip-dev-commands.mjs`) that removes dev commands from `package.json` during production builds, then restores the original after packaging.

### How It Works

1. **Development mode** (`npm run compile`):
   - All commands remain in `package.json`
   - DevCommands.ts registered conditionally via `IS_DEV_MODE`
   - Full dev tooling available

2. **Production build** (`npm run package`):
   - Strips commands with category `"FlightPath Test"` from `package.json`
   - Builds extension bundle
   - Restores original `package.json`

### Workflow

```bash
# Development (all commands available)
npm run compile
npm run watch

# Production build (dev commands removed from package.json)
npm run package

# Manual stripping (if needed)
npm run strip-dev-commands
npm run restore-package
```

### Dev Command Identification

Commands are identified for removal by:

1. **Category field**: `"category": "FlightPath Test"`
2. **Command ID list**: Hardcoded fallback in `strip-dev-commands.mjs`

All dev commands MUST use `"FlightPath Test"` category in `package.json`.

### Current Dev Commands

Commands automatically removed from production builds:

- `flightpath.test.copilotAutomation` - Test Copilot Chat automation
- `flightpath.test.fileAttachment` - Test file attachment commands
- `flightpath.test.chatModelSelection` - Test model switching
- `flightpath.test.chatAgentSelection` - Test agent selection
- `flightpath.listChatCommands` - List all chat commands
- `flightpath.listAllCommands` - List all VS Code commands
- `flightpath.investigateChatLogs` - Debug chat logs
- `flightpath.exportDiscoveredModels` - Export models to JSON
- `flightpath.showLanguageId` - Show document language ID

## Adding New Dev Commands

When creating a new dev command:

1. **Add to DevCommands.ts** implementation
2. **Add to package.json** with `"category": "FlightPath Test"`
3. **Test in dev mode** (F5)
4. **(Optional)** Add to `DEV_COMMAND_IDS` in `strip-dev-commands.mjs` as fallback

Example:

```json
{
  "command": "flightpath.myNewTest",
  "title": "My New Test Command",
  "category": "FlightPath Test", // ← REQUIRED for auto-removal
  "icon": "$(beaker)"
}
```

## Verification

To verify dev commands are stripped:

```bash
# Build production package
npm run package

# Check command count in package.json (should match production count)
# If you see "FlightPath Test" commands, the script failed

# Restore original
npm run restore-package
```

## Why Not Use VS Code's Conditional Registration?

VS Code **does not support** conditional command registration. From GitHub issue [#11506](https://github.com/microsoft/vscode/issues/11506), Microsoft's stance is:

> "Commands must be declared in package.json contributions and are definable and registerable only within extension code."

This means:

- ❌ No `when` clause for command visibility in package.json
- ❌ No runtime command registration without package.json declaration
- ❌ No official build-time stripping mechanism

Our build-time approach is the **only reliable solution** for hiding dev commands in production.

## Alternative Considered: Separate Extension

We could create a separate "FlightPath Dev Tools" extension, but this adds:

- Maintenance overhead (two extensions)
- Publishing complexity
- User confusion

The build-time stripping approach is cleaner for internal dev tooling.
