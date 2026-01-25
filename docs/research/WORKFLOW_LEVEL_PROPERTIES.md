# Workflow-Level Properties Architecture

**Status:** Planning Phase
**Created:** 2026-01-16
**Author:** FlightPath Team

## Overview

Add workflow-level default properties to enable shared configuration across all prompts in a workflow. This improves workflow reproducibility and reduces duplication when multiple prompts share common settings (provider, model, end conditions, etc.).

**Benefits:**

1. **Reproducibility**: Workflows with embedded defaults work consistently across different user environments
2. **DRY Principle**: Define shared settings once at workflow level instead of per-prompt
3. **Common End Conditions**: Set workflow-wide validation (e.g., "all prompts must pass tests")
4. **Better Sharing**: Workflows include their own defaults, reducing dependency on user settings

**Precedence Order:**

```
Prompt-level properties (highest)
  ↓
Workflow-level properties
  ↓
VS Code global settings (lowest/fallback)
```

---

## 1. Current State Analysis

### Current Schema Structure

```typescript
// FlightPathTypes.ts
export interface PromptFile {
  prompts: PromptItem[];
  // No workflow-level properties yet
}

export interface PromptItem {
  id?: string;
  prompt: string;
  provider?: Provider; // Prompt override
  model?: string; // Prompt override
  agent?: string; // Prompt override
  newChatSession?: boolean;
  allowDynamicExtension?: boolean;
  endCondition?: EndCondition;
}
```

**Current Resolution:**

1. Check prompt-level property (e.g., `prompt.model`)
2. If undefined → Fall back to VS Code setting (e.g., `flightpath.copilotCliModel`)

**Problems:**

- No way to set workflow-wide defaults
- Shared settings must be duplicated across prompts OR rely on user settings
- Workflows aren't self-contained (depend on user's VS Code configuration)

### Current UI Structure

**Settings Panel** (`settings.html`):

- Global VS Code settings only
- Provider, Model, Agent, NewChatSession, ExecutionMode, DynamicQueue
- Changes update workspace/user settings

**Prompt Properties Drawer** (`dashboard.html`):

- Per-prompt overrides
- Same fields as settings panel
- Changes update only the current prompt in the queue

**Problem:**

- Adding workflow-level properties would create a third UI location with duplicate fields
- User confusion: "Which dropdown is which?"

---

## 2. Proposed Schema Changes

### 2.1 Reuse Execution Properties with $ref

**Key Insight:** Prompt properties, workflow properties, and runtime metadata all share the same base fields (provider, model, agent, newChatSession). Use JSON Schema `$ref` to define once, reuse everywhere.

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "definitions": {
    "executionProperties": {
      "type": "object",
      "description": "Shared execution configuration properties",
      "properties": {
        "provider": {
          "type": "string",
          "enum": ["copilot-cli", "copilot-chat", "claude-cli", "codex-cli"],
          "description": "AI provider for execution"
        },
        "model": {
          "type": "string",
          "description": "AI model to use"
        },
        "agent": {
          "type": "string",
          "description": "Custom agent file (.agent.md)"
        },
        "newChatSession": {
          "type": "boolean",
          "description": "Start new chat session"
        },
        "allowDynamicExtension": {
          "type": "boolean",
          "description": "Allow dynamic queue extension"
        },
        "endCondition": {
          "$ref": "#/definitions/endCondition"
        }
      }
    },

    "promptFile": {
      "type": "object",
      "allOf": [
        { "$ref": "#/definitions/executionProperties" },
        {
          "properties": {
            "prompts": {
              "type": "array",
              "items": { "$ref": "#/definitions/promptItem" }
            }
          },
          "required": ["prompts"]
        }
      ]
    },

    "promptItem": {
      "type": "object",
      "allOf": [
        { "$ref": "#/definitions/executionProperties" },
        {
          "properties": {
            "id": { "type": "string" },
            "prompt": { "type": "string" },
            "sessionId": { "type": ["string", "number"] },
            "_runtime": { "$ref": "#/definitions/promptRuntimeMetadata" }
          },
          "required": ["prompt"]
        }
      ]
    },

    "promptRuntimeMetadata": {
      "type": "object",
      "allOf": [
        { "$ref": "#/definitions/executionProperties" },
        {
          "properties": {
            "sessionId": { "type": "string" },
            "startedAt": { "type": "number" },
            "completedAt": { "type": "number" },
            "retryCount": { "type": "number" }
          },
          "required": ["provider", "model", "startedAt"]
        }
      ]
    }
  }
}
```

### 2.2 TypeScript Type Updates

```typescript
// src/types/FlightPathTypes.ts

/**
 * Shared execution properties for prompts, workflows, and runtime metadata.
 * Using this interface ensures consistency across all levels.
 */
export interface ExecutionProperties {
  /** AI provider for execution */
  provider?: Provider;

  /** AI model to use */
  model?: string;

  /** Custom agent file (.agent.md) */
  agent?: string;

  /** Start new chat session */
  newChatSession?: boolean;

  /** Allow dynamic queue extension */
  allowDynamicExtension?: boolean;

  /** End condition validation */
  endCondition?: EndCondition;
}

/**
 * Workflow file with workflow-level defaults and prompts.
 */
export interface PromptFile extends ExecutionProperties {
  /** Array of prompts in this workflow */
  prompts: PromptItem[];
}

/**
 * Individual prompt item with optional overrides.
 */
export interface PromptItem extends ExecutionProperties {
  /** Unique prompt identifier */
  id?: string;

  /** Prompt text or file reference */
  prompt: string;

  /** Session ID for resuming conversations */
  sessionId?: string | number;

  /** Runtime execution metadata */
  _runtime?: PromptRuntimeMetadata;
}

/**
 * Runtime execution metadata tracked per prompt.
 */
export interface PromptRuntimeMetadata extends ExecutionProperties {
  /** Session ID returned by CLI */
  sessionId?: string;

  /** Timestamp when prompt started */
  startedAt: number;

  /** Timestamp when prompt completed */
  completedAt?: number;

  /** Retry count if applicable */
  retryCount?: number;
}
```

**Key Benefits:**

- ✅ Single definition of execution properties (DRY)
- ✅ Type safety: TypeScript enforces consistency
- ✅ Schema validation: JSON schema validates all levels
- ✅ Easy to extend: Add new property once, available everywhere

---

## 3. Property Resolution Logic

### 3.1 Resolution Algorithm

**New file:** `src/utils/PropertyResolver.ts`

```typescript
import { PromptFile, PromptItem, Provider } from "../types/FlightPathTypes";
import { ConfigurationUtils } from "./ConfigurationUtils";

/**
 * Resolved execution properties with precedence applied
 */
export interface ResolvedProperties {
  provider: Provider;
  model: string;
  agent?: string;
  newChatSession: boolean;
  allowDynamicExtension: boolean;
}

/**
 * Property resolution with three-tier precedence:
 * 1. Prompt-level (highest)
 * 2. Workflow-level
 * 3. VS Code settings (lowest/fallback)
 */
export class PropertyResolver {
  /**
   * Resolve all execution properties for a prompt.
   *
   * Precedence order:
   * - Prompt property if defined (highest priority)
   * - Workflow property if defined
   * - VS Code global setting (fallback)
   *
   * @param prompt The prompt to resolve properties for
   * @param workflow The parent workflow file
   * @returns Fully resolved properties
   */
  static resolve(prompt: PromptItem, workflow: PromptFile): ResolvedProperties {
    return {
      provider: this.resolveProvider(prompt, workflow),
      model: this.resolveModel(prompt, workflow),
      agent: this.resolveAgent(prompt, workflow),
      newChatSession: this.resolveNewChatSession(prompt, workflow),
      allowDynamicExtension: this.resolveAllowDynamicExtension(
        prompt,
        workflow
      ),
    };
  }

  /**
   * Resolve provider with three-tier precedence
   */
  private static resolveProvider(
    prompt: PromptItem,
    workflow: PromptFile
  ): Provider {
    // 1. Prompt-level override
    if (prompt.provider !== undefined) {
      return prompt.provider;
    }

    // 2. Workflow-level default
    if (workflow.provider !== undefined) {
      return workflow.provider;
    }

    // 3. VS Code setting fallback
    return ConfigurationUtils.getProvider();
  }

  /**
   * Resolve model with three-tier precedence
   */
  private static resolveModel(
    prompt: PromptItem,
    workflow: PromptFile
  ): string {
    // 1. Prompt-level override
    if (prompt.model !== undefined) {
      return prompt.model;
    }

    // 2. Workflow-level default
    if (workflow.model !== undefined) {
      return workflow.model;
    }

    // 3. VS Code setting fallback (provider-specific)
    const provider = this.resolveProvider(prompt, workflow);
    return ConfigurationUtils.getModelForProvider(provider);
  }

  /**
   * Resolve agent with three-tier precedence
   */
  private static resolveAgent(
    prompt: PromptItem,
    workflow: PromptFile
  ): string | undefined {
    // 1. Prompt-level override
    if (prompt.agent !== undefined) {
      return prompt.agent;
    }

    // 2. Workflow-level default
    if (workflow.agent !== undefined) {
      return workflow.agent;
    }

    // 3. No VS Code setting for agent (returns undefined)
    return undefined;
  }

  /**
   * Resolve newChatSession with three-tier precedence
   */
  private static resolveNewChatSession(
    prompt: PromptItem,
    workflow: PromptFile
  ): boolean {
    // 1. Prompt-level override
    if (prompt.newChatSession !== undefined) {
      return prompt.newChatSession;
    }

    // 2. Workflow-level default
    if (workflow.newChatSession !== undefined) {
      return workflow.newChatSession;
    }

    // 3. VS Code setting fallback
    return ConfigurationUtils.shouldStartNewChatSessionPerPrompt();
  }

  /**
   * Resolve allowDynamicExtension with three-tier precedence
   */
  private static resolveAllowDynamicExtension(
    prompt: PromptItem,
    workflow: PromptFile
  ): boolean {
    // 1. Prompt-level override
    if (prompt.allowDynamicExtension !== undefined) {
      return prompt.allowDynamicExtension;
    }

    // 2. Workflow-level default
    if (workflow.allowDynamicExtension !== undefined) {
      return workflow.allowDynamicExtension;
    }

    // 3. No VS Code setting (returns false)
    return false;
  }

  /**
   * Resolve end condition with two-tier precedence.
   * Note: End conditions are NOT inherited from VS Code settings.
   *
   * @param prompt The prompt to resolve end condition for
   * @param workflow The parent workflow file
   * @returns Resolved end condition or undefined
   */
  static resolveEndCondition(
    prompt: PromptItem,
    workflow: PromptFile
  ): EndCondition | undefined {
    // 1. Prompt-level override (highest priority)
    if (prompt.endCondition !== undefined) {
      return prompt.endCondition;
    }

    // 2. Workflow-level default
    if (workflow.endCondition !== undefined) {
      return workflow.endCondition;
    }

    // 3. No fallback - end conditions are explicit
    return undefined;
  }
}
```

### 3.2 Integration Points

**Update:** `src/flightpath/FlightPathManager.ts`

```typescript
// In executeNextPrompt() method:
const currentPrompt = this.queue.getCurrentPrompt();
const workflowFile = this.queue.getWorkflowFile();

// Resolve all properties with precedence
const resolved = PropertyResolver.resolve(currentPrompt, workflowFile);

// Pass resolved properties to integration
await this.integration.sendPrompt(currentPrompt, true, {
  promptIndex: this.queue.getCurrentIndex(),
  allPrompts: this.queue.getAllPrompts(),
  filePath: this.queue.getWorkflowFilePath(),
  resolvedProperties: resolved, // NEW
});
```

---

## 4. UX Design: Workflow Properties Panel

### 4.1 Problem Statement

Adding workflow-level properties creates UI confusion:

- **VS Code Settings**: Global defaults for all workflows
- **Prompt Drawer**: Per-prompt overrides
- **Workflow Properties**: ??? (new, unclear where to put)

**Challenge:** Avoid duplicate UI elements while maintaining clarity about which settings apply where.

### 4.2 Solution: Repurpose Settings Panel as Workflow Properties

**Transform `settings.html` into a workflow-focused configuration panel:**

- **Purpose**: Configure THIS workflow's default properties
- **Scope**: Properties save to working file (single source of truth for workflow state)
- **Global Settings**: Accessible via "More Settings..." button (opens VS Code settings UI)
- **Special Case**: Execution Mode gets quick access (frequently toggled, updates global setting)

**Clear Mental Model:**

- **settings.html** → Workflow Properties (what applies to THIS workflow)
- **VS Code Settings** → Global Defaults (what applies to ALL workflows)
- **Prompt Drawer** → Per-Prompt Overrides (what applies to ONE prompt)

### 4.3 Visual Design

```
┌──────────────────────────────────────────────────────────┐
│  Workflow Properties                                      │
│  Configure defaults for all prompts in this workflow      │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  Provider:  [Copilot CLI ▼]  [Set as Default] ⚙️        │ ← Differs from global
│                                                           │
│  Model:     [Claude Sonnet 4.5 ▼]                        │ ← Matches global (no button)
│                                                           │
│  Agent:     [code-reviewer ▼]  [Set as Default] ⚙️       │ ← Differs from global
│                                                           │
│  Resume Session: [Yes ▼]                               │ ← Matches global (no button)
│                                                           │
│  Allow Dynamic Extension: [No ▼]  [Set as Default] ⚙️    │ ← Differs from global
│                                                           │
│  ─────────────────────────────────────────────────────── │
│                                                           │
│  End Condition (workflow-wide):                          │
│    [×] Apply validation to all prompts                   │
│                                                           │
│    Script:   [npm test                              ]    │
│    Returns:  [true        ]  Timeout: [30000      ]     │
│    Retries:  [2           ]                              │
│    Retry Prompt: [                                  ]    │
│                  [Tests failed: {error}             ]    │
│                  [Please fix before proceeding.     ]    │
│                                                           │
├──────────────────────────────────────────────────────────┤
│  Session Settings (Quick Access)                         │
├──────────────────────────────────────────────────────────┤
│                                                           │
│  Execution Mode:  ⚪ Interactive  ⚫ Headless            │ ← Updates global, not workflow
│                                                           │
│  ℹ️  Frequently toggled during development. Updates      │
│     global setting (applies to all workflows).           │
│                                                           │
├──────────────────────────────────────────────────────────┤
│                      [More Settings...]                   │ ← Opens VS Code settings
└──────────────────────────────────────────────────────────┘
```

### 4.4 "Set as Default" Button Behavior

**Shows when:** Workflow property value differs from current VS Code global setting

**Click action:**

1. Updates VS Code setting to match workflow value
2. Button changes to "✓ Default" with checkmark animation (2 seconds)
3. Button fades out and disappears (now matches global)
4. User sees visual confirmation without clutter

**Tooltip:** "Set this as the default for all workflows"

**Example Flow:**

```
Initial State:
- Workflow: provider = "claude-cli"
- VS Code Setting: provider = "copilot-cli"
- UI Shows: Provider: [Claude CLI ▼] [Set as Default]

User clicks "Set as Default":
1. VS Code setting updates: copilot-cli → claude-cli
2. Button animates: [Set as Default] → [✓ Default]
3. After 2 seconds: Button fades out
4. UI Shows: Provider: [Claude CLI ▼]  (no button, matches global)
```

### 4.5 Execution Mode (Special Case)

**Why it's special:**

- NOT a workflow property (doesn't save to working file)
- Frequently toggled during development (interactive ↔ headless)
- Session-specific preference, not workflow-specific

**Behavior:**

- Radio buttons for quick toggle
- Updates VS Code global setting immediately
- Applies to all future executions (across all workflows)
- Shown in separate "Session Settings" section with explanation

### 4.6 Benefits of This Approach

✅ **Clear Separation of Concerns**

- settings.html = workflow configuration
- VS Code settings = global defaults
- No confusion about "which settings am I editing?"

✅ **Leverage VS Code's Built-in Settings UI**

- Powerful search, categories, descriptions
- Users already know how to use it
- Don't duplicate effort building advanced settings UI

✅ **"Set as Default" is Familiar Pattern**

- Browsers: "Make default browser"
- Apps: "Set as default program"
- Clear, actionable, well-understood

✅ **Contextual Button Visibility**

- Button only appears when needed (differs from global)
- Reduces visual clutter
- Provides clear path to sync workflow ↔ global

✅ **Execution Mode Quick Access**

- Frequently used, stays accessible
- Clear that it updates global setting (not workflow)

✅ **Simplified Implementation**

- No tab switching logic
- Simple comparison: workflow value vs global value
- Conditional button rendering

### 4.7 HTML Structure

```html
<div id="settings-app">
  <div class="panel-header">
    <h2>Workflow Properties</h2>
    <p class="panel-description">
      Configure defaults for all prompts in this workflow. Changes save to the
      working file.
    </p>
  </div>

  <!-- Workflow Properties Section -->
  <div class="workflow-properties">
    <!-- Provider -->
    <div class="setting-group">
      <label for="workflow-provider">Provider</label>
      <div class="setting-input-row">
        <select id="workflow-provider">
          <option value="copilot-cli">Copilot CLI</option>
          <option value="copilot-chat">Copilot Chat</option>
          <option value="claude-cli">Claude CLI</option>
          <option value="codex-cli">Codex CLI</option>
        </select>
        <button
          class="btn-set-default"
          data-property="provider"
          title="Set this as the default for all workflows"
          hidden
        >
          Set as Default
        </button>
      </div>
      <span class="setting-description">AI provider for execution</span>
    </div>

    <!-- Model -->
    <div class="setting-group">
      <label for="workflow-model">Model</label>
      <div class="setting-input-row">
        <select id="workflow-model">
          <!-- Populated dynamically based on provider -->
        </select>
        <button
          class="btn-set-default"
          data-property="model"
          title="Set this as the default for all workflows"
          hidden
        >
          Set as Default
        </button>
      </div>
      <span class="setting-description">AI model for execution</span>
    </div>

    <!-- Agent -->
    <div class="setting-group">
      <label for="workflow-agent">Agent</label>
      <div class="setting-input-row">
        <select id="workflow-agent">
          <option value="">None</option>
          <!-- Populated dynamically from .agent.md files -->
        </select>
        <button
          class="btn-set-default"
          data-property="agent"
          title="Set this as the default for all workflows"
          hidden
        >
          Set as Default
        </button>
      </div>
      <span class="setting-description">Custom agent file</span>
    </div>

    <!-- Resume Session -->
    <div class="setting-group">
      <label for="workflow-new-chat">Resume Session Per Prompt</label>
      <div class="setting-input-row">
        <select id="workflow-new-chat">
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
        <button
          class="btn-set-default"
          data-property="newChatSession"
          title="Set this as the default for all workflows"
          hidden
        >
          Set as Default
        </button>
      </div>
      <span class="setting-description">
        Start fresh chat session for each prompt
      </span>
    </div>

    <!-- Allow Dynamic Extension -->
    <div class="setting-group">
      <label for="workflow-dynamic-ext">Allow Dynamic Extension</label>
      <div class="setting-input-row">
        <select id="workflow-dynamic-ext">
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
        <button
          class="btn-set-default"
          data-property="allowDynamicExtension"
          title="Set this as the default for all workflows"
          hidden
        >
          Set as Default
        </button>
      </div>
      <span class="setting-description">
        Allow prompts to extend the workflow queue
      </span>
    </div>

    <!-- Workflow-Wide End Condition -->
    <div class="setting-group">
      <label class="checkbox-label">
        <input type="checkbox" id="workflow-end-enabled" />
        <span>Apply end condition to all prompts</span>
      </label>

      <div id="workflow-end-details" class="end-condition-details" hidden>
        <div class="end-condition-help">
          Validation runs after each prompt completes. Individual prompts can
          override or disable this.
        </div>

        <label for="workflow-end-script">Script:</label>
        <input type="text" id="workflow-end-script" placeholder="npm test" />

        <label for="workflow-end-returns">Returns:</label>
        <input type="text" id="workflow-end-returns" placeholder="true" />

        <label for="workflow-end-timeout">Timeout (ms):</label>
        <input
          type="number"
          id="workflow-end-timeout"
          value="30000"
          min="1000"
        />

        <label for="workflow-end-retries">Max Retries:</label>
        <input type="number" id="workflow-end-retries" value="0" min="-1" />

        <label for="workflow-end-retry-prompt">Retry Prompt:</label>
        <textarea
          id="workflow-end-retry-prompt"
          rows="3"
          placeholder="Validation failed: {error}&#10;&#10;Please fix the issues."
        ></textarea>
      </div>
    </div>
  </div>

  <!-- Session Settings (Quick Access) -->
  <div class="session-settings">
    <h3>Session Settings (Quick Access)</h3>
    <p class="section-description">
      <i class="codicon codicon-info"></i>
      Frequently toggled during development. Updates global setting.
    </p>

    <div class="setting-group">
      <label>Execution Mode</label>
      <div class="radio-group">
        <label class="radio-label">
          <input
            type="radio"
            name="execution-mode"
            value="interactive"
            checked
          />
          <span>Interactive</span>
        </label>
        <label class="radio-label">
          <input type="radio" name="execution-mode" value="headless" />
          <span>Headless</span>
        </label>
      </div>
      <span class="setting-description">
        Interactive shows terminal, headless runs in background
      </span>
    </div>
  </div>

  <!-- More Settings Button -->
  <div class="more-settings-container">
    <button
      id="more-settings-btn"
      class="more-settings-btn"
      title="Open FlightPath settings in VS Code for advanced configuration"
    >
      <i class="codicon codicon-settings-gear"></i>
      <span>More Settings...</span>
    </button>
  </div>
</div>
```

---

## 5. Example Workflows

### 5.1 Workflow with Global End Condition

**Use Case:** All prompts must pass tests

```yaml
# All prompts inherit this end condition
provider: copilot-cli
model: claude-sonnet-4.5
endCondition:
  script: npm test
  returns: "true"
  maxRetries: 2
  retryPrompt: |
    Tests failed: {error}

    Please fix the failing tests before proceeding.

prompts:
  - id: implement-feature
    prompt: "Implement the new user authentication feature"
    # Inherits workflow end condition

  - id: add-tests
    prompt: "Add comprehensive tests for authentication"
    # Inherits workflow end condition

  - id: update-docs
    prompt: "Update documentation"
    endCondition: null # Override: No validation for docs
```

### 5.2 Workflow with Shared Provider/Model

**Use Case:** Reproducible workflow for code review

```yaml
# Workflow defaults ensure consistency across users
provider: claude-cli
model: sonnet
agent: code-reviewer
newChatSession: true # Fresh session per prompt

prompts:
  - id: security-review
    prompt: "Review this code for security vulnerabilities"
    # Uses: claude-cli, sonnet, code-reviewer agent

  - id: performance-review
    prompt: "Analyze performance bottlenecks"
    # Uses: claude-cli, sonnet, code-reviewer agent

  - id: style-review
    prompt: "Check code style and best practices"
    model: haiku # Override: Use faster model for style checks
    # Uses: claude-cli, haiku (overridden), code-reviewer agent
```

### 5.3 Mixed Precedence Example

```yaml
# Workflow level
provider: copilot-cli
model: claude-sonnet-4.5
newChatSession: false

prompts:
  - id: analyze
    prompt: "Analyze the codebase"
    # Effective: copilot-cli, claude-sonnet-4.5, newChatSession=false

  - id: implement
    prompt: "Implement improvements"
    model: gpt-5 # Override model
    # Effective: copilot-cli, gpt-5 (overridden), newChatSession=false

  - id: review
    prompt: "Review changes"
    provider: claude-cli # Override provider
    model: opus # Override model
    newChatSession: true # Override session
    # Effective: claude-cli (overridden), opus (overridden), newChatSession=true (overridden)
    # All workflow defaults overridden at prompt level
```

---

## 6. Implementation Plan

### Phase 1: Schema Updates

**Files to modify:**

1. `schemas/prompt-schema.json`
   - Define `executionProperties` in definitions
   - Update `promptFile` to extend `executionProperties` using `allOf`
   - Update `promptItem` to extend `executionProperties` using `allOf`
   - Update `promptRuntimeMetadata` to extend `executionProperties` using `allOf`

2. `src/types/FlightPathTypes.ts`
   - Add `ExecutionProperties` interface
   - Update `PromptFile` to extend `ExecutionProperties`
   - Update `PromptItem` to extend `ExecutionProperties`
   - Update `PromptRuntimeMetadata` to extend `ExecutionProperties`

3. Run `npm run generate-schema` to regenerate YAML schema

**Testing:**

- Validate schema accepts workflow-level properties
- Test `$ref` inheritance works correctly
- Ensure backward compatibility (old files without workflow properties)

### Phase 2: Property Resolution Logic

**New file:** `src/utils/PropertyResolver.ts`

Implement:

- `resolve()` - Main resolution with three-tier precedence
- `resolveProvider()` - Provider resolution
- `resolveModel()` - Model resolution
- `resolveAgent()` - Agent resolution
- `resolveNewChatSession()` - Session setting resolution
- `resolveAllowDynamicExtension()` - Dynamic queue resolution
- `resolveEndCondition()` - End condition resolution

**Testing:**

- Unit tests for all resolution paths
- Test precedence order (prompt > workflow > settings)
- Test undefined/null handling at each level
- Test provider-specific model defaults

### Phase 3: Integration Updates

**Files to modify:**

1. `src/flightpath/FlightPathManager.ts`
   - Import PropertyResolver
   - Call `PropertyResolver.resolve()` before sending prompt
   - Pass resolved properties to integration

2. `src/flightpath/PromptQueue.ts`
   - Store workflow file (not just prompts)
   - Expose `getWorkflowFile()` method

3. `src/flightpath/PromptFileParser.ts`
   - Parse workflow-level properties from YAML/JSON
   - Validate workflow properties against schema

**Testing:**

- Test property resolution in real workflow execution
- Test workflow file parsing with properties
- Test backward compatibility (files without workflow properties)

### Phase 4: UI Implementation - Workflow Properties Panel

**Files to modify:**

1. `src/ui/webview/settings.html`
   - Update title: "Workflow Properties"
   - Update description: "Configure defaults for all prompts in this workflow"
   - Add "Set as Default" button to each setting row
   - Add workflow end condition section (checkbox + details)
   - Add "Session Settings" section for Execution Mode
   - Keep "More Settings..." button at bottom

2. `src/ui/webview/settings.js`
   - Remove global settings logic (moved to VS Code native settings)
   - Load workflow properties from active working file
   - Implement "Set as Default" button logic:
     - Compare workflow value vs global setting
     - Show button when different, hide when same
     - On click: update VS Code setting, animate button, fade out
   - Save workflow property changes to working file (single source of truth)
   - **Always write provider and model** to working file (required for execution)
   - Other properties written when explicitly set by user
   - Handle Execution Mode separately (updates global setting, not workflow)
   - Disable all fields when no workflow loaded

3. `src/ui/webview/settings.scss`
   - Style "Set as Default" button (inline with select/input)
   - Button animation (fade in/out, checkmark transition)
   - Session Settings section styling (distinct from workflow properties)
   - Disabled state styling when no workflow loaded

4. `src/ui/FlightPathSettingsProvider.ts`
   - New message: `updateWorkflowProperty` (saves to workflow file)
   - New message: `setAsDefault` (updates VS Code setting)
   - On webview ready: Send both workflow properties AND global settings
   - On workflow change: Send updated workflow properties

**Testing:**

- Test "Set as Default" button shows/hides correctly
- Test "Set as Default" updates VS Code setting
- Test button animation and fade out
- Test workflow property updates save to file
- Test Execution Mode updates global setting (not workflow)
- Test all fields disabled when no workflow loaded
- Test comparison logic (workflow vs global values)

### Phase 5: Dashboard Integration

**Files to modify:**

1. `src/ui/webview/dashboard.js`
   - When loading workflow, send workflow properties from working file to settings panel
   - When saving workflow, always include provider and model in working file
   - When creating new workflow, initialize working file with provider and model from global settings
   - Notify settings panel when workflow changes (re-enable fields)

2. `src/ui/FlightPathDashboardProvider.ts`
   - Message handler: Forward workflow properties to settings panel
   - Save working file with provider/model always included (required for execution)
   - Other properties included when explicitly set
   - On workflow load: Send workflow properties from working file to settings webview
   - On workflow create: Initialize working file with provider and model from globals

**Testing:**

- Test workflow load includes properties from working file and enables settings panel
- Test workflow save always includes provider and model
- Test new workflow creation initializes with provider and model from globals
- Test optional properties (agent, endCondition) only written when set
- Test settings panel reflects current working file properties
- Test settings panel disabled when no workflow loaded
- Test property changes write to working file immediately
- Test working file remains complete source of truth during execution

### Phase 6: Documentation & Examples

**Files to create/update:**

1. `docs/WORKFLOW_PROPERTIES.md` - Complete workflow properties guide
2. `manual-test/workflow-properties-examples/` - Example workflows
   - `shared-end-condition.flightpath.yaml`
   - `shared-provider-model.flightpath.yaml`
   - `mixed-precedence.flightpath.yaml`

3. Update existing docs:
   - `README.md` - Add workflow properties section
   - `.github/copilot-instructions.md` - Update property resolution docs

---

## 7. Backward Compatibility

### Breaking Changes

**None.** This is an additive feature:

1. **New workflow-level properties** - Optional, existing files work without them
2. **Property resolution** - Falls back gracefully to current behavior
3. **UI changes** - Settings panel is still settings panel, just enhanced

### Migration Strategy

**For users:** No action required. Existing workflows continue working:

- Without workflow properties → Current behavior (prompt > settings)
- With workflow properties → New precedence (prompt > workflow > settings)

**Gradual adoption:**

1. Users can start adding workflow properties to new workflows
2. Existing workflows continue using current precedence
3. Settings panel gains workflow tab when workflow loaded

---

## 8. Open Questions & Decisions

### Q: Should workflow properties be saved in working files?

**Current:** Working files store runtime state, not configuration

**Decision:** YES, working files are the single source of truth for ALL properties (both runtime state AND workflow configuration).

**Reasoning:**

- Working file represents complete state of the workflow execution
- Enables LLMs to modify workflow properties during execution
- **Always includes provider and model** (required for execution)
- Other properties (agent, endCondition, newChatSession, allowDynamicExtension) included when set
- Source file (`.flightpath.yaml`) is template, working file is active state
- Users can use templates for workflows with pre-configured end conditions
- Future: May add MCP function for changing workflow properties programmatically

### Q: Should "More Settings" button still open VS Code settings?

**Current:** "More Settings" button opens VS Code settings JSON

**Decision:** Yes, keep this behavior. Workflow tab handles common settings, VS Code settings handles advanced settings (tool permissions, timeouts, etc.)

**Reasoning:**

- Many advanced settings don't make sense at workflow level
- VS Code settings is still the canonical location for global config
- Workflow properties are convenience layer for reproducibility

### Q: Should workflow properties override be visualized in prompt drawer?

**Decision:** Out of scope for initial implementation.

**Note:** Prompt properties drawer already has "default" as an option for each field. When "default" is selected, the prompt uses workflow-level or global settings. Showing resolved hints is deferred to future enhancement.

---

## 9. Success Metrics

- ✅ Workflow files can include provider, model, agent, newChatSession, allowDynamicExtension, endCondition
- ✅ Property resolution follows three-tier precedence correctly
- ✅ Settings panel transforms into workflow properties editor
- ✅ Working file is single source of truth for ALL properties (runtime + configuration)
- ✅ Working file always includes provider and model (required for execution)
- ✅ Optional properties included when explicitly set by user
- ✅ Backward compatibility: Old workflows work without changes
- ✅ Shared workflows are more reproducible (include their own defaults)
- ✅ Workflow templates support pre-configured end conditions
- ✅ LLMs can modify workflow properties by editing working file

---

## 10. Alternative UX Designs Considered

### Alternative 1: Tabbed Settings Panel

**Description:** Transform settings panel into dual-purpose UI with "Global Settings" and "Workflow Defaults" tabs

**Pros:**

- Clear context (tab labels)
- Familiar pattern (tabs)
- Can see which settings apply where

**Cons:**

- Duplicates fields across tabs (same dropdowns in two places)
- Adds complexity (tab switching logic)
- Confusing: "Am I editing global or workflow settings?"
- Doesn't leverage VS Code's powerful built-in settings UI
- Creates unnecessary parallel UI for global settings

**Rejected:** Creates confusion, duplicates VS Code settings unnecessarily

### Alternative 2: Separate Workflow Properties Drawer

**Description:** Add a third drawer (like prompt properties) that opens from workflow header

**Pros:**

- Clear separation from global settings
- Familiar pattern (same as prompt drawer)

**Cons:**

- Three separate UI locations for similar fields (confusing)
- Workflow header is already crowded
- Drawer positioning unclear (workflow-level, not prompt-level)
- User confusion: "Where do I find the settings I need?"

**Rejected:** Too much UI clutter, unclear positioning

### Alternative 3: Inline in Workflow Header

**Description:** Add dropdown menus directly in workflow header/status area

**Pros:**

- Always visible
- Quick access

**Cons:**

- Clutters header area
- Doesn't scale (can't fit all fields)
- No room for descriptions/help text
- Can't include end condition configuration

**Rejected:** Doesn't scale, too cluttered

### Alternative 4: Modal Dialog

**Description:** Click workflow name → opens modal with all workflow properties

**Pros:**

- Clear context (modal title: "Workflow Properties")
- Can fit all fields with descriptions

**Cons:**

- Modal interrupts workflow (not inline)
- Extra click to open/close
- Can't see settings and workflow side-by-side
- Feels heavyweight for quick property changes

**Rejected:** Less discoverable, interrupts workflow

### Why "Set as Default" Button Pattern Won

✅ **Clear Separation of Concerns**

- settings.html = workflow (one purpose)
- VS Code settings = global (familiar, powerful)
- No confusion about "which UI am I using?"

✅ **Leverage Existing VS Code UI**

- Built-in settings UI is feature-rich (search, categories, validation)
- Don't duplicate effort
- Users already know how to use it

✅ **Familiar Pattern**

- "Set as Default" is well-understood (browsers, apps, OS)
- Clear action: "I like this workflow's settings, use them everywhere"

✅ **Contextual Visibility**

- Button only appears when workflow ≠ global
- Reduces visual clutter
- Clear path to sync settings

✅ **Simpler Implementation**

- No tab logic
- Simple value comparison
- Conditional button rendering

✅ **Better User Experience**

- Execution Mode quick access (frequently toggled)
- Clear explanations (which settings affect what)
- Progressive disclosure (end condition details)

---

**End of Planning Document**
