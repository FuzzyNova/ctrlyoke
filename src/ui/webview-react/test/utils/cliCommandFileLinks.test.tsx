import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@hooks/useMessageHandler", () => ({
  openFile: vi.fn(),
}));

import { openFile } from "@hooks/useMessageHandler";
import {
  findCliFileReferenceRanges,
  renderCommandTextWithFileLinks,
} from "@utils/cliCommandFileLinks";

describe("findCliFileReferenceRanges", () => {
  it("matches a Codex-style bare-relative temp file reference with escaped backslashes", () => {
    const text =
      "using these attachment excerpts .ctrlyoke\\\\temp\\\\1786938810-plan-4.excerpts.md, follow the instructions";
    const ranges = findCliFileReferenceRanges(text);

    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe(
      ".ctrlyoke\\\\temp\\\\1786938810-plan-4.excerpts.md"
    );
    expect(ranges[0].openPath).toBe(
      ".ctrlyoke\\temp\\1786938810-plan-4.excerpts.md"
    );
  });

  it("matches a Claude-style @-prefixed reference and includes the @ in the range", () => {
    const text =
      "using these file references @dev\\\\implemented\\\\PLAN.md, follow";
    const ranges = findCliFileReferenceRanges(text);

    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0].start, ranges[0].end)).toBe(
      "@dev\\\\implemented\\\\PLAN.md"
    );
    expect(ranges[0].openPath).toBe("dev\\implemented\\PLAN.md");
  });

  it("does not match executables or flag values with no recognized extension", () => {
    const text =
      '"C:\\\\Program Files\\\\nodejs\\\\node.exe" --model gpt-5.6-luna --hash sha256:629293e17749313f213f3a720e5f890469395afcc036382c728af0bc9df3c7a3';
    const ranges = findCliFileReferenceRanges(text);

    expect(ranges).toHaveLength(0);
  });

  it("still matches a plain .js script path (a real, openable file)", () => {
    const text =
      "C:\\\\Users\\\\natha\\\\AppData\\\\Roaming\\\\npm\\\\node_modules\\\\codex\\\\bin\\\\codex.js --enable hooks";
    const ranges = findCliFileReferenceRanges(text);

    expect(ranges).toHaveLength(1);
    expect(ranges[0].openPath).toBe(
      "C:\\Users\\natha\\AppData\\Roaming\\npm\\node_modules\\codex\\bin\\codex.js"
    );
  });

  it("matches POSIX absolute paths without treating URL paths as files", () => {
    const text =
      "@/Users/me/repo/src/foo.ts /home/u/repo/.ctrlyoke/temp/x.md https://x/y.md";
    const ranges = findCliFileReferenceRanges(text);

    expect(ranges.map((range) => text.slice(range.start, range.end))).toEqual([
      "@/Users/me/repo/src/foo.ts",
      "/home/u/repo/.ctrlyoke/temp/x.md",
    ]);
    expect(ranges.map((range) => range.openPath)).toEqual([
      "/Users/me/repo/src/foo.ts",
      "/home/u/repo/.ctrlyoke/temp/x.md",
    ]);
  });

  it("does not link a home-relative path as a root-absolute one", () => {
    expect(findCliFileReferenceRanges("cat ~/notes/plan.md")).toEqual([]);
  });
});

describe("renderCommandTextWithFileLinks", () => {
  it("opens POSIX absolute references unchanged when a working directory is present", () => {
    const text = "@/Users/me/repo/src/foo.ts /home/u/repo/.ctrlyoke/temp/x.md";
    render(
      <div>
        {renderCommandTextWithFileLinks(text, [], "/workspace/project")}
      </div>
    );

    const links = screen.getAllByRole("button");
    links[0].click();
    links[1].click();

    expect(openFile).toHaveBeenCalledWith("/Users/me/repo/src/foo.ts");
    expect(openFile).toHaveBeenCalledWith("/home/u/repo/.ctrlyoke/temp/x.md");
  });

  it("renders a relative reference as a link resolved against the working directory, preserving raw text", () => {
    const text =
      "using these attachment excerpts .ctrlyoke\\\\temp\\\\1786938810-plan-4.excerpts.md, follow";
    render(
      <div>
        {renderCommandTextWithFileLinks(
          text,
          [],
          "C:\\dev\\ctrlyoke.worktrees\\small-feature"
        )}
      </div>
    );

    const link = screen.getByRole("button", {
      name: /\.ctrlyoke\\\\temp\\\\1786938810-plan-4\.excerpts\.md/,
    });
    expect(link.textContent).toBe(
      ".ctrlyoke\\\\temp\\\\1786938810-plan-4.excerpts.md"
    );

    link.click();
    expect(openFile).toHaveBeenCalledWith(
      "C:\\dev\\ctrlyoke.worktrees\\small-feature/.ctrlyoke\\temp\\1786938810-plan-4.excerpts.md"
    );
  });

  it("leaves a relative reference as plain text when there is no working directory", () => {
    const text = ".ctrlyoke\\\\temp\\\\1786938810-plan-4.excerpts.md";
    const { container } = render(
      <div>{renderCommandTextWithFileLinks(text, [], undefined)}</div>
    );

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe(text);
  });

  it("still highlights find matches inside and around a link span", () => {
    const text = "open .ctrlyoke\\\\temp\\\\note.md now";
    const matchStart = text.indexOf("note");
    render(
      <div>
        {renderCommandTextWithFileLinks(
          text,
          [{ start: matchStart, end: matchStart + 4, active: true }],
          "C:\\dev\\ctrlyoke"
        )}
      </div>
    );

    const mark = screen.getByText("note");
    expect(mark.tagName).toBe("MARK");
    expect(mark.closest("button")).not.toBeNull();
  });

  it("falls back to plain highlighted text when there are no file references", () => {
    const text = "no file references here";
    const { container } = render(
      <div>{renderCommandTextWithFileLinks(text, [], "C:\\dev\\ctrlyoke")}</div>
    );

    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe(text);
  });
});
