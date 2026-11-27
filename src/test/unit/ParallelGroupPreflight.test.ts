import * as assert from "assert";
import * as os from "os";
import * as path from "path";
import { suite, test } from "mocha";
import {
  HARNESS_IDS,
  CTRLYOKE_MCP_MODES,
  MCP_SKILL_NAMES,
  PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES,
  STEP_TYPES,
  WORKTREE_MODES,
  type HarnessId,
} from "../../types/DashboardConstants";
import type {
  ParallelGroupDefinition,
  PromptFile,
  PromptStep,
  SubWorkflowStep,
  WorkflowStep,
} from "../../types/CtrlYokeTypes";
import { SUB_WORKFLOW_SOURCE_KINDS } from "../../types/SubWorkflowTypes";
import { classifySubWorkflowWorktree } from "../../utils/WorktreeConfigShape";
import {
  ctrlYokeToolFamilies,
  type ExecutionPropertyDefaults,
} from "../../types/ExecutionPropertyResolver";
import {
  MCP_APPEND_STEP_TOOL_NAME,
  MCP_WORKFLOW_MUTATION_TOOL_NAMES,
} from "../../utils/McpToolDefinitions";
import {
  MERGE_INTO_SHARED_ROOT_GUIDANCE,
  preflightParallelGroup,
  preflightParallelGroupMember,
  runsInMainCheckout,
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
  test("a run is in the main checkout only when it executes at its state root", () => {
    const stateRoot = path.join(os.tmpdir(), "ctrlyoke-main-checkout");
    assert.strictEqual(runsInMainCheckout(stateRoot, stateRoot), true);
    assert.strictEqual(
      runsInMainCheckout(path.join(stateRoot, "."), stateRoot),
      true
    );
    // An inherited child (D4a) has no worktree record of its own, but runs
    // in its parent's worktree, so it is not in the main checkout.
    assert.strictEqual(
      runsInMainCheckout(`${stateRoot}.worktrees/parent`, stateRoot),
      false
    );
    // A worktree that is not placed yet (a preview) is not the main checkout.
    assert.strictEqual(runsInMainCheckout(undefined, stateRoot), false);
  });

  test("prepares a sub-workflow member once and skips harness, session and interactive checks", async () => {
    const prepared: Array<{ stepIndex: number; workflow: unknown }> = [];
    const harnessChecks: HarnessId[] = [];
    const integrations: number[] = [];
    const result = await preflightParallelGroup({
      workflow: {
        // An interactive, explicitly shared session would collide for two
        // prompt members; a child run owns its own terminal and sessions.
        executionMode: "interactive",
        sessionId: "shared-session",
        steps: [
          { prompt: "interactive sibling" },
          {
            type: STEP_TYPES.WORKFLOW,
            workflow: { type: STEP_TYPES.SCRIPT, script: "echo lane" },
            _runtime: { stepId: "lane" },
          },
        ],
        parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
      },
      group: { ...group, startIndex: 0, endIndex: 1 },
      defaults: defaults(),
      hostCanProvidePty: true,
      supportsConcurrentInteractiveSessions: false,
      configuredWidth: 6,
      fanOutEnabled: true,
      checkHarnessReady: (harness) => {
        harnessChecks.push(harness);
        return undefined;
      },
      ensureIsolatedIntegration: (member) => {
        integrations.push(member.stepIndex);
        return { member: member.stepIndex };
      },
      prepareSubWorkflowMember: async (step, stepIndex) => {
        prepared.push({ stepIndex, workflow: step.workflow });
        return {
          ok: false,
          failureMessage: "Sub-workflow could not resolve 'x'",
        };
      },
    });

    assert.deepStrictEqual(result.issues, []);
    assert.deepStrictEqual(prepared, [
      {
        stepIndex: 1,
        workflow: { type: STEP_TYPES.SCRIPT, script: "echo lane" },
      },
    ]);
    assert.deepStrictEqual(harnessChecks, [HARNESS_IDS.COPILOT_CLI]);
    assert.deepStrictEqual(integrations, [0]);
    const lane = result.members.find((member) => member.stepIndex === 1);
    // A failed preparation is the member's own start failure, not a group issue.
    assert.deepStrictEqual(lane?.subWorkflowLaunch, {
      ok: false,
      failureMessage: "Sub-workflow could not resolve 'x'",
    });
    assert.strictEqual(lane?.resolvedSessionId, undefined);
  });

  test("an interactive prompt member joining beside a sub-workflow member is not multiplexed", async () => {
    const workflow: PromptFile = {
      executionMode: "interactive",
      steps: [
        { type: STEP_TYPES.WORKFLOW, workflow: "lane.ctrlyoke.yaml" },
        { prompt: "joiner" },
      ],
      parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
    };
    const options = {
      workflow,
      group: { ...group, startIndex: 0, endIndex: 1 },
      defaults: defaults(),
      hostCanProvidePty: true,
      supportsConcurrentInteractiveSessions: false,
      configuredWidth: 6,
      fanOutEnabled: true,
    };
    const lane = await preflightParallelGroupMember({
      ...options,
      step: workflow.steps![0]!,
      stepIndex: 0,
    });
    const joiner = await preflightParallelGroupMember({
      ...options,
      step: workflow.steps![1]!,
      stepIndex: 1,
      reservedMembers: [lane.member],
    });
    assert.deepStrictEqual(joiner.issues, []);
  });

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

suite("ParallelGroupPreflight MERGE_INTO_SHARED_ROOT", () => {
  const mergeLane: WorkflowStep = {
    type: STEP_TYPES.WORKFLOW,
    name: "merge lane",
    workflow: {
      prompt: "lane work",
      worktree: { mode: WORKTREE_MODES.MANAGED, merge: true },
    },
  };
  const plainLane: WorkflowStep = {
    type: STEP_TYPES.WORKFLOW,
    name: "plain lane",
    workflow: {
      prompt: "lane work",
      worktree: { mode: WORKTREE_MODES.MANAGED },
    },
  };
  const inheritingMember: WorkflowStep = {
    type: STEP_TYPES.WORKFLOW,
    name: "inheriting",
    workflow: { type: STEP_TYPES.SCRIPT, script: "npm test" },
  };

  /**
   * Preflight a group of `steps`, preparing each sub-workflow member the way
   * the executor does: its plan is classified from the inline definition.
   * `prepare: false` leaves members unprepared, as a preview does.
   */
  async function preflight(
    steps: WorkflowStep[],
    options: { prepare?: boolean; parentRunsInMainCheckout?: boolean } = {}
  ) {
    const groupDefinition = {
      ...group,
      startIndex: 0,
      endIndex: steps.length - 1,
    };
    return preflightParallelGroup({
      workflow: {
        steps: steps.map((step, index) => ({
          ...step,
          _runtime: { stepId: `member-${index}` },
        })),
        parallelGroups: [groupDefinition],
      },
      group: groupDefinition,
      defaults: defaults(),
      hostCanProvidePty: true,
      supportsConcurrentInteractiveSessions: true,
      configuredWidth: 6,
      fanOutEnabled: true,
      ...(options.parentRunsInMainCheckout !== undefined
        ? { parentRunsInMainCheckout: options.parentRunsInMainCheckout }
        : {}),
      ...(options.prepare === false
        ? {}
        : {
            prepareSubWorkflowMember: async (step: SubWorkflowStep) => {
              const definition = step.workflow as Exclude<
                SubWorkflowStep["workflow"],
                string
              >;
              return {
                ok: true as const,
                source: {
                  kind: SUB_WORKFLOW_SOURCE_KINDS.FILE,
                  resolvedPath: "/child.ctrlyoke.yaml",
                },
                worktreePlan: classifySubWorkflowWorktree(definition.worktree),
              };
            },
          }),
    });
  }

  const mergeIssues = (
    result: Awaited<ReturnType<typeof preflightParallelGroup>>
  ) =>
    result.issues.filter(
      (issue) =>
        issue.code ===
        PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.MERGE_INTO_SHARED_ROOT
    );

  test("a prompt member beside a merge lane is an issue naming both", async () => {
    const result = await preflight([{ prompt: "edit in place" }, mergeLane]);

    const issues = mergeIssues(result);
    assert.strictEqual(issues.length, 1);
    assert.deepStrictEqual(issues[0].memberIndices, [0, 1]);
    assert.strictEqual(
      issues[0].message,
      `Step 2 ("merge lane") merges into the parent's checkout, which Step 1 edits in the same parallel group. ${MERGE_INTO_SHARED_ROOT_GUIDANCE}`
    );
    assert.strictEqual(result.issues.length, 1);
  });

  test("a script member counts as editing the parent's checkout, in either order", async () => {
    const result = await preflight([
      mergeLane,
      { type: STEP_TYPES.SCRIPT, script: "npm run build" },
    ]);

    assert.deepStrictEqual(
      mergeIssues(result).map((issue) => issue.memberIndices),
      [[0, 1]]
    );
  });

  test("an inheriting workflow member beside a merge lane is an issue", async () => {
    const result = await preflight([inheritingMember, mergeLane]);

    assert.deepStrictEqual(
      mergeIssues(result).map((issue) => issue.memberIndices),
      [[0, 1]]
    );
    // It edits the parent's root wherever the parent runs, so a worktree
    // parent refuses it too (D4d: rule 2 never admits a merge lease).
    const inWorktree = await preflight([inheritingMember, mergeLane], {
      parentRunsInMainCheckout: false,
    });
    assert.deepStrictEqual(
      mergeIssues(inWorktree).map((issue) => issue.memberIndices),
      [[0, 1]]
    );
  });

  test("inheriting members beside each other, or beside a lane without merge, are not an issue", async () => {
    for (const parentRunsInMainCheckout of [true, false]) {
      const result = await preflight(
        [inheritingMember, { ...inheritingMember, name: "second" }, plainLane],
        { parentRunsInMainCheckout }
      );
      assert.deepStrictEqual(
        result.issues,
        [],
        String(parentRunsInMainCheckout)
      );
    }
  });

  test("a merge lane beside a lane without merge is not an issue", async () => {
    const result = await preflight([mergeLane, plainLane]);

    assert.deepStrictEqual(result.issues, []);
  });

  test("two merge lanes are not an issue", async () => {
    const result = await preflight([
      mergeLane,
      { ...mergeLane, name: "second" },
    ]);

    assert.deepStrictEqual(result.issues, []);
  });

  test("a preview classifies an unprepared inline member from its definition", async () => {
    const result = await preflight([inheritingMember, mergeLane], {
      prepare: false,
    });

    assert.strictEqual(mergeIssues(result).length, 1);
  });

  test("a worktree: false child edits the parent's checkout only when the parent runs in the main checkout", async () => {
    const mainCheckoutChild: WorkflowStep = {
      type: STEP_TYPES.WORKFLOW,
      workflow: { prompt: "main", worktree: false },
    };

    const onMain = await preflight([mainCheckoutChild, mergeLane], {
      parentRunsInMainCheckout: true,
    });
    const inWorktree = await preflight([mainCheckoutChild, mergeLane], {
      parentRunsInMainCheckout: false,
    });

    assert.strictEqual(mergeIssues(onMain).length, 1);
    assert.deepStrictEqual(inWorktree.issues, []);
  });

  test("a member that fails alone in preparation is not counted", async () => {
    const result = await preflightParallelGroup({
      workflow: {
        steps: [{ prompt: "edit in place" }, mergeLane],
        parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
      },
      group: { ...group, startIndex: 0, endIndex: 1 },
      defaults: defaults(),
      hostCanProvidePty: true,
      supportsConcurrentInteractiveSessions: true,
      configuredWidth: 6,
      fanOutEnabled: true,
      prepareSubWorkflowMember: async () => ({
        ok: false,
        failureMessage: "Sub-workflow could not resolve 'x'",
      }),
    });

    assert.deepStrictEqual(result.issues, []);
  });

  test("a member claimed beside a running merge lane fails its dispatch preflight", async () => {
    const workflow: PromptFile = {
      steps: [mergeLane, { prompt: "late joiner" }],
      parallelGroups: [{ ...group, startIndex: 0, endIndex: 1 }],
    };
    const groupResult = await preflight([mergeLane]);
    const claimed = await preflightParallelGroupMember({
      workflow,
      group: { ...group, startIndex: 0, endIndex: 1 },
      defaults: defaults(),
      hostCanProvidePty: true,
      supportsConcurrentInteractiveSessions: true,
      configuredWidth: 6,
      fanOutEnabled: true,
      step: { prompt: "late joiner" },
      stepIndex: 1,
      reservedMembers: groupResult.members,
    });

    assert.deepStrictEqual(
      claimed.issues.map((issue) => issue.code),
      [PARALLEL_GROUP_PREFLIGHT_DIAGNOSTIC_CODES.MERGE_INTO_SHARED_ROOT]
    );
    assert.match(claimed.failureMessage, /Parallel step 2 failed preflight/);
  });
});
