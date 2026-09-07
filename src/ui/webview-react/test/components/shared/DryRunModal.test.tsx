import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkflowExecutionPreview } from "@root/types/ExecutionPreviewTypes";
import type { HarnessCapabilityRegistrySnapshot } from "@root/types/CompatibilityTypes";
import {
  CAPABILITY_DOMAINS,
  CAPABILITY_FIDELITIES,
  CAPABILITY_MECHANISMS,
  CAPABILITY_VERIFICATION_STATUSES,
  HARNESS_IDS,
  PERMISSION_MODES,
  PREVIEW_PROMPT_CATEGORIES,
  PREVIEW_TRUNCATION_REASON_COPY,
  PREVIEW_TRUNCATION_REASONS,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";
import { useCompatibilityStore } from "@store/compatibilityStore";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkflowStore } from "@store/workflowStore";
import { DryRunModal } from "@components/shared/DryRunModal";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@hooks/useMessageHandler", () => ({ sendMessage }));

const clipboardWriteText = vi.fn<(text: string) => Promise<void>>();

const preview: WorkflowExecutionPreview = {
  parallelGroups: [],
  parallelGroupPreflights: [],
  workflow: {
    name: "Preview Workflow",
    stepCount: 2,
    sourcePath: "C:/workspace/workflow.ctrlyoke.yaml",
    harnessIds: ["claude-cli"],
    totalByteCount: 128,
    totalTokenEstimate: 42,
    workspaceMutationCount: 1,
  },
  diagnostics: [
    {
      code: "compatibility.permissions.mode.partial",
      severity: "warning",
      harnessId: "claude-cli",
      capability: "mode",
      state: {
        fidelity: "partial",
        mechanism: "translated-cli",
        verification: "unknown",
      },
      message: "Permission mode is only partially translated.",
    },
  ],
  steps: [
    {
      stepIndex: 0,
      stepName: "Prepare",
      type: "prompt",
      resolvedProperties: {
        harnessId: "claude-cli",
        session: { present: false },
        skills: [],
        secrets: ["API_TOKEN"],
        mcpServerIds: [],
        hooks: [],
        permissions: { mode: "custom", allowedRules: [], deniedRules: [] },
        limits: { violations: [] },
        conditions: {
          pre: [],
          end: [],
          retry: { maxAttempts: 1 },
        },
        propertySources: {},
      },
      prompt: {
        totalByteCount: 128,
        includedBodyByteCount: 128,
        bodyBudgetBytes: 1024,
        sections: [
          {
            category: "prompt-text",
            byteCount: 128,
            lineCount: 1,
            tokenEstimate: 42,
            chunkIndex: 0,
            contentHash: "hash",
            body: "redacted prompt body",
            truncationReason: "body-budget",
          },
        ],
      },
      command: {
        executable: "claude",
        args: ["--print"],
        displayCommand: "claude --print [REDACTED]",
        displayShell: "powershell",
        requiresShellVerbatimArgs: false,
        cwd: "C:/workspace",
        environmentKeys: ["TOKEN"],
      },
      workspaceMutations: [
        {
          path: "C:/workspace/.claude/settings.json",
          scope: "shared",
          ownedKeys: ["permissions"],
          operation: "write",
          warning: "Workspace-wide side effect: May replace owned keys.",
        },
      ],
      variables: [],
      conditions: {
        pre: [],
        end: [],
        retry: { maxAttempts: 2, backoffSeconds: 1 },
        errorBehavior: "stop",
      },
      permissionApplication: {
        effectiveMode: "custom",
        rules: [],
        nativeArguments: ["--permission-mode", "custom"],
        diagnostics: [],
      },
      diagnostics: [],
    },
    {
      stepIndex: 1,
      stepName: "Verify",
      type: "script",
      resolvedProperties: {
        harnessId: "claude-cli",
        session: { present: false },
        skills: [],
        mcpServerIds: [],
        hooks: [],
        permissions: { allowedRules: [], deniedRules: [] },
        limits: { violations: [] },
        conditions: {
          pre: [],
          end: [],
          retry: { maxAttempts: 1 },
        },
        propertySources: {},
      },
      command: {
        executable: "/bin/sh",
        args: ["-c", "npm test"],
        displayCommand: "/bin/sh -c 'npm test'",
        displayShell: "posix",
        requiresShellVerbatimArgs: false,
        cwd: "C:/workspace",
        environmentKeys: [],
      },
      workspaceMutations: [],
      variables: [],
      conditions: {
        pre: [],
        end: [],
        retry: { maxAttempts: 1 },
      },
      diagnostics: [
        {
          code: "verify.warning",
          severity: "error",
          harnessId: "claude-cli",
          capability: "verify",
          state: {
            fidelity: "unsupported",
            mechanism: "none",
            verification: "unknown",
          },
          message: "Verification is unavailable.",
        },
      ],
    },
  ],
};

function openPreview(
  scope: { kind: "workflow" } | { kind: "step"; stepIndex: number },
  nextPreview: WorkflowExecutionPreview = preview
) {
  useExecutionPreviewStore.setState({
    preview: nextPreview,
    status: "ready",
    scope,
    displayedDefinitionRevision: 1,
    displayedAddress: {
      workflowKey: "workflow-a" as never,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    },
    isStale: false,
  });
}

function makeCapabilitySnapshot(): HarnessCapabilityRegistrySnapshot {
  const harnesses = {} as HarnessCapabilityRegistrySnapshot["harnesses"];
  for (const harnessId of Object.values(HARNESS_IDS)) {
    const exactState = {
      fidelity: CAPABILITY_FIDELITIES.EXACT,
      mechanism: CAPABILITY_MECHANISMS.NATIVE,
      verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
    } as const;
    const declaration = {
      fidelity: CAPABILITY_FIDELITIES.EXACT,
      mechanism: CAPABILITY_MECHANISMS.NATIVE,
    } as const;
    harnesses[harnessId] = {
      available: true,
      descriptor: {
        harnessId,
        permissions: {
          mode: declaration,
          allowedTools: declaration,
          deniedTools: declaration,
        },
      },
      effective: {
        permissions: {
          mode: exactState,
          allowedTools: exactState,
          deniedTools: exactState,
        },
      },
    };
  }
  harnesses[HARNESS_IDS.CODEX_CLI].effective!.permissions!.allowedTools = {
    fidelity: CAPABILITY_FIDELITIES.UNSUPPORTED,
    mechanism: CAPABILITY_MECHANISMS.NONE,
    verification: CAPABILITY_VERIFICATION_STATUSES.VERIFIED,
  };
  return {
    schemaVersion: 1,
    enabledDomains: [CAPABILITY_DOMAINS.PERMISSIONS],
    harnesses,
  };
}

describe("DryRunModal", () => {
  beforeEach(() => {
    useExecutionPreviewStore.getState().reset();
    useWorkflowStore.getState().resetWorkflow();
    useSettingsStore.getState().resetSettings();
    useCompatibilityStore.getState().resetCapabilitySnapshot();
    clipboardWriteText.mockReset();
    clipboardWriteText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the workflow overview and wide master rail", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      width: 800,
      height: 400,
      x: 0,
      y: 0,
      top: 0,
      right: 800,
      bottom: 400,
      left: 0,
      toJSON: () => ({}),
    });
    openPreview({ kind: "workflow" });

    render(<DryRunModal scope={{ kind: "workflow" }} />);

    expect(screen.getByText("Workflow summary")).toBeInTheDocument();
    expect(
      screen.getByRole("navigation", { name: "Dry run sections" })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Prepare" })).toBeInTheDocument();
    expect(screen.getByText("Workflow timeline")).toBeInTheDocument();
  });

  it("renders grouped members in a bordered block with failFast and width", () => {
    const groupedPreview: WorkflowExecutionPreview = {
      ...preview,
      parallelGroups: [
        {
          id: "group",
          startIndex: 0,
          endIndex: 1,
          failFast: true,
        },
      ],
      parallelGroupPreflights: [
        {
          parallelGroupId: "group",
          effectiveWidth: 1,
          executableMemberCount: 2,
        },
      ],
      steps: preview.steps.slice(0, 2).map((step) => ({
        ...step,
        parallelGroupId: "group",
      })),
    };
    openPreview({ kind: "workflow" }, groupedPreview);

    render(<DryRunModal scope={{ kind: "workflow" }} />);

    expect(screen.getByText("Parallel steps 1–2")).toBeInTheDocument();
    expect(
      screen.getByText("failFast: true · runs sequentially")
    ).toBeInTheDocument();
  });

  it("shows the workflow portability report as an overview section", async () => {
    const user = userEvent.setup();
    useWorkflowStore.setState({
      steps: [{ prompt: "Use the configured tools" }],
    });
    useSettingsStore.getState().setWorkflowProperties({
      toolPermissions: {
        mode: PERMISSION_MODES.CUSTOM,
        allowedTools: ["shell(git:*)"],
        deniedTools: [],
      },
    });
    useCompatibilityStore
      .getState()
      .setCapabilitySnapshot(makeCapabilitySnapshot());
    openPreview({ kind: "workflow" });

    render(<DryRunModal scope={{ kind: "workflow" }} />);

    expect(screen.getByText("Portability report")).toBeInTheDocument();
    expect(screen.getByText("Unsupported")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Show Codex details" })
    );
    expect(screen.getByText("Codex details")).toBeInTheDocument();
  });

  it("shows granted secret names with a redacted marker and never a value", () => {
    openPreview({ kind: "step", stepIndex: 0 });

    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    expect(screen.getByText("API_TOKEN [REDACTED]")).toBeInTheDocument();
    expect(screen.queryByText("super-secret-value")).not.toBeInTheDocument();
  });

  it("collapses the workflow rail into CustomSelect below the narrow breakpoint", () => {
    openPreview({ kind: "workflow" });

    render(<DryRunModal scope={{ kind: "workflow" }} />);

    expect(
      screen.queryByRole("navigation", { name: "Dry run sections" })
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Select dry run section" })
    ).toBeInTheDocument();
  });

  it("renders step scope without Overview or the rail", async () => {
    const user = userEvent.setup();
    openPreview({ kind: "step", stepIndex: 0 });

    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    expect(screen.queryByText("Workflow summary")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("navigation", { name: "Dry run sections" })
    ).not.toBeInTheDocument();
    expect(screen.getByText("Resolved execution")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Command" }));
    expect(screen.getByText("claude --print [REDACTED]")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Conditions" }));
    expect(
      screen.getByText("Maximum attempts").parentElement
    ).toHaveTextContent("Maximum attempts2");
  });

  it("keeps tab order and primary icon shapes stable while showing severity and permission badges", () => {
    const diagnosticPreview: WorkflowExecutionPreview = {
      ...preview,
      steps: [
        {
          ...preview.steps[0],
          resolvedProperties: {
            ...preview.steps[0].resolvedProperties,
            permissions: {
              ...preview.steps[0].resolvedProperties.permissions,
              mode: PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL,
            },
          },
          diagnostics: [preview.steps[1].diagnostics[0]],
          permissionApplication: {
            ...preview.steps[0].permissionApplication!,
            diagnostics: [preview.diagnostics[0]],
          },
        },
      ],
    };
    openPreview({ kind: "step", stepIndex: 0 }, diagnosticPreview);

    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    const tabBar = screen.getByRole("tab", { name: "Summary" })
      .parentElement as HTMLElement;
    expect(
      Array.from(tabBar.querySelectorAll("button")).map(
        (button) => button.title
      )
    ).toEqual(["Summary", "Command", "Payload", "Conditions"]);

    const summary = screen.getByRole("tab", { name: "Summary" });
    expect(summary.querySelector(".codicon-map-vertical")).toBeInTheDocument();
    expect(summary.querySelector(".codicon-error")).toBeInTheDocument();
    expect(summary.querySelector(".codicon-warning")).not.toBeInTheDocument();
    // The badge alone carries the severity color; the primary map-vertical
    // icon stays at its default (active-tab) color.
    expect(summary).not.toHaveClass("text-error-fg");
    expect(summary).toHaveClass("text-foreground");
    expect(summary.querySelector(".codicon-error")).toHaveClass(
      "text-error-fg"
    );

    const command = screen.getByRole("tab", { name: "Command" });
    expect(command.querySelector(".codicon-terminal")).toBeInTheDocument();
    expect(command.querySelector(".codicon-shield")).toBeInTheDocument();
    expect(command.querySelector(".codicon-error")).not.toBeInTheDocument();
    expect(command.querySelector(".codicon-warning")).not.toBeInTheDocument();
    // The badge alone carries the permission-mode color; the primary
    // terminal icon stays at its default (inactive-tab) color.
    expect(command).not.toHaveClass("text-error-fg");
    expect(command).toHaveClass("text-description-fg");
    expect(command.querySelector(".codicon-shield")).toHaveClass(
      "text-error-fg"
    );

    expect(
      screen
        .getByRole("tab", { name: "Conditions" })
        .querySelector(".codicon-coverage")
    ).toBeInTheDocument();
  });

  it("omits the command permission badge for none mode", () => {
    const noneModePreview: WorkflowExecutionPreview = {
      ...preview,
      steps: [
        {
          ...preview.steps[0],
          resolvedProperties: {
            ...preview.steps[0].resolvedProperties,
            permissions: {
              ...preview.steps[0].resolvedProperties.permissions,
              mode: PERMISSION_MODES.NONE,
            },
          },
        },
      ],
    };
    openPreview({ kind: "step", stepIndex: 0 }, noneModePreview);

    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    expect(
      screen
        .getByRole("tab", { name: "Command" })
        .querySelector(".codicon-terminal")
    ).toBeInTheDocument();
    expect(
      screen
        .getByRole("tab", { name: "Command" })
        .querySelector(".codicon-shield")
    ).not.toBeInTheDocument();
  });

  it("formats byte and token magnitudes while keeping plain counts exact", () => {
    const magnitude = 1_234_567;
    const magnitudePreview: WorkflowExecutionPreview = {
      ...preview,
      workflow: {
        ...preview.workflow,
        totalByteCount: magnitude,
        totalTokenEstimate: magnitude,
      },
      steps: preview.steps.map((step) =>
        step.stepIndex === 0
          ? {
              ...step,
              prompt: {
                ...step.prompt!,
                totalByteCount: magnitude,
                includedBodyByteCount: magnitude,
                sections: step.prompt!.sections.map((section) => ({
                  ...section,
                  byteCount: magnitude,
                  tokenEstimate: magnitude,
                })),
              },
            }
          : step
      ),
    };
    openPreview({ kind: "workflow" }, magnitudePreview);

    render(<DryRunModal scope={{ kind: "workflow" }} />);

    const summary = screen.getByText("Workflow summary")
      .parentElement as HTMLElement;
    expect(summary).toHaveTextContent("Payload bytes1.2M");
    expect(summary).toHaveTextContent("Token estimate1.2M");
    expect(summary).toHaveTextContent("Steps2");
    expect(summary).toHaveTextContent("Workspace mutations1");
  });

  it("renders the workflow timeline in step order and skips empty steps", () => {
    const emptyStepPreview: WorkflowExecutionPreview = {
      ...preview,
      steps: preview.steps.map((step) =>
        step.stepIndex === 1 ? { ...step, command: undefined } : step
      ),
    };
    openPreview({ kind: "workflow" }, emptyStepPreview);

    render(<DryRunModal scope={{ kind: "workflow" }} />);

    expect(screen.getByLabelText("Step 1: Prepare")).toBeInTheDocument();
    expect(screen.queryByLabelText("Step 2: Verify")).not.toBeInTheDocument();
  });

  it("switches per-step timeline links without closing the modal", async () => {
    const user = userEvent.setup();
    openPreview({ kind: "step", stepIndex: 0 });
    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    await user.click(
      screen.getByRole("button", { name: "View in Payload tab" })
    );
    expect(screen.getByText("Categorized payload")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Summary" }));
    await user.click(
      screen.getByRole("button", { name: "View in Command tab" })
    );
    expect(screen.getByText("(PowerShell)")).toBeInTheDocument();
  });

  it("selects the step before switching tabs from the overview timeline", async () => {
    const user = userEvent.setup();
    openPreview({ kind: "workflow" });
    render(<DryRunModal scope={{ kind: "workflow" }} />);

    const verifyTimeline = screen.getByLabelText("Step 2: Verify");
    await user.click(
      within(verifyTimeline.parentElement as HTMLElement).getByRole("button", {
        name: "View in Command tab",
      })
    );

    expect(screen.getByText("(POSIX shell)")).toBeInTheDocument();
    expect(screen.getByText("/bin/sh -c 'npm test'")).toBeInTheDocument();
  });

  it("collapses consecutive run-local mutations while keeping them reachable", async () => {
    const user = userEvent.setup();
    const runLocalPreview: WorkflowExecutionPreview = {
      ...preview,
      steps: preview.steps.map((step) =>
        step.stepIndex === 0
          ? {
              ...step,
              workspaceMutations: [
                {
                  path: "C:/workspace/.ctrlyoke/temp/one.json",
                  scope: "run-local",
                  ownedKeys: ["hooks"],
                  operation: "write",
                },
                {
                  path: "C:/workspace/.ctrlyoke/temp/two.json",
                  scope: "run-local",
                  ownedKeys: [],
                  operation: "delete",
                },
                {
                  scope: "run-local",
                  ownedKeys: [],
                  operation: "update environment",
                },
              ],
            }
          : step
      ),
    };
    openPreview({ kind: "step", stepIndex: 0 }, runLocalPreview);
    const displayedPreview = useExecutionPreviewStore.getState().preview;
    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    expect(
      screen.getByRole("button", { name: /3 internal changes/ })
    ).toBeInTheDocument();
    expect(
      screen.queryByText("C:/workspace/.ctrlyoke/temp/one.json")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Merges into existing keys:")
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Workspace-wide side effect")
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: /3 internal changes/ })
    );

    expect(
      screen.getByText("C:/workspace/.ctrlyoke/temp/one.json")
    ).toBeInTheDocument();
    expect(
      screen.getByText("C:/workspace/.ctrlyoke/temp/two.json")
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Internal — .ctrlyoke/temp, cleared after this run")
    ).toHaveLength(3);
    expect(useExecutionPreviewStore.getState().preview).toBe(displayedPreview);
  });

  it("renders shared mutations expanded with warning and merge-key details", () => {
    openPreview({ kind: "step", stepIndex: 0 });
    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    expect(
      screen.getByText("Workspace-wide side effect: May replace owned keys.")
    ).toBeInTheDocument();
    expect(
      screen.getByText("Merges into existing keys: permissions")
    ).toBeInTheDocument();
  });

  it("shows the per-step tabs and every DTO truncation reason", async () => {
    const user = userEvent.setup();
    openPreview({ kind: "step", stepIndex: 0 });
    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    await user.click(screen.getByRole("tab", { name: "Payload" }));

    expect(screen.getByText("Categorized payload")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Preview only: the dry-run preview budget cut off this chunk's body here. The harness still receives it in full."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("redacted prompt body")).toBeInTheDocument();
  });

  it("renders file references as direct references without chunk or warning styling", async () => {
    const user = userEvent.setup();
    const filePath = "C:\\workspace\\dev\\backlog\\DRY_RUN_PREVIEW_PLAN.md";
    const fileReferencePreview: WorkflowExecutionPreview = {
      ...preview,
      steps: [
        {
          ...preview.steps[0],
          prompt: {
            totalByteCount: 34126,
            includedBodyByteCount: 0,
            bodyBudgetBytes: 1024,
            sections: [
              {
                category: PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE,
                byteCount: 34126,
                lineCount: null,
                tokenEstimate: 7290,
                chunkIndex: 0,
                contentHash: null,
                truncationReason: PREVIEW_TRUNCATION_REASONS.REFERENCE,
                path: filePath,
              },
            ],
          },
        },
      ],
    };
    openPreview({ kind: "step", stepIndex: 0 }, fileReferencePreview);

    const { container } = render(
      <DryRunModal scope={{ kind: "step", stepIndex: 0 }} />
    );
    await user.click(screen.getByRole("tab", { name: "Payload" }));

    expect(
      screen.getByText("File reference DRY_RUN_PREVIEW_PLAN.md")
    ).toBeInTheDocument();
    expect(screen.getByText(filePath)).toBeInTheDocument();
    expect(
      screen.getByText(
        PREVIEW_TRUNCATION_REASON_COPY[PREVIEW_TRUNCATION_REASONS.REFERENCE]
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/chunk/i)).not.toBeInTheDocument();
    expect(container.querySelector(".codicon-warning")).not.toBeInTheDocument();
    expect(container.querySelector(".text-warning-fg")).not.toBeInTheDocument();
  });

  it("uses category labels and neutral styling for the prior-context placeholder", async () => {
    const user = userEvent.setup();
    const placeholderPreview: WorkflowExecutionPreview = {
      ...preview,
      steps: [
        {
          ...preview.steps[0],
          prompt: {
            totalByteCount: 0,
            includedBodyByteCount: 0,
            bodyBudgetBytes: 1024,
            sections: [
              {
                category: PREVIEW_PROMPT_CATEGORIES.PRIOR_CONTEXT,
                byteCount: 0,
                lineCount: null,
                tokenEstimate: 0,
                chunkIndex: 0,
                contentHash: null,
                truncationReason: PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE,
              },
            ],
          },
        },
      ],
    };
    openPreview({ kind: "step", stepIndex: 0 }, placeholderPreview);

    const { container } = render(
      <DryRunModal scope={{ kind: "step", stepIndex: 0 }} />
    );
    await user.click(screen.getByRole("tab", { name: "Payload" }));

    expect(screen.getByText("Prior context · chunk 1")).toBeInTheDocument();
    expect(
      screen.getByText(
        PREVIEW_TRUNCATION_REASON_COPY[
          PREVIEW_TRUNCATION_REASONS.NOT_YET_AVAILABLE
        ]
      )
    ).toBeInTheDocument();
    expect(container.querySelector(".codicon-warning")).not.toBeInTheDocument();
    expect(container.querySelector(".text-warning-fg")).not.toBeInTheDocument();
  });

  it("keeps warning styling for content omitted by preview limits", async () => {
    const user = userEvent.setup();
    const warningPreview: WorkflowExecutionPreview = {
      ...preview,
      steps: [
        {
          ...preview.steps[0],
          prompt: {
            ...preview.steps[0].prompt!,
            sections: [
              {
                ...preview.steps[0].prompt!.sections[0],
                truncationReason: PREVIEW_TRUNCATION_REASONS.OVER_INLINE_CAP,
              },
              {
                ...preview.steps[0].prompt!.sections[0],
                chunkIndex: 1,
                truncationReason: PREVIEW_TRUNCATION_REASONS.BODY_BUDGET,
              },
            ],
          },
        },
      ],
    };
    openPreview({ kind: "step", stepIndex: 0 }, warningPreview);

    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);
    await user.click(screen.getByRole("tab", { name: "Payload" }));

    expect(
      screen.getByText(
        PREVIEW_TRUNCATION_REASON_COPY[
          PREVIEW_TRUNCATION_REASONS.OVER_INLINE_CAP
        ]
      )
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        PREVIEW_TRUNCATION_REASON_COPY[PREVIEW_TRUNCATION_REASONS.BODY_BUDGET]
      )
    ).toBeInTheDocument();
    expect(document.querySelectorAll(".codicon-warning")).toHaveLength(2);
    expect(document.querySelectorAll(".text-warning-fg")).toHaveLength(2);
  });

  it("renders Excerpts instead of the raw inline-reference category", async () => {
    const user = userEvent.setup();
    const excerptPreview: WorkflowExecutionPreview = {
      ...preview,
      steps: [
        {
          ...preview.steps[0],
          prompt: {
            ...preview.steps[0].prompt!,
            sections: [
              {
                ...preview.steps[0].prompt!.sections[0],
                category: PREVIEW_PROMPT_CATEGORIES.INLINE_REFERENCE,
              },
            ],
          },
        },
      ],
    };
    openPreview({ kind: "step", stepIndex: 0 }, excerptPreview);

    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);
    await user.click(screen.getByRole("tab", { name: "Payload" }));

    expect(screen.getByText("Excerpts · chunk 1")).toBeInTheDocument();
    expect(screen.queryByText(/inline-reference/)).not.toBeInTheDocument();
  });

  it("copies the redacted command and categorized payload", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    openPreview({ kind: "step", stepIndex: 0 });
    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    const copyCommand = screen.getByRole("button", { name: "Copy command" });
    expect(copyCommand).not.toBeDisabled();
    await user.click(copyCommand);
    expect(clipboardWriteText).toHaveBeenLastCalledWith(
      "claude --print [REDACTED]"
    );

    await user.click(screen.getByRole("button", { name: "Copy payload" }));
    expect(clipboardWriteText).toHaveBeenLastCalledWith("redacted prompt body");
  });

  it("reconstructs the payload copy as plain expanded text, not the raw DTO", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    openPreview(
      { kind: "step", stepIndex: 0 },
      {
        ...preview,
        steps: [
          {
            ...preview.steps[0],
            prompt: {
              totalByteCount: 256,
              includedBodyByteCount: 96,
              bodyBudgetBytes: 1024,
              sections: [
                {
                  category: "agent-instructions",
                  byteCount: 32,
                  lineCount: 1,
                  tokenEstimate: 8,
                  chunkIndex: 0,
                  contentHash: "hash-1",
                  body: "You are a helpful agent.",
                },
                {
                  category: "file-reference",
                  byteCount: 0,
                  lineCount: null,
                  tokenEstimate: 10,
                  chunkIndex: 1,
                  contentHash: null,
                  truncationReason: "reference",
                  path: "C:/workspace/README.md",
                  providerReference: "@README.md",
                },
                {
                  category: "inline-reference",
                  byteCount: 5000,
                  lineCount: 200,
                  tokenEstimate: 1200,
                  chunkIndex: 2,
                  contentHash: "hash-2",
                  truncationReason: "over-inline-cap",
                },
              ],
            },
          },
          ...preview.steps.slice(1),
        ],
      }
    );
    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    await user.click(screen.getByRole("button", { name: "Copy payload" }));
    expect(clipboardWriteText).toHaveBeenLastCalledWith(
      [
        "You are a helpful agent.",
        "@README.md",
        "[Excerpts omitted: Preview only: this chunk's body is hidden because it exceeds the inline content cap. The harness still receives it in full via the referenced file.]",
      ].join("\n\n")
    );
  });

  it("toggles the command shell and copies the re-rendered text, without touching the DTO's own rendering", async () => {
    const user = userEvent.setup();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteText },
    });
    openPreview({ kind: "step", stepIndex: 0 });
    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    await user.click(screen.getByRole("tab", { name: "Command" }));
    expect(screen.getByText("claude --print [REDACTED]")).toBeInTheDocument();
    expect(screen.getByText("(PowerShell)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Command Prompt" }));
    expect(screen.getByText("(Command Prompt)")).toBeInTheDocument();
    expect(
      screen.queryByText("claude --print [REDACTED]")
    ).not.toBeInTheDocument();
    expect(screen.getByText('^"claude^" ^"--print^"')).toBeInTheDocument();

    const copyCommand = screen.getByRole("button", { name: "Copy command" });
    await user.click(copyCommand);
    expect(clipboardWriteText).toHaveBeenLastCalledWith(
      '^"claude^" ^"--print^"'
    );
  });

  it("summarizes multiline command previews while keeping the full text in the title", async () => {
    const user = userEvent.setup();
    const script = "echo first\necho second";
    const displayCommand = "/bin/sh -c 'echo first\necho second'";
    const multilinePreview: WorkflowExecutionPreview = {
      ...preview,
      steps: preview.steps.map((step) =>
        step.stepIndex === 1
          ? {
              ...step,
              command: {
                ...step.command!,
                args: ["-c", script],
                displayCommand,
              },
            }
          : step
      ),
    };
    openPreview({ kind: "step", stepIndex: 1 }, multilinePreview);
    render(<DryRunModal scope={{ kind: "step", stepIndex: 1 }} />);

    await user.click(screen.getByRole("tab", { name: "Command" }));

    const command = document.querySelector("pre[title]");
    expect(command).not.toBeNull();
    expect(command?.getAttribute("title")).toBe(displayCommand);
    expect(command).toHaveTextContent("/bin/sh -c 'echo first …");
    expect(command).not.toHaveTextContent("echo second");
  });

  it("does not offer a shell toggle for a script step's POSIX command", async () => {
    const user = userEvent.setup();
    openPreview({ kind: "step", stepIndex: 1 });
    render(<DryRunModal scope={{ kind: "step", stepIndex: 1 }} />);

    await user.click(screen.getByRole("tab", { name: "Command" }));
    expect(
      screen.queryByRole("button", { name: "PowerShell" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Command Prompt" })
    ).not.toBeInTheDocument();
  });

  it("does not render for a different store scope", () => {
    openPreview({ kind: "workflow" });

    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the displayed plan byte-identical until Refresh is pressed", async () => {
    const user = userEvent.setup();
    const address = {
      workflowKey: "workflow-a" as never,
      kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
    } as const;
    openPreview({ kind: "workflow" });
    render(<DryRunModal scope={{ kind: "workflow" }} />);

    const before = screen.getByRole("dialog").textContent;
    act(() => {
      useExecutionPreviewStore.getState().observeDefinitionRevision(address, 2);
    });

    expect(screen.getByText("Definition changed —")).toBeInTheDocument();
    const afterBanner = screen
      .getByRole("dialog")
      .textContent?.replace("Definition changed —Refresh", "");
    expect(afterBanner).toBe(before);
    expect(sendMessage).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: { kind: "workflow" } })
    );
  });
});
