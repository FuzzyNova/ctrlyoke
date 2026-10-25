import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  useWorkflowContextMenu,
  type WorkflowContextMenuTarget,
} from "@hooks/useWorkflowContextMenu";
import { useUiStore } from "@store/uiStore";
import { useTerminalStore } from "@store/terminalStore";
import {
  MESSAGE_TYPES,
  WORKFLOW_VIEW_ADDRESS_KIND,
} from "@root/types/DashboardConstants";

// These assertions cover the standalone queue branch of notifyUser().
vi.hoisted(() => {
  window.__ctrlyokeStandalone = true;
});

const target: WorkflowContextMenuTarget = {
  address: {
    workflowKey: "workflow-1" as never,
    kind: "run" as const,
    runRef: "run-2" as never,
  },
  workflowName: "Workflow 1",
  scope: "lineage" as const,
  isFavorite: false,
  runDirectory: "/runs/workflow-1/run-2",
  isExecuting: false,
};

function TestHarness({
  menuTarget = target,
  onDuplicate = vi.fn(),
}: {
  menuTarget?: WorkflowContextMenuTarget;
  onDuplicate?: (
    target: WorkflowContextMenuTarget,
    opener: HTMLElement | null
  ) => void;
}) {
  const onToggleFavorite = vi.fn();
  const onDelete = vi.fn();
  const onCloseDropdown = vi.fn();
  const { openContextMenu, workflowContextMenuPortal } = useWorkflowContextMenu(
    {
      onDuplicate,
      onToggleFavorite,
      onDelete,
      onCloseDropdown,
    }
  );

  return (
    <>
      <button
        onClick={(event) =>
          openContextMenu(20, 20, menuTarget, event.currentTarget)
        }
      >
        Open menu
      </button>
      {workflowContextMenuPortal}
    </>
  );
}

describe("useWorkflowContextMenu", () => {
  beforeEach(() => {
    useUiStore.getState().resetUi();
    useTerminalStore.getState().setActiveTerminalWorkflows([]);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => cleanup());

  it("renders new run, duplicate, copy, exit terminals, favorite, and scoped delete in order", () => {
    render(<TestHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen
        .getAllByRole("menuitem")
        .map((button) => button.textContent?.trim())
    ).toEqual([
      "New Run (Don't Start)",
      "Duplicate Workflow…",
      "Copy Workflow Key",
      "Copy Run Directory Path",
      "Exit Terminal",
      "Exit All Idle Terminals",
      "Add to Favorites",
      "Delete Workflow",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(3);
    expect(
      screen.getByRole("menuitem", { name: "Copy Run Directory Path" })
    ).toHaveAttribute("title", expect.stringContaining("server's filesystem"));
  });

  it("prepares a new run from the addressed run without starting it", () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
    render(<TestHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "New Run (Don't Start)" })
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.PREPARE_NEW_RUN,
      address: target.address,
    });
  });

  it("disables both exit items when no workflow has an open terminal", () => {
    render(<TestHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Exit Terminal" })
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Exit Terminal" })
    ).toHaveAttribute("title", "This workflow has no open terminal");
    expect(
      screen.getByRole("menuitem", { name: "Exit All Idle Terminals" })
    ).toBeDisabled();
  });

  it("exits this workflow's terminal, or every idle one, when terminals are open", () => {
    const postMessage = vi.fn();
    Object.defineProperty(window, "vscodeApi", {
      configurable: true,
      value: { postMessage, getState: vi.fn(), setState: vi.fn() },
    });
    useTerminalStore.getState().setActiveTerminalWorkflows([
      {
        workflowId: "instance-1",
        workflowKey: "workflow-1" as never,
        runRef: "run-2" as never,
      },
    ]);
    render(<TestHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    const exitTerminal = screen.getByRole("menuitem", {
      name: "Exit Terminal",
    });
    expect(exitTerminal).toHaveAttribute(
      "title",
      expect.stringContaining("Ctrl+C")
    );
    fireEvent.click(exitTerminal);
    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.EXIT_IDLE_TERMINALS,
      workflowKey: "workflow-1",
    });

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Exit All Idle Terminals" })
    );
    expect(postMessage).toHaveBeenLastCalledWith({
      type: MESSAGE_TYPES.EXIT_IDLE_TERMINALS,
    });
  });

  it("keeps Exit Terminal disabled while the workflow executes", () => {
    useTerminalStore.getState().setActiveTerminalWorkflows([
      {
        workflowId: "instance-1",
        workflowKey: "workflow-1" as never,
        runRef: "run-2" as never,
      },
    ]);
    render(<TestHarness menuTarget={{ ...target, isExecuting: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(
      screen.getByRole("menuitem", { name: "Exit Terminal" })
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Exit All Idle Terminals" })
    ).toBeEnabled();
  });

  it("labels an unstarted run as reopened, and disables new run while executing", () => {
    const { unmount } = render(
      <TestHarness menuTarget={{ ...target, isUnstarted: true }} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(
      screen.getByRole("menuitem", { name: "Open Unstarted Run" })
    ).toBeEnabled();
    unmount();

    render(<TestHarness menuTarget={{ ...target, isExecuting: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(
      screen.getByRole("menuitem", { name: "New Run (Don't Start)" })
    ).toBeDisabled();
  });

  it("omits new run for a never-run workflow's draft", () => {
    render(
      <TestHarness
        menuTarget={{
          ...target,
          address: {
            workflowKey: "workflow-1" as never,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
          },
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(
      screen.queryByRole("button", { name: /New Run|Unstarted Run/ })
    ).not.toBeInTheDocument();
  });

  it("disables copy without a directory and delete while executing", () => {
    render(
      <TestHarness
        menuTarget={{ ...target, runDirectory: undefined, isExecuting: true }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getByRole("menuitem", { name: "Copy Run Directory Path" })
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Delete Workflow" })
    ).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Delete Workflow" })
    ).toHaveAttribute(
      "title",
      "Cannot delete a workflow while it is executing"
    );
  });

  it("disables run deletion for the synthetic draft row", () => {
    render(
      <TestHarness
        menuTarget={{
          ...target,
          scope: "run",
          address: {
            workflowKey: "workflow-1" as never,
            kind: WORKFLOW_VIEW_ADDRESS_KIND.DRAFT,
          },
          runDirectory: "/runs/workflow-1/draft",
        }}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(screen.getByRole("menuitem", { name: "Delete Run" })).toBeDisabled();
    expect(
      screen.getByRole("menuitem", { name: "Delete Run" })
    ).toHaveAttribute(
      "title",
      "The draft cannot be deleted from the run panel"
    );
  });

  it("copies the target directory and confirms with a toast", async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText);
    render(<TestHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy Run Directory Path" })
    );

    expect(writeText).toHaveBeenCalledWith("/runs/workflow-1/run-2");
    await waitFor(() =>
      expect(useUiStore.getState().toastQueue).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "Run directory path copied to clipboard",
          }),
        ])
      )
    );
  });

  it("copies the workflow key and confirms with a toast", async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText);
    render(<TestHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Copy Workflow Key" })
    );

    expect(writeText).toHaveBeenCalledWith("workflow-1");
    await waitFor(() =>
      expect(useUiStore.getState().toastQueue).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            message: "Workflow key copied to clipboard",
          }),
        ])
      )
    );
  });

  it("passes the opener separately when Duplicate is selected", () => {
    const onDuplicate = vi.fn();
    render(<TestHarness onDuplicate={onDuplicate} />);
    const opener = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(opener);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Duplicate Workflow…" })
    );

    expect(onDuplicate).toHaveBeenCalledWith(target, opener);
  });
});
