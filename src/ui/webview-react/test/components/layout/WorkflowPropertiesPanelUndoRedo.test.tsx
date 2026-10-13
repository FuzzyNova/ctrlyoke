import { EditorView } from "@codemirror/view";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { WorkflowPropertiesPanel } from "@components/layout/WorkflowPropertiesPanel";
import { UndoRedoControl } from "@components/shared/UndoRedoControl";
import { HARNESS_DISPLAY_NAMES } from "@components/shared/HarnessDropdown";
import { createMessageHandlers } from "@hooks/useMessageHandler";
import { useEditorStore } from "@store/editorStore";
import { useSettingsStore } from "@store/settingsStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useSecretRegistryStore } from "@store/secretRegistryStore";
import {
  CONDITION_ACTIONS,
  EXECUTION_MODES,
  HARNESS_IDS,
  MESSAGE_TYPES,
  PERMISSION_MODES,
  SCRIPT_OPERATORS,
  WORKFLOW_PROPERTY_KEYS,
  WORKTREE_MODES,
} from "@root/types/DashboardConstants";
import { SCRIPT_OPERATOR_OPTIONS_META } from "@root/types/SchemaUiMetadata";
import { restoreClearedWorkflowProperties } from "@root/utils/WorkflowPropertyPatch";

/**
 * Exhaustive undo/redo coverage for every editable control in the workflow
 * properties drawer.
 *
 * Each case drives one real UI gesture and then asserts the full round trip:
 * the gesture changes `workflowProperties`, records exactly the expected number
 * of zundo entries, undoing returns the properties to the byte-for-byte
 * baseline, and redoing returns them to the post-gesture value. The
 * `UndoRedoControl` is rendered alongside the panel so the assertions exercise
 * the production undo path (`temporal.undo()` -> `setWorkflowProperties`)
 * rather than poking the temporal store directly.
 */

const postMessage = vi.fn();

function resetStores(): void {
  useWorkflowStore.getState().resetWorkflow();
  useWorkflowStore.temporal.getState().clear();
  useEditorStore.getState().resetEditor();
  useSettingsStore.getState().resetSettings();
  useUiStore.getState().resetUi();
  useUiStore.setState({ settingsCollapsed: false });
  useSecretRegistryStore.getState().resetSecretRegistry();
}

/**
 * Key-order-independent serialization that drops `undefined` members, matching
 * how the rest of the app treats an omitted optional property. Undo restores a
 * snapshot object built at a different time, so raw `toEqual` would report
 * spurious differences from key insertion order alone.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([, member]) => member !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      );
    }
    return entry;
  });
}

function propertiesJson(): string {
  return stableJson(useSettingsStore.getState().workflowProperties);
}

function pastCount(): number {
  return useWorkflowStore.temporal.getState().pastStates.length;
}

/**
 * Seed the state a freshly opened workflow has: a definition on screen, plus
 * the `WORKFLOW_PROPERTIES_UPDATE` the extension always sends after reading the
 * working file. That echo is what puts the *complete* normalized key set into
 * both stores, and undo depends on it — a snapshot only knows which properties
 * the workflow did not have because every key is present and `undefined`.
 */
function seedBaseline(): void {
  useWorkflowStore.getState().loadWorkflow({
    fileName: "workflow.ctrlyoke.yaml",
    workflowName: "Undo Fixture",
    steps: [{ prompt: "Do the thing" }],
  });
  createMessageHandlers(false)[MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE]({
    workflowProperties: useSettingsStore.getState().workflowProperties,
  });
  useWorkflowStore.temporal.getState().clear();
}

function renderPanel(): void {
  render(
    <>
      <WorkflowPropertiesPanel />
      <UndoRedoControl isRunning={false} isPaused={false} />
    </>
  );
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`No element with id "${id}" is rendered`);
  }
  return element;
}

/** Replace a CodeMirror editor's whole document and commit it with a blur. */
function commitEditor(element: HTMLElement, text: string): void {
  const view = EditorView.findFromDOM(element as HTMLElement);
  if (!view) {
    throw new Error(`No CodeMirror view mounted on "${element.id}"`);
  }
  act(() => {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
    });
  });
  fireEvent.blur(element);
}

function commitInput(element: HTMLElement, value: string): void {
  fireEvent.change(element, { target: { value } });
  fireEvent.blur(element);
}

function openSelect(id: string): void {
  fireEvent.click(requireElement(id));
}

/**
 * Click an option in the dropdown that is currently open. Options are matched
 * on leading text because a `CustomSelect` row's accessible name also absorbs
 * its description line.
 */
function chooseOption(label: string): void {
  const listbox = screen.getByRole("listbox");
  const options = within(listbox).getAllByRole("button");
  const match = options.find((option) =>
    (option.textContent ?? "").trim().startsWith(label)
  );
  if (!match) {
    throw new Error(
      `No option starting with "${label}" in the open dropdown. Saw: ${options
        .map((option) => JSON.stringify((option.textContent ?? "").trim()))
        .join(", ")}`
    );
  }
  fireEvent.click(match);
}

function clickTab(name: string): void {
  fireEvent.click(screen.getByRole("tab", { name }));
}

function clickUndo(): void {
  fireEvent.click(screen.getByRole("button", { name: "Undo" }));
}

function clickRedo(): void {
  fireEvent.click(screen.getByRole("button", { name: "Redo" }));
}

interface UndoCase {
  /** Test name; also the gesture description in failure output. */
  name: string;
  /** Drawer tab that hosts the control, when it is not the default page. */
  tab?: string;
  /** Global settings / workflow overrides applied before the panel renders. */
  setup?: () => void;
  /** The UI gesture under test. */
  run: () => void;
  /**
   * How many zundo entries the gesture is expected to push. Anything other
   * than 1 is itself worth knowing about: a gesture that pushes several makes
   * the user press undo several times for one visible change.
   */
  entries?: number;
}

const HARNESS_CASES: UndoCase[] = [
  {
    name: "harness dropdown",
    setup: () => {
      useSettingsStore
        .getState()
        .updateGlobalSetting("harness", HARNESS_IDS.COPILOT_CLI);
    },
    run: () => {
      openSelect("settings-harness");
      chooseOption(HARNESS_DISPLAY_NAMES[HARNESS_IDS.CLAUDE_CLI]);
    },
  },
  {
    name: "model dropdown",
    setup: () => {
      // copilot-cli ships no built-in model list, so pick a harness that does.
      useSettingsStore
        .getState()
        .updateGlobalSetting("harness", HARNESS_IDS.CLAUDE_CLI);
    },
    run: () => {
      const settings = useSettingsStore.getState();
      const harness = settings.getEffectiveHarness();
      const current = settings.getEffectiveModel();
      const target = settings
        .getModelsForHarness(harness)
        .find((model) => model.value !== current);
      if (!target) {
        throw new Error(`No alternate model available for ${harness}`);
      }
      openSelect("settings-model");
      chooseOption(target.label);
    },
  },
  {
    name: "agent dropdown",
    setup: () => {
      useSettingsStore.getState().setAvailableAgents([
        {
          name: "reviewer",
          path: ".github/agents/reviewer.agent.md",
          description: "Reviews code",
        },
      ]);
    },
    run: () => {
      openSelect("settings-agent");
      chooseOption("reviewer");
    },
  },
  {
    name: "skills multi-select",
    setup: () => {
      useSettingsStore.getState().setAvailableSkills([
        {
          name: "commit",
          path: ".claude/skills/commit/SKILL.md",
          description: "Commit changes",
        },
      ]);
    },
    run: () => {
      openSelect("settings-skills");
      chooseOption("commit");
    },
  },
  {
    name: "additional args editor",
    run: () => {
      commitEditor(screen.getByLabelText("Additional arguments"), "--verbose");
    },
  },
  {
    name: "execution mode dropdown",
    setup: () => {
      useSettingsStore
        .getState()
        .updateGlobalSetting("executionMode", EXECUTION_MODES.HEADLESS);
    },
    run: () => {
      openSelect("settings-execution-mode");
      chooseOption("Interactive");
    },
  },
  {
    name: "worktree mode dropdown",
    run: () => {
      openSelect("settings-worktree-mode");
      chooseOption("Named");
    },
  },
  {
    name: "worktree branch editor",
    setup: () => {
      useSettingsStore.getState().updateWorkflowProperty("worktree", {
        mode: WORKTREE_MODES.NAMED,
        branch: "ui-work",
      });
    },
    run: () => {
      commitEditor(screen.getByLabelText("Worktree branch"), "feature/new");
    },
  },
  {
    name: "worktree base editor",
    setup: () => {
      useSettingsStore.getState().updateWorkflowProperty("worktree", {
        mode: WORKTREE_MODES.NAMED,
        branch: "ui-work",
      });
    },
    run: () => {
      commitEditor(screen.getByLabelText("Worktree base"), "main");
    },
  },
  {
    name: "worktree setup editor",
    setup: () => {
      useSettingsStore.getState().updateWorkflowProperty("worktree", {
        mode: WORKTREE_MODES.NAMED,
        branch: "ui-work",
      });
    },
    run: () => {
      commitEditor(screen.getByLabelText("Worktree setup"), "npm ci");
    },
  },
  {
    name: "worktree keep checkbox",
    setup: () => {
      useSettingsStore
        .getState()
        .updateWorkflowProperty("worktree", { mode: WORKTREE_MODES.MANAGED });
    },
    run: () => {
      fireEvent.click(screen.getByLabelText("Keep directory"));
    },
  },
  {
    name: "worktree merge checkbox",
    setup: () => {
      useSettingsStore
        .getState()
        .updateWorkflowProperty("worktree", { mode: WORKTREE_MODES.MANAGED });
    },
    run: () => {
      fireEvent.click(screen.getByLabelText("Merge"));
    },
  },
];

const CONTEXT_CASES: UndoCase[] = [
  {
    name: "resume session dropdown",
    tab: "Context",
    run: () => {
      openSelect("settings-resume-session");
      chooseOption("Resume");
    },
  },
  {
    name: "session id input",
    tab: "Context",
    setup: () => {
      useSettingsStore.getState().updateWorkflowProperty("resumeSession", true);
    },
    run: () => {
      commitInput(screen.getByLabelText("Session ID"), "7");
    },
  },
  {
    name: "prior context dropdown",
    tab: "Context",
    run: () => {
      fireEvent.click(screen.getByRole("button", { name: /priorContext/ }));
      chooseOption("All");
    },
  },
  {
    name: "variables editor",
    tab: "Context",
    setup: () => {
      useSettingsStore
        .getState()
        .updateWorkflowProperty("vars", { region: "us-east-1" });
    },
    run: () => {
      commitInput(screen.getByLabelText("Value for region"), "eu-west-1");
    },
  },
];

/** A pre-condition whose operator is a text operator, so Ignore case renders. */
const PRE_CONDITION_FIXTURE = {
  script: "check.sh",
  operator: SCRIPT_OPERATORS.CONTAINS,
  expected: "ready",
  onFail: CONDITION_ACTIONS.SKIP_PROMPT,
};

function seedPreConditionOnly(): void {
  useSettingsStore.getState().updateGlobalSetting("defaultEndCondition", null);
  useSettingsStore
    .getState()
    .updateWorkflowProperty("preCondition", PRE_CONDITION_FIXTURE);
  useSettingsStore.getState().updateWorkflowProperty("endCondition", null);
}

function seedEndConditionOnly(
  overrides: Record<string, unknown> = {}
): () => void {
  return () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("defaultPreCondition", null);
    useSettingsStore.getState().updateWorkflowProperty("preCondition", null);
    useSettingsStore.getState().updateWorkflowProperty("endCondition", {
      script: "npm test",
      operator: SCRIPT_OPERATORS.CONTAINS,
      expected: "0 failing",
      ...overrides,
    });
  };
}

const VALIDATION_CASES: UndoCase[] = [
  {
    name: "pre-condition enable checkbox",
    tab: "Validation",
    setup: () => {
      useSettingsStore.getState().updateGlobalSetting("defaultPreCondition", {
        script: "test -f package.json",
      });
      useSettingsStore
        .getState()
        .updateGlobalSetting("defaultEndCondition", null);
      useSettingsStore.getState().updateWorkflowProperty("preCondition", null);
    },
    run: () => {
      fireEvent.click(screen.getByLabelText("Enable Pre-Condition"));
    },
  },
  {
    name: "pre-condition script editor",
    tab: "Validation",
    setup: seedPreConditionOnly,
    run: () => {
      commitEditor(requireElement("settings-pre-script"), "verify.sh");
    },
  },
  {
    name: "pre-condition environment editor",
    tab: "Validation",
    setup: seedPreConditionOnly,
    run: () => {
      fireEvent.click(
        screen.getByRole("button", { name: "+ Add environment variable" })
      );
      commitInput(screen.getByLabelText("environment variable name"), "CI");
    },
  },
  {
    name: "pre-condition compare source dropdown",
    tab: "Validation",
    setup: seedPreConditionOnly,
    run: () => {
      openSelect("settings-pre-compare-source");
      chooseOption("Stdout");
    },
  },
  {
    name: "pre-condition operator dropdown",
    tab: "Validation",
    setup: seedPreConditionOnly,
    run: () => {
      openSelect("settings-pre-operator");
      chooseOption(
        SCRIPT_OPERATOR_OPTIONS_META[SCRIPT_OPERATORS.NOT_CONTAINS].label
      );
    },
  },
  {
    name: "pre-condition expected input",
    tab: "Validation",
    setup: seedPreConditionOnly,
    run: () => {
      commitInput(requireElement("settings-pre-expected"), "all good");
    },
  },
  {
    name: "pre-condition ignore case checkbox (check)",
    tab: "Validation",
    setup: seedPreConditionOnly,
    run: () => {
      fireEvent.click(requireElement("settings-pre-ignore-case"));
    },
  },
  {
    name: "pre-condition ignore case checkbox (uncheck)",
    tab: "Validation",
    setup: () => {
      useSettingsStore
        .getState()
        .updateGlobalSetting("defaultEndCondition", null);
      useSettingsStore.getState().updateWorkflowProperty("endCondition", null);
      useSettingsStore.getState().updateWorkflowProperty("preCondition", {
        ...PRE_CONDITION_FIXTURE,
        ignoreCase: true,
      });
    },
    run: () => {
      fireEvent.click(requireElement("settings-pre-ignore-case"));
    },
  },
  {
    // The reported case: the workflow has no pre-condition of its own, so the
    // toggle *creates* the property — and undo has to take it back off again,
    // not merely overwrite it.
    name: "pre-condition ignore case checkbox on an inherited condition",
    tab: "Validation",
    setup: () => {
      useSettingsStore
        .getState()
        .updateGlobalSetting("defaultEndCondition", null);
      useSettingsStore
        .getState()
        .updateGlobalSetting("defaultPreCondition", PRE_CONDITION_FIXTURE);
    },
    run: () => {
      fireEvent.click(requireElement("settings-pre-ignore-case"));
    },
  },
  {
    name: "pre-condition on-pass dropdown",
    tab: "Validation",
    setup: seedPreConditionOnly,
    run: () => {
      openSelect("settings-pre-on-pass");
      chooseOption("Stop Workflow");
    },
  },
  {
    name: "pre-condition on-fail dropdown",
    tab: "Validation",
    setup: seedPreConditionOnly,
    run: () => {
      openSelect("settings-pre-on-fail");
      chooseOption("Stop Workflow");
    },
  },
  {
    name: "pre-condition timeout input",
    tab: "Validation",
    setup: seedPreConditionOnly,
    run: () => {
      commitInput(requireElement("settings-pre-timeout"), "5");
    },
  },
  {
    name: "end-condition enable checkbox",
    tab: "Validation",
    setup: () => {
      useSettingsStore
        .getState()
        .updateGlobalSetting("defaultPreCondition", null);
      useSettingsStore
        .getState()
        .updateGlobalSetting("defaultEndCondition", { script: "npm test" });
      useSettingsStore.getState().updateWorkflowProperty("endCondition", null);
    },
    run: () => {
      fireEvent.click(screen.getByLabelText("Enable End Condition"));
    },
  },
  {
    name: "end-condition script editor",
    tab: "Validation",
    setup: seedEndConditionOnly(),
    run: () => {
      commitEditor(requireElement("settings-end-script"), "npm run verify");
    },
  },
  {
    name: "end-condition ignore case checkbox",
    tab: "Validation",
    setup: seedEndConditionOnly(),
    run: () => {
      fireEvent.click(requireElement("settings-end-ignore-case"));
    },
  },
  {
    name: "end-condition max retries input",
    tab: "Validation",
    setup: seedEndConditionOnly({ onFail: CONDITION_ACTIONS.RETRY }),
    entries: 2,
    run: () => {
      openSelect("settings-end-max-retries");
      chooseOption("Custom");
      commitInput(requireElement("settings-end-max-retries-custom"), "4");
    },
  },
  {
    name: "end-condition resume-session-on-retry checkbox",
    tab: "Validation",
    setup: seedEndConditionOnly({ onFail: CONDITION_ACTIONS.RETRY }),
    run: () => {
      fireEvent.click(requireElement("settings-end-resume-session-on-retry"));
    },
  },
  {
    name: "error behavior dropdown",
    tab: "Validation",
    run: () => {
      openSelect("settings-error-on-error");
      chooseOption("Continue");
    },
  },
];

const MCP_CASES: UndoCase[] = [
  {
    name: "mcp ctrlyoke toggle",
    tab: "MCP",
    run: () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Enable ctrlyoke MCP server" })
      );
    },
  },
];

const PERMISSION_CASES: UndoCase[] = [
  {
    name: "permission mode dropdown",
    tab: "Permissions",
    run: () => {
      openSelect("settings-permission-mode");
      chooseOption("Custom");
    },
  },
  {
    name: "secrets multi-select",
    tab: "Permissions",
    setup: () => {
      useSecretRegistryStore.getState().setEntries("workspace", [
        {
          name: "API_TOKEN",
          scope: "workspace",
          state: "managed-and-set",
          usedBy: { mcpServers: [], workflows: [] },
        },
      ]);
    },
    run: () => {
      openSelect("settings-secrets");
      chooseOption("API_TOKEN");
    },
  },
  {
    name: "trusted external roots dropdown",
    tab: "Permissions",
    setup: () => {
      useSettingsStore.getState().setGlobalSettings({
        ...useSettingsStore.getState().globalSettings,
        externalFileRootsByScope: {
          user: ["/home/user/library"],
          workspace: [],
        },
      });
    },
    run: () => {
      openSelect("settings-trusted-external-roots-mode");
      chooseOption("None");
    },
  },
  {
    name: "allowed tools editor",
    tab: "Permissions",
    setup: () => {
      useSettingsStore.getState().updateWorkflowProperty("toolPermissions", {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: [],
        deniedTools: [],
      });
    },
    run: () => {
      commitEditor(screen.getByLabelText("Allowed Tools"), "shell(git:*)");
    },
  },
  {
    name: "denied tools editor",
    tab: "Permissions",
    setup: () => {
      useSettingsStore.getState().updateWorkflowProperty("toolPermissions", {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: [],
        deniedTools: [],
      });
    },
    run: () => {
      commitEditor(screen.getByLabelText("Denied Tools"), "shell(rm:*)");
    },
  },
];

const HOOKS_CASES: UndoCase[] = [
  {
    name: "add hook",
    tab: "Hooks",
    run: () => {
      fireEvent.click(screen.getByRole("button", { name: "+ Add Hook" }));
    },
  },
];

const HEADER_CASES: UndoCase[] = [
  {
    name: "reset all to defaults",
    setup: () => {
      useSettingsStore
        .getState()
        .updateGlobalSetting("executionMode", EXECUTION_MODES.HEADLESS);
      useSettingsStore
        .getState()
        .updateWorkflowProperty("executionMode", EXECUTION_MODES.INTERACTIVE);
    },
    run: () => {
      fireEvent.click(
        screen.getByRole("button", { name: "Reset all to defaults" })
      );
    },
  },
];

const ALL_CASES: Array<{ group: string; cases: UndoCase[] }> = [
  { group: "harness page", cases: HARNESS_CASES },
  { group: "context page", cases: CONTEXT_CASES },
  { group: "validation page", cases: VALIDATION_CASES },
  { group: "mcp page", cases: MCP_CASES },
  { group: "permissions page", cases: PERMISSION_CASES },
  { group: "hooks page", cases: HOOKS_CASES },
  { group: "panel header", cases: HEADER_CASES },
];

describe("WorkflowPropertiesPanel undo/redo", () => {
  beforeAll(() => {
    if (!Range.prototype.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
  });

  beforeEach(() => {
    resetStores();
    postMessage.mockClear();
    (
      window.vscodeApi as unknown as { postMessage: typeof postMessage }
    ).postMessage = postMessage;
  });

  afterEach(cleanup);

  for (const { group, cases } of ALL_CASES) {
    describe(group, () => {
      for (const testCase of cases) {
        it(`round-trips ${testCase.name}`, () => {
          testCase.setup?.();
          seedBaseline();
          renderPanel();
          if (testCase.tab) {
            clickTab(testCase.tab);
          }

          const baseline = propertiesJson();
          expect(pastCount()).toBe(0);

          testCase.run();

          const mutated = propertiesJson();
          expect(
            mutated,
            `${testCase.name} did not change any workflow property`
          ).not.toBe(baseline);

          const entries = pastCount();
          expect(
            entries,
            `${testCase.name} pushed ${entries} undo entries`
          ).toBe(testCase.entries ?? 1);

          for (let i = 0; i < entries; i++) {
            clickUndo();
          }
          expect(
            propertiesJson(),
            `${testCase.name} did not undo cleanly`
          ).toBe(baseline);

          for (let i = 0; i < entries; i++) {
            clickRedo();
          }
          expect(
            propertiesJson(),
            `${testCase.name} did not redo cleanly`
          ).toBe(mutated);
        });
      }
    });
  }
});

/**
 * A faithful stand-in for the extension host's workflow-property write path,
 * so undo/redo can be asserted against what would actually be persisted rather
 * than only against the client's optimistic state.
 *
 * Every rule here mirrors a specific production behaviour:
 *  - messages cross the boundary as JSON, so `undefined` members never arrive
 *    and a patch's deletes travel as an explicit key list that
 *    `restoreClearedWorkflowProperties` re-materializes on arrival;
 *  - `WebviewSettingsSync.handleUpdateWorkflowProperties` returns early on an
 *    empty patch and otherwise delegates to `applyWorkflowPropertyWrites`
 *    (`WorkingFileManager.ts`), which replaces a key's value wholesale and
 *    only deletes when the patch carries an explicit `undefined`;
 *  - `WorkflowStepHandlers.syncUndoRedo` projects an undo/redo message's
 *    properties through `WORKFLOW_PROPERTY_KEYS` before writing them;
 *  - every write is followed by `sendWorkflowPropertiesToSettings`, which
 *    re-reads the file and echoes all `WORKFLOW_PROPERTY_KEYS` back.
 */
class WorkingFileSimulator {
  private readonly file: Record<string, unknown> = {};
  private echoQueued = false;

  seedFromStore(): void {
    for (const key of WORKFLOW_PROPERTY_KEYS) {
      const value = useSettingsStore.getState().workflowProperties[key];
      if (value !== undefined) {
        this.file[key] = value;
      }
    }
  }

  /** Serialized view of the persisted properties, for baseline comparison. */
  json(): string {
    return stableJson(
      Object.fromEntries(
        WORKFLOW_PROPERTY_KEYS.map((key) => [key, this.file[key]])
      )
    );
  }

  receive(rawMessage: unknown): void {
    const message = JSON.parse(JSON.stringify(rawMessage)) as Record<
      string,
      unknown
    >;

    if (message.type === MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTY) {
      // The singular form names its key outside the value, so a delete
      // survives the wire without a cleared list.
      this.write({ [message.property as string]: message.value });
      return;
    }
    if (message.type === MESSAGE_TYPES.UPDATE_WORKFLOW_PROPERTIES) {
      this.write(
        restoreClearedWorkflowProperties(
          message.properties as Record<string, unknown> | undefined,
          message.clearedProperties as string[] | undefined
        )
      );
      return;
    }
    if (message.type === MESSAGE_TYPES.UNDO_REDO_SYNC) {
      this.writeUndoRedo(
        (message.workflowProperties as Record<string, unknown>) ?? {},
        message.clearedWorkflowProperties as string[] | undefined
      );
    }
  }

  /** Deliver the queued `WORKFLOW_PROPERTIES_UPDATE` echo to the client. */
  flush(): void {
    if (!this.echoQueued) return;
    this.echoQueued = false;
    const workflowProperties = Object.fromEntries(
      WORKFLOW_PROPERTY_KEYS.map((key) => [key, this.file[key]])
    );
    act(() => {
      createMessageHandlers(false)[MESSAGE_TYPES.WORKFLOW_PROPERTIES_UPDATE]({
        workflowProperties,
      });
    });
  }

  private write(properties: Record<string, unknown>): void {
    // handleUpdateWorkflowProperties: an empty patch is not a write at all.
    if (Object.keys(properties).length === 0) return;

    const allowDeletes = Object.values(properties).some(
      (value) => value === undefined
    );
    this.applyWrites(properties, allowDeletes);
    this.echoQueued = true;
  }

  private writeUndoRedo(
    workflowProperties: Record<string, unknown>,
    clearedKeys: string[] | undefined
  ): void {
    // syncUndoRedo projects the snapshot through WORKFLOW_PROPERTY_KEYS and
    // re-materializes the keys the snapshot reported as cleared.
    const projected = restoreClearedWorkflowProperties(
      Object.fromEntries(
        WORKFLOW_PROPERTY_KEYS.map((key) => [
          key,
          workflowProperties[key],
        ]).filter(([, value]) => value !== undefined)
      ),
      clearedKeys?.filter((key) =>
        (WORKFLOW_PROPERTY_KEYS as readonly string[]).includes(key)
      )
    );
    this.write(projected);
  }

  private applyWrites(
    properties: Record<string, unknown>,
    allowDeletes: boolean
  ): void {
    for (const [key, value] of Object.entries(properties)) {
      if (value === undefined) {
        if (allowDeletes) delete this.file[key];
        continue;
      }
      this.file[key] = value;
    }
  }
}

describe("WorkflowPropertiesPanel undo/redo through the extension", () => {
  let workingFile: WorkingFileSimulator;

  beforeAll(() => {
    if (!Range.prototype.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
  });

  beforeEach(() => {
    resetStores();
    workingFile = new WorkingFileSimulator();
    postMessage.mockReset();
    postMessage.mockImplementation((message: unknown) => {
      workingFile.receive(message);
    });
    (
      window.vscodeApi as unknown as { postMessage: typeof postMessage }
    ).postMessage = postMessage;
  });

  afterEach(cleanup);

  for (const { group, cases } of ALL_CASES) {
    describe(group, () => {
      for (const testCase of cases) {
        it(`persists an undo of ${testCase.name}`, () => {
          testCase.setup?.();
          seedBaseline();
          workingFile.seedFromStore();
          renderPanel();
          if (testCase.tab) {
            clickTab(testCase.tab);
          }

          const baselineFile = workingFile.json();

          testCase.run();
          workingFile.flush();

          const mutatedFile = workingFile.json();
          expect(
            mutatedFile,
            `${testCase.name} persisted nothing to the working file`
          ).not.toBe(baselineFile);

          const entries = pastCount();
          for (let i = 0; i < entries; i++) {
            clickUndo();
            workingFile.flush();
          }
          expect(
            workingFile.json(),
            `undoing ${testCase.name} did not reach the working file`
          ).toBe(baselineFile);

          for (let i = 0; i < entries; i++) {
            clickRedo();
            workingFile.flush();
          }
          expect(
            workingFile.json(),
            `redoing ${testCase.name} did not reach the working file`
          ).toBe(mutatedFile);
        });
      }
    });
  }
});

describe("WorkflowPropertiesPanel undo/redo sequences", () => {
  beforeAll(() => {
    if (!Range.prototype.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
  });

  beforeEach(() => {
    resetStores();
    postMessage.mockClear();
    (
      window.vscodeApi as unknown as { postMessage: typeof postMessage }
    ).postMessage = postMessage;
  });

  afterEach(cleanup);

  /**
   * The reported "intermittent undo failures when setting a lot of things on
   * the pre-condition": several edits to the same nested condition object in a
   * row must each be independently undoable, in reverse order.
   */
  // This interaction traverses the full properties panel repeatedly; under
  // `npm test` the UI workers share the machine with six extension hosts, and
  // the default 20s budget expired under that load despite passing alone.
  it("unwinds a run of pre-condition edits one step at a time", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("defaultEndCondition", null);
    useSettingsStore.getState().updateWorkflowProperty("endCondition", null);
    useSettingsStore
      .getState()
      .updateWorkflowProperty("preCondition", { script: "check.sh" });
    seedBaseline();
    renderPanel();
    clickTab("Validation");

    const checkpoints: string[] = [propertiesJson()];

    openSelect("settings-pre-compare-source");
    chooseOption("Stdout");
    checkpoints.push(propertiesJson());

    openSelect("settings-pre-operator");
    chooseOption(SCRIPT_OPERATOR_OPTIONS_META[SCRIPT_OPERATORS.CONTAINS].label);
    checkpoints.push(propertiesJson());

    commitInput(requireElement("settings-pre-expected"), "ready");
    checkpoints.push(propertiesJson());

    fireEvent.click(requireElement("settings-pre-ignore-case"));
    checkpoints.push(propertiesJson());

    commitInput(requireElement("settings-pre-timeout"), "9");
    checkpoints.push(propertiesJson());

    // Every gesture must be its own entry, and every checkpoint distinct.
    expect(new Set(checkpoints).size).toBe(checkpoints.length);
    expect(pastCount()).toBe(checkpoints.length - 1);

    for (let i = checkpoints.length - 1; i > 0; i--) {
      clickUndo();
      expect(propertiesJson(), `undo back to checkpoint ${i - 1}`).toBe(
        checkpoints[i - 1]
      );
    }

    for (let i = 1; i < checkpoints.length; i++) {
      clickRedo();
      expect(propertiesJson(), `redo forward to checkpoint ${i}`).toBe(
        checkpoints[i]
      );
    }
  }, 60000);

  /**
   * Committing one field while a second control is activated in the same tick
   * is the ordinary way a user leaves a text box: the blur and the click land
   * together. Neither edit may be lost.
   */
  it("keeps a blurred expected value when the operator changes in the same gesture", () => {
    useSettingsStore
      .getState()
      .updateGlobalSetting("defaultEndCondition", null);
    useSettingsStore.getState().updateWorkflowProperty("endCondition", null);
    useSettingsStore.getState().updateWorkflowProperty("preCondition", {
      script: "check.sh",
      operator: SCRIPT_OPERATORS.CONTAINS,
    });
    seedBaseline();
    renderPanel();
    clickTab("Validation");

    const expected = requireElement("settings-pre-expected");
    fireEvent.change(expected, { target: { value: "ready" } });

    // The blur is delivered by the click that opens the operator dropdown, so
    // both handlers run before React re-renders the editor with new props.
    act(() => {
      fireEvent.blur(expected);
      fireEvent.click(requireElement("settings-pre-operator"));
    });
    chooseOption(
      SCRIPT_OPERATOR_OPTIONS_META[SCRIPT_OPERATORS.NOT_CONTAINS].label
    );

    expect(
      useSettingsStore.getState().workflowProperties.preCondition
    ).toMatchObject({
      script: "check.sh",
      operator: SCRIPT_OPERATORS.NOT_CONTAINS,
      expected: "ready",
    });
  });
});
