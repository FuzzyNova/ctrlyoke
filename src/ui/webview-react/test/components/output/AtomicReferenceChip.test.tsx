import { describe, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import { render, screen } from "@testing-library/react";
import { AtomicReferenceChip } from "@components/output/AtomicReferenceChip";
import { findAtomicReferences } from "@utils/atomicReferences";

function renderReference(
  token: string,
  findMatches: Parameters<typeof AtomicReferenceChip>[0]["findMatches"] = []
) {
  const descriptor = findAtomicReferences(token)[0];
  if (!descriptor) throw new Error(`No reference found in ${token}`);
  const labelStart = descriptor.title.lastIndexOf(
    descriptor.label.replace(/:.*$/, "")
  );
  const presentation = {
    sourceText: descriptor.title,
    rowRange: { from: 0, to: descriptor.title.length },
    compactRanges: [
      {
        source: {
          from: Math.max(0, labelStart),
          to: descriptor.title.length,
        },
        label: { from: 0, to: descriptor.label.length },
      },
    ],
    compactLabel: descriptor.label,
    selectionText: descriptor.title,
  };
  const onOpen = vi.fn();
  render(
    <AtomicReferenceChip
      descriptor={descriptor}
      presentation={presentation}
      findMatches={findMatches}
      onOpen={onOpen}
    />
  );
  return { descriptor, onOpen };
}

describe("AtomicReferenceChip", () => {
  it("uses native button semantics for pointer, Enter, and Space activation", async () => {
    const user = userEvent.setup();
    const { onOpen } = renderReference("@src/file.ts");
    const button = screen.getByRole("button");

    await user.click(button);
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["@src/deep/file.ts", "symbol-file", "file.ts", "Open src/deep/file.ts"],
    ["@src/deep/", "folder", "deep/", "Reveal src/deep/"],
    [
      "#selection:src/file.ts:10-20",
      "list-selection",
      "file.ts:10-20",
      "Open src/file.ts:10-20",
    ],
    [
      "#sym:src/file.ts:Thing:10-20",
      "symbol-misc",
      "Thing",
      "Go to Thing in src/file.ts:10-20",
    ],
    [
      "~0123456789abcdef",
      "source-control",
      "0123456",
      "Open git 0123456789abcdef",
    ],
  ])(
    "describes %s with its icon, label, title, and accessible name",
    (token, icon, label, ariaLabel) => {
      const { descriptor } = renderReference(token);
      const button = screen.getByRole("button");
      expect(button.querySelector(`.codicon-${icon}`)).not.toBeNull();
      expect(button).toHaveTextContent(label);
      expect(button).toHaveAttribute("title", descriptor.title);
      expect(button).toHaveAttribute("aria-label", ariaLabel);
    }
  );

  it("renders an embedded symbol kind with its icon accent", () => {
    renderReference("#sym.class:src/file.ts:Thing:10-20");

    const button = screen.getByRole("button");
    expect(button.querySelector(".codicon-symbol-class")).not.toBeNull();
    expect(button.style.getPropertyValue("--atomic-reference-accent")).toBe(
      "var(--vscode-symbolIcon-classForeground, #ee9d28)"
    );
  });

  it("expands and marks a match in a hidden path segment", () => {
    const source = "@ctrlyoke/src/ui/webview-react/utils/codemirrorTheme.ts";
    const hiddenFrom = source.indexOf("webview-react");
    renderReference(source, [
      {
        start: hiddenFrom,
        end: hiddenFrom + "webview-react".length,
        active: true,
      },
    ]);

    const button = screen.getByRole("button");
    expect(button).toHaveTextContent(source);
    expect(button.querySelector("mark")).toHaveTextContent("webview-react");
    expect(button.querySelector("mark")).toHaveAttribute(
      "data-find-active",
      "true"
    );
  });

  it("keeps a basename match compact", () => {
    const source = "@src/deep/codemirrorTheme.ts";
    const basenameFrom = source.lastIndexOf("codemirrorTheme.ts");
    renderReference(source, [
      { start: basenameFrom, end: source.length, active: false },
    ]);

    const button = screen.getByRole("button");
    expect(button).toHaveTextContent("codemirrorTheme.ts");
    expect(button).not.toHaveTextContent("@src/deep/");
    expect(button.querySelector("mark")).toHaveTextContent(
      "codemirrorTheme.ts"
    );
    expect(button.querySelector("mark")).not.toHaveAttribute(
      "data-find-active"
    );
  });

  it("marks inactive matches without giving them the active marker", () => {
    const source = "@src/webview-react/webview-react.ts";
    const first = source.indexOf("webview-react");
    renderReference(source, [
      { start: first, end: first + 12, active: false },
      {
        start: source.lastIndexOf("webview-react"),
        end: source.length - 3,
        active: true,
      },
    ]);

    const marks = screen.getAllByRole("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0]).not.toHaveAttribute("data-find-active");
    expect(marks[1]).toHaveAttribute("data-find-active", "true");
  });

  it("renders a long expanded reference as selectable full text with stable copy metadata", () => {
    const source = `@workspace/${"nested/".repeat(20)}long-file-name.ts`;
    renderReference(source, [
      {
        start: source.indexOf("nested"),
        end: source.indexOf("nested") + 6,
        active: true,
      },
    ]);

    const button = screen.getByRole("button");
    expect(button).toHaveTextContent(source);
    expect(button).toHaveAttribute("data-atomic-reference-copy-text", source);
    expect(button).toHaveAttribute("data-atomic-reference-source-text", source);
    expect(button).toHaveClass("atomic-reference-chip");
  });
});
