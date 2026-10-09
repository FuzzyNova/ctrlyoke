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
import { ensureSyntaxTree, forceParsing } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFileEditor } from "@components/workspace-viewer/WorkspaceFileEditor";
import { PROMPT_MARKDOWN_DECORATION_CLASSES } from "@utils/codemirrorLanguage";
import { createCtrlYokeHighlightStyle } from "@utils/syntaxPalette";
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

function highlightedText(view: EditorView) {
  const style = createCtrlYokeHighlightStyle();
  if (!ensureSyntaxTree(view.state, view.state.doc.length, 30_000)) {
    throw new Error("editor syntax tree did not parse in time");
  }
  forceParsing(view);
  const spans = Array.from(
    view.dom.querySelectorAll<HTMLElement>(".cm-content span[class]")
  ).map((element) => ({
    text: element.textContent ?? "",
    classes: element.className,
  }));
  return { spans, style };
}

function syntaxClass(
  style: ReturnType<typeof createCtrlYokeHighlightStyle>,
  role: string
) {
  const tag = {
    heading: tags.heading,
    strong: tags.strong,
    "inline-code": tags.monospace,
    string: tags.string,
    number: tags.number,
    emphasis: tags.emphasis,
    property: tags.propertyName,
    comment: tags.comment,
  }[
    role as
      | "heading"
      | "strong"
      | "inline-code"
      | "string"
      | "number"
      | "emphasis"
      | "property"
      | "comment"
  ];
  return tag ? style.style([tag]) : null;
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

  it("uses the shared Markdown configuration for prompt files", async () => {
    const { view } = await renderEditor(
      "notes.prompt.md",
      '# Heading\n\n```json\n{"name": "yes", "count": 12}\n```'
    );
    const { spans, style } = highlightedText(view);
    expect(
      spans.some(
        (span) =>
          span.text.includes("Heading") &&
          span.classes.includes(syntaxClass(style, "heading") ?? "\0")
      )
    ).toBe(true);
    expect(
      spans.some(
        (span) =>
          span.text.includes("yes") &&
          span.classes.includes(syntaxClass(style, "string") ?? "\0")
      )
    ).toBe(true);
    expect(
      spans.some(
        (span) =>
          span.text === "12" &&
          span.classes.includes(syntaxClass(style, "number") ?? "\0")
      )
    ).toBe(true);
  });

  it("nests Markdown only inside YAML prompt block scalars", async () => {
    const content = [
      'name: "workflow"',
      "# keep this YAML comment",
      "steps:",
      "  - prompt: |",
      "      ## Main heading",
      "      **strong** and `inline`",
      "      ```json",
      '      {"name": "yes", "count": 12}',
      "      ```",
      "      ```",
      "          # code heading",
      "      ```",
      "  - parallel:",
      "      - prompt: >-",
      "          ### Parallel heading",
      "          *emphasis*",
      '  - prompt: "quoted text"',
      "nameAfter: stillYaml",
      "endCondition:",
      "  retryPrompt: |",
      "    # Retry heading",
    ].join("\n");
    const { view } = await renderEditor("a.ctrlyoke.yaml", content);
    const { spans, style } = highlightedText(view);
    const has = (text: string, className: string) =>
      spans.some(
        (span) =>
          span.text.includes(text) &&
          span.classes.includes(syntaxClass(style, className) ?? "\0")
      );

    expect(has("Main heading", "heading")).toBe(true);
    expect(has("strong", "strong")).toBe(true);
    expect(has("inline", "inline-code")).toBe(true);
    expect(has("yes", "string")).toBe(true);
    expect(has("12", "number")).toBe(true);
    expect(has("code heading", "inline-code")).toBe(true);
    expect(has("code heading", "heading")).toBe(false);
    expect(has("Parallel heading", "heading")).toBe(true);
    expect(has("emphasis", "emphasis")).toBe(true);
    expect(has("Retry heading", "heading")).toBe(true);
    expect(has("name", "property")).toBe(true);
    expect(has("keep this YAML comment", "comment")).toBe(true);
    expect(has("nameAfter", "property")).toBe(true);
    expect(has("quoted text", "string")).toBe(true);
  });

  it("keeps text in an unclosed YAML prompt fence live", async () => {
    const { view } = await renderEditor(
      "open-fence.ctrlyoke.yaml",
      "steps:\n  - prompt: |\n      ```\n      # live heading\n"
    );
    const { spans, style } = highlightedText(view);
    expect(
      view.dom.querySelector(
        `.${PROMPT_MARKDOWN_DECORATION_CLASSES.UNCLOSED_FENCE}`
      )
    ).not.toBeNull();
    expect(
      spans.some(
        (span) =>
          span.text.includes("live heading") &&
          span.classes.includes(syntaxClass(style, "heading") ?? "\0")
      )
    ).toBe(false);
  });

  it("keeps large YAML prompt edits within the editor parse budget", async () => {
    const content = `steps:\n  - prompt: |\n${"      # heading and plain text\n".repeat(3000)}  - prompt: done\n`;
    const { view } = await renderEditor("large.ctrlyoke.yaml", content);
    const startedAt = performance.now();
    view.dispatch({ changes: { from: 0, insert: "# edited\n" } });
    expect(performance.now() - startedAt).toBeLessThan(250);
  });

  it("keeps plain YAML highlighting when read-only rebuilds the view", async () => {
    const content = 'title: "highlighted"\n';
    const result = await renderEditor("plain.yaml", content);
    result.rerender(
      <WorkspaceFileEditor
        filePath="plain.yaml"
        content={content}
        readOnly
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );
    await waitFor(() => {
      const view = EditorView.findFromDOM(
        result.container.querySelector<HTMLElement>(".cm-editor")!
      )!;
      const highlighted = highlightedText(view);
      expect(
        highlighted.spans.some(
          (span) =>
            span.text === "title" &&
            span.classes.includes(
              syntaxClass(highlighted.style, "property") ?? "\0"
            )
        )
      ).toBe(true);
    });
  });

  it("drops plain YAML highlighting when the reused editor opens another file", async () => {
    const yamlContent = 'title: "highlighted"\n';
    const result = await renderEditor("foo.yaml", yamlContent);
    const source = "const value = 1;\n";
    result.rerender(
      <WorkspaceFileEditor
        filePath="bar.ts"
        content={source}
        onChange={vi.fn()}
        onSave={vi.fn()}
      />
    );

    await waitFor(() => {
      const view = EditorView.findFromDOM(
        result.container.querySelector<HTMLElement>(".cm-editor")!
      )!;
      const highlighted = highlightedText(view);
      expect(
        highlighted.spans.some(
          (span) =>
            span.text === "const" &&
            span.classes.includes(
              createCtrlYokeHighlightStyle().style([tags.keyword]) ?? "\0"
            )
        )
      ).toBe(true);
      expect(
        highlighted.spans.some(
          (span) =>
            span.text === "title" &&
            span.classes.includes(
              syntaxClass(highlighted.style, "property") ?? "\0"
            )
        )
      ).toBe(false);
    });
  });

  beforeEach(() => {
    useWorkspaceViewerStore.getState().reset();
    useSettingsStore.setState((state) => ({
      globalSettings: {
        ...state.globalSettings,
        atomicContextReferences: false,
        defaultPreCondition: null,
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

  it("maps syntax diagnostics by their marked source position", async () => {
    const content = "steps:\n  - prompt: [\n";
    const { view } = await renderEditor("a.ctrlyoke.yaml", content);
    const offset = content.indexOf("[");
    const request = await waitFor(() =>
      latestPostedMessage<RequestMessage>(
        postMessage,
        (message) => message.type === MESSAGE_TYPES.VALIDATE_WORKFLOW_DOCUMENT
      )
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        data: {
          type: MESSAGE_TYPES.WORKFLOW_DOCUMENT_DIAGNOSTICS,
          seq: request.seq,
          issues: [
            {
              path: "",
              message: "Unexpected end of stream",
              severity: "error",
              position: {
                line: 2,
                column: offset - content.lastIndexOf("\n", offset - 1),
              },
            },
          ],
        },
      })
    );
    await waitFor(() => {
      const diagnostic = getDiagnostics(view).find((item) =>
        item.message.includes("Unexpected end")
      );
      expect(diagnostic?.from).toBe(offset);
      expect(diagnostic?.to).toBe(offset + 1);
    });
  });

  it("continues receiving diagnostics after the EditorView is rebuilt", async () => {
    const content = "steps:\n  - prompt: 42\n";
    const editor = await renderEditor("a.ctrlyoke.yaml", content);
    const answer = async (afterSequence = -1) => {
      const request = await waitFor(() => {
        const current = latestPostedMessage<RequestMessage>(
          postMessage,
          (message) => message.type === MESSAGE_TYPES.VALIDATE_WORKFLOW_DOCUMENT
        );
        expect(current.seq).toBeGreaterThan(afterSequence);
        return current;
      });
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
    };
    await answer();
    await waitFor(() => expect(diagnosticCount(editor.view.state)).toBe(1));
    const firstRequest = latestPostedMessage<RequestMessage>(
      postMessage,
      (message) => message.type === MESSAGE_TYPES.VALIDATE_WORKFLOW_DOCUMENT
    );
    editor.rerender(
      <WorkspaceFileEditor
        filePath="a.ctrlyoke.yaml"
        content={content}
        onChange={vi.fn()}
        onSave={vi.fn()}
        readOnly
      />
    );
    await answer(firstRequest.seq);
    await waitFor(() => {
      const rebuilt = EditorView.findFromDOM(
        editor.container.querySelector<HTMLElement>(".cm-editor")!
      )!;
      expect(diagnosticCount(rebuilt.state)).toBe(1);
      expect(
        rebuilt.dom.querySelector(".cm-lintRange-error")?.textContent
      ).toBe("42");
    });
  });

  it("continues receiving prompt reference lint replies after rebuilding", async () => {
    const content = "steps:\n  - prompt: @missing.ts\n";
    const editor = await renderEditor("a.ctrlyoke.yaml", content);
    const reply = async (afterSequence = -1) => {
      const request = await waitFor(() => {
        const current = latestPostedMessage<RequestMessage>(
          postMessage,
          (message) => message.type === MESSAGE_TYPES.VALIDATE_CONTEXT_REFS
        );
        expect(current.seq).toBeGreaterThan(afterSequence);
        return current;
      });
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: MESSAGE_TYPES.CONTEXT_REFS_VALIDATION,
            seq: request.seq,
            results: request.references?.map((reference) => ({
              id: reference.id,
              exists: false,
              message: "missing file",
            })),
          },
        })
      );
    };
    await reply();
    await waitFor(() =>
      expect(
        getDiagnostics(editor.view).some(
          (item) => item.message === "missing file"
        )
      ).toBe(true)
    );
    const firstRequest = latestPostedMessage<RequestMessage>(
      postMessage,
      (message) => message.type === MESSAGE_TYPES.VALIDATE_CONTEXT_REFS
    );
    editor.rerender(
      <WorkspaceFileEditor
        filePath="a.ctrlyoke.yaml"
        content={content}
        onChange={vi.fn()}
        onSave={vi.fn()}
        readOnly
      />
    );
    await reply(firstRequest.seq);
    await waitFor(() => {
      const rebuilt = EditorView.findFromDOM(
        editor.container.querySelector<HTMLElement>(".cm-editor")!
      )!;
      expect(
        getDiagnostics(rebuilt).some((item) => item.message === "missing file")
      ).toBe(true);
    });
  });

  it("re-lints pre-condition references when the settings default changes", async () => {
    const { view } = await renderEditor(
      "a.ctrlyoke.yaml",
      "steps:\n  - prompt: $preCondition:stdout\n"
    );
    await waitFor(() => expect(diagnosticCount(view.state)).toBe(1));
    useSettingsStore.getState().updateGlobalSetting("defaultPreCondition", {
      script: "settings-check.sh",
    });
    await waitFor(() => expect(diagnosticCount(view.state)).toBe(0));
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
      expect(request.seq).toBeGreaterThanOrEqual(1_000_000_000);
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
