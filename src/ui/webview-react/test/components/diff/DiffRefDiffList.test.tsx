import { createRef } from "react";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VirtualizedPagedListProps } from "@components/shared/VirtualizedPagedList";
import { DiffRefDiffList } from "@components/diff/DiffRefDiffList";
import type { WorkspaceGitRefDiffEntry } from "@root/types/HostedWorkspaceViewerTypes";
import type { PagedGitRefDiffController } from "@hooks/usePagedGitRefDiff";

const { usePagedGitRefDiff } = vi.hoisted(() => ({
  usePagedGitRefDiff: vi.fn(),
}));

vi.mock("@hooks/usePagedGitRefDiff", () => ({ usePagedGitRefDiff }));
vi.mock("@components/shared", () => ({
  VirtualizedPagedList: <T,>(props: VirtualizedPagedListProps<T>) => (
    <div data-testid="virtualized-paged-list">
      {[0, 1, 2].map((index) => {
        const item = props.getItem(index);
        return (
          <div key={index} data-test-row={index}>
            {item
              ? props.renderItem(item, index)
              : props.renderPlaceholder(index)}
          </div>
        );
      })}
    </div>
  ),
}));

vi.mock("@components/diff/DiffFileCard", () => ({
  DiffFileCard: (props: {
    path: string;
    source: { kind: string };
    ariaSetSize?: number;
    ariaPosInSet?: number;
  }) => (
    <div
      data-testid={`diff-card-${props.path}`}
      data-source-kind={props.source.kind}
      aria-setsize={props.ariaSetSize}
      aria-posinset={props.ariaPosInSet}
    />
  ),
}));

function textEntry(path: string): WorkspaceGitRefDiffEntry {
  return {
    path,
    changeType: "modified",
    payloadKind: "text",
    oldContent: "old",
    newContent: "new",
  };
}

function controller(): PagedGitRefDiffController {
  const loaded = new Map<number, WorkspaceGitRefDiffEntry>([
    [0, textEntry("src/text.ts")],
    [1, {
      path: "assets/image.png",
      changeType: "created",
      payloadKind: "image",
      image: { newImageDataUri: "data:image/png;base64,image" },
    }],
    [2, {
      path: "assets/font.bin",
      changeType: "deleted",
      payloadKind: "binary",
    }],
  ]);
  return {
    ref: "~abcdef0",
    repo: "repo-a",
    listingId: "diff-1",
    totalCount: 3,
    pageSize: 3,
    getEntry: (index) => loaded.get(index),
    uniqueLoadedCount: 3,
    loadedCount: 3,
    loadedOffsets: [0],
    inFlightOffsets: [],
    failedRanges: [],
    initialLoading: false,
    isInitialLoading: false,
    pageLoading: false,
    isLoading: false,
    error: null,
    initialError: null,
    commitInfo: null,
    refLabel: "Commit abcdef0",
    navigate: vi.fn(),
    navigateTo: vi.fn(),
    refresh: vi.fn(),
    retry: vi.fn(),
    retryPage: vi.fn(),
    requestRange: vi.fn(),
    loadRange: vi.fn(),
    onRangeChange: vi.fn(),
    onViewportRangeChange: vi.fn(),
  };
}

describe("DiffRefDiffList", () => {
  beforeEach(() => {
    usePagedGitRefDiff.mockReturnValue(controller());
  });

  it("uses VirtualizedPagedList and maps text, image, and binary entries directly", () => {
    render(
      <DiffRefDiffList
        ref="~abcdef0"
        repo="repo-a"
        scrollContainerRef={createRef<HTMLDivElement>()}
        controller={controller()}
      />
    );

    expect(screen.getByTestId("virtualized-paged-list")).toBeInTheDocument();
    expect(screen.getByTestId("diff-card-src/text.ts")).toHaveAttribute(
      "data-source-kind",
      "content"
    );
    expect(screen.getByTestId("diff-card-assets/image.png")).toHaveAttribute(
      "data-source-kind",
      "image"
    );
    expect(screen.getByTestId("diff-card-assets/font.bin")).toHaveAttribute(
      "data-source-kind",
      "binary"
    );
  });
});
