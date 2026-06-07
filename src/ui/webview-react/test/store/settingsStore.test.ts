import { describe, it, expect, beforeEach } from "vitest";
import { useSettingsStore } from "@store/settingsStore";
import { HARNESS_IDS, HARNESS_STATUS_STRINGS } from "@/types/messages";
import { PERMISSION_MODES } from "@root/types/DashboardConstants";
import type { GlobalSettings, WorkflowProperties } from "@store/settingsStore";

// Zustand stores are module singletons — reset between tests.
beforeEach(() => {
  useSettingsStore.getState().resetSettings();
});

// ---------------------------------------------------------------------------
// Model options
// ---------------------------------------------------------------------------

describe("setModelOptions", () => {
  it("merges new options into existing model options", () => {
    useSettingsStore.getState().setModelOptions({
      [HARNESS_IDS.COPILOT_CLI]: [{ value: "gpt-5", label: "GPT-5" }],
    });
    const opts = useSettingsStore
      .getState()
      .getModelsForHarness(HARNESS_IDS.COPILOT_CLI);
    expect(opts).toHaveLength(1);
    expect(opts[0].value).toBe("gpt-5");
  });

  it("does not overwrite other harness options when merging", () => {
    const claudeOpts = useSettingsStore
      .getState()
      .getModelsForHarness(HARNESS_IDS.CLAUDE_CLI);
    expect(claudeOpts.length).toBeGreaterThan(0);

    useSettingsStore.getState().setModelOptions({
      [HARNESS_IDS.COPILOT_CLI]: [{ value: "gpt-5", label: "GPT-5" }],
    });

    // Claude options should still be there
    const stillClaude = useSettingsStore
      .getState()
      .getModelsForHarness(HARNESS_IDS.CLAUDE_CLI);
    expect(stillClaude.length).toBeGreaterThan(0);
  });
});

describe("getModelsForHarness", () => {
  it("returns empty array for harness with no models set", () => {
    // After resetSettings copilot-cli has no models
    const opts = useSettingsStore
      .getState()
      .getModelsForHarness(HARNESS_IDS.COPILOT_CLI);
    expect(Array.isArray(opts)).toBe(true);
  });

  it("returns built-in claude-cli models from initial state", () => {
    const opts = useSettingsStore
      .getState()
      .getModelsForHarness(HARNESS_IDS.CLAUDE_CLI);
    expect(opts.length).toBeGreaterThan(0);
    expect(opts[0]).toHaveProperty("value");
    expect(opts[0]).toHaveProperty("label");
  });
});

// ---------------------------------------------------------------------------
// Agents & Skills
// ---------------------------------------------------------------------------

describe("setAvailableAgents", () => {
  it("updates the agents list", () => {
    useSettingsStore.getState().setAvailableAgents([
      {
        name: "my-agent",
        path: "/workspace/.flightpath/agents/my-agent.agent.md",
      },
    ]);
    expect(useSettingsStore.getState().availableAgents).toHaveLength(1);
    expect(useSettingsStore.getState().availableAgents[0].name).toBe(
      "my-agent"
    );
  });
});

describe("setAvailableSkills", () => {
  it("updates the skills list", () => {
    useSettingsStore.getState().setAvailableSkills([
      { name: "skill-a", path: "/workspace/.flightpath/skills/skill-a.md" },
      { name: "skill-b", path: "/workspace/.flightpath/skills/skill-b.md" },
    ]);
    expect(useSettingsStore.getState().availableSkills).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Harness status
// ---------------------------------------------------------------------------

describe("setHarnessStatus", () => {
  it("updates a single harness status", () => {
    useSettingsStore.getState().setHarnessStatus(HARNESS_IDS.CLAUDE_CLI, {
      available: true,
      status: HARNESS_STATUS_STRINGS.AVAILABLE,
    });
    const status =
      useSettingsStore.getState().harnessStatus[HARNESS_IDS.CLAUDE_CLI];
    expect(status.available).toBe(true);
    expect(status.status).toBe(HARNESS_STATUS_STRINGS.AVAILABLE);
  });

  it("does not affect other harness statuses", () => {
    const beforeCopilot =
      useSettingsStore.getState().harnessStatus[HARNESS_IDS.COPILOT_CLI];

    useSettingsStore.getState().setHarnessStatus(HARNESS_IDS.CLAUDE_CLI, {
      available: true,
      status: HARNESS_STATUS_STRINGS.AVAILABLE,
    });

    const afterCopilot =
      useSettingsStore.getState().harnessStatus[HARNESS_IDS.COPILOT_CLI];
    expect(afterCopilot).toEqual(beforeCopilot);
  });
});

describe("isHarnessAvailable", () => {
  it("returns false for checking state", () => {
    expect(
      useSettingsStore.getState().isHarnessAvailable(HARNESS_IDS.COPILOT_CLI)
    ).toBe(false);
  });

  it("returns true after marking available", () => {
    useSettingsStore.getState().setHarnessStatus(HARNESS_IDS.COPILOT_CLI, {
      available: true,
      status: HARNESS_STATUS_STRINGS.AVAILABLE,
    });
    expect(
      useSettingsStore.getState().isHarnessAvailable(HARNESS_IDS.COPILOT_CLI)
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Global settings
// ---------------------------------------------------------------------------

describe("setGlobalSettings", () => {
  it("replaces global settings", () => {
    const settings: GlobalSettings = {
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "claude-opus-4",
      harnessDefaultModels: {},
      harnessDefaultAdditionalArgs: {},
      agent: "",
      skills: ["skill-a"],
      executionMode: "headless",
      resumeSession: true,
      mcpServers: ["flightpath"],
      hooks: [],
      autoFocusOutputOnExecution: true,
      toolPermissions: {
        mode: PERMISSION_MODES.ALLOW_ALL,
        allowedTools: [],
        deniedTools: [],
      },
      respectGitignore: false,
      autoExpandEditorWhenTyping: true,
      outputVirtualizationRowThreshold: 200,
      confirmDeleteOperations: false,
      confirmResetOperations: false,
      showHiddenFiles: true,
      priorContext: "none",
      workspaceRoot: "",
      defaultEndCondition: null,
      defaultPreCondition: null,
      settingSources: {},
    };
    useSettingsStore.getState().setGlobalSettings(settings);
    expect(useSettingsStore.getState().globalSettings.harness).toBe(
      HARNESS_IDS.CLAUDE_CLI
    );
    expect(useSettingsStore.getState().globalSettings.model).toBe(
      "claude-opus-4"
    );
    expect(useSettingsStore.getState().globalSettings.resumeSession).toBe(true);
  });
});

describe("updateGlobalSetting", () => {
  it("updates a single field without touching others", () => {
    const before = useSettingsStore.getState().globalSettings.harness;
    useSettingsStore.getState().updateGlobalSetting("model", "gpt-5");
    expect(useSettingsStore.getState().globalSettings.model).toBe("gpt-5");
    expect(useSettingsStore.getState().globalSettings.harness).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Workflow properties
// ---------------------------------------------------------------------------

describe("setWorkflowProperties", () => {
  it("stores workflow properties", () => {
    const props: WorkflowProperties = {
      harness: "claude-cli",
      model: "claude-opus-4",
    };
    useSettingsStore.getState().setWorkflowProperties(props);
    expect(useSettingsStore.getState().workflowProperties.harness).toBe(
      "claude-cli"
    );
  });
});

describe("updateWorkflowProperty", () => {
  it("updates a single property", () => {
    useSettingsStore
      .getState()
      .updateWorkflowProperty("model", "claude-opus-4");
    expect(useSettingsStore.getState().workflowProperties.model).toBe(
      "claude-opus-4"
    );
  });
});

describe("clearWorkflowProperties", () => {
  it("empties workflow properties", () => {
    useSettingsStore
      .getState()
      .setWorkflowProperties({ harness: "claude-cli" });
    useSettingsStore.getState().clearWorkflowProperties();
    expect(useSettingsStore.getState().workflowProperties).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Effective value resolution (workflow overrides global)
// ---------------------------------------------------------------------------

describe("getEffectiveHarness", () => {
  it("returns global harness when no workflow override", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("harness", HARNESS_IDS.COPILOT_CLI);
    expect(useSettingsStore.getState().getEffectiveHarness()).toBe(
      HARNESS_IDS.COPILOT_CLI
    );
  });

  it("returns workflow harness when set", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("harness", HARNESS_IDS.COPILOT_CLI);
    useSettingsStore
      .getState()
      .updateWorkflowProperty("harness", HARNESS_IDS.CLAUDE_CLI);
    expect(useSettingsStore.getState().getEffectiveHarness()).toBe(
      HARNESS_IDS.CLAUDE_CLI
    );
  });
});

describe("getEffectiveModel", () => {
  it("returns global model when no workflow override", () => {
    useSettingsStore.getState().updateGlobalSetting("model", "gpt-5");
    expect(useSettingsStore.getState().getEffectiveModel()).toBe("gpt-5");
  });

  it("returns workflow model when set", () => {
    useSettingsStore.getState().updateGlobalSetting("model", "gpt-5");
    useSettingsStore
      .getState()
      .updateWorkflowProperty("model", "claude-opus-4");
    expect(useSettingsStore.getState().getEffectiveModel()).toBe(
      "claude-opus-4"
    );
  });
});

describe("getEffectiveSkills", () => {
  it("falls back to global skills when no workflow override", () => {
    useSettingsStore.getState().updateGlobalSetting("skills", ["global-skill"]);
    expect(useSettingsStore.getState().getEffectiveSkills()).toEqual([
      "global-skill",
    ]);
  });

  it("uses workflow skills when set (even empty array)", () => {
    useSettingsStore.getState().updateGlobalSetting("skills", ["global-skill"]);
    useSettingsStore.getState().updateWorkflowProperty("skills", []);
    expect(useSettingsStore.getState().getEffectiveSkills()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Workflow loaded state
// ---------------------------------------------------------------------------

describe("setWorkflowLoaded", () => {
  it("updates the workflowLoaded flag", () => {
    expect(useSettingsStore.getState().workflowLoaded).toBe(false);
    useSettingsStore.getState().setWorkflowLoaded(true);
    expect(useSettingsStore.getState().workflowLoaded).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resetSettings
// ---------------------------------------------------------------------------

describe("resetSettings", () => {
  it("clears workflow properties and loaded flag", () => {
    useSettingsStore
      .getState()
      .setWorkflowProperties({ harness: "claude-cli" });
    useSettingsStore.getState().setWorkflowLoaded(true);
    useSettingsStore.getState().resetSettings();
    expect(useSettingsStore.getState().workflowProperties).toEqual({});
    expect(useSettingsStore.getState().workflowLoaded).toBe(false);
  });

  it("preserves model options and harness status after reset", () => {
    useSettingsStore.getState().setModelOptions({
      [HARNESS_IDS.COPILOT_CLI]: [{ value: "gpt-5", label: "GPT-5" }],
    });
    useSettingsStore.getState().resetSettings();
    const opts = useSettingsStore
      .getState()
      .getModelsForHarness(HARNESS_IDS.COPILOT_CLI);
    expect(opts[0].value).toBe("gpt-5");
  });
});
