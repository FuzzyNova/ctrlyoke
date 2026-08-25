import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiffFileCard } from "@components/diff/DiffFileCard";
import type { WorkspaceFileHistoryDiffResponse } from "@root/types/HostedWorkspaceViewerTypes";

vi.mock("@components/output/DiffView", () => ({
  DiffView: ({ findQuery }: { findQuery?: string }) => (
    <div data-testid="loaded-diff">
      {findQuery ? <mark data-testid="find-highlight">{findQuery}</mark> : null}
    </div>
  ),
}));

function detail(): WorkspaceFileHistoryDiffResponse {
  return {
    hash: "commit-1",
    shortHash: "commit-1",
    subject: "Add history detail",
    body: "",
    author: "Author",
    authorEmail: "author@example.com",
    date: "2026-08-25T12:00:00.000Z",
    relativeDate: "today",
    path: "src/file.ts",
    oldPath: "src/file.ts",
    changeType: "modified",
    payloadKind: "text",
    language: "typescript",
    oldContent: "before",
    newContent: "after",
  };
}

function deferredSource(
  fetchDetail: (
    path: string,
    commit: string,
    repo?: string
  ) => Promise<WorkspaceFileHistoryDiffResponse>
) {
  return {
    kind: "deferred" as const,
    commit: "commit-1",
    state: "not-loaded" as const,
    fetchDetail,
  };
}

describe("deferred DiffFileCard", () => {
  it("starts collapsed, loads on expansion, and renders the shared text branch", async () => {
    const fetchDetail = vi.fn().mockResolvedValue(detail());
    render(
      <DiffFileCard
        path="src/file.ts"
        changeType="modified"
        source={deferredSource(fetchDetail)}
        note="Add history detail · commit-1 · Author · today"
      />
    );

    expect(screen.queryByTestId("loaded-diff")).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand history diff" })
    );
    expect(fetchDetail).toHaveBeenCalledWith(
      "src/file.ts",
      "commit-1",
      undefined
    );
    expect(screen.getByText("Loading history diff…")).toBeInTheDocument();

    await waitFor(() =>
      expect(screen.getByTestId("loaded-diff")).toBeInTheDocument()
    );
    expect(screen.getByText(/Add history detail/)).toBeInTheDocument();
  });

  it("shows an error and retries only that card", async () => {
    const fetchDetail = vi
      .fn()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(detail());
    render(
      <DiffFileCard
        path="src/file.ts"
        changeType="modified"
        source={deferredSource(fetchDetail)}
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Expand history diff" })
    );
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByTestId("loaded-diff")).toBeInTheDocument()
    );
    expect(fetchDetail).toHaveBeenCalledTimes(2);
  });

  it("applies a global find query after asynchronously loaded detail arrives", async () => {
    const fetchDetail = vi.fn().mockResolvedValue(detail());
    render(
      <DiffFileCard
        path="src/file.ts"
        changeType="modified"
        source={deferredSource(fetchDetail)}
        findQuery="after"
      />
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Expand history diff" })
    );
    await waitFor(() =>
      expect(screen.getByTestId("find-highlight")).toHaveTextContent("after")
    );
  });
});
