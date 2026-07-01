/**
 * Tests for MarkdownText.
 *
 * Streamdown and the shared syntax highlighter run normally here so fenced
 * code blocks exercise the real refractor rendering path.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock openFile so clicking file links doesn't try to post to vscode
vi.mock("@hooks/useMessageHandler", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@hooks/useMessageHandler")>();
  return { ...original, openFile: vi.fn() };
});

import { MarkdownText } from "@components/output/MarkdownText";

describe("MarkdownText", () => {
  it("renders plain text content", async () => {
    render(<MarkdownText>Hello world</MarkdownText>);
    expect(await screen.findByText("Hello world")).toBeInTheDocument();
  });

  it("renders bold text", async () => {
    render(<MarkdownText>**bold text**</MarkdownText>);
    const bold = await screen.findByText("bold text");
    expect(bold.tagName).toBe("STRONG");
  });

  it("renders italic text", async () => {
    render(<MarkdownText>_italic text_</MarkdownText>);
    const em = await screen.findByText("italic text");
    expect(em.tagName).toBe("EM");
  });

  it("renders inline code", async () => {
    render(<MarkdownText>`const x = 1`</MarkdownText>);
    const code = await screen.findByText("const x = 1");
    expect(code.tagName).toBe("CODE");
  });

  it("renders highlighted tokens for supported fenced languages", () => {
    const { container } = render(
      <MarkdownText>{"```ts\nconst value = 1;\n```"}</MarkdownText>
    );

    const code = container.querySelector("code.fp-syntax.language-ts");
    expect(code).toBeTruthy();
    expect(code?.querySelector(".token.keyword")?.textContent).toBe("const");
    expect(code?.querySelector(".token.number")?.textContent).toBe("1");
  });

  it("falls back to plain text for unsupported fenced languages", () => {
    const { container } = render(
      <MarkdownText>{"```unknownlang\nconst value = 1;\n```"}</MarkdownText>
    );

    const code = container.querySelector("code.fp-syntax.language-unknownlang");
    expect(code).toBeTruthy();
    expect(code).toHaveTextContent("const value = 1;");
    expect(code?.querySelector(".token")).toBeNull();
  });

  it("renders a heading", async () => {
    render(<MarkdownText># Hello</MarkdownText>);
    const h1 = await screen.findByRole("heading", { level: 1 });
    expect(h1).toBeInTheDocument();
  });

  it("renders a link for external URLs", async () => {
    render(<MarkdownText>[click here](https://example.com)</MarkdownText>);
    const link = await screen.findByRole("link", { name: "click here" });
    expect(link).toHaveAttribute(
      "href",
      expect.stringContaining("example.com")
    );
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders a file-ref button for local file paths in text", async () => {
    render(<MarkdownText>See src/utils/foo.ts for details</MarkdownText>);
    // The remark plugin converts matching paths into <file-ref> → FileRefButton
    const fileBtn = await screen.findByTitle(/Open src\/utils\/foo\.ts/);
    expect(fileBtn).toBeInTheDocument();
  });

  it("calls openFile when file-ref button clicked", async () => {
    const user = userEvent.setup();
    const { openFile } = await import("@hooks/useMessageHandler");
    render(<MarkdownText>Open src/utils/foo.ts now</MarkdownText>);
    const fileBtn = await screen.findByTitle(/Open src\/utils\/foo\.ts/);
    await user.click(fileBtn);
    expect(openFile).toHaveBeenCalledWith("src/utils/foo.ts");
  });

  it("opens Codex /abs/path drive markdown links as local file refs", async () => {
    const user = userEvent.setup();
    const { openFile } = await import("@hooks/useMessageHandler");
    vi.mocked(openFile).mockClear();

    render(
      <MarkdownText>
        {
          "[useDesktopLayout.ts](/abs/path/c:/dev/ctrlyoke/src/ui/webview-react/hooks/useDesktopLayout.ts:143)"
        }
      </MarkdownText>
    );

    const fileBtn = await screen.findByTitle(
      /Open C:\/dev\/ctrlyoke\/src\/ui\/webview-react\/hooks\/useDesktopLayout\.ts:143/
    );
    await user.click(fileBtn);
    expect(openFile).toHaveBeenCalledWith(
      "C:/dev/ctrlyoke/src/ui/webview-react/hooks/useDesktopLayout.ts",
      143
    );
  });

  it("opens slash-prefixed Windows drive markdown links as local file refs", async () => {
    const user = userEvent.setup();
    const { openFile } = await import("@hooks/useMessageHandler");
    vi.mocked(openFile).mockClear();

    render(
      <MarkdownText>
        {"[ContextExpander.ts](/c:/dev/ctrlyoke/src/utils/ContextExpander.ts)"}
      </MarkdownText>
    );

    const fileBtn = await screen.findByTitle(
      /Open C:\/dev\/ctrlyoke\/src\/utils\/ContextExpander\.ts/
    );
    await user.click(fileBtn);
    expect(openFile).toHaveBeenCalledWith(
      "C:/dev/ctrlyoke/src/utils/ContextExpander.ts"
    );
  });

  it("applies the markdown-text class on the container", () => {
    const { container } = render(<MarkdownText>text</MarkdownText>);
    // Streamdown wraps in a div — look for the markdown-text class anywhere
    expect(container.querySelector(".markdown-text")).toBeTruthy();
  });

  it("injects VS Code find-match theme styles for markdown marks", () => {
    render(
      <MarkdownText highlightQuery="alpha">alpha beta alpha</MarkdownText>
    );

    const style = document.getElementById("fp-find-highlight");
    expect(style?.textContent).toContain("--vscode-editor-findMatchBackground");
    expect(style?.textContent).toContain(
      "--vscode-editor-findMatchHighlightBackground"
    );
  });

  it("highlights all occurrences of the find query", () => {
    const { container } = render(
      <MarkdownText highlightQuery="alpha">alpha beta alpha gamma</MarkdownText>
    );

    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe("alpha");
    expect(marks[1].textContent).toBe("alpha");
  });

  it("marks the active match with data-find-active", () => {
    const { container } = render(
      <MarkdownText highlightQuery="alpha" highlightActiveIndex={1}>
        alpha beta alpha gamma
      </MarkdownText>
    );

    const marks = container.querySelectorAll("mark");
    expect(marks[0]).not.toHaveAttribute("data-find-active");
    expect(marks[1]).toHaveAttribute("data-find-active", "true");
  });

  it("highlights matches inside bold text without breaking the markup", async () => {
    const { container } = render(
      <MarkdownText highlightQuery="bold">**bold text**</MarkdownText>
    );

    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("bold");
    const strong = await screen.findByText((_, element) => {
      return (
        element?.tagName === "STRONG" && element.textContent === "bold text"
      );
    });
    expect(strong).toBeInTheDocument();
  });

  it("highlights find matches inside syntax-highlighted fenced code blocks", () => {
    const { container } = render(
      <MarkdownText highlightQuery="value">
        {"```ts\nconst value = 1;\n```"}
      </MarkdownText>
    );

    const mark = container.querySelector("code.fp-syntax mark");
    expect(mark?.textContent).toBe("value");
    // Syntax tokens are preserved alongside the find highlight.
    expect(
      container.querySelector("code.fp-syntax .token.keyword")?.textContent
    ).toBe("const");
  });

  it("highlights find matches inside inline code", () => {
    const { container } = render(
      <MarkdownText highlightQuery="value">{"`const value`"}</MarkdownText>
    );

    const mark = container.querySelector("code mark");
    expect(mark?.textContent).toBe("value");
  });

  it("is case-insensitive by default and case-sensitive when requested", () => {
    const insensitive = render(
      <MarkdownText highlightQuery="Alpha">alpha ALPHA Alpha</MarkdownText>
    );
    expect(insensitive.container.querySelectorAll("mark")).toHaveLength(3);

    const sensitive = render(
      <MarkdownText highlightQuery="Alpha" highlightCaseSensitive>
        alpha ALPHA Alpha
      </MarkdownText>
    );
    expect(sensitive.container.querySelectorAll("mark")).toHaveLength(1);
  });

  it("does not highlight for a whitespace-only query", () => {
    const { container } = render(
      <MarkdownText highlightQuery="   ">alpha beta gamma</MarkdownText>
    );
    expect(container.querySelectorAll("mark")).toHaveLength(0);
  });

  it("treats regex special characters in the query as literal text", () => {
    const { container } = render(
      <MarkdownText highlightQuery="a.b (c)">
        a.b (c) and axb (c) too
      </MarkdownText>
    );

    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("a.b (c)");
  });

  it("re-highlights with updated query/activeIndex without leaking marks across renders", () => {
    const { container, rerender } = render(
      <MarkdownText highlightQuery="alpha" highlightActiveIndex={0}>
        alpha beta alpha
      </MarkdownText>
    );
    expect(container.querySelectorAll("mark")).toHaveLength(2);
    expect(container.querySelectorAll("mark")[0]).toHaveAttribute(
      "data-find-active",
      "true"
    );

    rerender(
      <MarkdownText highlightQuery="beta" highlightActiveIndex={0}>
        alpha beta alpha
      </MarkdownText>
    );
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(1);
    expect(marks[0].textContent).toBe("beta");
    expect(marks[0]).toHaveAttribute("data-find-active", "true");
  });

  it("marks only the document-globally active occurrence across multiple paragraphs", () => {
    // Streamdown's default streaming mode transforms each paragraph as a
    // separate block, resetting remarkHighlightMatches' occurrence counter
    // per block. Without forcing static mode while highlighting, activeIndex
    // 0 would match occurrence 0 in *every* block.
    const md = "alpha in paragraph one.\n\nalpha in paragraph two.";

    const first = render(
      <MarkdownText highlightQuery="alpha" highlightActiveIndex={0}>
        {md}
      </MarkdownText>
    );
    let marks = first.container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveAttribute("data-find-active", "true");
    expect(marks[1]).not.toHaveAttribute("data-find-active");

    const second = render(
      <MarkdownText highlightQuery="alpha" highlightActiveIndex={1}>
        {md}
      </MarkdownText>
    );
    marks = second.container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0]).not.toHaveAttribute("data-find-active");
    expect(marks[1]).toHaveAttribute("data-find-active", "true");
  });

  it("auto-renders mermaid with Copy + PNG controls and no render/source toggle", async () => {
    const source = "graph TD\n  A --> B";
    render(<MarkdownText>{`\`\`\`mermaid\n${source}\n\`\`\``}</MarkdownText>);

    // Diagram renders on mount (no gating button); Copy + PNG are the controls.
    expect(
      await screen.findByRole("button", { name: /copy source/i })
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /download as png/i })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /render diagram/i })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /show source/i })
    ).not.toBeInTheDocument();
  });

  it("copies the mermaid source to the clipboard", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    const source = "graph TD\n  A --> B";
    render(<MarkdownText>{`\`\`\`mermaid\n${source}\n\`\`\``}</MarkdownText>);

    await user.click(
      await screen.findByRole("button", { name: /copy source/i })
    );

    expect(writeText).toHaveBeenCalledWith(source);
    // On success the icon button's accessible name flips to "Copied".
    expect(
      await screen.findByRole("button", { name: /copied/i })
    ).toBeInTheDocument();
  });
});
