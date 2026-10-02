/**
 * Tests for MarkdownText.
 *
 * Streamdown and the shared syntax highlighter run normally here so fenced
 * code blocks exercise the real refractor rendering path.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MESSAGE_TYPES } from "@/types/messages";
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

    const code = container.querySelector("code.cy-syntax.language-ts");
    expect(code).toBeTruthy();
    expect(code?.querySelector(".token.keyword")?.textContent).toBe("const");
    expect(code?.querySelector(".token.number")?.textContent).toBe("1");
  });

  it("falls back to plain text for unsupported fenced languages", () => {
    const { container } = render(
      <MarkdownText>{"```unknownlang\nconst value = 1;\n```"}</MarkdownText>
    );

    const code = container.querySelector("code.cy-syntax.language-unknownlang");
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
    const fileBtn = await screen.findByRole("button", { name: "Open file" });
    expect(fileBtn).toBeInTheDocument();
  });

  it("calls openFile when file-ref button clicked", async () => {
    const user = userEvent.setup();
    const { openFile } = await import("@hooks/useMessageHandler");
    render(<MarkdownText>Open src/utils/foo.ts now</MarkdownText>);
    const fileBtn = await screen.findByRole("button", { name: "Open file" });
    await user.click(fileBtn);
    expect(openFile).toHaveBeenCalledWith("src/utils/foo.ts");
  });

  it("renders auto-linked local paths as atomic chips when opted in", async () => {
    render(
      <MarkdownText atomicContextReferences>
        See src/ui/webview-react/utils/foo.ts for details
      </MarkdownText>
    );
    expect(
      await screen.findByRole("button", { name: /open src/i })
    ).toHaveClass("atomic-reference-chip");
  });

  it("preserves authored labels for opted-in local Markdown links", async () => {
    render(
      <MarkdownText atomicContextReferences>
        {["[the utility](src/utils/foo.ts)"].join("")}
      </MarkdownText>
    );
    const chip = await screen.findByRole("button", {
      name: /open src\/utils\/foo\.ts/i,
    });
    expect(chip).toHaveTextContent("the utility");
    expect(chip).toHaveAttribute("title", "src/utils/foo.ts");
  });

  it("expands an opted-in chip when a hidden path segment matches", async () => {
    const markdown = "See src/ui/webview-react/utils/foo.ts";
    const start = markdown.indexOf("src/");
    render(
      <MarkdownText
        atomicContextReferences
        findDecorations={{
          matches: [{ start: start + 7, end: start + 20, active: true }],
        }}
      >
        {markdown}
      </MarkdownText>
    );
    const mark = await screen.findByText("webview-react");
    expect(mark.tagName).toBe("MARK");
    expect(mark).toHaveAttribute("data-find-active", "true");
  });

  it("does not chip external links or inline code", async () => {
    const { container } = render(
      <MarkdownText atomicContextReferences>
        {["[external](https://example.com) `src/utils/foo.ts`"].join("")}
      </MarkdownText>
    );
    expect(
      await screen.findByRole("link", { name: "external" })
    ).toBeInTheDocument();
    expect(container.querySelector("code .atomic-reference-chip")).toBeNull();
    expect(container.querySelectorAll(".atomic-reference-chip")).toHaveLength(
      0
    );
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

    const fileBtn = await screen.findByRole("button", { name: "Open file" });
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

    const fileBtn = await screen.findByRole("button", { name: "Open file" });
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

    const style = document.getElementById("cy-find-highlight");
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

    const mark = container.querySelector("code.cy-syntax mark");
    expect(mark?.textContent).toBe("value");
    // Syntax tokens are preserved alongside the find highlight.
    expect(
      container.querySelector("code.cy-syntax .token.keyword")?.textContent
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

describe("MarkdownText context references in replies", () => {
  const postMessage = () => vi.mocked(window.vscodeApi!.postMessage);
  const links = (container: HTMLElement) =>
    Array.from(container.querySelectorAll<HTMLElement>('[role="link"]'));

  it("links every ctrlyoke reference kind an agent can cite", () => {
    const reply = [
      "Changed @src/utils/foo.ts and @src/ui/ (see #selection:src/utils/foo.ts:3-5",
      "and #sym:src/utils/foo.ts:bar:10-12) after ~abc1234 and ~diff,",
      "using $step:2, $previous, $endCondition:stdout and /skill:commit and /mcp:ctrlyoke.",
    ].join(" ");
    const { container } = render(
      <MarkdownText contextReferences>{reply}</MarkdownText>
    );

    expect(links(container).map((link) => link.textContent)).toEqual([
      "@src/utils/foo.ts",
      "@src/ui/",
      "#selection:src/utils/foo.ts:3-5",
      "#sym:src/utils/foo.ts:bar:10-12",
      "~abc1234",
      "~diff",
      "$step:2",
      "$previous",
      // $endCondition:stdout has no open target outside a retry prompt.
      "/skill:commit",
      "/mcp:ctrlyoke",
    ]);
    // `@src/utils/foo.ts` is claimed whole — no stray `@` before a bare link.
    expect(
      container.querySelector('button[aria-label="Open file"]')
    ).toBeNull();
  });

  it("keeps references containing Markdown emphasis markers whole", () => {
    const reply = [
      "Changed @src/__tests__/foo.test.ts and @pkg/__init__.py.",
      "See #selection:src/__tests__/a.test.ts:3-5 and #sym:src/a.py:__init__:1-2.",
      "Keep __bold__ prose bold, and leave `@src/__tests__/inline.ts` alone.",
      "",
      "```text\n@src/__tests__/fenced.ts\n```",
    ].join("\n");
    const { container } = render(
      <MarkdownText contextReferences>{reply}</MarkdownText>
    );

    expect(links(container).map((link) => link.textContent)).toEqual([
      "@src/__tests__/foo.test.ts",
      "@pkg/__init__.py",
      "#selection:src/__tests__/a.test.ts:3-5",
      "#sym:src/a.py:__init__:1-2",
    ]);
    const refs = links(container);
    expect(refs.map((ref) => ref.getAttribute("title"))).toEqual([
      "Open src/__tests__/foo.test.ts",
      "Open pkg/__init__.py",
      "Open src/__tests__/a.test.ts:3-5",
      "Go to __init__ in src/a.py:1-2",
    ]);
    postMessage().mockClear();
    refs.forEach((ref) => fireEvent.click(ref));
    expect(postMessage().mock.calls.map(([message]) => message)).toEqual([
      { type: MESSAGE_TYPES.OPEN_FILE, path: "src/__tests__/foo.test.ts" },
      { type: MESSAGE_TYPES.OPEN_FILE, path: "pkg/__init__.py" },
      {
        type: MESSAGE_TYPES.OPEN_FILE,
        path: "src/__tests__/a.test.ts",
        lineStart: 3,
        lineEnd: 5,
      },
      {
        type: MESSAGE_TYPES.OPEN_FILE,
        path: "src/a.py",
        lineStart: 1,
        lineEnd: 2,
      },
    ]);
    expect(screen.getByText("bold", { selector: "strong" })).toBeInTheDocument();
    expect(container.querySelector("code")).toHaveTextContent(
      "@src/__tests__/inline.ts"
    );
  });

  it("anchors repeated references after escaped text to their own source ranges", () => {
    const reply = "a\\_b ~abc1234 and ~abc1234";
    const firstStart = reply.indexOf("~abc1234");
    const secondStart = reply.lastIndexOf("~abc1234");
    const { container } = render(
      <MarkdownText
        contextReferences
        highlightQuery="abc1234"
        highlightActiveIndex={1}
        findDecorations={{
          matches: [
            { start: firstStart + 1, end: firstStart + 8, active: false },
            { start: secondStart + 1, end: secondStart + 8, active: true },
          ],
        }}
      >
        {reply}
      </MarkdownText>
    );

    const refs = links(container);
    expect(refs).toHaveLength(2);
    const active = container.querySelector('mark[data-find-active="true"]');
    expect(active?.closest('[role="link"]')).toBe(refs[1]);
  });

  it("opens cited references like the prompt editor does", () => {
    postMessage().mockClear();
    const { container } = render(
      <MarkdownText contextReferences>
        Fixed #selection:src/a.ts:3-5, broken by ~abc1234
      </MarkdownText>
    );
    const [selection, commit] = links(container);

    fireEvent.click(selection);
    expect(postMessage()).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.OPEN_FILE,
      path: "src/a.ts",
      lineStart: 3,
      lineEnd: 5,
    });
    fireEvent.click(commit);
    expect(postMessage()).toHaveBeenCalledWith({
      type: MESSAGE_TYPES.OPEN_GIT_CHANGE,
      ref: "abc1234",
    });
  });

  it("renders cited references as chips with canonical copy text when atomic formatting is on", () => {
    const { container } = render(
      <MarkdownText contextReferences atomicContextReferences>
        {"Intro paragraph.\n\nI modified @src/ui/foo.ts after ~abc1234def"}
      </MarkdownText>
    );
    const chips = container.querySelectorAll(".atomic-reference-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent("foo.ts");
    expect(chips[0]).toHaveAttribute(
      "data-atomic-reference-copy-text",
      "@src/ui/foo.ts"
    );
    expect(chips[1]).toHaveTextContent("abc1234");
    expect(chips[1]).toHaveAttribute(
      "data-atomic-reference-copy-text",
      "~abc1234def"
    );
  });

  it("keeps linking bare file paths exactly as before", async () => {
    const plain = render(
      <MarkdownText contextReferences>See src/utils/foo.ts now</MarkdownText>
    );
    expect(
      await plain.findByRole("button", { name: "Open file" })
    ).toBeInTheDocument();
    plain.unmount();

    const chip = render(
      <MarkdownText contextReferences atomicContextReferences>
        {"Intro.\n\nSee src/ui/webview-react/utils/foo.ts now"}
      </MarkdownText>
    );
    const button = await chip.findByRole("button", { name: /open src/i });
    expect(button).toHaveClass("atomic-reference-chip");
    // The second block's chip copies its own path, not text sliced from the
    // first block with block-relative offsets.
    expect(button).toHaveAttribute(
      "data-atomic-reference-copy-text",
      "src/ui/webview-react/utils/foo.ts"
    );
  });

  it("leaves code, links, image refs and secret grants alone", async () => {
    const { container } = render(
      <MarkdownText contextReferences>
        {
          "`@src/a.ts` [~abc1234](https://example.com) !API_KEY @docs/shot.png\n\n```\n@src/b.ts\n```"
        }
      </MarkdownText>
    );
    expect(links(container)).toHaveLength(0);
    // The image ref keeps its thumbnail path (falling back to a file button).
    expect(
      await screen.findByRole("button", { name: "Open file" })
    ).toHaveTextContent("docs/shot.png");
  });

  it("does not parse ctrlyoke syntax unless the caller opts in", () => {
    const { container } = render(
      <MarkdownText>Fixed by ~abc1234 and #selection:src/a.ts:3-5</MarkdownText>
    );
    expect(links(container)).toHaveLength(0);
  });

  it("keeps a single-tilde commit ref from striking through the reply", () => {
    const { container } = render(
      <MarkdownText contextReferences>
        See ~abc1234 (the regression)~ and later, while ~~this~~ is struck.
      </MarkdownText>
    );
    expect(links(container).map((link) => link.textContent)).toEqual([
      "~abc1234",
    ]);
    const struck = container.querySelectorAll("del");
    expect(struck).toHaveLength(1);
    expect(struck[0]).toHaveTextContent("this");
  });

  it("keeps GitHub single-tilde strikethrough for Markdown that does not opt in", () => {
    const { container } = render(
      <MarkdownText>See ~abc1234 (the regression)~ and later</MarkdownText>
    );
    expect(container.querySelector("del")).toHaveTextContent("abc1234");
  });

  it("keeps the active find match aligned past matches inside a reference", () => {
    const reply = "Edited @src/foo.ts then foo again";
    const refStart = reply.indexOf("foo.ts");
    const plainStart = reply.lastIndexOf("foo");
    const { container } = render(
      <MarkdownText
        contextReferences
        highlightQuery="foo"
        highlightActiveIndex={1}
        findDecorations={{
          matches: [
            { start: refStart, end: refStart + 3, active: false },
            { start: plainStart, end: plainStart + 3, active: true },
          ],
        }}
      >
        {reply}
      </MarkdownText>
    );
    const active = container.querySelectorAll('mark[data-find-active="true"]');
    expect(active).toHaveLength(1);
    expect(active[0].closest('[role="link"]')).toBeNull();
  });

  it("expands a cited chip to reveal a find match in its hidden path", async () => {
    const reply = "See #selection:src/webview-react/a.ts:3-5";
    const start = reply.indexOf("webview-react");
    render(
      <MarkdownText
        contextReferences
        atomicContextReferences
        highlightQuery="webview-react"
        highlightActiveIndex={0}
        findDecorations={{
          matches: [
            { start, end: start + "webview-react".length, active: true },
          ],
        }}
      >
        {reply}
      </MarkdownText>
    );
    const mark = await screen.findByText("webview-react");
    expect(mark.tagName).toBe("MARK");
    expect(mark).toHaveAttribute("data-find-active", "true");
    expect(mark.closest(".atomic-reference-chip")).not.toBeNull();
  });
});
