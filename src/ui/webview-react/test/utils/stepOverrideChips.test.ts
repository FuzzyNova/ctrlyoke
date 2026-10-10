import { describe, expect, it } from "vitest";
import {
  EXECUTION_MODES,
  HARNESS_IDS,
  MCP_SERVER_IDS,
  PERMISSION_MODES,
  PRIOR_CONTEXT_KEYWORDS,
  SESSION_ID_SENTINELS,
  STEP_TYPES,
  TOAST_LEVEL_MODES,
} from "@root/types/DashboardConstants";
import type { PromptStep } from "@root/types/WebviewMessageTypes";
import type { GlobalSettings, WorkflowProperties } from "@store/settingsStore";
import type { WorkflowStep } from "@store/workflowStore";
import {
  buildStepOverrideChips,
  formatSessionIdPreview,
  isConcreteSessionId,
} from "@utils/stepOverrideChips";

const SESSION_ID = "3f2a9c1e-1111-2222-3333-444455556666";

const globalSettings: GlobalSettings = {
  toastLevel: TOAST_LEVEL_MODES.ALL,
  harness: HARNESS_IDS.CLAUDE_CLI,
  model: "settings-model",
  harnessDefaultModels: { [HARNESS_IDS.CLAUDE_CLI]: "settings-model" },
  harnessDefaultAdditionalArgs: {},
  agent: "",
  skills: [],
  secrets: [],
  executionMode: EXECUTION_MODES.INTERACTIVE,
  maxSteps: 100,
  effectiveParallelGroupWidth: 6,
  resumeSession: false,
  mcpServers: [MCP_SERVER_IDS.CTRLYOKE],
  hooks: [],
  autoFocusOutputOnExecution: false,
  toolPermissions: {
    mode: PERMISSION_MODES.ALLOW_ALL,
    allowedTools: [],
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
  isMultiRoot: false,
  priorContext: PRIOR_CONTEXT_KEYWORDS.PREVIOUS,
  workspaceRoot: "",
  defaultErrorBehavior: null,
  defaultEndCondition: null,
  defaultPreCondition: null,
  settingSources: {},
};

/** A reply draft as `buildReplyPropertyValues` writes it under the settings above. */
const replyStep: PromptStep = {
  prompt: "follow up",
  harness: HARNESS_IDS.CLAUDE_CLI,
  model: "settings-model",
  executionMode: EXECUTION_MODES.INTERACTIVE,
  agent: null,
  skills: null,
  secrets: null,
  mcpServers: [MCP_SERVER_IDS.CTRLYOKE],
  hooks: null,
  additionalArgs: null,
  toolPermissions: {
    mode: PERMISSION_MODES.ALLOW_ALL,
    allowedTools: [],
    deniedTools: [],
  },
  endCondition: null,
  preCondition: null,
  errorBehavior: null,
  priorContext: PRIOR_CONTEXT_KEYWORDS.NONE,
  resumeSession: true,
  sessionId: SESSION_ID,
};

function labels(
  step: WorkflowStep,
  workflowProperties: WorkflowProperties = {},
  settings: GlobalSettings = globalSettings
): string[] {
  return buildStepOverrideChips(step, workflowProperties, settings).map(
    (chip) => chip.label
  );
}

describe("buildStepOverrideChips", () => {
  it("collapses a reply to a session chip plus the values that really differ", () => {
    const chips = buildStepOverrideChips(replyStep, {}, globalSettings);

    expect(chips.map((chip) => chip.label)).toEqual([
      formatSessionIdPreview(SESSION_ID),
      "ctx: none",
    ]);
    expect(chips[0]).toMatchObject({ icon: "reply" });
    expect(chips[0].title).toContain(SESSION_ID);
    expect(chips[0].title).toContain("agent: none");
    expect(chips[0].title).toContain("MCP[ctrlyoke]");
    expect(chips[0].title).toContain("perms:");
  });

  it("brings a pinned chip back once the inherited value moves away", () => {
    expect(labels(replyStep, { agent: "reviewer" })).toContain("agent: none");
    expect(
      labels(replyStep, {
        toolPermissions: {
          mode: PERMISSION_MODES.CUSTOM,
          allowedTools: [],
          deniedTools: [],
        },
      })
    ).toContainEqual(expect.stringMatching(/^perms: /));
    expect(
      labels(replyStep, { executionMode: EXECUTION_MODES.HEADLESS })
    ).toContain("Interactive");
  });

  it("shows overrides that differ from the inherited value", () => {
    expect(
      labels({
        prompt: "p",
        agent: "agents/reviewer.md",
        skills: ["a", "b"],
        additionalArgs: "--verbose",
        mcpServers: null,
      })
    ).toEqual([
      "agent: reviewer.md",
      "skills: 2",
      "MCP: none",
      "args: --verbose",
    ]);
  });

  it("keeps the resume chip when no concrete session is pinned", () => {
    expect(labels({ prompt: "p", resumeSession: true })).toEqual(["resume"]);
    expect(
      labels({
        prompt: "p",
        resumeSession: true,
        sessionId: SESSION_ID_SENTINELS.FINAL_STEP,
      })
    ).toEqual(["resume"]);
    expect(labels({ prompt: "p", resumeSession: false })).toEqual([]);
  });

  it("hides a disabled end condition unless something would otherwise run", () => {
    expect(labels({ prompt: "p", endCondition: null })).toEqual([]);
    expect(
      labels(
        { prompt: "p", endCondition: null },
        {
          endCondition: { script: "check.js" },
        }
      )
    ).toEqual(["ec: disabled"]);
  });

  it("only shows execution mode for script steps", () => {
    expect(
      labels({
        type: STEP_TYPES.SCRIPT,
        script: "build.sh",
        executionMode: EXECUTION_MODES.HEADLESS,
      } as WorkflowStep)
    ).toEqual(["Headless"]);
  });
});

describe("isConcreteSessionId", () => {
  it("rejects step numbers, sentinels and blanks", () => {
    expect(isConcreteSessionId(SESSION_ID)).toBe(true);
    expect(isConcreteSessionId(3)).toBe(false);
    expect(isConcreteSessionId("3")).toBe(false);
    expect(isConcreteSessionId(SESSION_ID_SENTINELS.FINAL_STEP)).toBe(false);
    expect(isConcreteSessionId("")).toBe(false);
    expect(isConcreteSessionId(undefined)).toBe(false);
  });
});
