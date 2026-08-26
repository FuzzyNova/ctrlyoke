import { fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PermissionListEditor } from "@components/shared/PermissionListEditor";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";

function renderEditor(
  props: Partial<ComponentProps<typeof PermissionListEditor>> = {}
) {
  const result = render(
    <PermissionListEditor
      id="permission-editor"
      value={[]}
      onChange={vi.fn()}
      {...props}
    />
  );
  const content = result.container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("CodeMirror content element was not rendered");
  return { ...result, content };
}

describe("PermissionListEditor", () => {
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

  it("round-trips permission lists through the editor text", () => {
    const initial = renderEditor({
      value: ["shell(*)", "github(search)"],
    });
    expect(initial.content.textContent).toBe("shell(*)github(search)");
    initial.unmount();

    const onChange = vi.fn();
    const { content } = renderEditor({
      onChange,
    });

    // Paste echoes back the exact `\n` split (no trim/filter) so the
    // controlled `value` round-trips losslessly while editing is still in
    // progress — see the "does not corrupt input" test below for why.
    fireEvent.paste(content, {
      clipboardData: {
        getData: () => " shell(*)\n github(search) \n\n",
      },
    });

    expect(onChange).toHaveBeenLastCalledWith([
      " shell(*)",
      " github(search) ",
      "",
      "",
    ]);
  });

  it("trims and drops blank lines on blur", () => {
    const onChange = vi.fn();
    const { content } = renderEditor({
      value: [" shell(*)", " github(search) ", "", ""],
      onChange,
    });

    fireEvent.blur(content);

    expect(onChange).toHaveBeenLastCalledWith(["shell(*)", "github(search)"]);
  });

  it("does not corrupt input when a blank line is created via Enter and fed back through a controlled value prop", async () => {
    // Regression test: PermissionListEditor previously trimmed/filtered
    // blank lines on every keystroke before calling `onChange`. Since
    // pressing Enter creates a trailing blank line, that transform made the
    // echoed value permanently diverge from the live document, so
    // `syncDocument` would immediately delete the newline the user just
    // typed — merging the next line's text onto the previous line instead
    // of starting a new one.
    function ControlledWrapper() {
      const [value, setValue] = useState<string[]>([]);
      return (
        <PermissionListEditor
          id="controlled"
          value={value}
          onChange={setValue}
        />
      );
    }

    const user = userEvent.setup();
    const { container } = render(<ControlledWrapper />);
    const content = container.querySelector<HTMLElement>(".cm-content")!;

    await user.click(content);
    for (const ch of "read") {
      await user.keyboard(ch);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await user.keyboard("{Enter}");
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const ch of "grep") {
      await user.keyboard(ch);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await new Promise((resolve) => setTimeout(resolve, 50));

    const lines = [...content.querySelectorAll(".cm-line")].map(
      (line) => line.textContent
    );
    expect(lines).toEqual(["read", "grep"]);
  });

  it("reports invalid pattern syntax with an inline diagnostic", async () => {
    const { container } = renderEditor({ value: ["not a pattern"] });

    await waitFor(() => {
      const diagnostic = container.querySelector(".cm-lintRange-error");
      expect(diagnostic).toBeInTheDocument();
      expect(diagnostic).toHaveTextContent("not a pattern");
    });
  });

  it("requests permission completions for the full document", async () => {
    const user = userEvent.setup();
    const { content } = renderEditor();
    await user.click(content);
    await user.type(content, "s");

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.PERMISSION_COMPLETIONS_REQUEST,
        text: "s",
        position: 1,
        seq: expect.any(Number),
      });
    });
  });
});
