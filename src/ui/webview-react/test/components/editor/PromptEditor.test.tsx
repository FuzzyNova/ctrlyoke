/**
 * Tests for PromptEditor's EXECUTE_PROMPT submission addressing.
 *
 * A prompt-editor submission must carry the displayed run address and
 * optimistic revisions (`mutation`) so the backend appends to the exact run
 * the client is viewing — not whatever run the lineage's bound instance
 * happens to hold (typically the latest), which silently targeted the wrong
 * run when an older run was selected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Stub HarnessIcon so this test does not depend on `?raw` SVG asset
// resolution from src/ui/icons (denied by Vite's fs allow-list when vitest is
// invoked with a bare `--root src/ui/webview-react` instead of the project
// config). The icons are irrelevant to what is asserted here.
vi.mock("@components/shared/HarnessIcon", () => ({
  HarnessIcon: () => null,
}));

vi.mock("../../../hooks/useCompatibilityDiagnostics", () => ({
  useCompatibilityDiagnostics: () => ({
    isChecking: false,
    diagnostics: [
      {
        code: "compatibility.promptInputs.images.unsupported",
        severity: "warning",
        harnessId: "codex-cli",
        capability: "images",
        consumer: { kind: "queue", stepIndex: 0 },
        state: {
          fidelity: "unsupported",
          mechanism: "none",
          verification: "verified",
        },
        message: "Image prompt inputs are not supported by Codex CLI.",
        remediation: "Choose a harness with native image attachment support.",
      },
    ],
  }),
}));

import {
  PromptEditor,
  type PromptFileAction,
} from "@components/editor/PromptEditor";
import { useEditorStore } from "@store/editorStore";
import { useUiStore } from "@store/uiStore";
import { useWorkflowStore } from "@store/workflowStore";
import { useSecretRegistryStore } from "@store/secretRegistryStore";
import {
  MESSAGE_TYPES,
  ACTION_TYPES,
  FINAL_STEP_PHASES,
  EXECUTION_STATES,
  STEP_STATUS,
} from "@/types/messages";
import {
  HARNESS_IDS,
  SECRET_REGISTRY_STATES,
  STEP_TYPES,
} from "@root/types/DashboardConstants";

// The vscode mock is set up in test/setup.ts (window.vscodeApi).
const postMessageSpy = vi.fn();

beforeEach(() => {
  useEditorStore.getState().resetEditor();
  useWorkflowStore.setState({
    steps: [],
    currentStep: 0,
    executionState: EXECUTION_STATES.IDLE,
  });
  useSecretRegistryStore.getState().resetSecretRegistry();
  useUiStore.setState({
    displayedViewAddress: null,
    displayedDefinitionRevision: null,
    displayedDescriptorRevision: null,
  });
  (
    window.vscodeApi as unknown as { postMessage: ReturnType<typeof vi.fn> }
  ).postMessage = postMessageSpy;
  postMessageSpy.mockClear();
});

function findExecutePromptMessage(): Record<string, unknown> | undefined {
  return postMessageSpy.mock.calls.find(
    ([msg]) => (msg as { type?: string }).type === MESSAGE_TYPES.EXECUTE_PROMPT
  )?.[0] as Record<string, unknown> | undefined;
}

describe("PromptEditor — EXECUTE_PROMPT run addressing", () => {
  it("attaches the displayed run mutation to a prompt submission", async () => {
    const user = userEvent.setup();
    useEditorStore.getState().setPromptText("append to the viewed run");
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-1" as never,
      },
      displayedDefinitionRevision: 4,
      displayedDescriptorRevision: 9,
    });

    const { container } = render(<PromptEditor />);
    const runButton = container.querySelector(
      ".btn-editor-run"
    ) as HTMLButtonElement;
    expect(runButton).not.toBeNull();
    await user.click(runButton);

    const message = findExecutePromptMessage();
    expect(message).toMatchObject({
      type: MESSAGE_TYPES.EXECUTE_PROMPT,
      text: "append to the viewed run",
      action: ACTION_TYPES.RUN,
      mutation: {
        address: { workflowKey: "wf-1", kind: "run", runRef: "run-1" },
        expectedDefinitionRevision: 4,
        expectedDescriptorRevision: 9,
      },
    });
  });

  it("attaches the displayed run mutation to a script final-step update", async () => {
    const user = userEvent.setup();
    useEditorStore.setState({
      selectionTarget: { kind: FINAL_STEP_PHASES.FINAL_STEP },
      stepType: STEP_TYPES.SCRIPT,
      scriptCommand: "echo done",
    });
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-1" as never,
      },
      displayedDefinitionRevision: 4,
      displayedDescriptorRevision: 9,
    });

    const { container } = render(<PromptEditor />);
    const updateButton = container.querySelector(
      ".btn-editor-update"
    ) as HTMLButtonElement;
    expect(updateButton).not.toBeNull();
    await user.click(updateButton);

    const message = postMessageSpy.mock.calls.find(
      ([msg]) =>
        (msg as { type?: string }).type === MESSAGE_TYPES.UPDATE_FINAL_PROMPT
    )?.[0] as Record<string, unknown> | undefined;
    expect(message).toMatchObject({
      type: MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
      mutation: {
        address: { workflowKey: "wf-1", kind: "run", runRef: "run-1" },
        expectedDefinitionRevision: 4,
        expectedDescriptorRevision: 9,
      },
    });
  });

  it("coordinates a completed-step edit in one update message instead of posting a stale rewind", async () => {
    const user = userEvent.setup();
    useWorkflowStore.setState({
      steps: [
        { prompt: "completed prefix", status: STEP_STATUS.COMPLETED },
        { prompt: "completed suffix", status: STEP_STATUS.COMPLETED },
      ],
      currentStep: 2,
      executionState: EXECUTION_STATES.COMPLETED,
    });
    useEditorStore
      .getState()
      .selectPrompt(
        { kind: FINAL_STEP_PHASES.QUEUE, index: 1 },
        { prompt: "completed suffix" }
      );
    useEditorStore.getState().setPromptText("edited suffix");
    useUiStore.setState({
      displayedViewAddress: {
        workflowKey: "wf-1" as never,
        kind: "run",
        runRef: "run-1" as never,
      },
      displayedDefinitionRevision: 2,
      displayedDescriptorRevision: 7,
    });

    const { container } = render(<PromptEditor />);
    const updateButton = container.querySelector(
      ".btn-editor-update"
    ) as HTMLButtonElement;
    expect(updateButton).not.toBeNull();
    await user.click(updateButton);

    const updateMessages = postMessageSpy.mock.calls
      .map(([message]) => message as Record<string, unknown>)
      .filter((message) => message.type === MESSAGE_TYPES.UPDATE_PROMPT);
    expect(updateMessages).toHaveLength(1);
    expect(updateMessages[0]).toMatchObject({
      index: 1,
      text: "edited suffix",
      rewindCompletedStep: true,
      mutation: {
        address: { workflowKey: "wf-1", kind: "run", runRef: "run-1" },
        expectedDefinitionRevision: 2,
        expectedDescriptorRevision: 7,
      },
    });
    expect(
      postMessageSpy.mock.calls.some(
        ([message]) =>
          (message as { type?: string }).type ===
          MESSAGE_TYPES.SET_START_POSITION
      )
    ).toBe(false);
  });

  it("omits the mutation when no persisted draft/run view is displayed", async () => {
    const user = userEvent.setup();
    useEditorStore.getState().setPromptText("fresh ephemeral prompt");

    const { container } = render(<PromptEditor />);
    const runButton = container.querySelector(
      ".btn-editor-run"
    ) as HTMLButtonElement;
    await user.click(runButton);

    const message = findExecutePromptMessage();
    expect(message).toBeDefined();
    expect(message).not.toHaveProperty("mutation");
  });
});

describe("PromptEditor — prompt-file action", () => {
  function renderWithAction() {
    let action: PromptFileAction | null = null;
    render(
      <PromptEditor
        onPromptFileActionChange={(nextAction) => {
          action = nextAction;
        }}
      />
    );
    return () => action;
  }

  it("keeps the editor text until conversion succeeds, then persists and opens the file", async () => {
    useEditorStore.getState().setPromptText("exact text\nwith whitespace\n");
    const getAction = renderWithAction();

    await waitFor(() =>
      expect(getAction()?.tooltip).toBe("Convert to prompt file")
    );
    getAction()?.onClick();

    const request = postMessageSpy.mock.calls.find(
      ([message]) =>
        (message as { type?: string }).type ===
        MESSAGE_TYPES.CONVERT_PROMPT_TO_FILE
    )?.[0] as { seq: number; text: string };
    expect(request.text).toBe("exact text\nwith whitespace\n");
    expect(useEditorStore.getState().promptText).toBe(
      "exact text\nwith whitespace\n"
    );

    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.PROMPT_FILE_CREATED,
          seq: request.seq,
          reference: "./.ctrlyoke/prompts/exact-text.prompt.md",
          resolvedPath: "C:/workspace/.ctrlyoke/prompts/exact-text.prompt.md",
        },
      })
    );

    await waitFor(() =>
      expect(useEditorStore.getState().promptText).toBe(
        "./.ctrlyoke/prompts/exact-text.prompt.md"
      )
    );
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.OPEN_PROMPT_FILE,
      path: "C:/workspace/.ctrlyoke/prompts/exact-text.prompt.md",
    });
  });

  it("leaves the editor unchanged when conversion fails or a late reply arrives", async () => {
    useEditorStore.getState().setPromptText("keep this text");
    const getAction = renderWithAction();
    await waitFor(() =>
      expect(getAction()?.tooltip).toBe("Convert to prompt file")
    );
    getAction()?.onClick();
    const request = postMessageSpy.mock.calls.find(
      ([message]) =>
        (message as { type?: string }).type ===
        MESSAGE_TYPES.CONVERT_PROMPT_TO_FILE
    )?.[0] as { seq: number };

    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.PROMPT_FILE_CREATED,
          seq: request.seq + 1,
          reference: "./late.prompt.md",
          resolvedPath: "C:/late.prompt.md",
        },
      })
    );
    expect(useEditorStore.getState().promptText).toBe("keep this text");

    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.PROMPT_FILE_CREATED,
          seq: request.seq,
          error: "No workspace folder open",
        },
      })
    );
    expect(useEditorStore.getState().promptText).toBe("keep this text");
  });

  it("shows the empty-file state and opens using the latest resolved validation path", async () => {
    useEditorStore
      .getState()
      .setPromptText("./.ctrlyoke/prompts/draft.prompt.md");
    const getAction = renderWithAction();

    await waitFor(() =>
      expect(
        postMessageSpy.mock.calls.some(
          ([message]) =>
            (message as { type?: string }).type ===
            MESSAGE_TYPES.VALIDATE_FILE_REF
        )
      ).toBe(true)
    );
    const validationRequests = postMessageSpy.mock.calls
      .map(([message]) => message as { type?: string; seq?: number })
      .filter((message) => message.type === MESSAGE_TYPES.VALIDATE_FILE_REF);
    const request = validationRequests[validationRequests.length - 1]!;

    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.FILE_REF_VALIDATION,
          seq: request.seq,
          filePath: "./.ctrlyoke/prompts/draft.prompt.md",
          exists: true,
          isEmpty: true,
          resolvedPath: "C:/workspace/.ctrlyoke/prompts/draft.prompt.md",
        },
      })
    );

    expect(await waitFor(() => getAction()?.tooltip)).toBe("Open prompt file");
    expect(await waitFor(() => getAction()?.disabled)).toBe(false);
    expect(screen.getByText("Prompt file is empty")).toBeInTheDocument();
    getAction()?.onClick();
    expect(postMessageSpy).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.OPEN_PROMPT_FILE,
      path: "C:/workspace/.ctrlyoke/prompts/draft.prompt.md",
    });
  });
});

describe("PromptEditor — prompt secret grants", () => {
  it("posts a selected secret in the UPDATE_PROMPT payload", async () => {
    useSecretRegistryStore.getState().setEntries("workspace", [
      {
        name: "API_TOKEN",
        scope: "workspace",
        state: SECRET_REGISTRY_STATES.MANAGED_AND_SET,
        usedBy: { mcpServers: [], workflows: [] },
      },
    ]);
    useEditorStore
      .getState()
      .selectPrompt(
        { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        { prompt: "old prompt" }
      );
    useEditorStore.getState().setPromptText("updated prompt");
    useUiStore.getState().openPropertiesDrawer();

    const { container } = render(<PromptEditor />);
    fireEvent.click(screen.getByRole("button", { name: "Secrets" }));
    fireEvent.click(screen.getByText("API_TOKEN").closest("button")!);
    await userEvent
      .setup()
      .click(
        container.querySelector(".btn-editor-update") as HTMLButtonElement
      );

    const message = postMessageSpy.mock.calls.find(
      ([msg]) => (msg as { type?: string }).type === MESSAGE_TYPES.UPDATE_PROMPT
    )?.[0] as Record<string, unknown> | undefined;
    expect(message).toMatchObject({
      type: MESSAGE_TYPES.UPDATE_PROMPT,
      text: "updated prompt",
      properties: { secrets: ["API_TOKEN"] },
    });
  });

  it("sends secrets in clearProperties when a step override is cleared", async () => {
    useEditorStore
      .getState()
      .selectPrompt(
        { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        { prompt: "old prompt", secrets: ["API_TOKEN"] }
      );
    useEditorStore.getState().setPromptText("updated prompt");
    useEditorStore.getState().setProperty("secrets", undefined);

    const { container } = render(<PromptEditor />);
    await userEvent
      .setup()
      .click(
        container.querySelector(".btn-editor-update") as HTMLButtonElement
      );

    const message = postMessageSpy.mock.calls.find(
      ([msg]) => (msg as { type?: string }).type === MESSAGE_TYPES.UPDATE_PROMPT
    )?.[0] as Record<string, unknown> | undefined;
    expect(message).toMatchObject({
      type: MESSAGE_TYPES.UPDATE_PROMPT,
      clearProperties: expect.arrayContaining(["secrets"]),
    });
  });

  it("does not persist an inline secret reference as a declaration", async () => {
    useEditorStore.getState().selectPrompt(
      { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
      {
        prompt: "Use !INLINE_TOKEN",
        secrets: ["INLINE_TOKEN", "EXPLICIT_TOKEN"],
      }
    );
    useEditorStore.getState().setPromptText("Use !INLINE_TOKEN");

    const { container } = render(<PromptEditor />);
    await userEvent
      .setup()
      .click(
        container.querySelector(".btn-editor-update") as HTMLButtonElement
      );

    const message = postMessageSpy.mock.calls.find(
      ([msg]) => (msg as { type?: string }).type === MESSAGE_TYPES.UPDATE_PROMPT
    )?.[0] as Record<string, unknown> | undefined;
    expect(message).toMatchObject({
      properties: { secrets: ["EXPLICIT_TOKEN"] },
    });
  });
});

describe("PromptEditor — image compatibility feedback", () => {
  it("keeps image compatibility feedback beside the editable prompt", () => {
    useEditorStore
      .getState()
      .selectPrompt(
        { kind: FINAL_STEP_PHASES.QUEUE, index: 0 },
        { prompt: "Review @screen.png", harness: HARNESS_IDS.CODEX_CLI }
      );

    render(<PromptEditor />);

    expect(
      screen.getByText(/Image prompt inputs are not supported/)
    ).toBeVisible();
    expect(
      screen.getByText(/Image prompt inputs are not supported/)
    ).toHaveTextContent("Codex CLI");
    expect(
      document.getElementById("prompt-image-compatibility")
    ).not.toBeNull();
  });
});
