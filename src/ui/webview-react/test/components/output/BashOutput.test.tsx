import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BashOutput } from "@components/output/BashOutput";
import { OPERATION_STATUS } from "@/types/cliEvents";

describe("BashOutput", () => {
  it("renders the command text", () => {
    render(<BashOutput command="npm test" />);
    expect(screen.getByText("npm test")).toBeInTheDocument();
  });

  it("truncates a long single-line command and expands it on demand", async () => {
    const user = userEvent.setup();
    const longCommand = `node -e "${"x".repeat(220)}"`;
    const { container } = render(<BashOutput command={longCommand} />);

    expect(screen.getByTitle("Show full command")).toBeInTheDocument();
    expect(screen.queryByText("Show full command")).not.toBeInTheDocument();
    expect(container.textContent).toContain("...");
    expect(container.textContent).not.toContain("x".repeat(200));

    await user.click(screen.getByTitle("Show full command"));

    expect(screen.getByTitle("Hide full command")).toBeInTheDocument();
    expect(container.textContent).not.toContain(`${"x".repeat(160)}...`);
    expect(container.textContent).toContain(longCommand);
  });

  it("shows the full-command label when the caller enables it", async () => {
    const user = userEvent.setup();
    const longCommand = `node -e "${"x".repeat(220)}"`;
    render(<BashOutput command={longCommand} showLabel />);

    expect(screen.getByText("Show full command")).toHaveClass(
      "uppercase",
      "text-[length:var(--fp-output-font-size-xs)]"
    );

    await user.click(screen.getByTitle("Show full command"));

    expect(screen.getByText("Hide full command")).toBeInTheDocument();
  });

  it("renders output when status is completed", () => {
    render(
      <BashOutput
        command="ls"
        output="file.ts\nfile2.ts"
        status={OPERATION_STATUS.COMPLETED}
      />
    );
    expect(screen.getByText(/file\.ts/)).toBeInTheDocument();
  });

  it("renders error when status is failed", () => {
    render(
      <BashOutput
        command="bad"
        error="command not found"
        status={OPERATION_STATUS.FAILED}
      />
    );
    expect(screen.getByText(/command not found/)).toBeInTheDocument();
  });

  it("deduplicates identical output and error by keeping the error rendering", () => {
    render(
      <BashOutput
        command="bad"
        output="Exception during run: Error: Cannot find module 'vscode'"
        error="Exception during run: Error: Cannot find module 'vscode'"
        exitCode={1}
        status={OPERATION_STATUS.FAILED}
      />
    );

    const matches = screen.getAllByText(
      /Exception during run: Error: Cannot find module 'vscode'/
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].closest(".text-error-fg")).not.toBeNull();
  });

  it("does not render output/error while command is running", () => {
    render(
      <BashOutput
        command="sleep 10"
        output="some output"
        status={OPERATION_STATUS.INITIATED}
      />
    );
    expect(screen.queryByText("some output")).not.toBeInTheDocument();
  });

  it("shows running status badge when initiated", () => {
    render(
      <BashOutput command="sleep 10" status={OPERATION_STATUS.INITIATED} />
    );
    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("shows exit code badge on success (exit 0)", () => {
    render(
      <BashOutput
        command="ls"
        exitCode={0}
        status={OPERATION_STATUS.COMPLETED}
      />
    );
    expect(screen.getByText(/exit: 0/)).toBeInTheDocument();
  });

  it("shows exit code badge on failure", () => {
    render(
      <BashOutput command="bad" exitCode={1} status={OPERATION_STATUS.FAILED} />
    );
    expect(screen.getByText(/exit: 1/)).toBeInTheDocument();
  });

  it("truncates long output and shows 'show more' link", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    render(
      <BashOutput
        command="cat"
        output={lines}
        status={OPERATION_STATUS.COMPLETED}
        maxLines={10}
      />
    );
    expect(screen.getByText(/show .* more line/i)).toBeInTheDocument();
  });

  it("uses the supplied collapsed result line count", () => {
    const lines = Array.from({ length: 8 }, (_, i) => `line ${i + 1}`).join(
      "\n"
    );
    render(
      <BashOutput
        command="cat"
        output={lines}
        status={OPERATION_STATUS.COMPLETED}
        maxLines={4}
      />
    );

    expect(screen.getByText("[show 4 more lines]")).toBeInTheDocument();
    expect(screen.queryByText("line 5")).not.toBeInTheDocument();
  });

  it("truncates long single-line output by character count", () => {
    const longLine = "x".repeat(1600);
    const { container } = render(
      <BashOutput
        command="cat"
        output={longLine}
        status={OPERATION_STATUS.COMPLETED}
        maxCharacters={1200}
      />
    );

    expect(screen.getByText("[show more output]")).toBeInTheDocument();
    expect(container.textContent).not.toContain("x".repeat(1300));
  });

  it("expands output when 'show more' link clicked", async () => {
    const user = userEvent.setup();
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    render(
      <BashOutput
        command="cat"
        output={lines}
        status={OPERATION_STATUS.COMPLETED}
        maxLines={10}
      />
    );
    await user.click(screen.getByText(/show .* more line/i));
    expect(screen.getByText(/show less/i)).toBeInTheDocument();
    expect(screen.getByText(/line 19/)).toBeInTheDocument();
  });

  it("collapses output when 'show less' clicked", async () => {
    const user = userEvent.setup();
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    render(
      <BashOutput
        command="cat"
        output={lines}
        status={OPERATION_STATUS.COMPLETED}
        maxLines={10}
      />
    );
    await user.click(screen.getByText(/show .* more line/i));
    await user.click(screen.getByText(/show less/i));
    expect(screen.getByText(/show .* more line/i)).toBeInTheDocument();
  });

  it("does not show expand link when output fits in maxLines", () => {
    render(
      <BashOutput
        command="ls"
        output="line 1\nline 2"
        status={OPERATION_STATUS.COMPLETED}
        maxLines={10}
      />
    );
    expect(screen.queryByText(/show .* more line/i)).not.toBeInTheDocument();
  });

  it("renders without status prop (treats as completed)", () => {
    render(<BashOutput command="ls" output="result" />);
    expect(screen.getByText("result")).toBeInTheDocument();
  });

  it("applies custom className to container", () => {
    const { container } = render(
      <BashOutput command="ls" className="my-class" />
    );
    expect(container.firstChild).toHaveClass("my-class");
  });

  it("highlights find matches in output and error", () => {
    const { container } = render(
      <BashOutput
        command="ls"
        output="alpha beta"
        error="alpha gamma"
        status={OPERATION_STATUS.FAILED}
        outputFindMatches={[{ start: 0, end: 5, active: false }]}
        errorFindMatches={[{ start: 0, end: 5, active: true }]}
      />
    );

    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0]).not.toHaveAttribute("data-find-active");
    expect(marks[0].textContent).toBe("alpha");
    expect(marks[1]).toHaveAttribute("data-find-active", "true");
    expect(marks[1].textContent).toBe("alpha");
  });

  it("does not render a mark for a find match hidden behind 'show more'", () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const hiddenMatchStart = lines.indexOf("line 19");
    const { container } = render(
      <BashOutput
        command="cat"
        output={lines}
        status={OPERATION_STATUS.COMPLETED}
        maxLines={10}
        outputFindMatches={[
          {
            start: hiddenMatchStart,
            end: hiddenMatchStart + "line 19".length,
            active: true,
          },
        ]}
      />
    );

    expect(container.querySelector("mark")).toBeNull();
    expect(screen.getByText(/show .* more line/i)).toBeInTheDocument();
  });

  it("strips ANSI and control characters from command output", () => {
    const { container } = render(
      <BashOutput
        command={"npm test\u0007"}
        output={"\u001b[1mRUN\u001b[22m\r\nok\u0007"}
        status={OPERATION_STATUS.COMPLETED}
      />
    );

    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(container.textContent).toContain("RUN");
    expect(container.textContent).toContain("ok");
    expect(container.textContent).not.toContain("\u001b");
    expect(container.textContent).not.toContain("\u0007");
    expect(container.textContent).not.toContain("\r");
  });
});
