import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { WorkflowExecutionPreview } from "@root/types/ExecutionPreviewTypes";
import { useExecutionPreviewStore } from "@store/executionPreviewStore";
import { DryRunModal } from "@components/shared/DryRunModal";

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock("@hooks/useMessageHandler", () => ({ sendMessage }));

const clipboardWriteText = vi.fn<(text: string) => Promise<void>>();

const preview: WorkflowExecutionPreview = {
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
          ownedKeys: ["permissions"],
          operation: "write",
          warning: "May replace owned keys.",
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

function openPreview(scope: { kind: "workflow" } | { kind: "step"; stepIndex: number }) {
  useExecutionPreviewStore.setState({
    preview,
    status: "ready",
    scope,
    displayedDefinitionRevision: 1,
    displayedAddress: { workflowKey: "workflow-a" as never, kind: "draft" },
    isStale: false,
  });
}

describe("DryRunModal", () => {
  beforeEach(() => {
    useExecutionPreviewStore.getState().reset();
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
    expect(screen.getByRole("navigation", { name: "Dry run sections" })).toBeInTheDocument();
    expect(screen.getByTitle("Prepare")).toBeInTheDocument();
    expect(screen.getByText("Workspace mutations across all steps")).toBeInTheDocument();
  });

  it("collapses the workflow rail into CustomSelect below the narrow breakpoint", () => {
    openPreview({ kind: "workflow" });

    render(<DryRunModal scope={{ kind: "workflow" }} />);

    expect(screen.queryByRole("navigation", { name: "Dry run sections" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select dry run section" })).toBeInTheDocument();
  });

  it("renders step scope without Overview or the rail", async () => {
    const user = userEvent.setup();
    openPreview({ kind: "step", stepIndex: 0 });

    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    expect(screen.queryByText("Workflow summary")).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Dry run sections" })).not.toBeInTheDocument();
    expect(screen.getByText("Resolved execution")).toBeInTheDocument();

    await user.click(screen.getByTitle("Command"));
    expect(screen.getByText("claude --print [REDACTED]")).toBeInTheDocument();
  });

  it("shows the per-step tabs and every DTO truncation reason", async () => {
    const user = userEvent.setup();
    openPreview({ kind: "step", stepIndex: 0 });
    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    await user.click(screen.getByTitle("Payload"));

    expect(screen.getByText("Categorized payload")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Harness will not receive this content: the preview body budget omitted it."
      )
    ).toBeInTheDocument();
    expect(screen.getByText("redacted prompt body")).toBeInTheDocument();
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
    expect(clipboardWriteText).toHaveBeenLastCalledWith("claude --print [REDACTED]");

    await user.click(screen.getByRole("button", { name: "Copy payload" }));
    expect(clipboardWriteText).toHaveBeenLastCalledWith(
      JSON.stringify(preview.steps[0].prompt, null, 2)
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

    await user.click(screen.getByTitle("Command"));
    expect(screen.getByText("claude --print [REDACTED]")).toBeInTheDocument();
    expect(screen.getByText("(PowerShell)")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Command Prompt" }));
    expect(screen.getByText("(Command Prompt)")).toBeInTheDocument();
    expect(screen.queryByText("claude --print [REDACTED]")).not.toBeInTheDocument();
    expect(screen.getByText('^"claude^" ^"--print^"')).toBeInTheDocument();

    const copyCommand = screen.getByRole("button", { name: "Copy command" });
    await user.click(copyCommand);
    expect(clipboardWriteText).toHaveBeenLastCalledWith('^"claude^" ^"--print^"');
  });

  it("does not offer a shell toggle for a script step's POSIX command", async () => {
    const user = userEvent.setup();
    openPreview({ kind: "step", stepIndex: 1 });
    render(<DryRunModal scope={{ kind: "step", stepIndex: 1 }} />);

    await user.click(screen.getByTitle("Command"));
    expect(screen.queryByRole("button", { name: "PowerShell" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Command Prompt" })).not.toBeInTheDocument();
  });

  it("does not render for a different store scope", () => {
    openPreview({ kind: "workflow" });

    render(<DryRunModal scope={{ kind: "step", stepIndex: 0 }} />);

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("keeps the displayed plan byte-identical until Refresh is pressed", async () => {
    const user = userEvent.setup();
    const address = { workflowKey: "workflow-a" as never, kind: "draft" } as const;
    openPreview({ kind: "workflow" });
    render(<DryRunModal scope={{ kind: "workflow" }} />);

    const before = screen.getByRole("dialog").textContent;
    act(() => {
      useExecutionPreviewStore
        .getState()
        .observeDefinitionRevision(address, 2);
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
