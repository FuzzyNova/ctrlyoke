import { describe, expect, it } from "vitest";
import {
  HARNESS_IDS,
  HOOK_EVENT_NAMES,
  MCP_SKILL_NAMES,
  PERMISSION_MODES,
  PRIOR_CONTEXT_KEYWORDS,
  TOAST_LEVEL_MODES,
  EDITOR_FONT_SIZE_VSCODE,
} from "@root/types/DashboardConstants";
import type { PromptStep } from "@root/types/WebviewMessageTypes";
import type { GlobalSettings, WorkflowProperties } from "@store/settingsStore";
import { buildReplyPropertyValues } from "@utils/replyToStep";

const globalSettings: GlobalSettings = {
  toastLevel: TOAST_LEVEL_MODES.ALL,
  harness: HARNESS_IDS.COPILOT_CLI,
  model: "settings-model",
  harnessDefaultModels: {
    [HARNESS_IDS.COPILOT_CLI]: "settings-model",
    [HARNESS_IDS.CLAUDE_CLI]: "claude-default-model",
  },
  harnessDefaultAdditionalArgs: {
    [HARNESS_IDS.COPILOT_CLI]: "--settings",
    [HARNESS_IDS.CLAUDE_CLI]: "--claude",
  },
  agent: "settings-agent",
  skills: ["settings-skill"],
  secrets: ["SETTINGS_SECRET"],
  executionMode: "headless",
  maxSteps: 100,
  effectiveParallelGroupWidth: 6,
  resumeSession: false,
  mcpServers: ["settings-server"],
  hooks: [{ event: HOOK_EVENT_NAMES.PRE_TOOL_USE, command: "settings-hook" }],
  autoFocusOutputOnExecution: false,
  toolPermissions: {
    mode: PERMISSION_MODES.ALLOW_ALL,
    allowedTools: ["settings-tool"],
    deniedTools: [],
  },
  respectGitignore: true,
  autoExpandEditorWhenTyping: false,
  atomicContextReferences: false,
  outputVirtualizationRowThreshold: 200,
  collapsedToolOutputLineCount: 10,
  confirmDeleteOperations: true,
  confirmResetOperations: true,
  confirmContinuationDiscardOperations: true,
  hideGitIgnoredFiles: false,
  wordWrap: true,
  outputFontSize: 13,
  editorFontSize: EDITOR_FONT_SIZE_VSCODE,
  isMultiRoot: false,
  priorContext: PRIOR_CONTEXT_KEYWORDS.ALL,
  workspaceRoot: "",
  defaultErrorBehavior: null,
  defaultEndCondition: null,
  defaultPreCondition: null,
  settingSources: {},
};

const workflowProperties: WorkflowProperties = {};

function build(step: PromptStep, overrides: Partial<WorkflowProperties> = {}) {
  return buildReplyPropertyValues({
    step,
    sessionId: "session-uuid",
    workflowProperties: { ...workflowProperties, ...overrides },
    globalSettings,
  });
}

describe("buildReplyPropertyValues", () => {
  it("resolves authored overrides and copies display-only color", () => {
    const result = build({
      prompt: "Continue this work",
      color: "#123456",
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "authored-model",
      executionMode: "interactive",
      agent: "authored-agent",
      skills: ["authored-skill"],
      secrets: ["AUTHORED_SECRET"],
      mcpServers: ["authored-server"],
      hooks: [
        { event: HOOK_EVENT_NAMES.PRE_TOOL_USE, command: "authored-hook" },
      ],
      additionalArgs: "--authored",
      toolPermissions: {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["allowed"],
        deniedTools: ["denied"],
      },
      endCondition: { script: "npm test", maxRetries: 2 },
      preCondition: { script: "npm run check" },
      errorBehavior: { onError: "continue" },
    });

    expect(result).toMatchObject({
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "authored-model",
      executionMode: "interactive",
      color: "#123456",
      agent: "authored-agent",
      skills: ["authored-skill"],
      secrets: ["AUTHORED_SECRET"],
      mcpServers: ["authored-server"],
      hooks: [
        { event: HOOK_EVENT_NAMES.PRE_TOOL_USE, command: "authored-hook" },
      ],
      additionalArgs: "--authored",
      toolPermissions: {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["allowed"],
        deniedTools: ["denied"],
      },
      endCondition: { script: "npm test", maxRetries: 2 },
      preCondition: { script: "npm run check" },
      errorBehavior: { onError: "continue" },
    });
  });

  it("makes inherited workflow and settings values explicit", () => {
    const workflowResult = build(
      { prompt: "Continue this work" },
      {
        harness: HARNESS_IDS.CLAUDE_CLI,
        model: "workflow-model",
        agent: "workflow-agent",
        skills: ["workflow-skill"],
        secrets: ["WORKFLOW_SECRET"],
        mcpServers: ["workflow-server"],
        hooks: [
          { event: HOOK_EVENT_NAMES.PRE_TOOL_USE, command: "workflow-hook" },
        ],
        additionalArgs: "--workflow",
      }
    );

    expect(workflowResult).toMatchObject({
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "workflow-model",
      agent: "workflow-agent",
      skills: ["workflow-skill"],
      secrets: ["WORKFLOW_SECRET"],
      mcpServers: ["workflow-server"],
      hooks: [
        { event: HOOK_EVENT_NAMES.PRE_TOOL_USE, command: "workflow-hook" },
      ],
      additionalArgs: "--workflow",
    });

    const settingsResult = build({ prompt: "Continue this work" });
    expect(settingsResult).toMatchObject({
      harness: HARNESS_IDS.COPILOT_CLI,
      model: "settings-model",
      executionMode: "headless",
      agent: "settings-agent",
      skills: ["settings-skill"],
      secrets: ["SETTINGS_SECRET"],
      mcpServers: ["settings-server"],
      hooks: [
        { event: HOOK_EVENT_NAMES.PRE_TOOL_USE, command: "settings-hook" },
      ],
      additionalArgs: "--settings",
      toolPermissions: {
        mode: PERMISSION_MODES.ALLOW_ALL,
        allowedTools: ["settings-tool"],
        deniedTools: [],
      },
    });
    expect(settingsResult.harness).not.toBeUndefined();
    expect(settingsResult.model).not.toBeUndefined();
  });

  it("writes resolved none values as null", () => {
    const result = build({
      prompt: "Continue this work",
      agent: null,
      skills: null,
      secrets: null,
      mcpServers: null,
      hooks: null,
      additionalArgs: null,
      toolPermissions: null,
    });

    expect(result).toMatchObject({
      agent: null,
      skills: null,
      secrets: null,
      mcpServers: null,
      hooks: null,
      additionalArgs: null,
      toolPermissions: null,
      endCondition: null,
      preCondition: null,
      errorBehavior: null,
    });
    expect(result).not.toHaveProperty("agent", undefined);
    expect(result).not.toHaveProperty("skills", undefined);
    expect(result).not.toHaveProperty("secrets", undefined);
  });

  it("uses runtime harness and model when current settings have changed", () => {
    const result = build({
      prompt: "Continue this work",
      _runtime: {
        harness: HARNESS_IDS.CLAUDE_CLI,
        model: "runtime-model",
      },
    });

    expect(result.harness).toBe(HARNESS_IDS.CLAUDE_CLI);
    expect(result.model).toBe("runtime-model");
  });

  it("overlays runtime fields when the session harness matches", () => {
    const result = buildReplyPropertyValues({
      step: {
        prompt: "Continue this work",
        _runtime: {
          harness: HARNESS_IDS.CLAUDE_CLI,
          model: "runtime-model",
          agent: "runtime-agent",
          skills: ["runtime-skill"],
          secrets: ["RUNTIME_SECRET"],
          executionMode: "interactive",
        },
      },
      sessionId: "claude-session",
      sessionHarness: HARNESS_IDS.CLAUDE_CLI,
      workflowProperties,
      globalSettings,
    });

    expect(result).toMatchObject({
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "runtime-model",
      agent: "runtime-agent",
      skills: ["runtime-skill"],
      secrets: ["RUNTIME_SECRET"],
      executionMode: "interactive",
    });
  });

  it("uses resolved values when the session harness differs from runtime", () => {
    const result = buildReplyPropertyValues({
      step: {
        prompt: "Continue this work",
        _runtime: {
          harness: HARNESS_IDS.CLAUDE_CLI,
          model: "old-claude-model",
          agent: "old-claude-agent",
          skills: ["old-claude-skill"],
          secrets: ["OLD_CLAUDE_SECRET"],
          executionMode: "interactive",
        },
      },
      sessionId: "codex-session",
      sessionHarness: HARNESS_IDS.CODEX_CLI,
      sessionModel: "output-session-model",
      workflowProperties: {
        ...workflowProperties,
        agent: "resolved-agent",
        skills: ["resolved-skill"],
        secrets: ["RESOLVED_SECRET"],
        executionMode: "headless",
      },
      globalSettings,
    });

    expect(result).toMatchObject({
      harness: HARNESS_IDS.CODEX_CLI,
      model: "output-session-model",
      agent: "resolved-agent",
      skills: ["resolved-skill"],
      secrets: ["RESOLVED_SECRET"],
      executionMode: "headless",
    });
  });

  it("resolves harness defaults using the runtime harness", () => {
    const result = build({
      prompt: "Continue this work",
      _runtime: { harness: HARNESS_IDS.CLAUDE_CLI },
    });

    expect(result).toMatchObject({
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "claude-default-model",
      additionalArgs: "--claude",
    });
  });

  it("uses the harness paired with the selected latest output session", () => {
    const result = buildReplyPropertyValues({
      step: {
        prompt: "Continue this work",
        _runtime: { harness: HARNESS_IDS.COPILOT_CLI },
      },
      sessionId: "output-session",
      sessionHarness: HARNESS_IDS.CLAUDE_CLI,
      workflowProperties,
      globalSettings,
    });

    expect(result).toMatchObject({
      harness: HARNESS_IDS.CLAUDE_CLI,
      model: "claude-default-model",
      additionalArgs: "--claude",
    });
  });

  it("strips all built-in MCP skill names", () => {
    const result = build({
      prompt: "Continue this work",
      skills: ["custom-skill", ...Object.values(MCP_SKILL_NAMES)],
    });

    expect(result.skills).toEqual(["custom-skill"]);
  });

  it("resumes the concrete session ID and sets prior context to None", () => {
    const result = build({ prompt: "Continue this work" });

    expect(result.resumeSession).toBe(true);
    expect(result.sessionId).toBe("session-uuid");
    expect(result.priorContext).toBe(PRIOR_CONTEXT_KEYWORDS.NONE);
  });
});
