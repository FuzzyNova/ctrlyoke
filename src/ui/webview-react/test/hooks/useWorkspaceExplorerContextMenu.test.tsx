import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceExplorerContextMenu } from "@hooks/useWorkspaceExplorerContextMenu";
import type { WorkspaceEntry } from "@root/types/HostedWorkspaceViewerTypes";

function TestHarness({ entry }: { entry: WorkspaceEntry }) {
  const { openContextMenu, explorerContextMenuPortal } =
    useWorkspaceExplorerContextMenu({
      explorerPath: "src",
      isRootsList: false,
      onRefresh: vi.fn(),
      onOpenFile: vi.fn(),
      onViewFileHistory: onViewFileHistory,
    });

  return (
    <>
      <button onClick={() => openContextMenu(20, 20, entry)}>Open menu</button>
      {explorerContextMenuPortal}
    </>
  );
}

const onViewFileHistory = vi.fn();

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("useWorkspaceExplorerContextMenu file history", () => {
  it("shows the action only for files and passes a normalized path", () => {
    render(
      <TestHarness
        entry={{ name: "file.ts", path: "src\\file.ts", kind: "file" }}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    fireEvent.click(screen.getByRole("button", { name: "View File History" }));
    expect(onViewFileHistory).toHaveBeenCalledWith("src/file.ts");

    cleanup();
    render(
      <TestHarness entry={{ name: "src", path: "src", kind: "directory" }} />
    );
    fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
    expect(
      screen.queryByRole("button", { name: "View File History" })
    ).not.toBeInTheDocument();
  });
});
