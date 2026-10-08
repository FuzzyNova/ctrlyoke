import { render, screen, waitFor } from "@testing-library/react";
import {
  acceptCompletion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFileEditor } from "@components/workspace-viewer/WorkspaceFileEditor";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { loadWorkflowFileSupport } from "@utils/workflowFileSupport/loadWorkflowFileSupport";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import {
  answerLatestRequestUntil,
  latestPostedMessage,
} from "../../fixtures/completionRequests";

const { useLanguageIntelligenceMock } = vi.hoisted(() => ({
  useLanguageIntelligenceMock: vi.fn(() => ({
    filePath: "",
    extensions: [] as Extension[],
    sessionId: null as string | null,
    capabilities: {},
    statusHint: null as string | null,
  })),
}));

vi.mock("@hooks/useLanguageIntelligence", () => ({
  useLanguageIntelligence: useLanguageIntelligenceMock,
}));

interface RequestMessage {
  type: string;
  seq: number;
  trigger?: string;
  text?: string;
  position?: number;
}

const postMessage = vi.mocked(window.vscodeApi!.postMessage);

/** Renders the editor on `filePath` and waits for the lazy ctrlyoke chunk. */
async function renderEditor(filePath: string, content: string) {
  const result = render(
    <WorkspaceFileEditor
      filePath={filePath}
      content={content}
      onChange={vi.fn()}
      onSave={vi.fn()}
    />
  );
  const dom = await waitFor(() => {
    const el = result.container.querySelector<HTMLElement>(".cm-editor");
    expect(el).not.toBeNull();
    return el!;
  });
  const view = EditorView.findFromDOM(dom)!;
  // The chunk loads asynchronously; give it a tick before typing.
  await new Promise((resolve) => setTimeout(resolve, 50));
  return { ...result, view };
}

/** Appends `text` at the end of the document as typed input. */
function typeAtEnd(view: EditorView, text: string) {
  const end = view.state.doc.length;
  view.dispatch({
    changes: { from: end, insert: text },
    selection: { anchor: end + text.length },
    userEvent: "input.type",
  });
}

const optionLabels = () =>
  Array.from(document.body.querySelectorAll(".cm-completionLabel")).map(
    (el) => el.textContent
  );

describe("WorkspaceFileEditor ctrlyoke file support", () => {
  beforeAll(async () => {
    // Pay the dynamic import's cost once, before any case races it.
    await loadWorkflowFileSupport();
    if (!Range.prototype.getClientRects) {
      Object.defineProperty(Range.prototype, "getClientRects", {
        configurable: true,
        value: () => [],
      });
    }
  });

  beforeEach(() => {
    useWorkspaceViewerStore.getState().reset();
    postMessage.mockClear();
    useLanguageIntelligenceMock.mockReturnValue({
      filePath: "",
      extensions: [],
      sessionId: null,
      capabilities: {},
      statusHint: null,
    });
  });

  it("offers harness ids for a YAML value", async () => {
    const { view } = await renderEditor(
      ".ctrlyoke/workflows/a.ctrlyoke.yaml",
      "steps:\n  - prompt: hi\n    harness: "
    );

    typeAtEnd(view, "co");

    await waitFor(() => expect(optionLabels()).toContain("copilot-cli"));
  });

  it("offers schema keys in a JSON workflow, quotes included", async () => {
    const { view } = await renderEditor(
      "flows/a.ctrlyoke.json",
      '{ "steps": [ { "prompt": "hi", "har'
    );

    typeAtEnd(view, "");
    typeAtEnd(view, "n");

    await waitFor(() => expect(optionLabels()).toContain("harness"));
  });

  it("combines with a language server's completion in one dropdown", async () => {
    // CodeMirror tracks a source by identity, so it must be created once.
    const serverSource = (context: CompletionContext) => ({
      from: context.pos - 1,
      options: [{ label: "from-language-server" }],
      filter: false,
    });
    useLanguageIntelligenceMock.mockReturnValue({
      filePath: "",
      extensions: [
        EditorState.languageData.of(() => [{ autocomplete: serverSource }]),
      ],
      sessionId: null,
      capabilities: {},
      statusHint: null,
    });
    const { view } = await renderEditor(
      "a.ctrlyoke.yaml",
      "steps:\n  - prompt: hi\n    harness: "
    );

    typeAtEnd(view, "c");

    await waitFor(() => {
      expect(optionLabels()).toContain("from-language-server");
      expect(optionLabels()).toContain("copilot-cli");
    });
  });

  it("requests prompt-token completions only inside prompt text", async () => {
    const { view } = await renderEditor(
      "a.ctrlyoke.yaml",
      "name: see\nsteps:\n  - prompt: |\n      read "
    );

    typeAtEnd(view, "@sr");

    await answerLatestRequestUntil<RequestMessage>({
      postMessage,
      isRequest: (message) =>
        message.type === MESSAGE_TYPES.REQUEST_COMPLETIONS &&
        message.trigger === "@",
      respond: (request) => ({
        type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
        items: [{ label: "src/app.ts", insertText: "src/app.ts" }],
        from: view.state.doc.length - 3,
        seq: request.seq,
      }),
      until: () => expect(optionLabels()).toContain("src/app.ts"),
    });
  });

  it("does not request prompt tokens outside prompt text", async () => {
    const { view } = await renderEditor("a.ctrlyoke.yaml", "name: see ");

    typeAtEnd(view, "@sr");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(
      postMessage.mock.calls.some(
        ([message]) => message.type === MESSAGE_TYPES.REQUEST_COMPLETIONS
      )
    ).toBe(false);
  });

  it.each([
    {
      name: "a JSON prompt string",
      filePath: "a.ctrlyoke.json",
      content: '{ "prompt": "read ',
      inserted: `"docs/it's notes.md"`,
      expected: `@\\"docs/it's notes.md\\"`,
    },
    {
      name: "a YAML double-quoted prompt",
      filePath: "a.ctrlyoke.yaml",
      content: 'steps:\n  - prompt: "read ',
      inserted: `"docs/it's notes.md"`,
      expected: `@\\"docs/it's notes.md\\"`,
    },
    {
      name: "a YAML single-quoted prompt",
      filePath: "a.ctrlyoke.yaml",
      content: "steps:\n  - prompt: 'read ",
      inserted: `"docs/it's notes.md"`,
      expected: `@"docs/it''s notes.md"`,
    },
    {
      name: "a YAML block prompt, unchanged",
      filePath: "a.ctrlyoke.yaml",
      content: "steps:\n  - prompt: |\n      read ",
      inserted: `"docs/it's notes.md"`,
      expected: `@"docs/it's notes.md"`,
    },
  ])(
    "escapes a quoted path inserted into $name",
    async ({ filePath, content, inserted, expected }) => {
      const { view } = await renderEditor(filePath, content);

      typeAtEnd(view, "@my");

      await answerLatestRequestUntil<RequestMessage>({
        postMessage,
        isRequest: (message) =>
          message.type === MESSAGE_TYPES.REQUEST_COMPLETIONS &&
          message.trigger === "@",
        respond: (request) => ({
          type: MESSAGE_TYPES.COMPLETIONS_RESPONSE,
          items: [{ label: "my notes.md", insertText: inserted, kind: 16 }],
          from: view.state.doc.length - 3,
          seq: request.seq,
        }),
        until: () => expect(optionLabels()).toContain("my notes.md"),
      });
      // CodeMirror ignores an accept that lands within its interaction delay.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(acceptCompletion(view)).toBe(true);

      expect(view.state.doc.toString()).toContain(expected);
    }
  );

  it("ignores a trigger that sits before the prompt string on the same line", async () => {
    const { view } = await renderEditor(
      "a.ctrlyoke.json",
      '{"name":"@x","prompt":"a'
    );

    typeAtEnd(view, "b");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(
      postMessage.mock.calls.some(
        ([message]) => message.type === MESSAGE_TYPES.REQUEST_COMPLETIONS
      )
    ).toBe(false);
  });

  it("asks for the MCP registry when an mcpServers value needs it", async () => {
    const { view } = await renderEditor(
      "a.ctrlyoke.yaml",
      "steps:\n  - prompt: hi\n    mcpServers:\n      - "
    );

    typeAtEnd(view, "c");

    await waitFor(() =>
      expect(
        postMessage.mock.calls.some(
          ([message]) =>
            message.type === MESSAGE_TYPES.REQUEST_MCP_REGISTRY_SERVERS
        )
      ).toBe(true)
    );
  });

  it("routes script text to the script completion request", async () => {
    const { view } = await renderEditor(
      "a.ctrlyoke.yaml",
      "steps:\n  - script: npm "
    );

    typeAtEnd(view, "te");

    await waitFor(() => {
      const request = latestPostedMessage<RequestMessage>(
        postMessage,
        (message) => message.type === MESSAGE_TYPES.SCRIPT_COMPLETIONS_REQUEST
      );
      expect(request.text).toBe("npm te");
      expect(request.position).toBe(6);
    });
  });

  it("leaves other files without ctrlyoke completions", async () => {
    const { view } = await renderEditor(
      "config/plain.yaml",
      "steps:\n  - prompt: hi\n    harness: "
    );

    typeAtEnd(view, "co");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(optionLabels()).not.toContain("copilot-cli");
    expect(screen.queryByText("copilot-cli")).toBeNull();
  });
});
