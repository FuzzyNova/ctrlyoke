import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { WORKSPACE_ENTRY_KINDS } from "@root/types/DashboardConstants";
import type {
  WorkspaceSearchResponse,
  WorkspaceSearchResult,
} from "@root/types/HostedWorkspaceViewerTypes";
import {
  WORKSPACE_SEARCH_DEBOUNCE_MS,
  WORKSPACE_SEARCH_PAGE_SIZE,
  WorkspaceSearchPane,
} from "@components/workspace-viewer/WorkspaceSearchPane";
import { useSettingsStore } from "@store/settingsStore";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { workspaceRepos, workspaceSearch } from "@utils/hostedApi";

vi.mock("@utils/hostedApi", () => ({
  workspaceSearch: vi.fn(),
  workspaceRepos: vi.fn(),
}));

const workspaceSearchMock = vi.mocked(workspaceSearch);
const workspaceReposMock = vi.mocked(workspaceRepos);

// The results list is virtualized; TanStack sizes its window from the scroll
// container's offsetHeight, which jsdom reports as 0.
const originalOffsetHeight = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetHeight"
);
const originalOffsetWidth = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "offsetWidth"
);

beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get(this: HTMLElement) {
      return this.classList.contains("overflow-y-auto") ? 200 : 20;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 400,
  });
});

afterAll(() => {
  if (originalOffsetHeight) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetHeight",
      originalOffsetHeight
    );
  }
  if (originalOffsetWidth) {
    Object.defineProperty(
      HTMLElement.prototype,
      "offsetWidth",
      originalOffsetWidth
    );
  }
});

function page(
  results: WorkspaceSearchResult[],
  overrides: Partial<WorkspaceSearchResponse> = {}
): WorkspaceSearchResponse {
  return {
    searchId: "search-1",
    results,
    totalCount: results.length,
    complete: true,
    capped: false,
    ...overrides,
  };
}

function files(count: number, start = 0): WorkspaceSearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: WORKSPACE_ENTRY_KINDS.FILE,
    path: `src/file-${start + i}.ts`,
    name: `file-${start + i}.ts`,
  }));
}

const EMPTY_RESPONSE = page([]);

function advanceDebounce() {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(WORKSPACE_SEARCH_DEBOUNCE_MS);
  });
}

function flushResponses() {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

function search(query: string) {
  fireEvent.change(
    screen.getByRole("searchbox", { name: "Search workspace" }),
    {
      target: { value: query },
    }
  );
  return advanceDebounce();
}

describe("WorkspaceSearchPane", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    workspaceSearchMock.mockReset();
    workspaceSearchMock.mockResolvedValue(EMPTY_RESPONSE);
    workspaceReposMock.mockReset();
    workspaceReposMock.mockResolvedValue({ repos: [], prefixRepoIds: {} });
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
      searchId: undefined,
      offset: 0,
      limit: WORKSPACE_SEARCH_PAGE_SIZE,
    });
  });

  it("passes the selected scope and git-ignore override to the search", async () => {
    render(<WorkspaceSearchPane />);
    await search("ab");

    fireEvent.click(screen.getByRole("button", { name: "Content" }));
    await advanceDebounce();

    expect(workspaceSearchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: "ab",
        scope: "content",
        includeGitIgnored: true,
        offset: 0,
      })
    );

    const includeIgnored = screen.getByRole("checkbox", {
      name: "Include git-ignored files",
    });
    expect(includeIgnored).toBeChecked();
    fireEvent.click(includeIgnored);
    await advanceDebounce();

    expect(includeIgnored).not.toBeChecked();
    expect(workspaceSearchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        query: "ab",
        scope: "content",
        includeGitIgnored: false,
        offset: 0,
      })
    );
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

  it("discovers repos on mount so the picker works without opening SCM", async () => {
    workspaceReposMock.mockResolvedValue({
      repos: [
        { id: "one", label: "One", rootPath: "/one" },
        { id: "two", label: "Two", rootPath: "/two" },
      ],
      prefixRepoIds: { one: "one", two: "two" },
    });

    render(<WorkspaceSearchPane />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(workspaceReposMock).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("combobox", { name: "Select repository" })
    ).toBeInTheDocument();
  });

  it("scopes to a repo only when there is more than one to choose from", async () => {
    workspaceReposMock.mockResolvedValue({
      repos: [{ id: "only", label: "Only", rootPath: "/only" }],
      prefixRepoIds: { only: "only" },
    });

    render(<WorkspaceSearchPane />);
    await search("ab");

    // A lone repo must not scope the scan away from non-repo workspace roots.
    expect(workspaceSearchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ repo: undefined })
    );

    useWorkspaceViewerStore.setState({
      repos: [
        { id: "only", label: "Only", rootPath: "/only" },
        { id: "other", label: "Other", rootPath: "/other" },
      ],
      selectedRepoId: "other",
    });
    await advanceDebounce();

    expect(workspaceSearchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ repo: "other" })
    );
  });

  it("renders loading and empty states", async () => {
    let resolveSearch!: (response: WorkspaceSearchResponse) => void;
    workspaceSearchMock.mockReturnValueOnce(
      new Promise<WorkspaceSearchResponse>((resolve) => {
        resolveSearch = resolve;
      })
    );
    render(<WorkspaceSearchPane />);
    await search("ab");
    expect(screen.getByText("Searching...")).toBeInTheDocument();

    resolveSearch(EMPTY_RESPONSE);
    await flushResponses();
    expect(screen.getByText("No results")).toBeInTheDocument();
  });

  it("shows an exact count, or a lower bound while the scan is unfinished", async () => {
    workspaceSearchMock.mockResolvedValueOnce(page(files(3)));
    render(<WorkspaceSearchPane />);
    await search("file");
    expect(screen.getByText("3 results")).toBeInTheDocument();

    workspaceSearchMock.mockResolvedValueOnce(
      page(files(WORKSPACE_SEARCH_PAGE_SIZE), {
        totalCount: 150,
        complete: false,
      })
    );
    await search("files");
    expect(screen.getByText("150+ results")).toBeInTheDocument();

    workspaceSearchMock.mockResolvedValueOnce(
      page(files(WORKSPACE_SEARCH_PAGE_SIZE), {
        totalCount: 10_000,
        capped: true,
      })
    );
    await search("filez");
    expect(screen.getByText("10,000+ results")).toBeInTheDocument();
  });

  it("loads the next page of the same search when scrolled to the end", async () => {
    workspaceSearchMock
      .mockResolvedValueOnce(
        page(files(WORKSPACE_SEARCH_PAGE_SIZE), {
          totalCount: 80,
          complete: false,
        })
      )
      .mockResolvedValueOnce(
        page(files(30, WORKSPACE_SEARCH_PAGE_SIZE), {
          totalCount: 80,
        })
      );
    const { container } = render(<WorkspaceSearchPane />);
    await search("file");

    // The first page fills the viewport, so nothing more is requested yet.
    expect(workspaceSearchMock).toHaveBeenCalledOnce();
    expect(screen.getByText("80+ results")).toBeInTheDocument();
    expect(
      container.querySelector('[data-workspace-search-placeholder="true"]')
    ).not.toBeNull();

    const scroller = container.querySelector<HTMLElement>(".overflow-y-auto")!;
    await act(async () => {
      scroller.scrollTop = 100_000;
      scroller.dispatchEvent(new Event("scroll"));
    });
    await flushResponses();

    expect(workspaceSearchMock).toHaveBeenCalledTimes(2);
    expect(workspaceSearchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        searchId: "search-1",
        offset: WORKSPACE_SEARCH_PAGE_SIZE,
      })
    );
    expect(screen.getByText("file-79.ts")).toBeInTheDocument();
    expect(screen.getByText("80 results")).toBeInTheDocument();
    expect(
      container.querySelector('[data-workspace-search-placeholder="true"]')
    ).toBeNull();
  });

  it("keeps loading while a short page leaves the list's end in view", async () => {
    workspaceSearchMock
      .mockResolvedValueOnce(page(files(2), { complete: false }))
      .mockResolvedValueOnce(page(files(1, 2), { totalCount: 3 }));
    render(<WorkspaceSearchPane />);
    await search("file");
    await flushResponses();

    expect(workspaceSearchMock).toHaveBeenCalledTimes(2);
    expect(workspaceSearchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ searchId: "search-1", offset: 2 })
    );
    expect(screen.getByText("file-2.ts")).toBeInTheDocument();
    expect(screen.getByText("3 results")).toBeInTheDocument();
  });

  it("continues a scan whose page budget ran out before finding anything", async () => {
    workspaceSearchMock
      .mockResolvedValueOnce(page([], { complete: false }))
      .mockResolvedValueOnce(page(files(1)));
    render(<WorkspaceSearchPane />);
    await search("file");
    expect(screen.queryByText("No results")).not.toBeInTheDocument();
    await flushResponses();

    expect(workspaceSearchMock).toHaveBeenCalledTimes(2);
    expect(workspaceSearchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ searchId: "search-1", offset: 0 })
    );
    expect(screen.getByText("file-0.ts")).toBeInTheDocument();
  });

  it("opens filename and content matches through store navigation", async () => {
    const openToFile = vi.fn();
    useWorkspaceViewerStore.setState({ openToFile });
    workspaceSearchMock.mockResolvedValueOnce(
      page([
        {
          kind: WORKSPACE_ENTRY_KINDS.FILE,
          path: "src/app.ts",
          name: "app.ts",
        },
        {
          kind: WORKSPACE_ENTRY_KINDS.CONTENT,
          path: "src/lib.ts",
          line: 12,
          matchSnippet: "a very long matching line",
        },
        {
          kind: WORKSPACE_ENTRY_KINDS.CONTENT,
          path: "src/lib.ts",
          line: 30,
          matchSnippet: "another match",
        },
      ])
    );
    render(<WorkspaceSearchPane />);
    await search("app");

    // A file's matches share one path heading.
    expect(screen.getAllByText("src/lib.ts")).toHaveLength(1);

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
      .mockResolvedValueOnce(
        page([
          { kind: WORKSPACE_ENTRY_KINDS.FILE, path: "new.ts", name: "new.ts" },
        ])
      );

    render(<WorkspaceSearchPane />);
    await search("old");
    await search("new");
    expect(screen.getByRole("button", { name: /new\.ts/ })).toBeInTheDocument();

    resolveFirst(
      page([
        { kind: WORKSPACE_ENTRY_KINDS.FILE, path: "old.ts", name: "old.ts" },
      ])
    );
    await flushResponses();

    expect(screen.queryByText("old.ts")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /new\.ts/ })).toBeInTheDocument();
  });

  it("offers a retry when a page request fails", async () => {
    workspaceSearchMock
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(page(files(1)));
    render(<WorkspaceSearchPane />);
    await search("file");
    await flushResponses();

    expect(screen.getByText("Search failed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flushResponses();

    expect(screen.queryByText("Search failed.")).not.toBeInTheDocument();
    expect(screen.getByText("file-0.ts")).toBeInTheDocument();
  });
});
