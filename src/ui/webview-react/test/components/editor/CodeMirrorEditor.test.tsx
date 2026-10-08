import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import type { Completion } from "@codemirror/autocomplete";
import { forEachDiagnostic, forceLinting } from "@codemirror/lint";
import {
  buildCodeMirrorCompletionResult,
  buildPromptReferenceInsertion,
  createAtomicReferenceExtension,
  createClickHandlerExtension,
  createConditionOutputLintExtension,
  createContextReferenceLintExtension,
  createPriorContextLintExtension,
  createSlashTokenDecorationExtension,
  destroyOrphanedMouseSelection,
  findSlashCompletionContext,
  findCustomCompletionContext,
  relintForContextChange,
  keyboardTooltipSpace,
  type CodeMirrorEditorMode,
} from "@components/editor/CodeMirrorEditor";
import { CodeMirrorEditor } from "@components/editor/CodeMirrorEditor";
import { MESSAGE_TYPES, PROMPT_EDITOR_INSERT_MODES } from "@/types/messages";
import {
  CAPTURING_OUTPUT_PLACEHOLDER,
  RETRY_PROMPT_PLACEHOLDERS,
  SCRIPT_OUTPUT_SOURCES,
} from "@root/types/DashboardConstants";
import { USER_FEEDBACK_SEVERITY } from "@root/types/DashboardConstants";
import { EDITOR_PLACEHOLDER_TEXT } from "@root/types/DashboardConstants";

describe("CodeMirrorEditor bulk placeholders", () => {
  it.each([
    EDITOR_PLACEHOLDER_TEXT.BULK_PROMPTS(3),
    EDITOR_PLACEHOLDER_TEXT.BULK_STEPS(3),
    EDITOR_PLACEHOLDER_TEXT.BULK_LOCKED(3),
  ])("reconfigures placeholder without replacing EditorView: %s", (text) => {
    const onChange = vi.fn();
    const { container, rerender } = render(
      <CodeMirrorEditor
        value=""
        onChange={onChange}
        placeholder="first"
        affUri=""
        dicUri=""
      />
    );
    const editor = container.querySelector(".cm-editor");
    expect(editor).not.toBeNull();
    const view = EditorView.findFromDOM(editor as HTMLElement);

    rerender(
      <CodeMirrorEditor
        value=""
        onChange={onChange}
        placeholder={text}
        affUri=""
        dicUri=""
      />
    );

    expect(EditorView.findFromDOM(editor as HTMLElement)).toBe(view);
    expect(container.querySelector(".cm-placeholder")?.textContent).toBe(text);
  });
});

async function getConditionOutputDiagnostics(
  doc: string,
  mode: CodeMirrorEditorMode,
  hasPreCondition: boolean
) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({
    parent,
    doc,
    extensions: [
      createConditionOutputLintExtension(
        { current: hasPreCondition },
        { current: mode }
      ),
    ],
  });

  try {
    forceLinting(view);
    await new Promise((resolve) => setTimeout(resolve, 350));
    const diagnostics: Array<{ message: string }> = [];
    forEachDiagnostic(view.state, (diagnostic) => {
      diagnostics.push({ message: diagnostic.message });
    });
    return diagnostics;
  } finally {
    view.destroy();
    parent.remove();
  }
}

describe("CodeMirrorEditor condition-output references", () => {
  it("offers both condition-output namespaces through the dollar completion source", () => {
    expect(findCustomCompletionContext("$preCondition:", 0)).toEqual({
      trigger: "$",
      query: "preCondition:",
      from: 0,
    });

    const result = buildCodeMirrorCompletionResult(
      [
        {
          label: `${SCRIPT_OUTPUT_SOURCES.PRE_CONDITION}:${RETRY_PROMPT_PLACEHOLDERS.STDOUT}`,
          detail: "Pre-condition script stdout",
        },
        {
          label: `${SCRIPT_OUTPUT_SOURCES.END_CONDITION}:${RETRY_PROMPT_PLACEHOLDERS.STDOUT}`,
          detail: "End-condition script stdout",
        },
      ],
      1,
      { trigger: "$", query: "preCondition:" }
    );

    expect(result.options.map((option) => option.label)).toContain(
      `${SCRIPT_OUTPUT_SOURCES.PRE_CONDITION}:${RETRY_PROMPT_PLACEHOLDERS.STDOUT}`
    );
    expect(result.options.map((option) => option.label)).toContain(
      `${SCRIPT_OUTPUT_SOURCES.END_CONDITION}:${RETRY_PROMPT_PLACEHOLDERS.STDOUT}`
    );
  });

  it("does not offer a placeholder completion after an opening brace", () => {
    expect(findCustomCompletionContext("{", 0)).toBeNull();
  });

  it.each([
    {
      mode: "prompt" as const,
      hasPreCondition: false,
      doc: "$preCondition:stdout",
      message:
        "$preCondition:stdout has no effect — this step has no pre-condition configured",
    },
    {
      mode: "prompt" as const,
      hasPreCondition: true,
      doc: "$endCondition:stderr",
      message:
        "$endCondition:stderr is only available in the retry prompt, not the initial prompt",
    },
  ])(
    "warns for unavailable $ references",
    async ({ mode, hasPreCondition, doc, message }) => {
      await expect(
        getConditionOutputDiagnostics(doc, mode, hasPreCondition)
      ).resolves.toEqual([{ message }]);
    }
  );

  it.each([
    ["prompt", true, "$preCondition:stdout"],
    ["endCondition", true, "$preCondition:stdout"],
    ["endCondition", true, "$endCondition:stdout"],
  ] as const)(
    "does not warn for valid %s references",
    async (mode, hasPreCondition, doc) => {
      await expect(
        getConditionOutputDiagnostics(doc, mode, hasPreCondition)
      ).resolves.toEqual([]);
    }
  );

  it("lints a reference followed by a trailing comma", async () => {
    // The comma used to be swallowed into the field, so the reference was
    // neither chipped nor linted even though a run expanded it.
    await expect(
      getConditionOutputDiagnostics(
        "Fix $preCondition:stdout, then retry",
        "prompt",
        false
      )
    ).resolves.toEqual([
      {
        message:
          "$preCondition:stdout has no effect — this step has no pre-condition configured",
      },
    ]);
    await expect(
      getConditionOutputDiagnostics(
        "Fix $preCondition:stdout, then retry",
        "prompt",
        true
      )
    ).resolves.toEqual([]);
  });

  it("warns about an unknown field and offers the field it extends", async () => {
    const diagnostics = await getConditionOutputDiagnostics(
      "Fix $preCondition:stdout2 now",
      "prompt",
      true
    );
    expect(diagnostics).toEqual([
      {
        message: `Unknown field "stdout2" for $preCondition — it will not be expanded. Did you mean $preCondition:stdout? Known fields: ${Object.values(RETRY_PROMPT_PLACEHOLDERS).join(", ")}.`,
      },
    ]);
  });

  it("applies the unknown-field quick fix", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      doc: "Fix $endCondition:exitCodes now",
      extensions: [
        createConditionOutputLintExtension(
          { current: true },
          { current: "endCondition" }
        ),
      ],
    });
    try {
      forceLinting(view);
      await new Promise((resolve) => setTimeout(resolve, 350));
      let applied = false;
      forEachDiagnostic(view.state, (diagnostic, from, to) => {
        const action = diagnostic.actions?.[0];
        if (!action || applied) return;
        action.apply(view, from, to);
        applied = true;
      });
      expect(applied).toBe(true);
      expect(view.state.doc.toString()).toBe("Fix $endCondition:exitCode now");
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("does not lint condition-output references inside fenced code blocks", async () => {
    await expect(
      getConditionOutputDiagnostics(
        "```text\n$endCondition:stdout\n```",
        "prompt",
        false
      )
    ).resolves.toEqual([]);
  });
});

describe("CodeMirrorEditor prior-context references", () => {
  it("does not chip or lint prior-context refs inside nested fences", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const referenceValidity = new Map<string, boolean>();
    const view = new EditorView({
      parent,
      doc: "````md\n```\n$previous\n```\n````",
      extensions: [
        createAtomicReferenceExtension(new Map(), referenceValidity),
        createPriorContextLintExtension(
          { current: 0 },
          { current: false },
          referenceValidity
        ),
      ],
    });

    try {
      forceLinting(view);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const diagnostics: unknown[] = [];
      forEachDiagnostic(view.state, (diagnostic) =>
        diagnostics.push(diagnostic)
      );

      expect(view.dom.querySelector(".cm-atomic-ref")).toBeNull();
      expect(diagnostics).toEqual([]);
      expect(referenceValidity.has("$previous")).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("marks an invalid prior-context chip after lint validation", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const referenceValidity = new Map<string, boolean>();
    const view = new EditorView({
      parent,
      doc: "$previous",
      extensions: [
        createAtomicReferenceExtension(new Map(), referenceValidity),
        createPriorContextLintExtension(
          { current: 0 },
          { current: false },
          referenceValidity
        ),
      ],
    });

    try {
      forceLinting(view);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");

      expect(chip?.getAttribute("data-invalid")).toBe("true");
      expect(referenceValidity.get("$previous")).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe("CodeMirrorEditor $previous:N lint", () => {
  it("notes an over-large count without marking the chip invalid", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const referenceValidity = new Map<string, boolean>();
    const view = new EditorView({
      parent,
      doc: "$previous:5",
      extensions: [
        createAtomicReferenceExtension(new Map(), referenceValidity),
        createPriorContextLintExtension(
          { current: 2 },
          { current: false },
          referenceValidity
        ),
      ],
    });

    try {
      forceLinting(view);
      await new Promise((resolve) => setTimeout(resolve, 350));
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      const diagnostics: Array<{ severity: string; message: string }> = [];
      forEachDiagnostic(view.state, (diagnostic) =>
        diagnostics.push(diagnostic)
      );

      expect(chip?.getAttribute("data-ref")).toBe("previous:5");
      expect(chip?.hasAttribute("data-invalid")).toBe(false);
      expect(referenceValidity.get("$previous:5")).toBe(true);
      expect(diagnostics).toEqual([
        expect.objectContaining({
          severity: "info",
          message:
            "Only 2 prior steps are available before this step — $previous:5 will include at most 2",
        }),
      ]);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe("CodeMirrorEditor prior-context re-lint on step context change", () => {
  it("clears a stale invalid $step chip once the step count arrives", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const referenceValidity = new Map<string, boolean>();
    const stepCountRef = { current: 0 };
    const view = new EditorView({
      parent,
      doc: "$step:1-3",
      extensions: [
        createAtomicReferenceExtension(new Map(), referenceValidity),
        createPriorContextLintExtension(
          stepCountRef,
          { current: false },
          referenceValidity
        ),
      ],
    });

    try {
      // First lint runs before the workflow steps have loaded.
      forceLinting(view);
      await new Promise((resolve) => setTimeout(resolve, 350));
      expect(referenceValidity.get("$step:1-3")).toBe(false);

      // No lint is pending now, so a bare forceLinting would be a no-op.
      stepCountRef.current = 5;
      relintForContextChange(view);
      await new Promise((resolve) => setTimeout(resolve, 50));

      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(referenceValidity.get("$step:1-3")).toBe(true);
      expect(chip?.hasAttribute("data-invalid")).toBe(false);
      let diagnosticCount = 0;
      forEachDiagnostic(view.state, () => diagnosticCount++);
      expect(diagnosticCount).toBe(0);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

interface LintSnapshot {
  severity: string;
  message: string;
  text: string;
}

async function lintDocument(
  doc: string,
  extensions: Extension[]
): Promise<LintSnapshot[]> {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ parent, doc, extensions });
  try {
    forceLinting(view);
    await new Promise((resolve) => setTimeout(resolve, 600));
    const found: LintSnapshot[] = [];
    forEachDiagnostic(view.state, (diagnostic, from, to) => {
      found.push({
        severity: diagnostic.severity,
        message: diagnostic.message,
        text: doc.slice(from, to),
      });
    });
    return found;
  } finally {
    view.destroy();
    parent.remove();
  }
}

function lintPriorContext(
  doc: string,
  stepCount: number,
  hasFinalStep: boolean
): Promise<LintSnapshot[]> {
  return lintDocument(doc, [
    createPriorContextLintExtension(
      { current: stepCount },
      { current: hasFinalStep }
    ),
  ]);
}

describe("CodeMirrorEditor prior-context lint rules", () => {
  it.each([
    [
      "$previous",
      0,
      false,
      "warning",
      "Prior context not found — no prior steps are available before this step",
    ],
    [
      "$all",
      0,
      false,
      "warning",
      "Prior context not found — no prior steps are available before this step",
    ],
    [
      "$finalStep",
      3,
      false,
      "warning",
      "Prior context not found — no final step is configured",
    ],
    [
      "$allFinalStep",
      3,
      false,
      "warning",
      "Prior context not found — no final step is configured",
    ],
    [
      "$step:9",
      3,
      false,
      "warning",
      "Prior context not found — step 9 does not exist",
    ],
    [
      "$previous:4",
      1,
      false,
      "info",
      "Only 1 prior step is available before this step — $previous:4 will include at most 1",
    ],
  ])(
    "reports %s with %i steps (final step: %s)",
    async (doc, stepCount, hasFinalStep, severity, message) => {
      await expect(
        lintPriorContext(doc, stepCount, hasFinalStep)
      ).resolves.toEqual([{ severity, message, text: doc }]);
    }
  );

  it("reports several missing steps in one range message", async () => {
    const [diagnostic] = await lintPriorContext("$step:8-9", 3, false);
    expect(diagnostic.message).toMatch(
      /^Prior context not found — steps .+ do not exist$/
    );
    expect(diagnostic.severity).toBe("warning");
  });

  it.each([
    ["$previous", 1, true],
    ["$all", 2, false],
    ["$finalStep", 1, true],
    ["$step:2", 3, false],
  ])("does not report a resolvable %s", async (doc, stepCount, hasFinal) => {
    await expect(lintPriorContext(doc, stepCount, hasFinal)).resolves.toEqual(
      []
    );
  });

  it("does not report a prior-context ref inside inline code", async () => {
    await expect(
      lintPriorContext("Use `$step:9` here", 3, false)
    ).resolves.toEqual([]);
  });
});

describe("CodeMirrorEditor context-reference lint rules", () => {
  const resolver =
    (existing: Set<string>) =>
    async (references: Array<{ id: string; path?: string }>) =>
      references.map((reference) =>
        existing.has(reference.path ?? "")
          ? { id: reference.id, exists: true }
          : {
              id: reference.id,
              exists: false,
              message: "File not found",
            }
      );
  const SUPPRESSED =
    "Context expansion suppressed — this reference won't be expanded inside code";

  it("reports an unresolved reference with the host message", async () => {
    const found = await lintDocument("See @src/missing.ts please", [
      createContextReferenceLintExtension(resolver(new Set())),
    ]);
    expect(found).toEqual([
      {
        severity: "warning",
        message: "File not found",
        text: "@src/missing.ts",
      },
    ]);
  });

  it("falls back to a generic message when the host gives none", async () => {
    const found = await lintDocument("See @src/missing.ts", [
      createContextReferenceLintExtension(async (references) =>
        references.map((reference) => ({ id: reference.id, exists: false }))
      ),
    ]);
    expect(found.map((entry) => entry.message)).toEqual(["context not found"]);
  });

  it("does not report a resolved reference", async () => {
    await expect(
      lintDocument("See @src/real.ts", [
        createContextReferenceLintExtension(resolver(new Set(["src/real.ts"]))),
      ])
    ).resolves.toEqual([]);
  });

  it("warns that expansion is suppressed for an existing file in inline code", async () => {
    await expect(
      lintDocument("Read `@src/real.ts` now", [
        createContextReferenceLintExtension(resolver(new Set(["src/real.ts"]))),
      ])
    ).resolves.toEqual([
      { severity: "warning", message: SUPPRESSED, text: "@src/real.ts" },
    ]);
  });

  it("warns that expansion is suppressed for an existing file in a fence", async () => {
    await expect(
      lintDocument("```\n@src/real.ts\n```", [
        createContextReferenceLintExtension(resolver(new Set(["src/real.ts"]))),
      ])
    ).resolves.toEqual([
      { severity: "warning", message: SUPPRESSED, text: "@src/real.ts" },
    ]);
  });

  it("stays silent for a missing file inside code", async () => {
    await expect(
      lintDocument("Read `@src/missing.ts` now\n```\n@src/missing.ts\n```", [
        createContextReferenceLintExtension(resolver(new Set())),
      ])
    ).resolves.toEqual([]);
  });
});

describe("CodeMirrorEditor external reference completions", () => {
  it("opens ! completion only at a word boundary with an uppercase name query", () => {
    expect(findCustomCompletionContext("use !", 0)).toEqual({
      trigger: "!",
      query: "",
      from: 4,
    });
    expect(findCustomCompletionContext("use !API_", 0)).toEqual({
      trigger: "!",
      query: "API_",
      from: 4,
    });
  });

  it("does not open ! completion for Markdown images, prose, filenames, or lowercase text", () => {
    expect(findCustomCompletionContext("![alt](url)")).toBeNull();
    expect(findCustomCompletionContext("Done!")).toBeNull();
    expect(findCustomCompletionContext("data!file.csv")).toBeNull();
    expect(findCustomCompletionContext("Done!token")).toBeNull();
  });

  it("finds slash-token completion contexts and allows namespace punctuation", () => {
    expect(findSlashCompletionContext("/", 4)).toEqual({ from: 4, query: "" });
    expect(findSlashCompletionContext(" /", 0)).toEqual({ from: 1, query: "" });
    expect(findSlashCompletionContext("(/", 0)).toEqual({ from: 1, query: "" });
    expect(findSlashCompletionContext('"/', 0)).toEqual({ from: 1, query: "" });
    expect(findSlashCompletionContext("use /skill:code-review", 0)).toEqual({
      from: 4,
      query: "skill:code-review",
    });
    expect(findSlashCompletionContext("use /mcp:playwright", 0)).toEqual({
      from: 4,
      query: "mcp:playwright",
    });
    expect(findSlashCompletionContext("/skill:bad name")).toBeNull();
  });

  it("maps slash completion items to explicit skill and MCP insertions", () => {
    const result = buildCodeMirrorCompletionResult(
      [
        { label: "commit", insertText: "/skill:commit" },
        { label: "playwright", insertText: "/mcp:playwright" },
      ],
      0,
      { trigger: "/", query: "" }
    );

    expect(result.options.map((option) => option.apply)).toEqual([
      "skill:commit",
      "mcp:playwright",
    ]);
  });

  it("disables CodeMirror filtering for @ completions when the query already includes a path", () => {
    const result = buildCodeMirrorCompletionResult(
      [
        {
          label: "CodeMirrorEditor.tsx",
          kind: 16,
          insertText:
            "src/ui/webview-react/components/editor/CodeMirrorEditor.tsx",
          sortText:
            "0_src/ui/webview-react/components/editor/CodeMirrorEditor.tsx",
        },
      ],
      12,
      {
        trigger: "@",
        query: "src/ui/webview-react/components/editor/Co",
      }
    );

    expect(result.from).toBe(13);
    expect(result.filter).toBe(false);
  });

  it("keeps CodeMirror fuzzy filtering for basename-only @ completions", () => {
    const result = buildCodeMirrorCompletionResult(
      [{ label: "CodeMirrorEditor.tsx", kind: 16, insertText: "src/file.ts" }],
      5,
      { trigger: "@", query: "Co" }
    );

    expect(result.from).toBe(6);
    expect(result.filter).toBeUndefined();
  });

  it("shows extension-ranked completions unfiltered and in the order sent", () => {
    const result = buildCodeMirrorCompletionResult(
      [
        {
          label: "useFinalStepContextMenu",
          kind: 2,
          insertText: "sym:src/a.ts:useFinalStepContextMenu:1-2",
          filterText: "useFinalStepContextMenu src/a.ts",
          rank: 0,
        },
        {
          label: "useContextPct",
          kind: 2,
          insertText: "sym:src/b.ts:useContextPct:1-2",
          filterText: "useContextPct src/b.ts",
          rank: 1,
        },
      ],
      5,
      { trigger: "#", query: "usecontext" }
    );

    expect(result.filter).toBe(false);
    expect(result.options.map((option) => option.label)).toEqual([
      "useFinalStepContextMenu",
      "useContextPct",
    ]);
    // "use" + "Context" highlighted in the displayed label
    expect(result.getMatch?.(result.options[0])).toEqual([0, 3, 12, 19]);
  });

  it("highlights only the child segment of a typed directory query", () => {
    const result = buildCodeMirrorCompletionResult(
      [{ label: "CodeMirrorEditor.tsx", kind: 16, insertText: "x", rank: 0 }],
      5,
      { trigger: "@", query: "src/editor/cme" }
    );

    expect(result.getMatch?.(result.options[0])).toEqual([0, 1, 4, 5, 10, 11]);
  });

  it("uses filterText for CodeMirror fuzzy matching while keeping the visible label", () => {
    const result = buildCodeMirrorCompletionResult(
      [
        {
          label: "CodeMirrorEditor.tsx",
          kind: 16,
          insertText: "src/file.ts",
          filterText:
            "CodeMirrorEditor.tsx src/ui/webview-react/components/editor/CodeMirrorEditor.tsx",
        },
      ],
      5,
      { trigger: "@", query: "cme" }
    );

    expect(result.options[0]?.label).toBe(
      "CodeMirrorEditor.tsx src/ui/webview-react/components/editor/CodeMirrorEditor.tsx"
    );
    expect(result.options[0]?.displayLabel).toBe("CodeMirrorEditor.tsx");
  });

  it("replaces the complete lone prompt path without adding a trigger offset", () => {
    const result = buildCodeMirrorCompletionResult(
      [
        {
          label: "current.prompt.md",
          kind: 16,
          insertText: "root2/prompts/current.prompt.md",
        },
      ],
      0,
      { trigger: "path", query: "root2/prompts/cu" }
    );

    expect(result.from).toBe(0);
    expect(result.filter).toBe(false);
    expect(result.options[0]?.apply).toBe("root2/prompts/current.prompt.md");
  });
});

describe("CodeMirrorEditor ctrlyoke skill/mcp links", () => {
  it("decorates only explicit skill/mcp tokens and opens the selected skill", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const postMessage = vi.fn();
    const view = new EditorView({
      parent,
      doc: "/skill:commit /mcp:playwright /commit /mcp",
      extensions: [
        createSlashTokenDecorationExtension(),
        createClickHandlerExtension({ postMessage }, { current: 0 }),
      ],
    });

    try {
      const links = view.dom.querySelectorAll<HTMLElement>(".cm-link");
      expect(links).toHaveLength(2);

      const skillLink = links[0];
      expect(skillLink.textContent).toBe("/skill:commit");
      expect(skillLink.getAttribute("data-skill-name")).toBe("commit");

      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      skillLink.dispatchEvent(click);

      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.OPEN_SKILL,
        skillName: "commit",
      });
      expect(click.defaultPrevented).toBe(true);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("decorates an explicit mcp token and requests its config preview", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const postMessage = vi.fn();
    const view = new EditorView({
      parent,
      doc: "/skill:commit /mcp:playwright /commit /mcp",
      extensions: [
        createSlashTokenDecorationExtension(),
        createClickHandlerExtension({ postMessage }, { current: 0 }),
      ],
    });

    try {
      const links = view.dom.querySelectorAll<HTMLElement>(".cm-link");
      const mcpLink = links[1];
      expect(mcpLink.textContent).toBe("/mcp:playwright");
      expect(mcpLink.getAttribute("data-mcp-server-name")).toBe("playwright");

      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      mcpLink.dispatchEvent(click);

      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.REQUEST_MCP_CONFIG_PREVIEW,
        mcpServerName: "playwright",
      });
      expect(click.defaultPrevented).toBe(true);
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe("CodeMirrorEditor completion kind icons", () => {
  function typeFor(kind: number | undefined) {
    return buildCodeMirrorCompletionResult(
      [{ label: "x", kind, insertText: "x" }],
      0,
      { trigger: "#", query: "" }
    ).options[0]?.type;
  }

  it("maps symbol completion kinds to distinct symbol-* codicons", () => {
    expect(typeFor(1)).toBe("symbol-method"); // Method
    expect(typeFor(2)).toBe("symbol-function"); // Function
    expect(typeFor(6)).toBe("symbol-class"); // Class
    expect(typeFor(7)).toBe("symbol-interface"); // Interface
    expect(typeFor(21)).toBe("symbol-struct"); // Struct
  });

  it("gives the selection completion (Unit) its own icon, distinct from git completions (Reference)", () => {
    expect(typeFor(10)).toBe("list-selection");
    expect(typeFor(17)).toBe("source-control");
  });

  it("falls back to symbol-misc for an unknown or missing kind", () => {
    expect(typeFor(999)).toBe("symbol-misc");
    expect(typeFor(undefined)).toBe("symbol-misc");
  });
});

describe("CodeMirrorEditor symbol completion icon cache seeding", () => {
  // The completion item's kind is known synchronously at pick time; picking it
  // should seed the chip icon cache immediately instead of waiting on the
  // debounced round trip in createContextReferenceLintExtension, so the chip
  // never has to show DEFAULT_COMPLETION_ICON first and flash to the real
  // icon later. See symbolIconCacheKey for the cache key format.
  function pickSymbolCompletion(
    cache: Map<string, string>,
    insertText: string,
    kind: number
  ) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ parent, doc: "" });

    const result = buildCodeMirrorCompletionResult(
      [{ label: "MySymbol", kind, insertText }],
      0,
      { trigger: "#", query: "" },
      cache
    );
    const completion = result.options[0];
    const apply = completion.apply as (
      view: EditorView,
      completion: unknown,
      from: number,
      to: number
    ) => void;
    apply(view, completion, 0, 0);

    const docText = view.state.doc.toString();
    view.destroy();
    return docText;
  }

  it("seeds the cache with the completion's own icon on pick", () => {
    const cache = new Map<string, string>();

    // Production insertText has no leading `#` (the `#` trigger stays in the
    // doc at `from`); the seed reconstructs `#` + insertText before parsing, so
    // this must still resolve the symbol kind. Before that reconstruction the
    // parse silently no-op'd and the chip flashed the misc icon.
    const docText = pickSymbolCompletion(
      cache,
      "sym:src/a.ts:MyClass:10-20",
      6 // Class
    );

    // Terminal reference → self-terminating trailing space (see
    // withReferenceBoundarySpace). The seeded cache key is unaffected.
    expect(docText).toBe("sym:src/a.ts:MyClass:10-20 ");
    expect(cache.get("src/a.ts::MyClass::10-20")).toBe("symbol-class");
  });

  it("does not seed the cache when no cache is supplied", () => {
    const result = buildCodeMirrorCompletionResult(
      [
        {
          label: "MyClass",
          kind: 6,
          insertText: "sym:src/a.ts:MyClass:10-20",
        },
      ],
      0,
      { trigger: "#", query: "" }
    );

    expect(result.options[0].apply).toBe("sym:src/a.ts:MyClass:10-20 ");
  });

  it("does not seed the cache for non-symbol completions even with a kind", () => {
    const cache = new Map<string, string>();

    const result = buildCodeMirrorCompletionResult(
      [{ label: "foo.ts", kind: 16, insertText: "foo.ts" }],
      0,
      { trigger: "@", query: "" },
      cache
    );

    expect(result.options[0].apply).toBe("foo.ts ");
    expect(cache.size).toBe(0);
  });
});

describe("CodeMirrorEditor output capture completions", () => {
  it("uses a function-valued apply and inserts the capture placeholder", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ parent, doc: "@" });
    const picked = vi.fn();

    try {
      const result = buildCodeMirrorCompletionResult(
        [
          {
            label: "Agent Host (Output)",
            insertText: CAPTURING_OUTPUT_PLACEHOLDER,
            captureId: "capture-1",
          },
        ],
        0,
        { trigger: "@", query: "" },
        undefined,
        picked
      );
      const completion = result.options[0];
      const apply = completion?.apply as (
        view: EditorView,
        completion: Completion,
        from: number,
        to: number
      ) => void;

      expect(typeof completion?.apply).toBe("function");
      apply(view, completion!, result.from, result.from);

      // The `@` trigger itself is consumed along with the placeholder — the
      // resolved reference is always a fresh `@<path>` (see
      // resolvePendingCapture), so leaving the original `@` in place would
      // double it up once the snapshot save resolves.
      expect(view.state.doc.toString()).toBe(CAPTURING_OUTPUT_PLACEHOLDER);
      expect(picked).toHaveBeenCalledWith(
        "capture-1",
        0,
        CAPTURING_OUTPUT_PLACEHOLDER.length
      );
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("consumes a leading # trigger too, since the resolved reference is always @<path>", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({ parent, doc: "#" });
    const picked = vi.fn();

    try {
      const result = buildCodeMirrorCompletionResult(
        [
          {
            label: "selection: Agent Host (lines 1-2)",
            insertText: CAPTURING_OUTPUT_PLACEHOLDER,
            captureId: "capture-2",
          },
        ],
        0,
        { trigger: "#", query: "" },
        undefined,
        picked
      );
      const completion = result.options[0];
      const apply = completion?.apply as (
        view: EditorView,
        completion: Completion,
        from: number,
        to: number
      ) => void;

      apply(view, completion!, result.from, result.from);

      expect(view.state.doc.toString()).toBe(CAPTURING_OUTPUT_PLACEHOLDER);
      expect(picked).toHaveBeenCalledWith(
        "capture-2",
        0,
        CAPTURING_OUTPUT_PLACEHOLDER.length
      );
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe("CodeMirrorEditor completion boundary space", () => {
  // A terminal reference gets a trailing space on pick so appended text can't
  // merge into it (and, in atomic mode, get absorbed into the chip). "Keep
  // typing" completions (directories, "$step:") and the whole-prompt path
  // trigger are exempt so progressive completion / file loading still works.
  function applyFor(
    insertText: string,
    trigger: "@" | "#" | "~" | "$" | "path"
  ) {
    return buildCodeMirrorCompletionResult([{ label: "x", insertText }], 0, {
      trigger,
      query: "",
    }).options[0].apply;
  }

  it("appends a trailing space to terminal @file / #selection / ~git references", () => {
    expect(applyFor("src/app.ts", "@")).toBe("src/app.ts ");
    expect(applyFor('"path with spaces/a.ts"', "@")).toBe(
      '"path with spaces/a.ts" '
    );
    expect(applyFor("selection:src/a.ts:10-20", "#")).toBe(
      "selection:src/a.ts:10-20 "
    );
    expect(applyFor("diff", "~")).toBe("diff ");
    expect(applyFor("previous", "$")).toBe("previous ");
  });

  it("leaves directory completions unterminated so sub-folder drilling continues", () => {
    expect(applyFor("src/ui/", "@")).toBe("src/ui/");
    expect(applyFor('"path with spaces/"', "@")).toBe('"path with spaces/"');
  });

  it("leaves colon-continuation tokens ($step:) unterminated", () => {
    expect(applyFor("step:", "$")).toBe("step:");
  });

  it("does not add a space for the whole-prompt path trigger", () => {
    expect(applyFor("prompts/current.prompt.md", "path")).toBe(
      "prompts/current.prompt.md"
    );
  });
});

describe("CodeMirrorEditor prompt reference insertion", () => {
  it("surrounds multi-reference inserts with newlines when inserting mid-line", () => {
    const result = buildPromptReferenceInsertion(
      "Review this prompt",
      {
        requestId: "insert-1",
        references: ["@src/app.ts", "@package.json"],
        mode: PROMPT_EDITOR_INSERT_MODES.INSERT,
      },
      { from: "Review".length, to: "Review".length }
    );

    expect(result).toEqual({
      from: "Review".length,
      to: "Review".length,
      text: "\n@src/app.ts\n@package.json\n",
    });
  });

  it("prepends a space when the cursor sits directly after a filename-legal character", () => {
    const result = buildPromptReferenceInsertion(
      "Review",
      {
        requestId: "insert-3",
        references: ["@src/app.ts"],
        mode: PROMPT_EDITOR_INSERT_MODES.INSERT,
      },
      { from: "Review".length, to: "Review".length }
    );

    expect(result).toEqual({
      from: "Review".length,
      to: "Review".length,
      text: " @src/app.ts",
    });
  });

  it("does not prepend a space when the cursor follows whitespace or punctuation", () => {
    const afterSpace = buildPromptReferenceInsertion(
      "Review ",
      {
        requestId: "insert-4",
        references: ["@src/app.ts"],
        mode: PROMPT_EDITOR_INSERT_MODES.INSERT,
      },
      { from: "Review ".length, to: "Review ".length }
    );
    expect(afterSpace.text).toBe("@src/app.ts");

    const afterParen = buildPromptReferenceInsertion(
      "See (",
      {
        requestId: "insert-5",
        references: ["@src/app.ts"],
        mode: PROMPT_EDITOR_INSERT_MODES.INSERT,
      },
      { from: "See (".length, to: "See (".length }
    );
    expect(afterParen.text).toBe("@src/app.ts");
  });

  it("appends references at the end of the document in append mode", () => {
    const result = buildPromptReferenceInsertion(
      "Analyze current output",
      {
        requestId: "insert-2",
        references: ["@src/extension.ts"],
        mode: PROMPT_EDITOR_INSERT_MODES.APPEND,
      },
      { from: 0, to: 0 }
    );

    expect(result).toEqual({
      from: "Analyze current output".length,
      to: "Analyze current output".length,
      text: "\n@src/extension.ts",
    });
  });
});

describe("CodeMirrorEditor orphaned mouse-selection guard", () => {
  it("tears down a lingering MouseSelection (the stuck-caret orphan)", () => {
    const destroy = vi.fn();
    const view = {
      inputState: { mouseSelection: { destroy } },
    } as unknown as EditorView;

    destroyOrphanedMouseSelection(view);

    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("is a no-op (and does not throw) when there is no active mouse selection", () => {
    expect(() =>
      destroyOrphanedMouseSelection({
        inputState: { mouseSelection: null },
      } as unknown as EditorView)
    ).not.toThrow();

    // Also tolerate a future CodeMirror that drops/renames inputState entirely.
    expect(() =>
      destroyOrphanedMouseSelection({} as unknown as EditorView)
    ).not.toThrow();
  });
});

describe("CodeMirrorEditor atomic reference chips", () => {
  it("uses an embedded symbol kind on first render without contacting the host", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const postMessage = vi.mocked(window.vscodeApi!.postMessage);
    postMessage.mockClear();
    const view = new EditorView({
      parent,
      doc: "#sym.class:src/file.ts:Thing:10-20",
      extensions: [createAtomicReferenceExtension()],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip?.querySelector(".codicon-symbol-class")).not.toBeNull();
      expect(postMessage).not.toHaveBeenCalled();
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("lets validation correct a stale embedded symbol kind", async () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const cache = new Map<string, string>();
    const token = "#sym.class:src/file.ts:Thing:10-20";
    const validateReferences = vi.fn(async (references: { id: string }[]) =>
      references.map((reference) => ({
        id: reference.id,
        exists: true,
        symbolKind: 7, // CompletionItemKind.Interface
      }))
    );
    const view = new EditorView({
      parent,
      doc: token,
      extensions: [
        createAtomicReferenceExtension(cache),
        createContextReferenceLintExtension(validateReferences, cache),
      ],
    });

    try {
      expect(view.dom.querySelector(".codicon-symbol-class")).not.toBeNull();

      forceLinting(view);
      await vi.waitFor(() => {
        expect(validateReferences).toHaveBeenCalled();
        expect(cache.get("src/file.ts::Thing::10-20")).toBe("symbol-interface");
        expect(
          view.dom.querySelector(".codicon-symbol-interface")
        ).not.toBeNull();
      });
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("keeps an unresolvable symbol chip marked invalid", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const token = "#sym.class:src/missing.ts:Thing:10-20";
    const validity = new Map<string, boolean>([[token, false]]);
    const view = new EditorView({
      parent,
      doc: token,
      extensions: [createAtomicReferenceExtension(new Map(), validity)],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip?.getAttribute("data-invalid")).toBe("true");
      expect(chip?.querySelector(".codicon-symbol-class")).not.toBeNull();
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("opens on a plain click without starting a CodeMirror mouse selection", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const postMessage = vi.fn();
    const view = new EditorView({
      parent,
      doc: "@src/deep/file.ts",
      extensions: [
        createAtomicReferenceExtension(),
        createClickHandlerExtension({ postMessage }, { current: 2 }),
      ],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip).not.toBeNull();

      chip?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, button: 0 })
      );
      const inputState = view as unknown as {
        inputState: { mouseSelection: unknown };
      };
      expect(inputState.inputState.mouseSelection).toBeNull();

      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      chip?.dispatchEvent(click);

      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.OPEN_FILE,
        path: "src/deep/file.ts",
      });
      expect(click.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(view.contentDOM);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("refuses to open a chip the validation pass marked invalid and warns instead of posting OPEN_FILE", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const postMessage = vi.fn();
    const nativePostMessage = window.vscodeApi!.postMessage as ReturnType<
      typeof vi.fn
    >;
    nativePostMessage.mockClear();
    const validity = new Map<string, boolean>([["@b/missing.ts", false]]);
    const view = new EditorView({
      parent,
      doc: "@b/missing.ts",
      extensions: [
        createAtomicReferenceExtension(new Map(), validity),
        createClickHandlerExtension({ postMessage }, { current: 0 }),
      ],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      // Flagged for the click handler...
      expect(chip?.getAttribute("data-invalid")).toBe("true");

      const click = new MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      });
      chip?.dispatchEvent(click);

      // ...so the click is consumed with a warning, never an open attempt.
      expect(postMessage).not.toHaveBeenCalled();
      expect(nativePostMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.SHOW_NATIVE_FEEDBACK,
        severity: USER_FEEDBACK_SEVERITY.WARNING,
        message:
          "Can't open — this reference doesn't resolve to an existing file",
        detail: undefined,
      });
      expect(click.defaultPrevented).toBe(true);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("renders the warning border class on an unresolvable reference chip", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const validity = new Map<string, boolean>([["@b/missing.ts", false]]);
    const view = new EditorView({
      parent,
      doc: "@b/missing.ts",
      extensions: [createAtomicReferenceExtension(new Map(), validity)],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip?.classList.contains("cm-atomic-ref-invalid")).toBe(true);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("does not mark a resolvable reference chip with the warning border class", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const validity = new Map<string, boolean>([["@a/valid.ts", true]]);
    const view = new EditorView({
      parent,
      doc: "@a/valid.ts",
      extensions: [createAtomicReferenceExtension(new Map(), validity)],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip?.classList.contains("cm-atomic-ref-invalid")).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("suppresses the native hover title on an unresolvable reference chip so it doesn't fight the lint tooltip", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const validity = new Map<string, boolean>([["@b/missing.ts", false]]);
    const view = new EditorView({
      parent,
      doc: "@b/missing.ts",
      extensions: [createAtomicReferenceExtension(new Map(), validity)],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip?.hasAttribute("title")).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("carries only chip styling — never cm-link, whose link color and underline paint inside the chip", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new EditorView({
      parent,
      doc: "@src/deep/file.ts",
      extensions: [createAtomicReferenceExtension()],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip?.classList.contains("atomic-reference-chip")).toBe(true);
      expect(chip?.classList.contains("cm-link")).toBe(false);
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("renders /skill: and /mcp: references as chips and opens them on plain click", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const postMessage = vi.fn();
    const view = new EditorView({
      parent,
      doc: "/skill:commit /mcp:playwright",
      extensions: [
        createAtomicReferenceExtension(),
        createClickHandlerExtension({ postMessage }, { current: 0 }),
      ],
    });

    try {
      const chips = view.dom.querySelectorAll<HTMLElement>(".cm-atomic-ref");
      expect(chips).toHaveLength(2);
      expect(chips[0].querySelector(".codicon-tools")).not.toBeNull();
      expect(chips[0]).toHaveTextContent("commit");
      expect(chips[1].querySelector(".codicon-mcp")).not.toBeNull();
      expect(chips[1]).toHaveTextContent("playwright");

      chips[0].dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.OPEN_SKILL,
        skillName: "commit",
      });

      chips[1].dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true })
      );
      expect(postMessage).toHaveBeenCalledWith({
        type: MESSAGE_TYPES.REQUEST_MCP_CONFIG_PREVIEW,
        mcpServerName: "playwright",
      });
    } finally {
      view.destroy();
      parent.remove();
    }
  });

  it("keeps the native hover title on a resolvable reference chip", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const validity = new Map<string, boolean>([["@a/valid.ts", true]]);
    const view = new EditorView({
      parent,
      doc: "@a/valid.ts",
      extensions: [createAtomicReferenceExtension(new Map(), validity)],
    });

    try {
      const chip = view.dom.querySelector<HTMLElement>(".cm-atomic-ref");
      expect(chip?.title).toBe("@a/valid.ts");
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe("keyboardTooltipSpace", () => {
  const originalVisualViewport = window.visualViewport;

  function stubDocumentElement(width: number, height: number) {
    Object.defineProperty(document.documentElement, "clientWidth", {
      value: width,
      configurable: true,
    });
    Object.defineProperty(document.documentElement, "clientHeight", {
      value: height,
      configurable: true,
    });
  }

  function stubVisualViewport(
    viewport:
      | Pick<VisualViewport, "offsetTop" | "offsetLeft" | "width" | "height">
      | undefined
  ) {
    Object.defineProperty(window, "visualViewport", {
      value: viewport,
      configurable: true,
    });
  }

  afterEach(() => {
    stubVisualViewport(
      originalVisualViewport as unknown as VisualViewport | undefined
    );
    Reflect.deleteProperty(document.documentElement, "clientWidth");
    Reflect.deleteProperty(document.documentElement, "clientHeight");
  });

  it("falls back to the document element when there is no visual viewport", () => {
    stubDocumentElement(390, 800);
    stubVisualViewport(undefined);

    expect(keyboardTooltipSpace()).toEqual({
      top: 0,
      left: 0,
      bottom: 800,
      right: 390,
    });
  });

  it("clamps the bottom to the keyboard line so the dropdown can flip above", () => {
    stubDocumentElement(390, 800);
    // Keyboard up: the layout viewport keeps its full 800px, the visual
    // viewport shrinks to the 460px band above the keyboard.
    stubVisualViewport({
      offsetTop: 0,
      offsetLeft: 0,
      width: 390,
      height: 460,
    });

    expect(keyboardTooltipSpace()).toEqual({
      top: 0,
      left: 0,
      bottom: 460,
      right: 390,
    });
  });

  it("expresses a panned visual viewport in layout-viewport coordinates", () => {
    stubDocumentElement(390, 800);
    // iOS panned the visual viewport down by 120px — coordsAtPos still reports
    // client rects against the layout viewport, so the band is 120..580.
    stubVisualViewport({
      offsetTop: 120,
      offsetLeft: 0,
      width: 390,
      height: 460,
    });

    expect(keyboardTooltipSpace()).toEqual({
      top: 120,
      left: 0,
      bottom: 580,
      right: 390,
    });
  });

  it("matches CodeMirror's default window space when no keyboard is open", () => {
    stubDocumentElement(1280, 900);
    stubVisualViewport({
      offsetTop: 0,
      offsetLeft: 0,
      width: 1280,
      height: 900,
    });

    expect(keyboardTooltipSpace()).toEqual({
      top: 0,
      left: 0,
      bottom: 900,
      right: 1280,
    });
  });
});
