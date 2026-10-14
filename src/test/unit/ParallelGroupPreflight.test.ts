import * as assert from "assert";
import { suite, test } from "mocha";
import {
  HARNESS_IDS,
  CTRLYOKE_MCP_MODES,
  MCP_SKILL_NAMES,
  PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES,
  type HarnessId,
} from "../../types/DashboardConstants";
import type {
  ParallelGroupDefinition,
  PromptFile,
  PromptStep,
} from "../../types/CtrlYokeTypes";
import {
  ctrlYokeToolFamilies,
  type ExecutionPropertyDefaults,
} from "../../types/ExecutionPropertyResolver";
import {
  MCP_APPEND_STEP_TOOL_NAME,
  MCP_WORKFLOW_MUTATION_TOOL_NAMES,
} from "../../utils/McpToolDefinitions";
import {
  preflightParallelGroup,
  preflightParallelGroupMember,
} from "../../core/ParallelGroupPreflight";

const group: ParallelGroupDefinition = {
  id: "group",
  startIndex: 1,
  endIndex: 2,
  failFast: true,
};

function defaults(
  overrides: Partial<ExecutionPropertyDefaults> = {}
): ExecutionPropertyDefaults {
  return {
    harness: HARNESS_IDS.COPILOT_CLI,
    modelsByHarness: {},
    additionalArgsByHarness: {},
    executionMode: "headless",
    resumeSession: false,
    ctrlyokeMcpMode: "native",
    mcpServers: [],
    hooks: null,
    ...overrides,
  };
}

async function run(
  workflow: PromptFile,
  defaultsValue = defaults(),
  supportsConcurrentInteractiveSessions = true,
  fanOutEnabled = true
) {
  return preflightParallelGroup({
    workflow,
    group: workflow.parallelGroups?.[0] ?? {
      ...group,
      startIndex: 0,
      endIndex: 1,
    },
    defaults: defaultsValue,
    hostCanProvidePty: true,
    supportsConcurrentInteractiveSessions,
    configuredWidth: 6,
    fanOutEnabled,
  });
}

suite("ParallelGroupPreflight", () => {
  test("finds inherited/default explicit session collisions", async () => {
    const result = await run(
      {
        steps: [{ prompt: "one" }, { prompt: "two" }],
        parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
      },
      defaults({ resumeSession: true, sessionId: "shared-session" })
    );
    const collision = result.issues.find(
      (issue) =>
        issue.code ===
        PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.SESSION_COLLISION
    );
    assert.deepStrictEqual(collision?.memberIndices, [0, 1]);
    assert.match(collision?.message ?? "", /Step 1.*Step 2/);
  });

  test("adds the session flag hint for collisions inheriting its workflow ID", async () => {
    const result = await preflightParallelGroup({
      workflow: {
        sessionId: "flag-session",
        resumeSession: true,
        steps: [{ prompt: "one" }, { prompt: "two" }],
        parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
      },
      group: { ...group, startIndex: 0, endIndex: 1 },
      defaults: defaults(),
      hostCanProvidePty: true,
      supportsConcurrentInteractiveSessions: true,
      configuredWidth: 6,
      fanOutEnabled: true,
      workflowSessionIdFromOverride: true,
    });
    const collision = result.issues.find(
      (issue) =>
        issue.code ===
        PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.SESSION_COLLISION
    );
    assert.match(
      collision?.message ?? "",
      /Members inherit --session-id, so give those members their own sessionId or run without the flag\./
    );
  });

  function completedOn(harness: HarnessId, sessionId: string): PromptStep {
    return {
      prompt: `before on ${harness}`,
      harness,
      _runtime: {
        harness,
        model: "model",
        sessionId,
        startedAt: 1,
        completedAt: 2,
      },
    };
  }

  function sessions(result: Awaited<ReturnType<typeof run>>) {
    return result.members.map((member) => ({
      sessionId: member.resolvedSessionId,
      autoResumeSharedWith: member.autoResumeSharedWith,
    }));
  }

  test("auto-resumes each member's own harness session across groups", async () => {
    const result = await run({
      resumeSession: true,
      steps: [
        completedOn(HARNESS_IDS.COPILOT_CLI, "copilot-session"),
        completedOn(HARNESS_IDS.CLAUDE_CLI, "claude-session"),
        { prompt: "fix on copilot", harness: HARNESS_IDS.COPILOT_CLI },
        { prompt: "fix on claude", harness: HARNESS_IDS.CLAUDE_CLI },
      ],
      parallelGroups: [{ ...group, startIndex: 2, endIndex: 3 }],
    });

    assert.deepStrictEqual(result.issues, []);
    assert.deepStrictEqual(sessions(result), [
      { sessionId: "copilot-session", autoResumeSharedWith: undefined },
      { sessionId: "claude-session", autoResumeSharedWith: undefined },
    ]);
  });

  test("starts a later member fresh when its auto-resumed session is already held", async () => {
    const before = completedOn(HARNESS_IDS.COPILOT_CLI, "prior-session");
    const autoResumed = await run({
      harness: HARNESS_IDS.COPILOT_CLI,
      resumeSession: true,
      steps: [
        before,
        { name: "alpha", prompt: "one" },
        { name: "beta", prompt: "two" },
      ],
      parallelGroups: [group],
    });
    assert.deepStrictEqual(autoResumed.issues, []);
    assert.deepStrictEqual(sessions(autoResumed), [
      { sessionId: "prior-session", autoResumeSharedWith: undefined },
      { sessionId: undefined, autoResumeSharedWith: 1 },
    ]);

    const heldByExplicitReference = await run({
      harness: HARNESS_IDS.COPILOT_CLI,
      resumeSession: true,
      steps: [before, { prompt: "one", sessionId: 1 }, { prompt: "two" }],
      parallelGroups: [group],
    });
    assert.deepStrictEqual(heldByExplicitReference.issues, []);
    assert.deepStrictEqual(sessions(heldByExplicitReference), [
      { sessionId: "prior-session", autoResumeSharedWith: undefined },
      { sessionId: undefined, autoResumeSharedWith: 1 },
    ]);
  });

  test("still rejects an explicit sessionId that collides with an auto-resumed member", async () => {
    const result = await run({
      harness: HARNESS_IDS.COPILOT_CLI,
      resumeSession: true,
      steps: [
        completedOn(HARNESS_IDS.COPILOT_CLI, "prior-session"),
        { name: "alpha", prompt: "one" },
        { name: "beta", prompt: "two", sessionId: 1 },
      ],
      parallelGroups: [group],
    });
    assert.match(
      result.issues.find(
        (issue) =>
          issue.code ===
          PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.SESSION_COLLISION
      )?.message ?? "",
      /Step 2 \("alpha"\).*Step 3 \("beta"\)/
    );
  });

  test("checks an edited member against current running reservations", async () => {
    const workflow: PromptFile = {
      steps: [
        {
          prompt: "running",
          sessionId: "shared-session",
          resumeSession: true,
        },
        { prompt: "pending" },
      ],
      parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
    };
    const admitted = await run(workflow);
    const editedStep = {
      ...workflow.steps![1],
      sessionId: "shared-session",
      resumeSession: true,
    };
    const edited = await preflightParallelGroupMember({
      workflow: {
        ...workflow,
        steps: [workflow.steps![0], editedStep],
      },
      group: workflow.parallelGroups![0],
      stepIndex: 1,
      step: editedStep,
      defaults: defaults(),
      hostCanProvidePty: true,
      supportsConcurrentInteractiveSessions: true,
      configuredWidth: 6,
      fanOutEnabled: true,
      reservedMembers: [admitted.members[0]],
    });

    assert.strictEqual(
      edited.issues.some(
        (issue) =>
          issue.code ===
          PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.SESSION_COLLISION
      ),
      true
    );
  });

  test("reports interactive multiplexing without banning workflow mutation", async () => {
    const result = await run(
      {
        executionMode: "interactive",
        mcpServers: ["ctrlyoke"],
        steps: [{ prompt: "one" }, { prompt: "two" }],
        parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
      },
      defaults(),
      false,
      false
    );
    assert.strictEqual(result.groupStartBoundary, 0);
    assert.strictEqual(result.effectiveWidth, 1);
    assert.deepStrictEqual(
      new Set(result.issues.map((issue) => issue.code)),
      new Set([PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.INTERACTIVE_MULTIPLEX])
    );
  });

  test("admits group members that deny only the step-mutating tools", async () => {
    const result = await run({
      mcpServers: [
        { id: "ctrlyoke", deniedTools: [...MCP_WORKFLOW_MUTATION_TOOL_NAMES] },
      ],
      steps: [{ prompt: "one" }, { prompt: "two" }],
      parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
    });

    assert.strictEqual(result.issues.length, 0);
    assert.ok(
      result.members.every(
        (member) => !ctrlYokeToolFamilies(member.resolvedProperties).mutation
      )
    );
  });

  test("does not reject a group member that keeps one step-mutating tool", async () => {
    const result = await run({
      mcpServers: [
        {
          id: "ctrlyoke",
          deniedTools: MCP_WORKFLOW_MUTATION_TOOL_NAMES.filter(
            (tool) => tool !== MCP_APPEND_STEP_TOOL_NAME
          ),
        },
      ],
      steps: [{ prompt: "one" }, { prompt: "two" }],
      parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
    });

    assert.strictEqual(result.issues.length, 0);
    assert.ok(
      result.members.every(
        (member) => ctrlYokeToolFamilies(member.resolvedProperties).mutation
      )
    );
  });

  test("retains workflow and coordination skills for skill-mode group members", async () => {
    const result = await run(
      {
        mcpServers: ["ctrlyoke"],
        steps: [{ prompt: "one" }, { prompt: "two" }],
        parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
      },
      defaults({ ctrlyokeMcpMode: CTRLYOKE_MCP_MODES.SKILL })
    );

    assert.deepStrictEqual(
      result.members.map((member) => member.resolvedProperties.skills),
      [
        [MCP_SKILL_NAMES.TOOLS, MCP_SKILL_NAMES.COORDINATION],
        [MCP_SKILL_NAMES.TOOLS, MCP_SKILL_NAMES.COORDINATION],
      ]
    );
    assert.strictEqual(result.issues.length, 0);
  });

  test("allows skill-mode members that did not request ctrlyoke", async () => {
    const result = await run(
      {
        steps: [{ prompt: "one" }, { prompt: "two" }],
        parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
      },
      defaults({ ctrlyokeMcpMode: CTRLYOKE_MCP_MODES.SKILL })
    );

    assert.deepStrictEqual(
      result.members.map((member) => member.resolvedProperties.skills),
      [undefined, undefined]
    );
    assert.strictEqual(result.issues.length, 0);
  });
});
