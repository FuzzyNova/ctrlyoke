import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ScriptCommandEditor } from "@components/shared/ScriptCommandEditor";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { latestPostedMessage } from "../../fixtures/completionRequests";

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

    const request = latestPostedMessage<{ type: string; seq: number }>(
      postMessage,
      (message) => message.type === MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST
    );

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

  it("inserts a newline and keeps focus in multiline mode", async () => {
    const user = userEvent.setup();
    const onBlur = vi.fn();
    const onChange = vi.fn();
    const { content } = renderEditor({
      multiline: true,
      onBlur,
      onChange,
    });

    await user.click(content);
    await user.type(content, "echo one");
    await user.keyboard("{Enter}echo two");

    expect(onChange).toHaveBeenLastCalledWith("echo one\necho two");
    expect(onBlur).not.toHaveBeenCalled();
    expect(content.querySelectorAll(".cm-line")).toHaveLength(2);
    expect(
      [...content.querySelectorAll(".cm-line")].map((line) => line.textContent)
    ).toEqual(["echo one", "echo two"]);
  });

  it("blurs and keeps the command single-line when Enter is pressed", async () => {
    const user = userEvent.setup();
    const onBlur = vi.fn();
    const { content } = renderEditor({ onBlur });

    await user.click(content);
    await user.type(content, "echo one");
    await user.keyboard("{Enter}");

    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(content).not.toHaveTextContent("\n");
    expect(content).not.toHaveFocus();
  });

  it("preserves pasted newlines only in multiline mode", () => {
    const multiline = renderEditor({ multiline: true });
    fireEvent.paste(multiline.content, {
      clipboardData: { getData: () => "echo one\necho two" },
    });
    expect(multiline.content.querySelectorAll(".cm-line")).toHaveLength(2);
    expect(
      [...multiline.content.querySelectorAll(".cm-line")].map(
        (line) => line.textContent
      )
    ).toEqual(["echo one", "echo two"]);
    multiline.unmount();

    const singleLine = renderEditor();
    fireEvent.paste(singleLine.content, {
      clipboardData: { getData: () => "echo one\necho two" },
    });
    expect(singleLine.content).toHaveTextContent("echo oneecho two");
  });
});
