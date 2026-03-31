/**
 * Tests for MarkdownText.
 *
 * Streamdown is a real ESM package — we let it render normally but mock
 * the heavy highlight.js utility to avoid jsdom canvas/worker issues.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// Mock hljsUtils to avoid the stylesheet injection side-effect and heavy work
vi.mock("@utils/hljsUtils", () => ({
  highlightCode: (code: string) => code, // return plain text
  injectHljsStyles: vi.fn(),
}));

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

  it("applies the markdown-text class on the container", () => {
    const { container } = render(<MarkdownText>text</MarkdownText>);
    // Streamdown wraps in a div — look for the markdown-text class anywhere
    expect(container.querySelector(".markdown-text")).toBeTruthy();
  });
});
