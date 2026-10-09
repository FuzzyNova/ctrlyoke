import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  acceptCompletion,
  type CompletionContext,
} from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import type { Extension } from "@codemirror/state";
import { activateHover, EditorView } from "@codemirror/view";
import { diagnosticCount, forEachDiagnostic } from "@codemirror/lint";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFileEditor } from "@components/workspace-viewer/WorkspaceFileEditor";
import { MESSAGE_TYPES } from "@root/types/DashboardConstants";
import { loadWorkflowFileSupport } from "@utils/workflowFileSupport/loadWorkflowFileSupport";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import { useSettingsStore } from "@store/settingsStore";
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
  references?: Array<{ id: string; path?: string }>;
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

function getDiagnostics(view: EditorView) {
  const diagnostics: Array<{
    from: number;
    to: number;
    severity: string;
    message: string;
  }> = [];
  forEachDiagnostic(view.state, (diagnostic, from, to) =>
    diagnostics.push({
      from,
      to,
      severity: diagnostic.severity,
      message: diagnostic.message,
    })
  );
  return diagnostics;
}

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
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        atomicContextReferences: false,
      },
    }));
    postMessage.mockClear();
    useLanguageIntelligenceMock.mockReturnValue({
      filePath: "",
      extensions: [],
      sessionId: null,
      capabilities: {},
      statusHint: null,
    });
  });

  it("chips only live YAML prompt references, leaving comments, names and code as links", async () => {
    const content =
      'name: "@src/name.ts"\n# @src/comment.ts\nsteps:\n  - prompt: |\n      use @src/prompt.ts and `@src/code.ts`\n';
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        atomicContextReferences: true,
      },
    }));

    const { view } = await renderEditor("a.ctrlyoke.yaml", content);

    expect(
      Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-atomic-ref")).map(
        (chip) => chip.getAttribute("data-path")
      )
    ).toEqual(["src/prompt.ts"]);
    expect(
      Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-link")).map(
        (link) => link.getAttribute("data-path")
      )
    ).toEqual(
      expect.arrayContaining(["src/name.ts", "src/comment.ts", "src/code.ts"])
    );
    fireEvent.click(view.dom.querySelector(".cm-atomic-ref")!, {
      ctrlKey: true,
      clientX: 1,
      clientY: 1,
    });
    expect(useWorkspaceViewerStore.getState().pendingNavigation).toMatchObject({
      type: "file",
      filePath: "src/prompt.ts",
    });
  });

  it("keeps an escaped reference in a quoted YAML prompt as a link", async () => {
    const content = 'steps:\n  - prompt: "line\\n @src/escaped.ts"\n';
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        atomicContextReferences: true,
      },
    }));

    const { view } = await renderEditor("a.ctrlyoke.yaml", content);

    expect(view.dom.querySelector(".cm-atomic-ref")).toBeNull();
    expect(view.dom.querySelector<HTMLElement>(".cm-link")?.dataset.path).toBe(
      "src/escaped.ts"
    );
  });

  it("chips a .prompt.md body reference but not a frontmatter reference", async () => {
    const content = '---\nname: "@src/frontmatter.ts"\n---\nUse @src/body.ts\n';
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        atomicContextReferences: true,
      },
    }));

    const { view } = await renderEditor("notes.prompt.md", content);

    expect(
      Array.from(view.dom.querySelectorAll<HTMLElement>(".cm-atomic-ref")).map(
        (chip) => chip.getAttribute("data-path")
      )
    ).toEqual(["src/body.ts"]);
    expect(
      view.dom.querySelector<HTMLElement>(
        '.cm-link[data-path="src/frontmatter.ts"]'
      )
    ).not.toBeNull();
  });

  it("does not chip JSON references", async () => {
    const content = '{"prompt":"Use @src/file.ts"}';
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        atomicContextReferences: true,
      },
    }));

    const { view } = await renderEditor("a.ctrlyoke.json", content);

    expect(view.dom.querySelector(".cm-atomic-ref")).toBeNull();
    expect(
      view.dom.querySelector('.cm-link[data-path="src/file.ts"]')
    ).not.toBeNull();
  });

  it("toggles chips live without recreating the view or changing saved text", async () => {
    const content = "steps:\n  - prompt: |\n      Use @src/file.ts\n";
    const onChange = vi.fn();
    const { container } = render(
      <WorkspaceFileEditor
        filePath="a.ctrlyoke.yaml"
        content={content}
        onChange={onChange}
        onSave={vi.fn()}
      />
    );
    const editorDom = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(".cm-editor");
      expect(element).not.toBeNull();
      return element!;
    });
    const view = EditorView.findFromDOM(editorDom)!;
    await loadWorkflowFileSupport();

    act(() => {
      useSettingsStore.setState((state) => ({
        globalSettings: {
          ...state.globalSettings,
          atomicContextReferences: true,
        },
      }));
    });
    await waitFor(() =>
      expect(view.dom.querySelector(".cm-atomic-ref")?.textContent).toContain(
        "file.ts"
      )
    );

    act(() => {
      useSettingsStore.setState((state) => ({
        globalSettings: {
          ...state.globalSettings,
          atomicContextReferences: false,
        },
      }));
    });
    await waitFor(() =>
      expect(view.dom.querySelector(".cm-atomic-ref")).toBeNull()
    );
    expect(EditorView.findFromDOM(editorDom)).toBe(view);
    expect(view.state.doc.toString()).toBe(content);
    expect(onChange).not.toHaveBeenCalled();
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

  it.each([
    {
      filePath: "a.ctrlyoke.yaml",
      content: "steps:\n  - prompt: 42\n",
    },
    {
      filePath: "a.ctrlyoke.json",
      content: '{"steps":[{"prompt":42}]}',
    },
  ])(
    "shows a schema diagnostic on the invalid value in $filePath",
    async ({ filePath, content }) => {
      const { view } = await renderEditor(filePath, content);
      await waitFor(() => {
        const request = latestPostedMessage<RequestMessage>(
          postMessage,
          (message) => message.type === MESSAGE_TYPES.VALIDATE_WORKFLOW_DOCUMENT
        );
        expect(request.text).toBe(content);
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: MESSAGE_TYPES.WORKFLOW_DOCUMENT_DIAGNOSTICS,
              seq: request.seq,
              issues: [
                {
                  path: "/steps/0/prompt",
                  message: "must be string",
                  severity: "error",
                },
              ],
            },
          })
        );
        expect(diagnosticCount(view.state)).toBe(1);
        expect(view.dom.querySelector(".cm-lintRange-error")?.textContent).toBe(
          "42"
        );
      });
    }
  );

  it("drops diagnostics returned for a stale validation sequence", async () => {
    const { view } = await renderEditor(
      "a.ctrlyoke.yaml",
      "steps:\n  - prompt: 42\n"
    );
    await waitFor(() =>
      expect(
        postMessage.mock.calls.some(
          ([message]) =>
            message.type === MESSAGE_TYPES.VALIDATE_WORKFLOW_DOCUMENT
        )
      ).toBe(true)
    );
    const oldRequest = latestPostedMessage<RequestMessage>(
      postMessage,
      (message) => message.type === MESSAGE_TYPES.VALIDATE_WORKFLOW_DOCUMENT
    );
    typeAtEnd(view, " ");
    await waitFor(() => {
      const current = latestPostedMessage<RequestMessage>(
        postMessage,
        (message) => message.type === MESSAGE_TYPES.VALIDATE_WORKFLOW_DOCUMENT
      );
      expect(current.seq).not.toBe(oldRequest.seq);
    });
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.WORKFLOW_DOCUMENT_DIAGNOSTICS,
          seq: oldRequest.seq,
          issues: [
            { path: "/steps/0/prompt", message: "stale", severity: "error" },
          ],
        },
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(diagnosticCount(view.state)).toBe(0);
  });

  it("does not validate plain YAML files", async () => {
    const { view } = await renderEditor(
      "config/plain.yaml",
      "steps:\n  - prompt: 42\n"
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      postMessage.mock.calls.some(
        ([message]) => message.type === MESSAGE_TYPES.VALIDATE_WORKFLOW_DOCUMENT
      )
    ).toBe(false);
    expect(diagnosticCount(view.state)).toBe(0);
  });

  it("maps a YAML block prompt diagnostic to the exact source token", async () => {
    const content = "steps:\n  - prompt: |\n      $step:9\n";
    const { view } = await renderEditor("a.ctrlyoke.yaml", content);
    const tokenStart = content.indexOf("$step:9");

    await waitFor(() => {
      expect(
        getDiagnostics(view).some(
          (diagnostic) =>
            diagnostic.message.includes("step 9 does not exist") &&
            diagnostic.from === tokenStart &&
            diagnostic.to === tokenStart + "$step:9".length
        )
      ).toBe(true);
    });
  });

  it("only allows end-condition output references in retryPrompt", async () => {
    const content =
      "steps:\n  - prompt: |\n      $endCondition:exitCode\n    endCondition:\n      script: echo ok\n      retryPrompt: |\n        $endCondition:exitCode\n";
    const { view } = await renderEditor("a.ctrlyoke.yaml", content);

    await waitFor(() => {
      const diagnostics = getDiagnostics(view).filter((diagnostic) =>
        diagnostic.message.includes("only available in the retry prompt")
      );
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0].from).toBe(content.indexOf("$endCondition"));
    });
  });

  it("resolves missing references and warns when an existing file is in code", async () => {
    const content =
      "steps:\n  - prompt: |\n      @missing.ts and `@existing.ts`\n";
    const { view } = await renderEditor("a.ctrlyoke.yaml", content);

    await waitFor(() => {
      const request = latestPostedMessage<RequestMessage>(
        postMessage,
        (message) => message.type === MESSAGE_TYPES.VALIDATE_CONTEXT_REFS
      );
      expect(request.references).toHaveLength(2);
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: MESSAGE_TYPES.CONTEXT_REFS_VALIDATION,
            seq: request.seq,
            results: request.references?.map((reference) => ({
              id: reference.id,
              exists: reference.path === "existing.ts",
              message: "context file not found",
            })),
          },
        })
      );
    });

    await waitFor(() => {
      expect(getDiagnostics(view).map(({ message }) => message)).toEqual(
        expect.arrayContaining([
          "context file not found",
          "Context expansion suppressed — this reference won't be expanded inside code",
        ])
      );
    });
  });

  it("ignores prompt-like text in a name and YAML comment", async () => {
    const content =
      'name: "$step:9"\n# $step:9\nsteps:\n  - prompt: ordinary text\n';
    const { view } = await renderEditor("a.ctrlyoke.yaml", content);

    await new Promise((resolve) => setTimeout(resolve, 450));
    expect(
      getDiagnostics(view).some((diagnostic) =>
        diagnostic.message.includes("step 9 does not exist")
      )
    ).toBe(false);
  });

  it("maps diagnostics across escaped JSON prompt characters", async () => {
    const content = '{"prompt":"$step:\\u0039"}';
    const { view } = await renderEditor("a.ctrlyoke.json", content);
    const sourceStart = content.indexOf("$step:");

    await waitFor(() => {
      const diagnostic = getDiagnostics(view).find((entry) =>
        entry.message.includes("step 9 does not exist")
      );
      expect(diagnostic).toMatchObject({
        from: sourceStart,
        to: content.length - 2,
      });
    });
  });

  it.each([
    {
      filePath: "a.ctrlyoke.yaml",
      content: "harness: copilot-cli\nsteps:\n  - prompt: hi\n",
      key: "harness",
      expectedDescription: "Harness to use for this prompt.",
    },
    {
      filePath: "a.ctrlyoke.yaml",
      content: "steps:\n  - prompt: hi\n    model: default\n",
      key: "model",
      expectedDescription: "AI model to use for this prompt.",
    },
  ])(
    "shows the schema description when hovering $key",
    async ({ filePath, content, key, expectedDescription }) => {
      const { view } = await renderEditor(filePath, content);
      const offset = content.indexOf(key) + 1;
      activateHover(view, offset, 1);

      await waitFor(
        () => {
          const tooltip = document.body.querySelector(
            ".cm-tooltip-workflow-outline"
          );
          expect(tooltip?.textContent).toContain(expectedDescription);
        },
        { timeout: 1000 }
      );
    }
  );
});
