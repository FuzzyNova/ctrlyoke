import { describe, it, expect, beforeEach } from "vitest";
import {
  useEditorStore,
  PROPERTY_DEFAULTS,
  END_CONDITION_DEFAULTS,
} from "@store/editorStore";
import {
  FINAL_STEP_PHASES,
  PROMPT_EDITOR_INSERT_MODES,
} from "@/types/messages";
import { STEP_TYPES } from "@root/types/DashboardConstants";
import type { PromptStep } from "@/types/messages";
import type { ScriptStep } from "@root/types/WebviewMessageTypes";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function store() {
  return useEditorStore.getState();
}

function makePromptStep(overrides: Partial<PromptStep> = {}): PromptStep {
  return {
    prompt: "Do something useful",
    name: "My Prompt",
    harness: "claude-cli",
    model: "claude-opus-4",
    ...overrides,
  };
}

function makeScriptStep(overrides: Partial<ScriptStep> = {}): ScriptStep {
  return {
    type: STEP_TYPES.SCRIPT,
    script: "npm test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  store().resetEditor();
});

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe("initial state", () => {
  it("starts in new prompt mode", () => {
    expect(store().selectionTarget.kind).toBe("newPrompt");
    expect(store().selectedPromptIndex).toBeNull();
    expect(store().isNewPromptMode()).toBe(true);
    expect(store().isEditMode()).toBe(false);
  });

  it("starts with empty prompt text and clean state", () => {
    expect(store().promptText).toBe("");
    expect(store().stepEnabled).toBe(true);
    expect(store().isDirty).toBe(false);
    expect(store().hasContent()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Content updates
// ---------------------------------------------------------------------------

describe("setPromptText", () => {
  it("updates promptText and marks dirty", () => {
    store().setPromptText("Analyze the codebase");
    expect(store().promptText).toBe("Analyze the codebase");
    expect(store().isDirty).toBe(true);
    expect(store().hasContent()).toBe(true);
  });

  it("hasContent returns false for whitespace-only text", () => {
    store().setPromptText("   ");
    expect(store().hasContent()).toBe(false);
  });
});

describe("setPromptName", () => {
  it("updates promptName and marks dirty", () => {
    store().setPromptName("Step 1");
    expect(store().promptName).toBe("Step 1");
    expect(store().isDirty).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property updates
// ---------------------------------------------------------------------------

describe("setProperty", () => {
  it("updates a single property and marks dirty", () => {
    store().setProperty("harness", "copilot-cli");
    expect(store().properties.harness).toBe("copilot-cli");
    expect(store().isDirty).toBe(true);
  });

  it("does not affect other properties", () => {
    store().setProperty("model", "gpt-5");
    expect(store().properties.harness).toBe(PROPERTY_DEFAULTS.harness);
    expect(store().properties.model).toBe("gpt-5");
  });
});

describe("setProperties", () => {
  it("merges multiple properties at once", () => {
    store().setProperties({ harness: "claude-cli", model: "claude-opus-4" });
    expect(store().properties.harness).toBe("claude-cli");
    expect(store().properties.model).toBe("claude-opus-4");
    expect(store().isDirty).toBe(true);
  });
});

describe("resetProperties", () => {
  it("resets properties back to defaults", () => {
    store().setProperty("harness", "claude-cli");
    store().setProperty("model", "gpt-5");
    store().resetProperties();
    expect(store().properties).toEqual(PROPERTY_DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// End condition management
// ---------------------------------------------------------------------------

describe("setEndCondition", () => {
  it("sets end condition and marks dirty", () => {
    store().setEndCondition({ script: "npm test", returns: "true" });
    expect(store().properties.endCondition?.script).toBe("npm test");
    expect(store().isDirty).toBe(true);
    expect(store().hasEndCondition()).toBe(true);
  });

  it("accepts null to disable end condition", () => {
    store().setEndCondition({ script: "npm test", returns: "true" });
    store().setEndCondition(null);
    expect(store().properties.endCondition).toBeNull();
    expect(store().hasEndCondition()).toBe(false);
  });
});

describe("updateEndConditionField", () => {
  it("updates a single field using defaults as base when none set", () => {
    store().updateEndConditionField("script", "pytest");
    expect(store().properties.endCondition?.script).toBe("pytest");
    expect(store().properties.endCondition?.maxRetries).toBe(
      END_CONDITION_DEFAULTS.maxRetries
    );
  });

  it("updates maxRetries without touching other fields", () => {
    store().setEndCondition({ script: "npm test", returns: "true" });
    store().updateEndConditionField("maxRetries", 3);
    expect(store().properties.endCondition?.script).toBe("npm test");
    expect(store().properties.endCondition?.maxRetries).toBe(3);
  });
});

describe("clearEndCondition", () => {
  it("sets endCondition to undefined", () => {
    store().setEndCondition({ script: "npm test", returns: "true" });
    store().clearEndCondition();
    expect(store().properties.endCondition).toBeUndefined();
    expect(store().hasEndCondition()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mode switching
// ---------------------------------------------------------------------------

describe("enterEditMode", () => {
  it("switches to edit mode and loads prompt data", () => {
    const item = makePromptStep({ prompt: "Fix bugs", name: "Fix Step" });
    store().enterEditMode(0, item);

    expect(store().selectionTarget).toEqual({
      kind: FINAL_STEP_PHASES.QUEUE,
      index: 0,
    });
    expect(store().selectedPromptIndex).toBe(0);
    expect(store().promptText).toBe("Fix bugs");
    expect(store().promptName).toBe("Fix Step");
    expect(store().isEditMode()).toBe(true);
    expect(store().isNewPromptMode()).toBe(false);
  });

  it("loads harness and model properties from prompt data", () => {
    const item = makePromptStep({ harness: "codex-cli", model: "gpt-5" });
    store().enterEditMode(2, item);
    expect(store().properties.harness).toBe("codex-cli");
    expect(store().properties.model).toBe("gpt-5");
  });

  it("loads prompt-level error behavior from prompt data", () => {
    store().enterEditMode(
      1,
      makePromptStep({
        errorBehavior: {
          onError: "retry",
          maxRetries: 2,
          retryDelaySec: 1,
        },
      })
    );

    expect(store().properties.errorBehavior).toEqual({
      onError: "retry",
      maxRetries: 2,
      retryDelaySec: 1,
    });
  });

  it("normalizes legacy null error behavior to stop when loading prompt data", () => {
    store().enterEditMode(1, makePromptStep({ errorBehavior: null }));

    expect(store().properties.errorBehavior).toEqual({
      onError: "stopWorkflow",
    });
  });

  it("loads disabled state from the step payload", () => {
    store().enterEditMode(2, makePromptStep({ enabled: false }));
    expect(store().stepEnabled).toBe(false);
  });

  it("saves new-prompt draft as savedNewPromptState", () => {
    store().setPromptText("Draft text");
    store().enterEditMode(0, makePromptStep());
    expect(store().savedNewPromptState?.promptText).toBe("Draft text");
  });

  it("marks isDirty=false for a fresh (non-pending) load", () => {
    store().enterEditMode(0, makePromptStep());
    expect(store().isDirty).toBe(false);
  });
});

describe("cancelEdit", () => {
  it("returns to new prompt mode", () => {
    store().enterEditMode(0, makePromptStep());
    store().cancelEdit();
    expect(store().isNewPromptMode()).toBe(true);
    expect(store().selectedPromptIndex).toBeNull();
  });

  it("restores the saved new-prompt draft", () => {
    store().setPromptText("Draft before editing");
    store().enterEditMode(0, makePromptStep());
    store().cancelEdit();
    expect(store().promptText).toBe("Draft before editing");
  });

  it("clears the pending edit for the cancelled prompt", () => {
    // Enter edit mode, modify text, then deselect (stores pending edit), re-enter
    store().enterEditMode(0, makePromptStep());
    store().setPromptText("Unsaved change");
    store().deselect(); // stores pending edit for queue:0

    // Re-enter and cancel — should clear pending edit
    store().enterEditMode(0, makePromptStep());
    store().cancelEdit();
    expect(store().pendingEdits["queue:0"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dirty state
// ---------------------------------------------------------------------------

describe("setDirty / markClean", () => {
  it("setDirty sets isDirty to given value", () => {
    store().setDirty(true);
    expect(store().isDirty).toBe(true);
  });

  it("markClean sets isDirty to false", () => {
    store().setPromptText("something");
    store().markClean();
    expect(store().isDirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateRequired", () => {
  it("returns false and sets error when promptText is empty", () => {
    const valid = store().validateRequired();
    expect(valid).toBe(false);
    expect(store().validationErrors["promptText"]).toBeTruthy();
  });

  it("returns true when promptText has content", () => {
    store().setPromptText("Analyze the codebase");
    const valid = store().validateRequired();
    expect(valid).toBe(true);
    expect(store().validationErrors).toEqual({});
  });
});

describe("setValidationError / clearValidationError", () => {
  it("adds and removes a validation error", () => {
    store().setValidationError("script", "Script path is required");
    expect(store().validationErrors["script"]).toBe("Script path is required");

    store().clearValidationError("script");
    expect(store().validationErrors["script"]).toBeUndefined();
  });
});

describe("clearAllValidationErrors", () => {
  it("removes all errors", () => {
    store().setValidationError("a", "err1");
    store().setValidationError("b", "err2");
    store().clearAllValidationErrors();
    expect(store().validationErrors).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Queue state
// ---------------------------------------------------------------------------

describe("setHasActiveQueue", () => {
  it("toggles hasActiveQueue flag", () => {
    expect(store().hasActiveQueue).toBe(false);
    store().setHasActiveQueue(true);
    expect(store().hasActiveQueue).toBe(true);
  });
});

describe("prompt editor inserts", () => {
  it("switches script mode back to prompt mode before inserting", () => {
    store().setStepType(STEP_TYPES.SCRIPT);

    store().preparePromptEditorForInsert();

    expect(store().selectionTarget.kind).toBe("newPrompt");
    expect(store().stepType).toBe(STEP_TYPES.PROMPT);
  });

  it("keeps edit mode active so an insert lands in the edited step", () => {
    store().setPromptText("Draft before editing");
    store().enterEditMode(0, makePromptStep({ prompt: "Existing prompt" }));

    store().preparePromptEditorForInsert();

    expect(store().selectionTarget.kind).toBe("queue");
    expect(store().promptText).toBe("Existing prompt");
  });

  it("queues and consumes pending insert requests", () => {
    store().enqueuePromptEditorInsert({
      requestId: "insert-1",
      references: ["@src/app.ts"],
      mode: PROMPT_EDITOR_INSERT_MODES.INSERT,
    });

    expect(store().pendingPromptEditorInserts).toHaveLength(1);

    store().consumePromptEditorInsert("insert-1");

    expect(store().pendingPromptEditorInserts).toEqual([]);
  });
});

describe("step enabled state", () => {
  it("preserves a toggled enabled state in pending edits", () => {
    store().enterEditMode(0, makePromptStep({ enabled: false }));
    store().setStepEnabled(true);
    store().deselect();

    store().enterEditMode(0, makePromptStep({ enabled: false }));

    expect(store().stepEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Script step execution mode override
// ---------------------------------------------------------------------------

describe("script step executionMode", () => {
  it("defaults to undefined (inherit) for a new script step", () => {
    store().setStepType(STEP_TYPES.SCRIPT);
    expect(store().scriptExecutionMode).toBeUndefined();
  });

  it("setScriptExecutionMode updates the value and marks dirty", () => {
    store().setScriptExecutionMode("interactive");
    expect(store().scriptExecutionMode).toBe("interactive");
    expect(store().isDirty).toBe(true);
  });

  it("enterEditMode loads executionMode from an existing script step", () => {
    store().enterEditMode(0, makeScriptStep({ executionMode: "headless" }));
    expect(store().scriptExecutionMode).toBe("headless");
  });

  it("enterEditMode leaves executionMode undefined when the step has no override", () => {
    store().enterEditMode(0, makeScriptStep());
    expect(store().scriptExecutionMode).toBeUndefined();
  });

  it("preserves an unsaved executionMode change in pending edits across deselect", () => {
    store().enterEditMode(0, makeScriptStep({ executionMode: "headless" }));
    store().setScriptExecutionMode("interactive");
    store().deselect();

    store().enterEditMode(0, makeScriptStep({ executionMode: "headless" }));

    expect(store().scriptExecutionMode).toBe("interactive");
  });

  it("cancelEdit discards an unsaved executionMode change", () => {
    store().enterEditMode(0, makeScriptStep({ executionMode: "headless" }));
    store().setScriptExecutionMode("interactive");
    store().cancelEdit();

    store().enterEditMode(0, makeScriptStep({ executionMode: "headless" }));

    expect(store().scriptExecutionMode).toBe("headless");
  });

  it("resetEditor clears executionMode back to undefined", () => {
    store().setScriptExecutionMode("interactive");
    store().resetEditor();
    expect(store().scriptExecutionMode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Script step secrets, errorBehavior, and env round-trip
// ---------------------------------------------------------------------------

describe("script step secrets/errorBehavior/env round-trip", () => {
  it("enterEditMode loads secrets from an existing script step", () => {
    store().enterEditMode(
      0,
      makeScriptStep({ secrets: ["API_KEY", "DB_PASSWORD"] })
    );
    expect(store().properties.secrets).toEqual(["API_KEY", "DB_PASSWORD"]);
  });

  it("enterEditMode loads errorBehavior from an existing script step", () => {
    store().enterEditMode(
      0,
      makeScriptStep({ errorBehavior: { onError: "continue" } })
    );
    expect(store().properties.errorBehavior).toEqual({ onError: "continue" });
  });

  it("enterEditMode loads env from an existing script step", () => {
    store().enterEditMode(0, makeScriptStep({ env: { FOO: "bar" } }));
    expect(store().scriptEnv).toEqual({ FOO: "bar" });
  });

  it("enterEditMode leaves secrets/errorBehavior undefined when the step has none", () => {
    store().enterEditMode(0, makeScriptStep());
    expect(store().properties.secrets).toBeUndefined();
    expect(store().properties.errorBehavior).toBeUndefined();
  });

  it("preserves an unsaved secrets change in pending edits across deselect", () => {
    store().enterEditMode(0, makeScriptStep({ secrets: ["API_KEY"] }));
    store().setProperty("secrets", ["OTHER_KEY"]);
    store().deselect();

    store().enterEditMode(0, makeScriptStep({ secrets: ["API_KEY"] }));

    expect(store().properties.secrets).toEqual(["OTHER_KEY"]);
  });
});

// ---------------------------------------------------------------------------
// getPromptProperties
// ---------------------------------------------------------------------------

describe("getPromptProperties", () => {
  it("includes prompt text", () => {
    store().setPromptText("Do a thing");
    expect(store().getPromptProperties().prompt).toBe("Do a thing");
  });

  it("includes name when set", () => {
    store().setPromptText("Do a thing");
    store().setPromptName("My Step");
    expect(store().getPromptProperties().name).toBe("My Step");
  });

  it("omits undefined properties (inherits from workflow)", () => {
    store().setPromptText("Do a thing");
    const props = store().getPromptProperties();
    expect("harness" in props).toBe(false);
    expect("model" in props).toBe(false);
  });

  it("includes explicit harness and model overrides", () => {
    store().setPromptText("Do a thing");
    store().setProperty("harness", "claude-cli");
    store().setProperty("model", "claude-opus-4");
    const props = store().getPromptProperties();
    expect(props.harness).toBe("claude-cli");
    expect(props.model).toBe("claude-opus-4");
  });

  it("includes enabled=false only when the step is disabled", () => {
    store().setPromptText("Do a thing");
    expect("enabled" in store().getPromptProperties()).toBe(false);

    store().setStepEnabled(false);

    expect(store().getPromptProperties().enabled).toBe(false);
  });

  it("includes endCondition when script is non-empty", () => {
    store().setPromptText("Run tests");
    store().setEndCondition({ script: "npm test", returns: "true" });
    expect(store().getPromptProperties().endCondition?.script).toBe("npm test");
  });

  it("omits endCondition when script is empty/blank", () => {
    store().setPromptText("Run tests");
    store().setEndCondition({ script: "  ", returns: "true" });
    expect("endCondition" in store().getPromptProperties()).toBe(false);
  });

  it("includes explicit errorBehavior overrides", () => {
    store().setPromptText("Retry on harness failure");
    store().setProperty("errorBehavior", {
      onError: "continue",
    });

    expect(store().getPromptProperties().errorBehavior).toEqual({
      onError: "continue",
    });
  });

  it("normalizes null errorBehavior overrides to stop", () => {
    store().setPromptText("Stop on harness failure");
    store().setProperty("errorBehavior", null);

    expect(store().properties.errorBehavior).toEqual({
      onError: "stopWorkflow",
    });
    expect(store().getPromptProperties().errorBehavior).toEqual({
      onError: "stopWorkflow",
    });
  });
});

// ---------------------------------------------------------------------------
// Reset
// ---------------------------------------------------------------------------

describe("resetEditor", () => {
  it("clears all editor state back to defaults", () => {
    store().setPromptText("Some text");
    store().setProperty("harness", "claude-cli");
    store().setValidationError("field", "error");
    store().enterEditMode(0, makePromptStep());

    store().resetEditor();

    expect(store().promptText).toBe("");
    expect(store().isDirty).toBe(false);
    expect(store().validationErrors).toEqual({});
    expect(store().isNewPromptMode()).toBe(true);
    expect(store().selectedPromptIndex).toBeNull();
    expect(store().properties).toEqual(PROPERTY_DEFAULTS);
  });
});

describe("resetToDefaults", () => {
  it("clears content and properties without changing selection mode", () => {
    store().enterEditMode(0, makePromptStep({ prompt: "original" }));
    store().setPromptText("edited");
    store().resetToDefaults();

    expect(store().promptText).toBe("");
    expect(store().isDirty).toBe(false);
    expect(store().properties).toEqual(PROPERTY_DEFAULTS);
  });
});
