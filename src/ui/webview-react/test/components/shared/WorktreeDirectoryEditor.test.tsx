import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorktreeDirectoryEditor } from "@components/shared/WorktreeDirectoryEditor";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { answerLatestRequestUntil } from "../../fixtures/completionRequests";

function renderEditor() {
  const result = render(
    <WorktreeDirectoryEditor
      id="directory-editor"
      value=""
      onChange={vi.fn()}
      aria-label="Worktree directory"
    />
  );
  const content = result.container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("CodeMirror content element was not rendered");
  return { ...result, content };
}

describe("WorktreeDirectoryEditor", () => {
  const postMessage = vi.mocked(window.vscodeApi!.postMessage);

  beforeAll(() => {
    if (!Range.prototype.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
  });

  beforeEach(() => {
    postMessage.mockClear();
  });

  it("asks the host for worktree directories, not branches", async () => {
    const user = userEvent.setup();
    const { content } = renderEditor();

    await user.click(content);
    await user.type(content, "bug");

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.WORKTREE_DIRECTORY_LIST_REQUEST,
        filterText: "bug",
        seq: expect.any(Number),
      });
    });
    expect(
      postMessage.mock.calls.some(
        ([message]) => message.type === MESSAGE_TYPES.BRANCH_LIST_REQUEST
      )
    ).toBe(false);
  });

  it("shows each directory with the branch it holds", async () => {
    const user = userEvent.setup();
    const { content } = renderEditor();

    await user.click(content);
    await user.type(content, "bug");

    await answerLatestRequestUntil<{
      type: string;
      filterText: string;
      seq: number;
    }>({
      postMessage,
      isRequest: (message) =>
        message.type === MESSAGE_TYPES.WORKTREE_DIRECTORY_LIST_REQUEST &&
        message.filterText === "bug",
      respond: (request) => ({
        type: MESSAGE_TYPES.WORKTREE_DIRECTORY_LIST_RESPONSE,
        items: [
          {
            label: "bug-fix",
            insertText: "bug-fix",
            detail: "on fix-race-condition",
          },
        ],
        seq: request.seq,
      }),
      until: () => {
        expect(screen.getByText("bug-fix")).toBeInTheDocument();
        expect(screen.getByText("on fix-race-condition")).toBeInTheDocument();
      },
    });
  });
});
