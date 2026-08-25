import { fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
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

    fireEvent.paste(content, {
      clipboardData: {
        getData: () => " shell(*)\n github(search) \n\n",
      },
    });

    expect(onChange).toHaveBeenLastCalledWith(["shell(*)", "github(search)"]);
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
