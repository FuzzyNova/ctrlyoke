# Implement Codex CLI Integration for FlightPath

<context>
FlightPath is a VS Code extension that automates GitHub Copilot through structured JSON workflows. It currently supports three CLI providers: Copilot CLI (default), Claude Code CLI, and needs Codex CLI as the third provider.

**Existing Architecture:**

- Base class: `CopilotIntegration` (abstract)
- CLI base: `CliIntegration` extends `CopilotIntegration` (shared CLI logic)
- Implementations: `CopilotCommandLineIntegration`, `ClaudeCommandLineIntegration` (both extend `CliIntegration`)
- Factory pattern in `FlightPathManager` selects provider based on `flightpath.provider` setting
- Shared permission system: `cliToolPermissions`, `cliAllowedTools`, `cliDeniedTools` settings

**Key Files to Reference:**

- @.github/copilot-instructions.md - Project architecture and patterns
- @src/flightpath/cli/CopilotCommandLineIntegration.ts - Reference implementation
- @src/flightpath/cli/ClaudeCommandLineIntegration.ts - Alternative CLI pattern
- @src/flightpath/base/CliIntegration.ts - Shared CLI base class
- @src/utils/ModelConstants.ts - Model definitions (single source of truth)
- @src/utils/ConfigurationUtils.ts - Settings access layer
  </context>

<requirements>
Implement Codex CLI as a third CLI provider for FlightPath following the established architecture patterns.

**Core Deliverables:**

1. New `CodexCommandLineIntegration.ts` class extending `CliIntegration`
2. Model constants in `ModelConstants.ts` (5 primary GPT models)
3. Configuration settings in `package.json`
4. Factory integration in `FlightPathManager.ts`
5. Configuration utilities in `ConfigurationUtils.ts`

**CRITICAL RESEARCH FINDINGS:**

- Codex does **NOT** support granular `sandbox_permissions` arrays (misleading help text)
- Permission model: Sandbox modes (3 options) + Approval policies (4 options)
- No tool pattern matching like Copilot/Claude (no `shell(git:*)` equivalent)
- FlightPath's `cliAllowedTools`/`cliDeniedTools` cannot be mapped to Codex
- Use simplified mode-based mapping only
  </requirements>

<architecture_plan>
**1. CodexCommandLineIntegration Class**

Extend `CliIntegration` base class following the Claude CLI pattern:

```typescript
export class CodexCommandLineIntegration extends CliIntegration {
  protected getCliCommand(): string {
    return "codex";
  }
  protected getProviderName(): string {
    return "Codex CLI";
  }

  // Override: Build command arguments
  protected buildCliArgs(prompt: string, promptFile: PromptFile): string[];

  // Override: Codex-specific completion detection
  protected detectCompletion(output: string): boolean;
}
```

**Key Implementation Points:**

- Use `exec` subcommand for headless execution: `codex exec --json [prompt]`
- JSON output format with JSONL events: `thread.started`, `turn.started`, `item.completed`, `turn.completed`
- Extract response from `item.completed` events (field: `item.text`)
- Completion detection: Look for `turn.completed` event in JSON stream

**2. Permission Mapping Strategy**

**CRITICAL:** Codex does NOT support granular tool patterns. Use simplified mode mapping:

```typescript
private getPermissionArgs(): string[] {
  const toolMode = ConfigurationUtils.getCliToolPermissions();

  switch (toolMode) {
    case "dangerouslyAllowAll":
      return ["--dangerously-bypass-approvals-and-sandbox"];
    case "allowAll":
      return ["--full-auto"];
    case "custom":
      // Use Codex-specific settings (sandbox + approval)
      const sandbox = ConfigurationUtils.getCodexSandboxMode();
      const approval = ConfigurationUtils.getCodexApprovalPolicy();
      return ["-s", sandbox, "-a", approval];
  }
}
```

**When `cliAllowedTools` or `cliDeniedTools` are configured:**

- Log clear message: "Codex CLI does not support granular tool patterns. Use Codex-specific sandbox/approval settings for custom control."
- Ignore tool pattern arrays
- Proceed with mode-based mapping

**3. Model Support**

**Primary Models (from Codex `/model` command):**

```typescript
export const CODEX_CLI_MODELS = [
  "gpt-5.1-codex-max", // Latest flagship for deep reasoning
  "gpt-5.1-codex", // Recommended, optimized for codex
  "gpt-5.1-codex-mini", // Cheaper, faster, less capable
  "gpt-5.2", // Latest frontier model
  "gpt-5.1", // Broad world knowledge
] as const;

export const CODEX_CLI_DEFAULT_MODEL = "gpt-5.1-codex" as const;
```

Model selection via `--model` flag or config.toml (Codex handles fallback).

**4. Directory Access**

Similar to Copilot CLI's `--add-dir` support:

- Check `flightpath.codexAllowedDirs` setting (array of directory paths)
- Add `--add-dir <dir>` flags for each configured directory
- Only applies in `workspace-write` sandbox mode

**5. Configuration Schema**

Add to `package.json` under `contributes.configuration.properties`:

```json
{
  "flightpath.codexCliModel": {
    "type": "string",
    "enum": [
      "gpt-5.1-codex-max",
      "gpt-5.1-codex",
      "gpt-5.1-codex-mini",
      "gpt-5.2",
      "gpt-5.1"
    ],
    "default": "gpt-5.1-codex",
    "description": "Default model for Codex CLI mode"
  },
  "flightpath.codexSandboxMode": {
    "type": "string",
    "enum": ["read-only", "workspace-write", "danger-full-access"],
    "enumDescriptions": [
      "Read-only file access",
      "Write to workspace + allowed directories (recommended)",
      "Unrestricted filesystem access (dangerous)"
    ],
    "default": "workspace-write",
    "description": "Sandbox mode for custom permission mode (Codex CLI only)"
  },
  "flightpath.codexApprovalPolicy": {
    "type": "string",
    "enum": ["untrusted", "on-failure", "on-request", "never"],
    "enumDescriptions": [
      "Ask for non-trusted commands (safe list: ls, cat, sed, etc.)",
      "Run all, ask only if command fails",
      "Model decides when to ask (recommended)",
      "Never ask, fully automated (dangerous)"
    ],
    "default": "on-request",
    "description": "Approval policy for custom permission mode (Codex CLI only)"
  },
  "flightpath.codexAllowedDirs": {
    "type": "array",
    "items": { "type": "string" },
    "default": [],
    "description": "Additional writable directories for Codex CLI workspace-write mode"
  }
}
```

**Note:** `provider` enum already exists - just add "codex-cli" option to the existing array.
</architecture_plan>

<implementation_strategy>
**Phase 1: Core Integration (Milestone 1)**

1. **Add Model Constants** (`ModelConstants.ts`)
   - Add `CODEX_CLI_MODELS` array (5 models)
   - Add `CODEX_CLI_MODEL_LABELS` display names
   - Add `CODEX_CLI_DEFAULT_MODEL` constant
   - Run `npm run sync-models` to update package.json enums

2. **Add Dashboard Constants** (`src/types/DashboardConstants.ts`)
   - Add `CODEX_CLI: "codex-cli"` to `PROVIDER_IDS` constant
   - Add Codex entry to `PROVIDER_INFO`: `{ name: "Codex CLI", shortName: "Codex CLI" }`
   - Add Codex entry to `DEFAULT_MODELS`: `"gpt-5.1-codex"`
   - Add `CODEX_CLI_MODELS` array (similar structure to `CLAUDE_CLI_MODELS`):
     ```typescript
     export const CODEX_CLI_MODELS = [
       {
         value: "gpt-5.1-codex-max",
         label: "GPT-5.1 Codex Max (Most Capable)",
       },
       { value: "gpt-5.1-codex", label: "GPT-5.1 Codex (Recommended)" },
       { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini (Fastest)" },
       { value: "gpt-5.2", label: "GPT-5.2 (Latest Frontier)" },
       { value: "gpt-5.1", label: "GPT-5.1" },
     ] as const;
     ```

3. **Add Configuration Settings** (`package.json`)
   - Add "codex-cli" to `flightpath.provider` enum
   - Add `codexCliModel` setting with 5 model options
   - Add `codexSandboxMode` setting (3 options)
   - Add `codexApprovalPolicy` setting (4 options)
   - Add `codexAllowedDirs` array setting

4. **Add Configuration Utilities** (`ConfigurationUtils.ts`)
   - `getCodexCliModel(): string` - Returns user's model or default
   - `getCodexSandboxMode(): string` - Returns sandbox mode (default: "workspace-write")
   - `getCodexApprovalPolicy(): string` - Returns approval policy (default: "on-request")
   - `getCodexAllowedDirs(): string[]` - Returns additional directories

5. **Implement CodexCommandLineIntegration** (`src/flightpath/cli/CodexCommandLineIntegration.ts`)
   - Extend `CliIntegration` base class
   - Implement `buildCliArgs()` - Build command: `["exec", "--json", ...permissions, ...dirs, "--model", model, prompt]`
   - Implement `getPermissionArgs()` - Mode-based mapping (allowAll → `--full-auto`, etc.)
   - Implement `getDirectoryArgs()` - Add `--add-dir` flags from `codexAllowedDirs`
   - Implement `detectCompletion()` - Parse JSONL, look for `turn.completed` event
   - Override `extractResponse()` - Extract text from `item.completed` events
   - Add warning logs when tool patterns are ignored

6. **Update Factory** (`FlightPathManager.ts`)
   - Add case for `Provider.CodexCli` in `createCopilotIntegration()`
   - Instantiate `CodexCommandLineIntegration`

7. **Provider Enum Update** (`FlightPathTypes.ts`)
   - Add `CODEX_CLI = "codex-cli"` to `Provider` enum

**Phase 2: Testing & Validation**

1. Test permission modes: `allowAll`, `dangerouslyAllowAll`, `custom`
2. Test model selection and defaults
3. Test directory access with `--add-dir`
4. Test JSON parsing and completion detection
5. Verify tool pattern warning messages
6. Test with sample workflows in `manual-test/`

**Phase 3: Documentation Updates**

1. Update `.github/copilot-instructions.md` with Codex CLI details
2. Update `docs/CODEX_CLI_INTEGRATION.md` status to "Implemented"
3. Add Codex CLI examples to manual-test directory
4. Update CHANGELOG.md with new feature
   </implementation_strategy>

<code_quality_principles>
**Follow FlightPath Patterns:**

- Single Responsibility: Each method has one clear purpose
- DRY: Reuse `CliIntegration` base methods (don't duplicate Copilot/Claude logic)
- SOLID: Extend base class, override specific behaviors only
- Type Safety: Use TypeScript strict mode, proper return types
- Error Handling: Comprehensive user feedback, clear error messages
- Logging: Use `Log` utility for consistent output

**NO HARDCODED STRINGS:**

- Add constants to `ModelConstants.ts` (models)
- Add constants to `DashboardConstants.ts` (if adding UI messages)
- Reference existing constants from base classes

**Provider Enum Usage:**

- Import and use `Provider` enum from `FlightPathTypes.ts`
- Never hardcode provider strings like "codex-cli"
  </code_quality_principles>

<success_criteria>
**Testing Requirements:**

1. Codex CLI integration selectable via settings UI
2. `codex exec --json` command executes successfully
3. JSON output parsed correctly, response extracted
4. Permission flags applied correctly for all three modes
5. Model selection works (via `--model` flag)
6. Directory access flags added for configured paths
7. Warning logged when tool patterns are configured (since unsupported)
8. Completion detection works (no hanging workflows)

**Definition of Done:**

- [ ] `CodexCommandLineIntegration.ts` implemented and compiles
- [ ] Model constants added to `ModelConstants.ts`
- [ ] Dashboard constants updated in `DashboardConstants.ts` (PROVIDER_IDS, PROVIDER_INFO, DEFAULT_MODELS, CODEX_CLI_MODELS)
- [ ] Settings added to `package.json` with enums and descriptions
- [ ] Configuration utilities added to `ConfigurationUtils.ts`
- [ ] Factory updated in `FlightPathManager.ts`
- [ ] Provider enum updated in `FlightPathTypes.ts`
- [ ] Settings UI dropdown shows "Codex CLI" option
- [ ] Model dropdown shows 5 Codex models when Codex provider selected
- [ ] Codex-specific settings (sandbox mode, approval policy) visible when Codex + custom mode selected
- [ ] Manual testing with sample workflows passes
- [ ] No TypeScript errors (strict mode)
- [ ] Code follows existing patterns from Copilot/Claude implementations
      </success_criteria>

<critical_notes>
**IMPORTANT RESEARCH FINDINGS:**

1. **No Tool Pattern Support:** Codex does NOT support `sandbox_permissions` arrays or tool-specific control. The help text example is misleading. Only use mode-based mapping.

2. **Permission Model:** Only three sandbox modes + four approval policies. No granular per-command or per-tool control.

3. **Ignore Tool Patterns:** When `cliAllowedTools` or `cliDeniedTools` are configured, log a clear warning and proceed with mode-based mapping. Do NOT try to convert patterns to Codex flags.

4. **JSON Output Format:** Use `--json` flag for structured JSONL output. Parse events: `thread.started`, `turn.started`, `item.completed` (extract text), `turn.completed` (signals completion).

5. **Model Discovery:** Codex has no `--list-models` command. Use static list from `/model` interactive command output (5 primary models).

6. **Convenience Flags:**
   - `--full-auto` = `-a on-request -s workspace-write` (recommended for automation)
   - `--dangerously-bypass-approvals-and-sandbox` = `-a never -s danger-full-access` (dangerous)
   - **NEVER** combine convenience flags with `-s` or `-a` (Codex will error)

7. **Follow Existing Patterns:** Study `ClaudeCommandLineIntegration.ts` closely - it's the most similar architecture (JSON output, exec subcommand pattern).
   </critical_notes>

<instructions>
Implement the Codex CLI integration following the exact patterns established in the existing CLI integrations. Focus on code reuse through the `CliIntegration` base class. Keep permission mapping simple (mode-based only). Ensure all configuration settings follow FlightPath's established naming conventions and enum patterns.

The implementation should be production-ready with comprehensive error handling, clear user feedback, and strict TypeScript compliance. Test thoroughly with manual workflows before marking complete.
</instructions>
