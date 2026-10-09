import * as assert from "assert";
import { suite, test } from "mocha";
import {
  BROWSER_NOTIFICATION_MODE_OPTIONS_META,
  AGENT_SELECTION_OPTIONS_META,
  CODEX_APPROVAL_POLICY_OPTIONS_META,
  CODEX_SANDBOX_MODE_OPTIONS_META,
  COMPARE_SOURCE_OPTIONS_META,
  CONDITION_ACTION_OPTIONS_META,
  CONTEXT_RESOLUTION_FAILURE_OPTIONS_META,
  DEFAULT_FORMAT_OPTIONS_META,
  EXECUTION_MODE_OPTIONS_META,
  HARNESS_OPTIONS_META,
  MAX_STEPS_SELECTION_OPTIONS_META,
  NEVER_OPTION_META,
  UNLIMITED_OPTION_META,
  HOOK_EVENT_OPTIONS_META,
  NOTIFICATION_EVENT_MODE_OPTIONS_META,
  PERMISSION_MODE_OPTIONS_META,
  PRIOR_CONTEXT_KEYWORD_OPTIONS_META,
  RUN_HISTORY_LOCATION_OPTIONS_META,
  SCRIPT_OPERATOR_OPTIONS_META,
  STEP_COLOR_MODE_OPTIONS_META,
  TERMINAL_CURSOR_STYLE_OPTIONS_META,
  TERMINAL_MOBILE_CONTROL_BAR_OPTIONS_META,
  TOAST_LEVEL_OPTIONS_META,
  WORKTREE_MODE_OPTIONS_META,
  WORKTREE_SELECTION_OPTIONS_META,
  WORKFLOW_AGENT_SELECTION_OPTIONS_META,
  toSelectOptions,
  type SchemaOptionMeta,
} from "../../types/SchemaUiMetadata";
import {
  BROWSER_NOTIFICATION_MODES,
  CODEX_APPROVAL_POLICIES,
  CODEX_SANDBOX_MODES,
  COMPARE_SOURCES,
  CONDITION_ACTIONS,
  CONTEXT_RESOLUTION_FAILURE_MODES,
  EXECUTION_MODES,
  AUTO_DETECT_HARNESS,
  HARNESS_IDS,
  NOTIFICATION_EVENT_MODES,
  PERMISSION_MODES,
  PRIOR_CONTEXT_KEYWORDS,
  RUN_HISTORY_LOCATIONS,
  SCRIPT_OPERATORS,
  STEP_COLOR_MODES,
  TERMINAL_CURSOR_STYLES,
  TERMINAL_MOBILE_CONTROL_BAR,
  TOAST_LEVEL_MODES,
  WORKTREE_BRANCH_STATES,
  WORKTREE_DIRECTORY_STATES,
  WORKTREE_LANDING_OUTCOMES,
  WORKTREE_LIFECYCLE_OWNERS,
  WORKTREE_LIFECYCLE_STATES,
  WORKTREE_MERGE_OUTCOMES,
  WORKTREE_MODES,
  WORKTREE_SETUP_OUTCOMES,
  WORKFLOW_FILE_FORMATS,
  LIMIT_SELECTION_VALUES,
} from "../../types/DashboardConstants";
import {
  SCHEMA_ENUMS,
  SCHEMA_VARIANT_DESCRIPTIONS,
} from "../../types/generated/SchemaDescriptions";

type MetaRow = SchemaOptionMeta<string>;

const META_BINDINGS: Array<{
  name: string;
  rows: readonly MetaRow[];
  paths: string[];
}> = [
  {
    name: "permission modes",
    rows: Object.values(PERMISSION_MODE_OPTIONS_META),
    paths: ["toolPermissions.mode", "defaults.toolPermissions.mode"],
  },
  {
    name: "harness IDs",
    rows: Object.values(HARNESS_OPTIONS_META),
    // `defaults.harness` additionally accepts AUTO_DETECT_HARNESS; asserted below.
    paths: ["harness"],
  },
  {
    name: "worktree modes",
    rows: Object.values(WORKTREE_MODE_OPTIONS_META),
    paths: ["worktree.mode", "defaults.worktree.mode"],
  },
  {
    name: "execution modes",
    rows: Object.values(EXECUTION_MODE_OPTIONS_META),
    paths: ["executionMode", "defaults.executionMode", "steps[].executionMode"],
  },
  {
    name: "prior context keywords",
    rows: Object.values(PRIOR_CONTEXT_KEYWORD_OPTIONS_META),
    paths: ["priorContext", "defaults.priorContext"],
  },
  {
    name: "condition actions",
    rows: Object.values(CONDITION_ACTION_OPTIONS_META),
    paths: [
      "onPass",
      "onFail",
      "preCondition.onPass",
      "preCondition.onFail",
      "endCondition.onPass",
      "endCondition.onFail",
      "steps[].onPass",
      "steps[].onFail",
      "errorBehavior.onError",
      "defaults.errorBehavior.onError",
    ],
  },
  {
    name: "compare sources",
    rows: Object.values(COMPARE_SOURCE_OPTIONS_META),
    paths: [
      "compareSource",
      "endCondition.compareSource",
      "preCondition.compareSource",
      "steps[].compareSource",
      "defaults.endCondition.compareSource",
      "defaults.preCondition.compareSource",
    ],
  },
  {
    name: "script operators",
    rows: Object.values(SCRIPT_OPERATOR_OPTIONS_META),
    paths: [
      "operator",
      "endCondition.operator",
      "preCondition.operator",
      "steps[].operator",
      "defaults.endCondition.operator",
      "defaults.preCondition.operator",
    ],
  },
  {
    name: "hook events",
    rows: Object.values(HOOK_EVENT_OPTIONS_META),
    paths: ["hooks[].event", "defaults.hooks[].event"],
  },
  {
    name: "notification event modes",
    rows: Object.values(NOTIFICATION_EVENT_MODE_OPTIONS_META),
    paths: [
      "notifications.events.workflowComplete",
      "notifications.events.promptComplete",
    ],
  },
  {
    name: "toast levels",
    rows: Object.values(TOAST_LEVEL_OPTIONS_META),
    paths: ["notifications.toastLevel"],
  },
  {
    name: "browser notification modes",
    rows: Object.values(BROWSER_NOTIFICATION_MODE_OPTIONS_META),
    paths: ["notifications.browser.mode"],
  },
  {
    name: "step color modes",
    rows: Object.values(STEP_COLOR_MODE_OPTIONS_META),
    paths: ["ui.stepColorMode"],
  },
  {
    name: "context resolution failure modes",
    rows: Object.values(CONTEXT_RESOLUTION_FAILURE_OPTIONS_META),
    paths: ["execution.contextResolutionFailure"],
  },
  {
    name: "Codex sandbox modes",
    rows: Object.values(CODEX_SANDBOX_MODE_OPTIONS_META),
    paths: ["permissions.codexSandboxMode"],
  },
  {
    name: "Codex approval policies",
    rows: Object.values(CODEX_APPROVAL_POLICY_OPTIONS_META),
    paths: ["permissions.codexApprovalPolicy"],
  },
  {
    name: "terminal cursor styles",
    rows: Object.values(TERMINAL_CURSOR_STYLE_OPTIONS_META),
    paths: ["terminal.cursorStyle"],
  },
  {
    name: "mobile control bar modes",
    rows: Object.values(TERMINAL_MOBILE_CONTROL_BAR_OPTIONS_META),
    paths: ["terminal.mobileControlBar"],
  },
  {
    name: "run history locations",
    rows: Object.values(RUN_HISTORY_LOCATION_OPTIONS_META),
    paths: ["storage.runHistoryLocation"],
  },
  {
    name: "default formats",
    rows: Object.values(DEFAULT_FORMAT_OPTIONS_META),
    paths: ["general.defaultFormat"],
  },
];

const CONSTANT_BINDINGS: Array<{
  name: string;
  values: readonly string[];
  paths: string[];
}> = [
  {
    name: "PERMISSION_MODES",
    values: Object.values(PERMISSION_MODES),
    paths: ["toolPermissions.mode", "defaults.toolPermissions.mode"],
  },
  {
    name: "WORKTREE_MODES",
    values: Object.values(WORKTREE_MODES),
    paths: [
      "worktree.mode",
      "defaults.worktree.mode",
      "_runtime.worktree.mode",
    ],
  },
  {
    name: "WORKTREE_LIFECYCLE_OWNERS",
    values: Object.values(WORKTREE_LIFECYCLE_OWNERS),
    paths: ["_runtime.worktree.lifecycleOwner"],
  },
  {
    name: "WORKTREE_LIFECYCLE_STATES",
    values: Object.values(WORKTREE_LIFECYCLE_STATES),
    paths: ["_runtime.worktree.lifecycleState"],
  },
  {
    name: "WORKTREE_SETUP_OUTCOMES",
    values: Object.values(WORKTREE_SETUP_OUTCOMES),
    paths: ["_runtime.worktree.setupOutcome"],
  },
  {
    name: "WORKTREE_LANDING_OUTCOMES",
    values: Object.values(WORKTREE_LANDING_OUTCOMES),
    paths: ["_runtime.worktree.landingOutcome"],
  },
  {
    name: "WORKTREE_MERGE_OUTCOMES",
    values: Object.values(WORKTREE_MERGE_OUTCOMES),
    paths: ["_runtime.worktree.mergeOutcome"],
  },
  {
    name: "WORKTREE_DIRECTORY_STATES",
    values: Object.values(WORKTREE_DIRECTORY_STATES),
    paths: ["_runtime.worktree.directoryState"],
  },
  {
    name: "WORKTREE_BRANCH_STATES",
    values: Object.values(WORKTREE_BRANCH_STATES),
    paths: ["_runtime.worktree.branchState"],
  },
  {
    name: "NOTIFICATION_EVENT_MODES",
    values: Object.values(NOTIFICATION_EVENT_MODES),
    paths: [
      "notifications.events.workflowComplete",
      "notifications.events.promptComplete",
    ],
  },
  {
    name: "TOAST_LEVEL_MODES",
    values: Object.values(TOAST_LEVEL_MODES),
    paths: ["notifications.toastLevel"],
  },
  {
    name: "BROWSER_NOTIFICATION_MODES",
    values: Object.values(BROWSER_NOTIFICATION_MODES),
    paths: ["notifications.browser.mode"],
  },
  {
    name: "STEP_COLOR_MODES",
    values: Object.values(STEP_COLOR_MODES),
    paths: ["ui.stepColorMode"],
  },
  {
    name: "CONDITION_ACTIONS",
    values: Object.values(CONDITION_ACTIONS),
    paths: [
      "onPass",
      "onFail",
      "preCondition.onPass",
      "preCondition.onFail",
      "endCondition.onPass",
      "endCondition.onFail",
      "errorBehavior.onError",
    ],
  },
  {
    name: "COMPARE_SOURCES",
    values: Object.values(COMPARE_SOURCES),
    paths: [
      "compareSource",
      "endCondition.compareSource",
      "preCondition.compareSource",
    ],
  },
  {
    name: "SCRIPT_OPERATORS",
    values: Object.values(SCRIPT_OPERATORS),
    paths: ["operator", "endCondition.operator", "preCondition.operator"],
  },
  {
    name: "CONTEXT_RESOLUTION_FAILURE_MODES",
    values: Object.values(CONTEXT_RESOLUTION_FAILURE_MODES),
    paths: ["execution.contextResolutionFailure"],
  },
  {
    name: "PRIOR_CONTEXT_KEYWORDS",
    values: Object.values(PRIOR_CONTEXT_KEYWORDS),
    paths: ["priorContext", "defaults.priorContext"],
  },
];

const LIMIT_LABEL_BINDINGS = [
  {
    rows: Object.values(MAX_STEPS_SELECTION_OPTIONS_META),
    paths: ["queue.maxSteps"],
  },
  {
    rows: [UNLIMITED_OPTION_META],
    paths: [
      "queue.maxSteps",
      "queue.maxWorkflowExecutionTimeSec",
      "runs.maxRuns",
      "execution.maxPromptTimeoutSec",
    ],
  },
  {
    rows: [NEVER_OPTION_META],
    paths: ["ui.outputVirtualizationRowThreshold"],
  },
];

const META_TABLES: readonly (readonly MetaRow[])[] = [
  ...META_BINDINGS.map(({ rows }) => rows),
  ...LIMIT_LABEL_BINDINGS.map(({ rows }) => rows),
];

function schemaValues(paths: string[]): unknown[] {
  return paths.flatMap((path) => SCHEMA_ENUMS[path] ?? []);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

suite("Schema UI metadata", () => {
  test("agent None options describe each surface's schema encoding", () => {
    const stepNone = toSelectOptions(
      AGENT_SELECTION_OPTIONS_META,
      "agent"
    ).find(({ label }) => label === "None");
    const workflowNone = toSelectOptions(
      WORKFLOW_AGENT_SELECTION_OPTIONS_META,
      "agent"
    )[0];

    assert.deepStrictEqual(stepNone, {
      value: "none",
      label: "None",
      schemaPath: "agent",
      pseudo: { writes: "agent: null" },
    });
    assert.deepStrictEqual(workflowNone, {
      value: "",
      label: "None",
      schemaPath: "agent",
      pseudo: { writes: 'agent: ""' },
    });
  });

  test("toSelectOptions carries the schema path and compact label", () => {
    const [claude] = toSelectOptions(HARNESS_OPTIONS_META, "harness").filter(
      ({ value }) => value === HARNESS_IDS.CLAUDE_CLI
    );
    assert.deepStrictEqual(claude, {
      value: HARNESS_IDS.CLAUDE_CLI,
      label: "Claude Code",
      short: "Claude Code",
      schemaPath: "harness",
    });
  });

  test("worktree options explain themselves with their schema branch descriptions", () => {
    for (const path of ["worktree", "defaults.worktree"]) {
      const options = toSelectOptions(WORKTREE_SELECTION_OPTIONS_META, path);
      const variants = SCHEMA_VARIANT_DESCRIPTIONS[path];
      assert.deepStrictEqual(
        options.map(({ label, description }) => [label, description]),
        [
          ["None", variants["false"]],
          ["Managed", variants["managed"]],
          ["Named", variants["named"]],
        ]
      );
      for (const option of options) {
        assert.ok(
          option.description,
          `${path} ${option.label} has no description`
        );
      }
    }
  });

  test("every bound schema enum value has a metadata row and every row is schema-valid", () => {
    for (const { name, rows, paths } of META_BINDINGS) {
      const accepted = schemaValues(paths);
      assert.ok(
        accepted.length > 0,
        `${name} has no generated schema enum binding`
      );
      const rowValues = rows.map(({ value }) => value);
      for (const value of accepted) {
        assert.ok(
          rowValues.includes(String(value)),
          `${name} is missing schema value ${String(value)}`
        );
      }
      for (const value of rowValues) {
        assert.ok(
          accepted.includes(value),
          `${name} metadata value ${value} is rejected by its bound schema enums`
        );
      }
    }
  });

  test("the mode and keyword constants match their bound schema enums", () => {
    for (const { name, values, paths } of CONSTANT_BINDINGS) {
      const accepted = [...new Set(schemaValues(paths).map(String))].sort();
      assert.deepStrictEqual(
        [...values].sort(),
        accepted,
        `${name} differs from its bound schema enums`
      );
    }
    assert.deepStrictEqual(
      [...Object.values(HARNESS_IDS)].sort(),
      [...new Set(schemaValues(["harness"]).map(String))].sort()
    );
    assert.deepStrictEqual(
      [...Object.values(HARNESS_IDS), AUTO_DETECT_HARNESS].sort(),
      [...new Set(schemaValues(["defaults.harness"]).map(String))].sort()
    );
    assert.deepStrictEqual(
      [...Object.values(EXECUTION_MODES)].sort(),
      [
        ...new Set(
          schemaValues(["executionMode", "defaults.executionMode"]).map(String)
        ),
      ].sort()
    );
    assert.deepStrictEqual(
      [...Object.values(WORKFLOW_FILE_FORMATS)].sort(),
      [...new Set(schemaValues(["general.defaultFormat"]).map(String))].sort()
    );
    assert.deepStrictEqual(
      [...Object.values(CODEX_SANDBOX_MODES)].sort(),
      [
        ...new Set(schemaValues(["permissions.codexSandboxMode"]).map(String)),
      ].sort()
    );
    assert.deepStrictEqual(
      [...Object.values(CODEX_APPROVAL_POLICIES)].sort(),
      [
        ...new Set(
          schemaValues(["permissions.codexApprovalPolicy"]).map(String)
        ),
      ].sort()
    );
    assert.deepStrictEqual(
      [...Object.values(TERMINAL_CURSOR_STYLES)].sort(),
      [...new Set(schemaValues(["terminal.cursorStyle"]).map(String))].sort()
    );
    assert.deepStrictEqual(
      [...Object.values(TERMINAL_MOBILE_CONTROL_BAR)].sort(),
      [
        ...new Set(schemaValues(["terminal.mobileControlBar"]).map(String)),
      ].sort()
    );
    assert.deepStrictEqual(
      [...Object.values(RUN_HISTORY_LOCATIONS)].sort(),
      [
        ...new Set(schemaValues(["storage.runHistoryLocation"]).map(String)),
      ].sort()
    );
  });

  test("non-humanized labels have an explicit alias reason", () => {
    for (const rows of META_TABLES) {
      for (const row of rows) {
        if (normalize(row.value) !== normalize(row.label)) {
          assert.ok(
            row.alias?.reason.trim(),
            `${row.value} → ${row.label} needs an alias reason`
          );
        }
      }
    }
  });

  test("labels follow the nothing vocabulary and stay consistent for shared values", () => {
    const labelsByValue = new Map<string, string>();
    const neverValues = new Set([
      "terminal.mobileControlBar",
      "notifications.browser.mode",
      "permissions.codexApprovalPolicy",
      "ui.outputVirtualizationRowThreshold",
    ]);
    const limitValues = new Set([
      "maxSteps",
      "queue.maxSteps",
      "queue.maxWorkflowExecutionTimeSec",
      "runs.maxRuns",
      "execution.maxPromptTimeoutSec",
    ]);
    for (const { rows, paths } of [...META_BINDINGS, ...LIMIT_LABEL_BINDINGS]) {
      const neverTable = paths.some((path) => neverValues.has(path));
      const limitTable = paths.some((path) => limitValues.has(path));
      for (const row of rows) {
        assert.ok(
          !/^(off|yes|no)$/i.test(row.label),
          `forbidden option label: ${row.label}`
        );
        assert.ok(
          !/^default\s*\(/i.test(row.label),
          `forbidden default label: ${row.label}`
        );
        if (row.value === LIMIT_SELECTION_VALUES.NEVER)
          assert.ok(
            neverTable,
            `never is outside the allowlist: ${paths.join(", ")}`
          );
        if (row.value === LIMIT_SELECTION_VALUES.UNLIMITED)
          assert.ok(
            limitTable,
            `unlimited is outside the limit allowlist: ${paths.join(", ")}`
          );
        const prior = labelsByValue.get(row.value);
        assert.ok(
          prior === undefined || prior === row.label,
          `${row.value} has labels ${prior} and ${row.label}`
        );
        labelsByValue.set(row.value, row.label);
      }
    }
  });
});
