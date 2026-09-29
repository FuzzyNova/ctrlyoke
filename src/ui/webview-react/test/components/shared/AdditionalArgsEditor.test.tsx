import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AdditionalArgsEditor } from "@components/shared/AdditionalArgsEditor";
import { HARNESS_IDS, MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { answerLatestRequestUntil } from "../../fixtures/completionRequests";

function renderEditor(
  props: Partial<ComponentProps<typeof AdditionalArgsEditor>> = {}
) {
  const result = render(
    <AdditionalArgsEditor
      id="additional-args-editor"
      value=""
      onChange={vi.fn()}
      harnessId={HARNESS_IDS.COPILOT_CLI}
      {...props}
    />
  );
  const content = result.container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("CodeMirror content element was not rendered");
  return { ...result, content };
}

interface FlagCompletionsRequest {
  type: string;
  text: string;
  seq: number;
}

describe("AdditionalArgsEditor", () => {
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

  it("requests completions with the harness id and cursor position", async () => {
    const user = userEvent.setup();
    const { content } = renderEditor({
      harnessId: HARNESS_IDS.CLAUDE_CLI,
    });

    await user.click(content);
    await user.type(content, "--r");

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_REQUEST,
        harnessId: HARNESS_IDS.CLAUDE_CLI,
        text: "--r",
        position: 3,
        seq: expect.any(Number),
      });
    });
  });

  it("renders flag completions from a matching response", async () => {
    const user = userEvent.setup();
    const { content } = renderEditor();

    await user.click(content);
    await user.type(content, "--r");

    await answerLatestRequestUntil<FlagCompletionsRequest>({
      postMessage,
      isRequest: (message) =>
        message.type === MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_REQUEST &&
        message.text === "--r",
      respond: (request) => ({
        type: MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_RESPONSE,
        items: [
          {
            flag: "--reasoning-effort",
            detail: "Reasoning effort to use",
          },
        ],
        from: 0,
        seq: request.seq,
      }),
      until: () => {
        expect(screen.getByText("--reasoning-effort")).toBeInTheDocument();
      },
    });
  });

  it("uses the new harness after a harness id change", async () => {
    const user = userEvent.setup();
    const rendered = renderEditor({
      harnessId: HARNESS_IDS.COPILOT_CLI,
    });

    await user.click(rendered.content);
    await user.type(rendered.content, "--r");
    await waitFor(() => {
      expect(
        postMessage.mock.calls.some(
          ([message]) =>
            message.type === MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_REQUEST &&
            message.harnessId === HARNESS_IDS.COPILOT_CLI
        )
      ).toBe(true);
    });

    postMessage.mockClear();
    rendered.rerender(
      <AdditionalArgsEditor
        id="additional-args-editor"
        value=""
        onChange={vi.fn()}
        harnessId={HARNESS_IDS.CLAUDE_CLI}
      />
    );
    const nextContent =
      rendered.container.querySelector<HTMLElement>(".cm-content");
    if (!nextContent)
      throw new Error("Remounted CodeMirror editor was not rendered");

    await user.click(nextContent);
    await user.type(nextContent, "--c");

    await waitFor(() => {
      expect(
        postMessage.mock.calls.some(
          ([message]) =>
            message.type === MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_REQUEST &&
            message.harnessId === HARNESS_IDS.CLAUDE_CLI &&
            message.text === "--c"
        )
      ).toBe(true);
    });
  });

  it("offers value hints after a flag token", async () => {
    const user = userEvent.setup();
    const flag = "--reasoning-effort";
    const { content } = renderEditor();

    // Paste the flag and type only the separating space: one keystroke is
    // enough to activate completion, and typing the whole flag cost nineteen
    // keystroke round-trips that under full `npm test` load could outlast the
    // test timeout on their own.
    await user.click(content);
    fireEvent.paste(content, { clipboardData: { getData: () => flag } });
    await user.type(content, " ", { skipClick: true });

    await answerLatestRequestUntil<FlagCompletionsRequest>({
      postMessage,
      isRequest: (message) =>
        message.type === MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_REQUEST &&
        message.text === `${flag} `,
      respond: (request) => ({
        type: MESSAGE_TYPES.HARNESS_FLAG_COMPLETIONS_RESPONSE,
        items: [{ flag, valueHints: ["low", "medium", "high"] }],
        from: `${flag} `.length,
        seq: request.seq,
      }),
      until: () => {
        expect(screen.getByText("high")).toBeInTheDocument();
      },
    });
  });
});
