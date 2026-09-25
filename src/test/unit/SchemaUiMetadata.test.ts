import * as assert from "assert";
import { suite, test } from "mocha";
import {
  BROWSER_NOTIFICATION_MODE_OPTIONS_META,
  CODEX_APPROVAL_POLICY_OPTIONS_META,
  CODEX_SANDBOX_MODE_OPTIONS_META,
  COMPARE_SOURCE_OPTIONS_META,
  CONDITION_ACTION_OPTIONS_META,
  CONTEXT_RESOLUTION_FAILURE_OPTIONS_META,
  DEFAULT_FORMAT_OPTIONS_META,
  EXECUTION_MODE_OPTIONS_META,
  HARNESS_OPTIONS_META,
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
  WORKTREE_MODES,
  WORKFLOW_FILE_FORMATS,
} from "../../types/DashboardConstants";
import { SCHEMA_ENUMS } from "../../types/generated/SchemaDescriptions";

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
    paths: ["harness", "defaults.harness"],
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
    paths: ["worktree.mode", "defaults.worktree.mode"],
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

const META_TABLES = META_BINDINGS.map(({ rows }) => rows);

function schemaValues(paths: string[]): unknown[] {
  return paths.flatMap((path) => SCHEMA_ENUMS[path] ?? []);
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

suite("Schema UI metadata", () => {
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
      [
        ...new Set(schemaValues(["harness", "defaults.harness"]).map(String)),
      ].sort()
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
    const timingValues = new Set([
      "terminal.mobileControlBar",
      "notifications.browser.mode",
      "permissions.codexApprovalPolicy",
    ]);
    for (const { rows, paths } of META_BINDINGS) {
      const timingTable = paths.some((path) => timingValues.has(path));
      for (const row of rows) {
        assert.ok(
          !/^(off|yes|no)$/i.test(row.label),
          `forbidden option label: ${row.label}`
        );
        assert.ok(
          !/^default\s*\(/i.test(row.label),
          `forbidden default label: ${row.label}`
        );
        if (row.value === "never")
          assert.ok(
            timingTable,
            `never is outside the timing allowlist: ${paths.join(", ")}`
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
