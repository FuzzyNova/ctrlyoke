import { afterEach, describe, expect, it } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { insertNewlineAndIndent } from "@codemirror/commands";
import { forEachDiagnostic, forceLinting } from "@codemirror/lint";
import { highlightTree, tags } from "@lezer/highlight";
import {
  createAtomicReferenceExtension,
  createCodeRangeDecorationExtension,
  createContextReferenceLintExtension,
  createLinkDecorationExtension,
  createPromptDecorationThemeExtension,
} from "@components/editor/CodeMirrorEditor";
import {
  createPromptMarkdownExtension,
  createPromptMarkdownLanguage,
  PROMPT_MARKDOWN_NODE_NAMES,
  resolveFenceLanguage,
} from "@utils/codemirrorLanguage";
import {
  LIST_MARK_TAG,
  QUOTE_MARK_TAG,
  createCtrlYokeHighlightStyle,
} from "@utils/syntaxPalette";
import { findCodeRanges } from "@root/utils/FileReferenceParser";

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length) mounted.pop()?.();
});

function mount(doc: string, extensions: Extension[]) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  const view = new EditorView({ parent, doc, extensions });
  mounted.push(() => {
    view.destroy();
    parent.remove();
  });
  return view;
}

function parse(doc: string) {
  const state = EditorState.create({
    doc,
    extensions: [createPromptMarkdownLanguage()],
  });
  const tree = ensureSyntaxTree(state, doc.length, 5000);
  if (!tree) throw new Error("markdown did not parse in time");
  return tree;
}

function visuallyCodedRanges(doc: string) {
  const ranges: Array<{ from: number; to: number }> = [];
  parse(doc).iterate({
    enter: (node) => {
      if (node.name === "InlineCode") {
        ranges.push({ from: node.from, to: node.to });
      } else if (node.name === PROMPT_MARKDOWN_NODE_NAMES.FENCED_CODE) {
        let codeMarks = 0;
        for (
          let child = node.node.firstChild;
          child;
          child = child.nextSibling
        ) {
          if (child.name === PROMPT_MARKDOWN_NODE_NAMES.CODE_MARK)
            codeMarks += 1;
        }
        if (codeMarks >= 2) ranges.push({ from: node.from, to: node.to });
      }
    },
  });
  return ranges;
}

/** Highlight classes the shared palette gives each stretch of `doc`. */
function highlighted(doc: string) {
  const style = createCtrlYokeHighlightStyle();
  const spans: Array<{ text: string; classes: string }> = [];
  highlightTree(parse(doc), style, (from, to, classes) => {
    spans.push({ text: doc.slice(from, to), classes });
  });
  return { spans, style };
}

describe("resolveFenceLanguage", () => {
  it("resolves aliases and only the first word of the info string", () => {
    expect(resolveFenceLanguage("ts")).not.toBeNull();
    expect(resolveFenceLanguage("ts title=a.ts")).toBe(
      resolveFenceLanguage("typescript")
    );
    expect(resolveFenceLanguage("language-yml")).toBe(
      resolveFenceLanguage("yaml")
    );
  });

  it("builds each language once", () => {
    expect(resolveFenceLanguage("json")).toBe(resolveFenceLanguage("JSON"));
  });

  it("returns null for plain text and unknown languages", () => {
    expect(resolveFenceLanguage("")).toBeNull();
    expect(resolveFenceLanguage("   ")).toBeNull();
    expect(resolveFenceLanguage("not-a-language")).toBeNull();
  });
});

describe("prompt markdown highlighting", () => {
  it("gives quote and list marks their own tags", () => {
    const { spans, style } = highlighted("> quoted\n\n- item\n\n1. first");
    const quote = style.style([QUOTE_MARK_TAG]);
    const list = style.style([LIST_MARK_TAG]);
    expect(quote).toBeTruthy();
    expect(list).toBeTruthy();
    expect(quote).not.toBe(list);
    expect(spans.find((s) => s.text === ">")?.classes).toBe(quote);
    expect(
      spans
        .filter((s) => s.text === "-" || s.text === "1.")
        .map((s) => s.classes)
    ).toEqual([list, list]);
  });

  it("highlights fenced JSON as strings and numbers", () => {
    const { spans, style } = highlighted(
      '```json\n{"name": "ctrl", "count": 3}\n```'
    );
    const stringClass = style.style([tags.string]);
    const find = (text: string) =>
      spans.find((s) => s.text === text)?.classes ?? "";
    expect(find('"ctrl"')).toContain(stringClass);
    expect(find("3")).toBeTruthy();
    expect(find("3")).not.toBe(stringClass);
  });

  it("does not read #selection: at the start of a line as a heading", () => {
    const names: string[] = [];
    parse("#selection:src/a.ts:1-2\n#sym.foo:bar").iterate({
      enter: (node) => {
        names.push(node.name);
      },
    });
    expect(names.some((name) => name.startsWith("ATXHeading"))).toBe(false);
  });

  it("keeps Enter exactly as it is without a language", () => {
    const view = mount("- item", [createPromptMarkdownExtension()]);
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    insertNewlineAndIndent(view);
    expect(view.state.doc.toString()).toBe("- item\n");
  });
});

describe("markdown and code-range parity", () => {
  // `visuallyCodedRanges` excludes unclosed fences, whose editor colours are
  // suppressed while the user is still typing. All other cases must match the
  // runtime authority exactly.
  const corpus: Array<{ name: string; doc: string; agree: boolean }> = [
    { name: "inline span", doc: "use `code` here", agree: true },
    { name: "double-backtick span", doc: "use ``a ` b`` here", agree: true },
    { name: "fence", doc: "a\n```\ncode\n```\nb", agree: true },
    { name: "fence with info", doc: "```ts\nlet x = 1;\n```", agree: true },
    {
      name: "longer closing fence",
      doc: "```\ncode\n`````\nafter",
      agree: true,
    },
    { name: "backticks inside a fence", doc: "```\na `b` c\n```", agree: true },
    { name: "unmatched backtick", doc: "a ` b\nc", agree: true },
    { name: "unclosed fence", doc: "```ts\nsee @src/a.ts", agree: true },
    {
      name: "fence indented in a list item",
      doc: "- item\n\n    ```\n    code\n    ```",
      agree: true,
    },
    { name: "tilde fence", doc: "~~~\ncode\n~~~", agree: true },
    {
      name: "closer with an info string",
      doc: "```\na\n```js\nb\n```",
      agree: true,
    },
    {
      name: "inline span across a line break",
      doc: "a `b\nc` d",
      agree: true,
    },
    {
      name: "fence in a blockquote",
      doc: "> ```\n> code\n> ```",
      agree: true,
    },
    {
      name: "backslash inside inline code",
      doc: "Run `C:\\tmp\\` then @file.md and `x`",
      agree: true,
    },
    {
      name: "later fence after an unclosed tilde opener",
      doc: "~~~~~~~~~~\nNotes\n\n```\n$previous\n```",
      // Runtime recovers and masks the later closed fence; Lezer keeps the
      // unclosed tilde fence open through EOF, so it paints no later range.
      agree: false,
    },
    {
      name: "later fence after an unclosed shorter backtick opener",
      doc: "````\n\n```\n$previous\n```",
      agree: false,
    },
    {
      name: "fence on a list marker line",
      doc: "- ```\n  code @x\n  ```",
      agree: true,
    },
    {
      name: "ordered list fence on its marker line",
      doc: "1. ```\n   @x\n   ```",
      agree: true,
    },
    {
      name: "blockquote fence ends with its container",
      doc: "> ```\n> code\n\nRegular @ref text\n\n```\nx",
      agree: true,
    },
    {
      name: "blockquote fence rejects lazy continuation",
      doc: "> ```\n@x\n> ```",
      agree: true,
    },
    {
      name: "tilde fence info may contain backticks",
      doc: "~~~ `js`\n@a\n~~~",
      agree: true,
    },
    {
      name: "inline span stops at a new list item",
      doc: "- a `x\n- b` @y",
      agree: true,
    },
    {
      name: "inline span stops at an ATX heading",
      doc: "`a\n# H `b",
      agree: true,
    },
  ];

  it.each(corpus)("$name", ({ doc, agree }) => {
    const lezer = visuallyCodedRanges(doc);
    const authority = findCodeRanges(doc);
    if (agree) {
      expect(lezer).toEqual(authority);
    } else {
      expect(lezer).not.toEqual(authority);
    }
  });

  it("suppresses syntax colours until an opened fence has a closer", () => {
    const view = mount("```ts\nconst value = 1;", [
      createPromptMarkdownExtension(),
    ]);
    expect(view.dom.querySelector(".cm-unclosed-fence")).not.toBeNull();

    view.dispatch({
      changes: { from: view.state.doc.length, insert: "\n```" },
    });
    expect(view.dom.querySelector(".cm-unclosed-fence")).toBeNull();
  });
});

describe("ctrlyoke decorations over markdown highlighting", () => {
  const withMarkdown = (...extensions: Extension[]) => [
    createPromptMarkdownExtension(),
    createPromptDecorationThemeExtension(),
    ...extensions,
  ];

  it("uses a valid VS Code variable for the inline code border", () => {
    mount("`inline`", withMarkdown());
    const styleText = Array.from(document.querySelectorAll("style"))
      .map((style) => style.textContent ?? "")
      .join("\n");
    expect(styleText).toContain("--vscode-panel-border");
    expect(styleText).not.toContain("--vscode-markdown-extension.");
  });

  it("renders a link as the innermost span inside emphasis and link syntax", () => {
    const view = mount(
      "*see @src/a.ts now*\n[x @src/b.ts](https://example.com)",
      withMarkdown(Prec.highest(createLinkDecorationExtension()))
    );
    const links = Array.from(view.dom.querySelectorAll(".cm-link"));
    expect(links.map((el) => el.textContent)).toEqual([
      "@src/a.ts",
      "@src/b.ts",
    ]);
    for (const link of links) {
      // Innermost: the text node sits directly in the link span, so markdown's
      // colour on the outer span can't override the link colour.
      expect(Array.from(link.childNodes).every((n) => n.nodeType === 3)).toBe(
        true
      );
    }
  });

  it("keeps every fragment of a reference visually uniform inside emphasis", () => {
    const view = mount(
      "see @src/a*b*c.ts",
      withMarkdown(Prec.highest(createLinkDecorationExtension()))
    );
    const links = Array.from(view.dom.querySelectorAll(".cm-link"));
    expect(links.map((el) => el.textContent).join("")).toBe("@src/a*b*c.ts");
    expect(links.length).toBeGreaterThan(1);
    for (const link of links) {
      expect(getComputedStyle(link).fontStyle).toBe("normal");
      expect(getComputedStyle(link).fontWeight).toBe("normal");
      expect(link.classList.contains("cm-link")).toBe(true);
    }
  });

  it("still replaces a reference inside emphasis with a chip", () => {
    const view = mount(
      "**read @src/a.ts**",
      withMarkdown(Prec.high(createAtomicReferenceExtension()))
    );
    expect(view.dom.querySelectorAll(".cm-atomic-ref")).toHaveLength(1);
  });

  it("decorates no reference inside code and distinguishes inline and fenced ranges", () => {
    const view = mount(
      'see `@src/a.ts`\n```json\n{"a": "value", "n": 1}\n```',
      withMarkdown(
        createCodeRangeDecorationExtension(),
        Prec.highest(createLinkDecorationExtension())
      )
    );
    expect(view.dom.querySelector(".cm-link")).toBeNull();
    expect(view.dom.querySelector(".cm-code-range-inline")).not.toBeNull();
    expect(view.dom.querySelector(".cm-code-range-fenced")).not.toBeNull();
    const stringClass = createCtrlYokeHighlightStyle().style([tags.string]);
    if (!stringClass) throw new Error("string highlight class is missing");
    expect(
      Array.from(view.dom.querySelectorAll("span")).some((span) =>
        span.classList.contains(stringClass)
      )
    ).toBe(true);
  });
});

describe("suppressed-expansion warning with markdown on", () => {
  const SUPPRESSED =
    "Context expansion suppressed — this reference won't be expanded inside code";
  const resolver =
    (existing: Set<string>) =>
    async (references: Array<{ id: string; path?: string }>) =>
      references.map((reference) =>
        existing.has(reference.path ?? "")
          ? { id: reference.id, exists: true }
          : { id: reference.id, exists: false, message: "File not found" }
      );
  let lastView: EditorView | undefined;

  async function lint(doc: string, existing: Set<string>) {
    const view = mount(doc, [
      createPromptMarkdownExtension(),
      // The precedences CodeMirrorEditor composes them at.
      createCodeRangeDecorationExtension(),
      Prec.high(createContextReferenceLintExtension(resolver(existing))),
    ]);
    lastView = view;
    forceLinting(view);
    await new Promise((resolve) => setTimeout(resolve, 700));
    const found: Array<{ message: string; text: string }> = [];
    forEachDiagnostic(view.state, (diagnostic, from, to) => {
      found.push({
        message: diagnostic.message,
        text: view.state.doc.sliceString(from, to),
      });
    });
    return found;
  }

  it("warns for an existing file in inline code and in a fence", async () => {
    const existing = new Set(["src/real.ts"]);
    expect(await lint("Read `@src/real.ts` now", existing)).toEqual([
      { message: SUPPRESSED, text: "@src/real.ts" },
    ]);
    expect(await lint("```ts\n@src/real.ts\n```", existing)).toEqual([
      { message: SUPPRESSED, text: "@src/real.ts" },
    ]);
  });

  it("draws the squiggle above the code background, not under it", async () => {
    await lint("Read `@src/real.ts` now", new Set(["src/real.ts"]));
    const lintRange = lastView!.dom.querySelector(".cm-lintRange");
    expect(lintRange).not.toBeNull();
    // The lint span sits beside (and outside) the code mark, so its squiggle
    // remains visible with the inline border.
    expect(lintRange!.querySelector(".cm-code-range-inline")).toBeNull();
    expect(lintRange!.closest(".cm-code-range-inline")).not.toBeNull();
  });

  it("stays silent for a missing file in code", async () => {
    expect(
      await lint("`@src/missing.ts`\n```\n@src/missing.ts\n```", new Set())
    ).toEqual([]);
  });
});

describe("prompt markdown performance", () => {
  it("parses and edits a ~25K-token prompt within budget", () => {
    const paragraph =
      "## Section\n\nSome *emphasised* and **bold** prose with `code` and @src/file.ts.\n\n```ts\nconst value = { a: 1, b: [2, 3] };\n```\n\n- item one\n- item two\n\n";
    const doc = paragraph.repeat(Math.ceil(100_000 / paragraph.length));

    const view = mount(doc, [createPromptMarkdownExtension()]);
    // Generous bounds: a hang, not scheduler noise, is what these catch.
    const parseStart = performance.now();
    ensureSyntaxTree(view.state, view.state.doc.length, 10_000);
    expect(performance.now() - parseStart).toBeLessThan(10_000);

    const typeStart = performance.now();
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "x" },
      selection: { anchor: view.state.doc.length + 1 },
    });
    expect(performance.now() - typeStart).toBeLessThan(2_000);
    // The edit's own reparse is time-sliced, so under load it can stop short
    // of the end; what must hold is that the tree can reach it after the edit.
    expect(
      ensureSyntaxTree(view.state, view.state.doc.length, 10_000)?.length
    ).toBe(view.state.doc.length);
  });
});
