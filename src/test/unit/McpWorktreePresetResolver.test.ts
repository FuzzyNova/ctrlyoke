import * as assert from "assert";
import { suite, test } from "mocha";
import type { PromptStep, WorkingFile } from "../../types/CtrlYokeTypes";
import { STEP_TYPES } from "../../types/DashboardConstants";
import {
  laneOrPromptStep,
  materializeMcpWorktreePreset,
  MCP_NO_WORKTREE_PRESETS_MESSAGE,
  summarizeMcpWorktreePresets,
  wrapPromptStepAsLane,
} from "../../utils/McpWorktreePresetResolver";
import { materializeMcpConditionPreset } from "../../utils/McpConditionPresetResolver";
import {
  formatDeclaredPresetList,
  getDeclaredPreset,
} from "../../utils/McpNamedPresets";

const PROTOTYPE_NAMES = [
  "toString",
  "constructor",
  "__proto__",
  "hasOwnProperty",
];

function workflowWith(
  worktreePresets?: WorkingFile["worktreePresets"]
): WorkingFile {
  return {
    startedAt: 1,
    definitionRevision: 1,
    steps: [{ prompt: "existing" }],
    ...(worktreePresets ? { worktreePresets } : {}),
  };
}

suite("McpNamedPresets", () => {
  test("looks up own properties only", () => {
    const presets = { lane: 1 };
    assert.strictEqual(getDeclaredPreset(presets, "lane"), 1);
    assert.strictEqual(getDeclaredPreset(undefined, "lane"), undefined);
    for (const name of PROTOTYPE_NAMES) {
      assert.strictEqual(getDeclaredPreset(presets, name), undefined, name);
    }
  });

  test("formats declared names in order, or none", () => {
    assert.strictEqual(formatDeclaredPresetList(undefined), "none");
    assert.strictEqual(formatDeclaredPresetList({}), "none");
    assert.strictEqual(
      formatDeclaredPresetList(
        { b: 1, a: 2 },
        (name, value) => `${name}=${value}`
      ),
      "b=1, a=2"
    );
  });

  test("condition presets share the own-property lookup", () => {
    const workingFile: WorkingFile = {
      startedAt: 1,
      definitionRevision: 1,
      steps: [],
      conditions: { committed: { script: "git status --porcelain" } },
    };
    for (const name of PROTOTYPE_NAMES) {
      assert.throws(
        () =>
          materializeMcpConditionPreset(workingFile, "endCondition", {
            use: name,
          }),
        /unknown condition preset .*Available presets: committed\./
      );
    }
  });
});

suite("McpWorktreePresetResolver", () => {
  test("summarizes presets with merge and a first-line setup preview", () => {
    assert.deepStrictEqual(summarizeMcpWorktreePresets(workflowWith()), []);
    assert.deepStrictEqual(
      summarizeMcpWorktreePresets(
        workflowWith({
          lane: { mode: "managed", merge: true, setup: "npm ci\necho done" },
          scratch: { mode: "managed", keep: true },
        })
      ),
      [
        { name: "lane", merge: true, setup: "npm ci" },
        { name: "scratch", merge: false, setup: "" },
      ]
    );
  });

  test("copies the declared preset by value", () => {
    const workingFile = workflowWith({
      lane: { mode: "managed", merge: true, base: "main", setup: "npm ci" },
    });
    const copy = materializeMcpWorktreePreset(workingFile, { use: "lane" });
    assert.deepStrictEqual(copy, {
      mode: "managed",
      merge: true,
      base: "main",
      setup: "npm ci",
    });
    workingFile.worktreePresets!.lane.setup = "echo later";
    assert.strictEqual(copy.setup, "npm ci");
  });

  test("rejects unknown and prototype names with the available list", () => {
    const workingFile = workflowWith({
      lane: { mode: "managed" },
      review: { mode: "managed" },
    });
    for (const name of ["missing", ...PROTOTYPE_NAMES]) {
      assert.throws(
        () => materializeMcpWorktreePreset(workingFile, { use: name }),
        /unknown worktree preset .*Available presets: lane, review\. workflow_status lists each preset under metadata\.worktreePresets\./,
        name
      );
    }
  });

  test("rejects any reference when the workflow declares no presets", () => {
    for (const workingFile of [workflowWith(), workflowWith({})]) {
      assert.throws(
        () => materializeMcpWorktreePreset(workingFile, { use: "lane" }),
        (error: Error) =>
          error.message === `worktree: ${MCP_NO_WORKTREE_PRESETS_MESSAGE}.`
      );
    }
  });

  test("wraps a prompt step into a lane and reads its prompt step back", () => {
    const step: PromptStep = {
      prompt: "implement",
      name: "API",
      model: "opus",
      endCondition: { script: "git status --porcelain" },
    };
    const lane = wrapPromptStepAsLane(step, { mode: "managed", merge: true });
    assert.deepStrictEqual(lane, {
      type: STEP_TYPES.WORKFLOW,
      name: "API",
      workflow: {
        prompt: "implement",
        model: "opus",
        endCondition: { script: "git status --porcelain" },
        worktree: { mode: "managed", merge: true },
      },
    });
    assert.deepStrictEqual(laneOrPromptStep(lane), {
      prompt: "implement",
      model: "opus",
      endCondition: { script: "git status --porcelain" },
    });
    assert.deepStrictEqual(
      wrapPromptStepAsLane({ prompt: "unnamed" }, { mode: "managed" }),
      {
        type: STEP_TYPES.WORKFLOW,
        workflow: { prompt: "unnamed", worktree: { mode: "managed" } },
      }
    );
    assert.strictEqual(laneOrPromptStep(step), step);
    assert.strictEqual(
      laneOrPromptStep({ type: STEP_TYPES.SCRIPT, script: "npm test" }),
      undefined
    );
    assert.strictEqual(
      laneOrPromptStep({
        type: STEP_TYPES.WORKFLOW,
        workflow: "child.ctrlyoke.yaml",
      }),
      undefined
    );
  });
});
