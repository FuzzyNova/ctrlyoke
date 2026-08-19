import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptCommandEditor } from "@components/shared/ScriptCommandEditor";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";

function renderEditor(
  props: Partial<ComponentProps<typeof ScriptCommandEditor>> = {}
) {
  const result = render(
    <ScriptCommandEditor
      id="script-editor"
      value=""
      onChange={vi.fn()}
      {...props}
    />
  );
  const content = result.container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("CodeMirror content element was not rendered");
  return { ...result, content };
}

describe("ScriptCommandEditor", () => {
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
      className: "script-field",
      placeholder: "npm test",
    });

    expect(content).toHaveAttribute("id", "script-editor");
    expect(content).toHaveAttribute("contenteditable", "true");
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  it("forwards changes to onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { content } = renderEditor({ onChange });

    await user.click(content);
    await user.type(content, "git status");

    expect(onChange).toHaveBeenLastCalledWith("git status");
  });

  it("requests completions while typing", async () => {
    const user = userEvent.setup();
    const { content } = renderEditor();

    await user.click(content);
    await user.type(content, "g");

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST,
        text: "g",
        position: 1,
        seq: expect.any(Number),
      });
    });
  });

  it("uses matching responses and ignores stale sequence numbers", async () => {
    const user = userEvent.setup();
    const { content } = renderEditor();

    await user.click(content);
    await user.type(content, "g");

    await waitFor(() => {
      expect(
        postMessage.mock.calls.some(
          ([message]) =>
            message.type === MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST
        )
      ).toBe(true);
    });

    const request = postMessage.mock.calls.find(
      ([message]) => message.type === MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST
    )?.[0];
    if (!request || typeof request.seq !== "number") {
      throw new Error("Script completion request was not posted");
    }

    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE,
          items: [
            { label: "stale suggestion", insertText: "stale suggestion" },
          ],
          from: 0,
          seq: request.seq - 1,
        },
      })
    );

    expect(screen.queryByText("stale suggestion")).not.toBeInTheDocument();

    fireEvent(
      window,
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.SCRIPT_COMPLETIONS_RESPONSE,
          items: [
            {
              label: "git status",
              insertText: "git status",
              detail: "Show the working tree status",
            },
          ],
          from: 0,
          seq: request.seq,
        },
      })
    );

    await waitFor(() => {
      expect(screen.getByText("git status")).toBeInTheDocument();
    });
  });
});
