/**
 * Tests for FileBrowserModal.
 *
 * FileBrowserModal takes no props — it is driven entirely by
 * uiStore.fileBrowserState (openFileBrowser/closeFileBrowser), so tests seed
 * that state directly, mirroring WorkspaceViewerModal.test.tsx.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  afterAll,
  beforeEach,
} from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FileBrowserModal } from "@components/workflow/FileBrowserModal";
import { useUiStore, type FileBrowserRequest } from "@store/uiStore";
import { workspaceFile, workspaceTree } from "@utils/hostedApi";
import type {
  WorkspaceTreeEntry,
  WorkspaceTreePageRequest,
  WorkspaceTreePageResponse,
  WorkspaceTreeRangeRequest,
} from "@root/types/HostedWorkspaceViewerTypes";

vi.mock("@utils/hostedApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@utils/hostedApi")>();
  return {
    ...actual,
    workspaceTree: vi.fn(),
    workspaceFile: vi.fn(),
  };
});

const workspaceTreeMock = vi.mocked(workspaceTree);
const workspaceFileMock = vi.mocked(workspaceFile);

const PAGE_SIZE = 100;
const ROOT_LISTING = "00000000-0000-4000-8000-000000000001";
const SRC_LISTING = "00000000-0000-4000-8000-000000000002";

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
      return this.dataset.testid === "file-browser-directory-list" ? 180 : 20;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 600,
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

function entry(
  index: number,
  kind: WorkspaceTreeEntry["kind"] = "file",
  name = `file-${index}.ts`,
  path = name
): WorkspaceTreeEntry {
  return { name, path, kind };
}

function pageResponse(
  listingId: string,
  path: string,
  entries: WorkspaceTreeEntry[],
  totalEntries: number,
  offset = 0
): WorkspaceTreePageResponse {
  return {
    listingId,
    pageSize: PAGE_SIZE,
    rootLabel: "workspace",
    path,
    parentPath: path === "" ? null : "",
    totalEntries,
    offset,
    entries,
    isGitRepo: false,
    isRootsList: false,
  };
}

function smallRootResponse(): WorkspaceTreePageResponse {
  return pageResponse(
    ROOT_LISTING,
    "",
    [
      entry(0, "directory", "src", "src"),
      entry(1, "file", "readme.md"),
      entry(2, "file", "image.png"),
    ],
    3
  );
}

function responseForLargeDirectory(
  entries: WorkspaceTreeEntry[],
  request: WorkspaceTreePageRequest | WorkspaceTreeRangeRequest,
  listingId = ROOT_LISTING
): WorkspaceTreePageResponse {
  if ("listingId" in request) {
    return pageResponse(
      listingId,
      "",
      entries.slice(request.offset, request.offset + PAGE_SIZE),
      entries.length,
      request.offset
    );
  }
  return pageResponse(
    listingId,
    request.path,
    entries.slice(0, PAGE_SIZE),
    entries.length
  );
}

async function expectTreeRequest(
  expected: WorkspaceTreePageRequest | WorkspaceTreeRangeRequest
): Promise<void> {
  await waitFor(() =>
    expect(workspaceTreeMock).toHaveBeenCalledWith(
      expected,
      expect.any(AbortSignal)
    )
  );
}

type FileBrowserOptions = FileBrowserRequest;

function openPicker(options: FileBrowserOptions): void {
  act(() => {
    useUiStore.getState().openFileBrowser(options);
  });
}

beforeEach(() => {
  workspaceTreeMock.mockReset();
  workspaceFileMock.mockReset();
  workspaceTreeMock.mockImplementation((request) => {
    const path = "listingId" in request ? "" : request.path;
    if (path === "src") {
      return Promise.resolve(
        pageResponse(
          SRC_LISTING,
          "src",
          [entry(0, "file", "index.ts", "src/index.ts")],
          1
        )
      );
    }
    return Promise.resolve(smallRootResponse());
  });
  useUiStore.setState({
    fileBrowserState: null,
    fileBrowserLastDirectory: null,
  });
});

describe("FileBrowserModal — visibility", () => {
  it("renders nothing when fileBrowserState is null", () => {
    render(<FileBrowserModal />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("loads the initial directory and lists its entries when opened", async () => {
    openPicker({ mode: "file", onSelect: vi.fn() });
    render(<FileBrowserModal />);

    await expectTreeRequest({ path: "", includeGitIgnored: true });
    expect(await screen.findByText("readme.md")).toBeInTheDocument();
    expect(screen.getByText("src/")).toBeInTheDocument();
  });
});

describe("FileBrowserModal — navigation", () => {
  it("navigates into a folder on click", async () => {
    const user = userEvent.setup();
    openPicker({ mode: "file", onSelect: vi.fn() });
    render(<FileBrowserModal />);

    await user.click(await screen.findByText("src/"));

    await expectTreeRequest({ path: "src", includeGitIgnored: true });
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
  });

  it("reopens in the directory used for the previous selection", async () => {
    const user = userEvent.setup();
    openPicker({ mode: "file", onSelect: vi.fn() });
    render(<FileBrowserModal />);

    await user.click(await screen.findByText("src/"));
    await user.click(await screen.findByText("index.ts"));
    await user.click(screen.getByRole("button", { name: "Select File" }));

    expect(useUiStore.getState().fileBrowserLastDirectory).toBe("src");
    workspaceTreeMock.mockClear();

    openPicker({ mode: "file", onSelect: vi.fn() });

    await expectTreeRequest({ path: "src", includeGitIgnored: true });
    expect(await screen.findByText("index.ts")).toBeInTheDocument();
  });

  it("falls back to the workspace root when the remembered directory is stale", async () => {
    useUiStore.setState({ fileBrowserLastDirectory: "deleted" });
    workspaceTreeMock.mockImplementation((request) => {
      const dirPath = "listingId" in request ? "" : request.path;
      if (dirPath === "deleted")
        return Promise.reject(new Error("Directory not found"));
      return Promise.resolve(smallRootResponse());
    });
    openPicker({ mode: "file", onSelect: vi.fn() });

    render(<FileBrowserModal />);

    await waitFor(() => {
      expect(workspaceTreeMock.mock.calls.map(([request]) => request)).toEqual([
        { path: "deleted", includeGitIgnored: true },
        { path: "", includeGitIgnored: true },
      ]);
    });
    expect(await screen.findByText("readme.md")).toBeInTheDocument();
  });

  it("does not let a slow previous directory response leak into the current one", async () => {
    const user = userEvent.setup();
    let resolveSrc!: (response: WorkspaceTreePageResponse) => void;
    let resolveRoot!: (response: WorkspaceTreePageResponse) => void;
    const srcResponse = new Promise<WorkspaceTreePageResponse>((resolve) => {
      resolveSrc = resolve;
    });
    const rootResponse = new Promise<WorkspaceTreePageResponse>((resolve) => {
      resolveRoot = resolve;
    });
    workspaceTreeMock.mockImplementation((request) => {
      if (!("listingId" in request) && request.path === "src")
        return srcResponse;
      if (!("listingId" in request) && request.path === "") {
        return workspaceTreeMock.mock.calls.length === 1
          ? Promise.resolve(smallRootResponse())
          : rootResponse;
      }
      return Promise.resolve(smallRootResponse());
    });
    openPicker({ mode: "file", onSelect: vi.fn() });
    render(<FileBrowserModal />);

    await screen.findByText("src/");
    await user.click(screen.getByText("src/"));
    await user.click(screen.getByTitle("Go to workspace root"));

    await act(async () => {
      resolveSrc(
        pageResponse(SRC_LISTING, "src", [entry(0, "file", "stale.ts")], 1)
      );
      resolveRoot(
        pageResponse(ROOT_LISTING, "", [entry(0, "file", "fresh.ts")], 1)
      );
    });

    expect(await screen.findByText("fresh.ts")).toBeInTheDocument();
    expect(screen.queryByText("stale.ts")).not.toBeInTheDocument();
  });
});

describe("FileBrowserModal — file mode", () => {
  it("selects a matching file, enabling confirm, and confirming selects it and closes", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    openPicker({ mode: "file", fileFilter: ["**/*.md"], onSelect });
    render(<FileBrowserModal />);

    const fileRow = await screen.findByText("readme.md");
    const confirmButton = screen.getByRole("button", { name: "Select File" });
    expect(confirmButton).toBeDisabled();

    await user.click(fileRow);
    expect(confirmButton).not.toBeDisabled();
    await user.click(confirmButton);

    expect(onSelect).toHaveBeenCalledWith("readme.md");
    expect(useUiStore.getState().fileBrowserState).toBeNull();
  });

  it("dims non-matching files per fileFilter and does not let them be selected", async () => {
    const user = userEvent.setup();
    openPicker({ mode: "file", fileFilter: ["**/*.md"], onSelect: vi.fn() });
    render(<FileBrowserModal />);

    const nonMatchingRow = await screen.findByText("image.png");
    const nonMatchingButton = nonMatchingRow.closest("button");
    expect(nonMatchingButton).toBeDisabled();
    await user.click(nonMatchingRow);
    expect(screen.getByRole("button", { name: "Select File" })).toBeDisabled();
  });

  it("loads and selects a file on a later page without loading file contents", async () => {
    const user = userEvent.setup();
    const entries = Array.from({ length: 1_205 }, (_, index) => entry(index));
    const onSelect = vi.fn();
    workspaceTreeMock.mockImplementation((request) =>
      Promise.resolve(responseForLargeDirectory(entries, request))
    );
    openPicker({ mode: "file", onSelect });
    render(<FileBrowserModal />);

    await expectTreeRequest({ path: "", includeGitIgnored: true });
    const scroller = screen.getByTestId("file-browser-directory-list");
    expect(scroller.querySelectorAll("button.fp-list-row").length).toBeLessThan(
      40
    );

    scroller.scrollTop = 1_100 * 36;
    fireEvent.scroll(scroller);
    await expectTreeRequest({ listingId: ROOT_LISTING, offset: 1_100 });
    expect(
      workspaceTreeMock.mock.calls.filter(
        ([request]) => "listingId" in request && request.offset < 1_100
      )
    ).toHaveLength(0);

    const laterFile = await screen.findByText("file-1100.ts");
    await user.click(laterFile);
    await user.click(screen.getByRole("button", { name: "Select File" }));

    expect(onSelect).toHaveBeenCalledWith("file-1100.ts");
    expect(workspaceFileMock).not.toHaveBeenCalled();
  });

  it("keeps filtered files visible and applies the filter only on the later page", async () => {
    const user = userEvent.setup();
    const entries = Array.from({ length: 120 }, (_, index) =>
      index === 100
        ? entry(index, "file", "later.md")
        : index === 101
          ? entry(index, "file", "later.png")
          : entry(index)
    );
    const onSelect = vi.fn();
    workspaceTreeMock.mockImplementation((request) =>
      Promise.resolve(responseForLargeDirectory(entries, request))
    );
    openPicker({ mode: "file", fileFilter: ["**/*.md"], onSelect });
    render(<FileBrowserModal />);

    await screen.findByText("file-0.ts");
    expect(screen.getByText(/Loaded .* of 120/)).toBeInTheDocument();
    const scroller = screen.getByTestId("file-browser-directory-list");
    scroller.scrollTop = 100 * 36;
    fireEvent.scroll(scroller);

    const matching = await screen.findByText("later.md");
    const mismatching = await screen.findByText("later.png");
    expect(mismatching.closest("button")).toBeDisabled();
    await user.click(matching);
    await user.click(screen.getByRole("button", { name: "Select File" }));
    expect(onSelect).toHaveBeenCalledWith("later.md");
  });

  it("shows a failed later page and retries only that page", async () => {
    const entries = Array.from({ length: 220 }, (_, index) => entry(index));
    let failed = true;
    workspaceTreeMock.mockImplementation((request) => {
      if ("listingId" in request && request.offset === 100 && failed) {
        failed = false;
        return Promise.reject(new Error("page failed"));
      }
      return Promise.resolve(responseForLargeDirectory(entries, request));
    });
    openPicker({ mode: "file", onSelect: vi.fn() });
    render(<FileBrowserModal />);

    await screen.findByText("file-0.ts");
    const scroller = screen.getByTestId("file-browser-directory-list");
    // Jump into the middle of the page. Its first absolute row (100) is not
    // mounted, so Retry must not depend on that row being in overscan.
    scroller.scrollTop = 150 * 36;
    fireEvent.scroll(scroller);

    expect(
      await screen.findByRole("button", { name: "Retry / Load page" })
    ).toBeInTheDocument();
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry / Load page" }));
    expect(await screen.findByText("file-150.ts")).toBeInTheDocument();
    expect(
      workspaceTreeMock.mock.calls.filter(
        ([request]) => "listingId" in request && request.offset === 100
      )
    ).toHaveLength(2);
  });
});

describe("FileBrowserModal — directory mode", () => {
  it("confirms the current directory without requiring a selection", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    openPicker({ mode: "directory", onSelect });
    render(<FileBrowserModal />);

    await screen.findByText("readme.md");
    const confirmButton = screen.getByRole("button", { name: "Select Folder" });
    expect(confirmButton).not.toBeDisabled();
    await user.click(confirmButton);

    expect(onSelect).toHaveBeenCalledWith("");
    expect(useUiStore.getState().fileBrowserState).toBeNull();
  });

  it("navigates into a folder and confirms that folder as the target", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    openPicker({ mode: "directory", onSelect });
    render(<FileBrowserModal />);

    await user.click(await screen.findByText("src/"));
    await expectTreeRequest({ path: "src", includeGitIgnored: true });
    await user.click(
      await screen.findByRole("button", { name: "Select Folder" })
    );

    expect(onSelect).toHaveBeenCalledWith("src");
  });

  it("keeps later-page files visible but disabled while allowing directory navigation", async () => {
    const user = userEvent.setup();
    const entries = Array.from({ length: 120 }, (_, index) =>
      index === 100
        ? entry(index, "file", "later.txt")
        : index === 101
          ? entry(index, "directory", "later-folder", "later-folder")
          : entry(index)
    );
    workspaceTreeMock.mockImplementation((request) => {
      if (!("listingId" in request) && request.path === "later-folder") {
        return Promise.resolve(
          pageResponse(SRC_LISTING, "later-folder", [], 0)
        );
      }
      return Promise.resolve(responseForLargeDirectory(entries, request));
    });
    const onSelect = vi.fn();
    openPicker({ mode: "directory", onSelect });
    render(<FileBrowserModal />);

    await screen.findByText("file-0.ts");
    const scroller = screen.getByTestId("file-browser-directory-list");
    scroller.scrollTop = 100 * 36;
    fireEvent.scroll(scroller);

    const file = await screen.findByText("later.txt");
    expect(file.closest("button")).toBeDisabled();
    await user.click(await screen.findByText("later-folder/"));
    await expectTreeRequest({ path: "later-folder", includeGitIgnored: true });
    await user.click(
      await screen.findByRole("button", { name: "Select Folder" })
    );
    expect(onSelect).toHaveBeenCalledWith("later-folder");
  });
});

describe("FileBrowserModal — cancel", () => {
  it("closes without calling onSelect", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    openPicker({ mode: "file", onSelect });
    render(<FileBrowserModal />);

    await screen.findByText("readme.md");
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onSelect).not.toHaveBeenCalled();
    expect(useUiStore.getState().fileBrowserState).toBeNull();
  });
});
