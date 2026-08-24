import { fireEvent, render } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type {
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { SingleLineCompletionEditor } from "@components/shared/SingleLineCompletionEditor";

const completionSource = vi.fn(
  (_context: CompletionContext): CompletionResult | null => null
);

function renderEditor(
  props: Partial<ComponentProps<typeof SingleLineCompletionEditor>> = {}
) {
  const result = render(
    <SingleLineCompletionEditor
      id="test-editor"
      value=""
      onChange={vi.fn()}
      completionSource={completionSource}
      {...props}
    />
  );
  const content = result.container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("CodeMirror content element was not rendered");
  return { ...result, content };
}

describe("SingleLineCompletionEditor", () => {
  beforeAll(() => {
    if (!Range.prototype.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
  });

  it("renders its accessibility attributes on the focusable content element", () => {
    const { container, content } = renderEditor({
      className: "dynamic-validation-border",
      "aria-label": "Shell command",
      "aria-describedby": "shell-help",
    });

    expect(container.firstElementChild).toHaveClass(
      "dynamic-validation-border"
    );
    expect(content).toHaveAttribute("id", "test-editor");
    expect(content).toHaveAttribute("aria-label", "Shell command");
    expect(content).toHaveAttribute("aria-describedby", "shell-help");
  });

  it("reports each typed character through onChange", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { content } = renderEditor({ onChange });

    await user.click(content);
    await user.type(content, "abc");

    expect(onChange.mock.calls.map(([value]) => value)).toEqual([
      "a",
      "ab",
      "abc",
    ]);
  });

  it("calls onBlur when the editor loses focus", () => {
    const onBlur = vi.fn();
    const { content } = renderEditor({ onBlur });

    fireEvent.blur(content);

    expect(onBlur).toHaveBeenCalledOnce();
  });

  it("does not insert a newline when Enter is pressed", async () => {
    const user = userEvent.setup();
    const onBlur = vi.fn();
    const { content } = renderEditor({ onBlur });

    content.focus();
    await user.keyboard("{Enter}");

    expect(content.textContent).not.toContain("\n");
    expect(onBlur).toHaveBeenCalledOnce();
  });

  it("closes completion with Escape without leaving the field", () => {
    const { content } = renderEditor();

    content.focus();
    fireEvent.keyDown(content, { key: "Escape", code: "Escape" });

    expect(document.activeElement).toBe(content);
  });

  it("collapses pasted multi-line text to one line", () => {
    const onChange = vi.fn();
    const { content } = renderEditor({ onChange });

    fireEvent.paste(content, {
      clipboardData: {
        getData: () => "first\nsecond\r\nthird",
      },
    });

    expect(onChange).toHaveBeenCalledWith("firstsecondthird");
    expect(content.textContent).toBe("firstsecondthird");
  });

  it("preserves newlines when multiline mode receives pasted text", () => {
    const onChange = vi.fn();
    const { content } = renderEditor({ multiline: true, onChange });

    fireEvent.paste(content, {
      clipboardData: {
        getData: () => "first\nsecond\r\nthird",
      },
    });

    expect(onChange).toHaveBeenCalledWith("first\nsecond\nthird");
  });

  it("inserts a newline instead of blurring in multiline mode", async () => {
    const user = userEvent.setup();
    const onBlur = vi.fn();
    const onChange = vi.fn();
    const { content } = renderEditor({
      multiline: true,
      onBlur,
      onChange,
    });

    content.focus();
    await user.keyboard("{Enter}");

    expect(onChange).toHaveBeenCalledWith("\n");
    expect(onBlur).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(content);
  });

  it("blocks edits and completion requests when disabled", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const disabledCompletionSource = vi.fn(
      (_context: CompletionContext): CompletionResult | null => null
    );
    const { content } = renderEditor({
      disabled: true,
      onChange,
      completionSource: disabledCompletionSource,
    });

    await user.click(content);
    await user.type(content, "blocked");
    fireEvent.keyDown(content, {
      key: " ",
      code: "Space",
      ctrlKey: true,
    });

    expect(content).toHaveAttribute("contenteditable", "false");
    expect(onChange).not.toHaveBeenCalled();
    expect(disabledCompletionSource).not.toHaveBeenCalled();
  });
});
