import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSearchResponse } from "@root/types/HostedWorkspaceViewerTypes";
import { WorkspaceSearchPane } from "@components/workspace-viewer/WorkspaceSearchPane";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { workspaceSearch } from "@utils/hostedApi";

vi.mock("@utils/hostedApi", () => ({
  workspaceSearch: vi.fn(),
}));

const workspaceSearchMock = vi.mocked(workspaceSearch);

const EMPTY_RESPONSE: WorkspaceSearchResponse = {
  results: [],
  truncated: false,
};

function advanceDebounce() {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(400);
  });
}

function setSearchResults(response: WorkspaceSearchResponse) {
  workspaceSearchMock.mockResolvedValueOnce(response);
}

describe("WorkspaceSearchPane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    workspaceSearchMock.mockReset();
    workspaceSearchMock.mockResolvedValue(EMPTY_RESPONSE);
    useWorkspaceViewerStore.getState().reset();
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        hideGitIgnoredFiles: false,
      },
    }));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("does not search below two characters and debounces a valid query", async () => {
    render(<WorkspaceSearchPane />);
    const input = screen.getByRole("searchbox", { name: "Search workspace" });

    fireEvent.change(input, { target: { value: "a" } });
    await advanceDebounce();
    expect(workspaceSearchMock).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "ab" } });
    expect(workspaceSearchMock).not.toHaveBeenCalled();
    await advanceDebounce();

    expect(workspaceSearchMock).toHaveBeenCalledOnce();
    expect(workspaceSearchMock).toHaveBeenCalledWith({
      query: "ab",
      scope: "both",
      includeGitIgnored: true,
      repo: undefined,
      limit: 50,
    });
  });

  it("passes the selected scope and git-ignore override to the search", async () => {
    render(<WorkspaceSearchPane />);
    const input = screen.getByRole("searchbox", { name: "Search workspace" });
    fireEvent.change(input, { target: { value: "ab" } });
    await advanceDebounce();

    fireEvent.click(screen.getByRole("button", { name: "Content" }));
    await advanceDebounce();

    expect(workspaceSearchMock).toHaveBeenLastCalledWith({
      query: "ab",
      scope: "content",
      includeGitIgnored: true,
      repo: undefined,
      limit: 50,
    });

    const includeIgnored = screen.getByRole("checkbox", {
      name: "Include git-ignored files",
    });
    expect(includeIgnored).toBeChecked();
    fireEvent.click(includeIgnored);
    await advanceDebounce();

    expect(includeIgnored).not.toBeChecked();
    expect(workspaceSearchMock).toHaveBeenLastCalledWith({
      query: "ab",
      scope: "content",
      includeGitIgnored: false,
      repo: undefined,
      limit: 50,
    });
    expect(useSettingsStore.getState().globalSettings.hideGitIgnoredFiles).toBe(
      false
    );
  });

  it("seeds the include-ignored checkbox from the global setting", () => {
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        hideGitIgnoredFiles: true,
      },
    }));

    render(<WorkspaceSearchPane />);

    expect(
      screen.getByRole("checkbox", { name: "Include git-ignored files" })
    ).not.toBeChecked();
  });

  it("only shows the repository picker for multiple repositories", () => {
    useWorkspaceViewerStore.setState({
      repos: [{ id: "one", label: "One", rootPath: "/one" }],
      selectedRepoId: "one",
    });
    const { rerender } = render(<WorkspaceSearchPane />);
    expect(
      screen.queryByRole("combobox", { name: "Select repository" })
    ).not.toBeInTheDocument();

    useWorkspaceViewerStore.setState({
      repos: [
        { id: "one", label: "One", rootPath: "/one" },
        { id: "two", label: "Two", rootPath: "/two" },
      ],
      selectedRepoId: "two",
    });
    rerender(<WorkspaceSearchPane />);
    expect(
      screen.getByRole("combobox", { name: "Select repository" })
    ).toHaveValue("two");
  });

  it("renders loading and empty states", async () => {
    let resolveSearch!: (response: WorkspaceSearchResponse) => void;
    workspaceSearchMock.mockReturnValueOnce(
      new Promise<WorkspaceSearchResponse>((resolve) => {
        resolveSearch = resolve;
      })
    );
    render(<WorkspaceSearchPane />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "ab" },
    });
    await advanceDebounce();
    expect(screen.getByText("Searching...")).toBeInTheDocument();

    resolveSearch(EMPTY_RESPONSE);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  it("shows a truncated notice and loads more with a higher limit", async () => {
    setSearchResults({
      results: [{ kind: "file", path: "src/app.ts", name: "app.ts" }],
      truncated: true,
    });
    workspaceSearchMock.mockResolvedValueOnce({
      results: [
        { kind: "file", path: "src/app.ts", name: "app.ts" },
        { kind: "file", path: "src/main.ts", name: "main.ts" },
      ],
      truncated: false,
    });
    render(<WorkspaceSearchPane />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "app" },
    });
    await advanceDebounce();
    expect(
      screen.getByText("Results are limited. More matches may be available.")
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(workspaceSearchMock).toHaveBeenCalledTimes(2);
    expect(workspaceSearchMock).toHaveBeenLastCalledWith({
      query: "app",
      scope: "both",
      includeGitIgnored: true,
      repo: undefined,
      limit: 100,
    });
    expect(screen.getByText("main.ts")).toBeInTheDocument();
  });

  it("opens filename and content matches through store navigation", async () => {
    const openToFile = vi.fn();
    useWorkspaceViewerStore.setState({ openToFile });
    setSearchResults({
      results: [
        { kind: "file", path: "src/app.ts", name: "app.ts" },
        {
          kind: "content",
          path: "src/lib.ts",
          line: 12,
          matchSnippet: "a very long matching line",
        },
      ],
      truncated: false,
    });
    render(<WorkspaceSearchPane />);
    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "app" },
    });
    await advanceDebounce();

    fireEvent.click(screen.getByRole("button", { name: /app\.ts/ }));
    fireEvent.click(
      screen.getByRole("button", { name: "Open src/lib.ts at line 12" })
    );

    expect(openToFile).toHaveBeenNthCalledWith(1, "src/app.ts");
    expect(openToFile).toHaveBeenNthCalledWith(2, "src/lib.ts", 12, 12);
  });

  it("ignores a slower response from an earlier query", async () => {
    let resolveFirst!: (response: WorkspaceSearchResponse) => void;
    workspaceSearchMock
      .mockReturnValueOnce(
        new Promise<WorkspaceSearchResponse>((resolve) => {
          resolveFirst = resolve;
        })
      )
      .mockResolvedValueOnce({
        results: [{ kind: "file", path: "new.ts", name: "new.ts" }],
        truncated: false,
      });

    render(<WorkspaceSearchPane />);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "old" } });
    await advanceDebounce();
    fireEvent.change(input, { target: { value: "new" } });
    await advanceDebounce();
    expect(screen.getByRole("button", { name: /new\.ts/ })).toBeInTheDocument();

    resolveFirst({
      results: [{ kind: "file", path: "old.ts", name: "old.ts" }],
      truncated: false,
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText("old.ts")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new\.ts/ })).toBeInTheDocument();
  });
});
