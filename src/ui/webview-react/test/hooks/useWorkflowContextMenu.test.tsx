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
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  afterEach(() => cleanup());

  it("renders new run, duplicate, copy, divider, favorite, and scoped delete in order", () => {
    render(<TestHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));

    expect(
      screen.getAllByRole("button").map((button) => button.textContent?.trim())
    ).toEqual([
      "Open menu",
      "New Run (Don't Start)",
      "Duplicate Workflow…",
      "Copy Run Directory Path",
      "Add to Favorites",
      "Delete Workflow",
    ]);
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    expect(
      screen.getByRole("button", { name: "Copy Run Directory Path" })
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
      screen.getByRole("button", { name: "New Run (Don't Start)" })
    );

    expect(postMessage).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.PREPARE_NEW_RUN,
      address: target.address,
    });
  });

  it("labels an unstarted run as reopened, and disables new run while executing", () => {
    const { unmount } = render(
      <TestHarness menuTarget={{ ...target, isUnstarted: true }} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(
      screen.getByRole("button", { name: "Open Unstarted Run" })
    ).toBeEnabled();
    unmount();

    render(<TestHarness menuTarget={{ ...target, isExecuting: true }} />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(
      screen.getByRole("button", { name: "New Run (Don't Start)" })
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
      screen.getByRole("button", { name: "Copy Run Directory Path" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete Workflow" })
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Delete Workflow" })
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

    expect(screen.getByRole("button", { name: "Delete Run" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Run" })).toHaveAttribute(
      "title",
      "The draft cannot be deleted from the run panel"
    );
  });

  it("copies the target directory and confirms with a toast", async () => {
    const writeText = vi.mocked(navigator.clipboard.writeText);
    render(<TestHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Copy Run Directory Path" })
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

  it("passes the opener separately when Duplicate is selected", () => {
    const onDuplicate = vi.fn();
    render(<TestHarness onDuplicate={onDuplicate} />);
    const opener = screen.getByRole("button", { name: "Open menu" });
    fireEvent.click(opener);
    fireEvent.click(
      screen.getByRole("button", { name: "Duplicate Workflow…" })
    );

    expect(onDuplicate).toHaveBeenCalledWith(target, opener);
  });
});
