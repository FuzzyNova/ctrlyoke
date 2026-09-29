import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { BranchNameEditor } from "@components/shared/BranchNameEditor";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { answerLatestRequestUntil } from "../../fixtures/completionRequests";

function renderEditor(
  props: Partial<ComponentProps<typeof BranchNameEditor>> = {}
) {
  const result = render(
    <BranchNameEditor
      id="branch-editor"
      value=""
      onChange={vi.fn()}
      {...props}
    />
  );
  const content = result.container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("CodeMirror content element was not rendered");
  return { ...result, content };
}

describe("BranchNameEditor", () => {
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

  it("renders the shared single-line editor", () => {
    const { content } = renderEditor({
      "aria-label": "Worktree branch",
      placeholder: "feature/new-branch",
    });

    expect(content).toHaveAttribute("id", "branch-editor");
    expect(content).toHaveAttribute("contenteditable", "true");
    expect(content).toHaveAttribute("aria-label", "Worktree branch");
    expect(screen.getByText("feature/new-branch")).toBeInTheDocument();
  });

  it("forwards changes to onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { content } = renderEditor({ onChange });

    await user.click(content);
    await user.type(content, "feature/new");

    expect(onChange).toHaveBeenLastCalledWith("feature/new");
  });

  it("posts the full field value as the branch filter", async () => {
    const user = userEvent.setup();
    const { content } = renderEditor();

    await user.click(content);
    await user.type(content, "feat/");

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.BRANCH_LIST_REQUEST,
        filterText: "feat/",
        seq: expect.any(Number),
      });
    });
  });

  it("turns a matching response into suggestions", async () => {
    const user = userEvent.setup();
    const { content } = renderEditor();

    await user.click(content);
    await user.type(content, "feat/");

    await answerLatestRequestUntil<{
      type: string;
      filterText: string;
      seq: number;
    }>({
      postMessage,
      isRequest: (message) =>
        message.type === MESSAGE_TYPES.BRANCH_LIST_REQUEST &&
        message.filterText === "feat/",
      respond: (request) => ({
        type: MESSAGE_TYPES.BRANCH_LIST_RESPONSE,
        items: [
          {
            label: "feat/new",
            insertText: "feat/new",
            detail: "Existing branch",
          },
        ],
        seq: request.seq,
      }),
      until: () => {
        expect(screen.getByText("feat/new")).toBeInTheDocument();
        expect(screen.getByText("Existing branch")).toBeInTheDocument();
      },
    });
  });

  it("keeps unmatched typed text and hides the popup for an empty response", async () => {
    const user = userEvent.setup();
    const { content } = renderEditor();

    await user.click(content);
    await user.type(content, "new-branch");

    await waitFor(() => {
      expect(
        postMessage.mock.calls.some(
          ([message]) => message.type === MESSAGE_TYPES.BRANCH_LIST_REQUEST
        )
      ).toBe(true);
    });

    const request = [...postMessage.mock.calls]
      .reverse()
      .find(
        ([message]) => message.type === MESSAGE_TYPES.BRANCH_LIST_REQUEST
      )?.[0];
    if (!request || typeof request.seq !== "number") {
      throw new Error("Branch list request was not posted");
    }

    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.BRANCH_LIST_RESPONSE,
          items: [],
          seq: request.seq,
        },
      })
    );

    await waitFor(() => {
      expect(content).toHaveTextContent("new-branch");
      expect(
        document.querySelector(".cm-tooltip-autocomplete")
      ).not.toBeInTheDocument();
    });
  });
});
