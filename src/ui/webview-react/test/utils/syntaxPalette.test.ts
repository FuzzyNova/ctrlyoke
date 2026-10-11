import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { tags, type Tag } from "@lezer/highlight";
import {
  SYNTAX_ROLES,
  buildSyntaxTokenStyles,
  createCtrlYokeHighlightStyle,
  getCtrlYokeHighlightSpec,
  syntaxRoleVariable,
} from "@utils/syntaxPalette";
import {
  getLanguageExtension,
  resolveCodeMirrorLanguage,
  resolveFenceLanguage,
} from "@utils/codemirrorLanguage";

const globalsCss = readFileSync(
  resolve(__dirname, "../../styles/globals.css"),
  "utf8"
);

const THEME_SELECTORS = [
  "body.vscode-dark",
  "body.vscode-light",
  "body.vscode-high-contrast",
  "body.vscode-high-contrast-light",
];

/** Declarations of every rule whose selector list contains `selector`. */
function declarationsFor(selector: string): string {
  const pattern = new RegExp(
    `(^|[\\s,])${selector.replace(/[.-]/g, "\\$&")}\\s*(,[^{]*)?\\{([^}]*)\\}`,
    "gm"
  );
  const rules = [...globalsCss.matchAll(pattern)];
  if (rules.length === 0) {
    throw new Error(`No rule for ${selector} in globals.css`);
  }
  return rules.map((rule) => rule[3]).join("\n");
}

interface CssRule {
  offset: number;
  selectors: string[];
  properties: Set<string>;
}

/** Innermost style rules of globals.css with their source offsets. */
function parseRules(): CssRule[] {
  const css = globalsCss.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    " ".repeat(comment.length)
  );
  return [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((match) => ({
    offset: match.index ?? 0,
    selectors: match[1].split(",").map((selector) => selector.trim()),
    properties: new Set(
      [...match[2].matchAll(/([\w-]+)\s*:/g)].map((decl) => decl[1])
    ),
  }));
}

describe("syntax palette", () => {
  // VS Code (and the hosted server) give a high-contrast light body both
  // `vscode-high-contrast` and `vscode-high-contrast-light`. Both selectors
  // have equal specificity, so the light rule only wins by coming later.
  it("orders body.vscode-high-contrast-light after body.vscode-high-contrast", () => {
    const rules = parseRules();
    const highContrast = rules.filter((rule) =>
      rule.selectors.includes("body.vscode-high-contrast")
    );
    const highContrastLight = rules.filter((rule) =>
      rule.selectors.includes("body.vscode-high-contrast-light")
    );
    const syntaxVariable = syntaxRoleVariable(SYNTAX_ROLES.KEYWORD);
    expect(
      highContrast.some((rule) => rule.properties.has(syntaxVariable))
    ).toBe(true);
    expect(
      highContrastLight.some((rule) => rule.properties.has(syntaxVariable))
    ).toBe(true);

    for (const dark of highContrast) {
      for (const light of highContrastLight) {
        const shared = [...dark.properties].filter((property) =>
          light.properties.has(property)
        );
        if (shared.length === 0) continue;
        expect(
          light.offset,
          `${shared.join(", ")} must be overridden by the high-contrast light rule`
        ).toBeGreaterThan(dark.offset);
      }
    }
  });

  it.each(THEME_SELECTORS)("defines every role for %s", (selector) => {
    const declarations = declarationsFor(selector);
    for (const role of Object.values(SYNTAX_ROLES)) {
      expect(declarations).toContain(`${syntaxRoleVariable(role)}:`);
    }
  });

  it("colours keywords as keywords, not with the purple symbol-icon variable", () => {
    const css = buildSyntaxTokenStyles();
    expect(css).not.toContain("symbolIcon");
    expect(css).toMatch(
      /\.cy-syntax \.token\.keyword[^{]*\{\s*color: var\(--cy-syntax-keyword\);/
    );
    expect(declarationsFor("body.vscode-dark")).toContain(
      "--cy-syntax-keyword: #569cd6;"
    );
  });

  it("generates the refractor CSS from the shared role table", () => {
    expect(buildSyntaxTokenStyles()).toMatchInlineSnapshot(`
      "/* ctrlyoke - refractor tokens, coloured by the shared --cy-syntax-* palette */

      .cy-syntax {
        color: var(--vscode-editor-foreground, #d4d4d4);
      }

      .cy-syntax .token,
      .diff .token {
        color: inherit;
      }

      .cy-syntax .token.table,
      .diff .token.table {
        display: inline;
      }

      .cy-syntax .token.keyword,
      .cy-syntax .token.atrule,
      .cy-syntax .token.important,
      .cy-syntax .token.entity,
      .diff .token.keyword,
      .diff .token.atrule,
      .diff .token.important,
      .diff .token.entity {
        color: var(--cy-syntax-keyword);
      }

      .cy-syntax .token.string,
      .cy-syntax .token.char,
      .cy-syntax .token.attr-value,
      .diff .token.string,
      .diff .token.char,
      .diff .token.attr-value {
        color: var(--cy-syntax-string);
      }

      .cy-syntax .token.number,
      .diff .token.number {
        color: var(--cy-syntax-number);
      }

      .cy-syntax .token.comment,
      .cy-syntax .token.prolog,
      .cy-syntax .token.doctype,
      .cy-syntax .token.cdata,
      .diff .token.comment,
      .diff .token.prolog,
      .diff .token.doctype,
      .diff .token.cdata {
        color: var(--cy-syntax-comment);
      }

      .cy-syntax .token.function,
      .cy-syntax .token.annotation,
      .cy-syntax .token.decorator,
      .diff .token.function,
      .diff .token.annotation,
      .diff .token.decorator {
        color: var(--cy-syntax-function);
      }

      .cy-syntax .token.class-name,
      .cy-syntax .token.maybe-class-name,
      .cy-syntax .token.builtin,
      .cy-syntax .token.namespace,
      .diff .token.class-name,
      .diff .token.maybe-class-name,
      .diff .token.builtin,
      .diff .token.namespace {
        color: var(--cy-syntax-type);
      }

      .cy-syntax .token.variable,
      .cy-syntax .token.parameter,
      .cy-syntax .token.constant,
      .diff .token.variable,
      .diff .token.parameter,
      .diff .token.constant {
        color: var(--cy-syntax-variable);
      }

      .cy-syntax .token.property,
      .diff .token.property {
        color: var(--cy-syntax-property);
      }

      .cy-syntax .token.attr-name,
      .diff .token.attr-name {
        color: var(--cy-syntax-attribute);
      }

      .cy-syntax .token.boolean,
      .cy-syntax .token.null,
      .cy-syntax .token.symbol,
      .diff .token.boolean,
      .diff .token.null,
      .diff .token.symbol {
        color: var(--cy-syntax-boolean);
      }

      .cy-syntax .token.regex,
      .diff .token.regex {
        color: var(--cy-syntax-regexp);
      }

      .cy-syntax .token.tag,
      .diff .token.tag {
        color: var(--cy-syntax-tag);
      }

      .cy-syntax .token.selector,
      .cy-syntax .token.selector-class,
      .cy-syntax .token.selector-id,
      .cy-syntax .token.selector-pseudo-class,
      .cy-syntax .token.selector-pseudo-element,
      .diff .token.selector,
      .diff .token.selector-class,
      .diff .token.selector-id,
      .diff .token.selector-pseudo-class,
      .diff .token.selector-pseudo-element {
        color: var(--cy-syntax-selector);
      }

      .cy-syntax .token.url,
      .diff .token.url {
        color: var(--cy-syntax-url);
      }

      .cy-syntax .token.title,
      .diff .token.title {
        color: var(--cy-syntax-heading);
        font-weight: bold;
      }

      .cy-syntax .token.bold,
      .diff .token.bold {
        color: var(--cy-syntax-strong);
        font-weight: bold;
      }

      .cy-syntax .token.italic,
      .diff .token.italic {
        color: var(--cy-syntax-emphasis);
        font-style: italic;
      }

      .cy-syntax .token.strike,
      .diff .token.strike {
        text-decoration: line-through;
      }

      .cy-syntax .token.code-snippet,
      .diff .token.code-snippet {
        color: var(--cy-syntax-inline-code);
      }

      .cy-syntax .token.blockquote,
      .diff .token.blockquote {
        color: var(--cy-syntax-quote);
      }

      .cy-syntax .token.list,
      .diff .token.list {
        color: var(--cy-syntax-list-marker);
      }"
    `);
  });

  it("generates the HighlightStyle spec from the shared role table", () => {
    const spec = getCtrlYokeHighlightSpec().map(({ tag, ...style }) => ({
      tag: tag.map(String),
      ...style,
    }));
    expect(spec).toMatchInlineSnapshot(`
      [
        {
          "color": "var(--cy-syntax-keyword)",
          "tag": [
            "keyword",
            "definitionKeyword",
            "modifier",
            "operatorKeyword",
            "moduleKeyword",
          ],
        },
        {
          "color": "var(--cy-syntax-control-keyword)",
          "tag": [
            "controlKeyword",
          ],
        },
        {
          "color": "var(--cy-syntax-string)",
          "tag": [
            "string",
            "character",
            "attributeValue",
          ],
        },
        {
          "color": "var(--cy-syntax-number)",
          "tag": [
            "number",
          ],
        },
        {
          "color": "var(--cy-syntax-comment)",
          "tag": [
            "comment",
          ],
        },
        {
          "color": "var(--cy-syntax-function)",
          "tag": [
            "function(variableName)",
            "function(propertyName)",
            "function(name)",
          ],
        },
        {
          "color": "var(--cy-syntax-type)",
          "tag": [
            "className",
            "typeName",
            "namespace",
          ],
        },
        {
          "color": "var(--cy-syntax-variable)",
          "tag": [
            "variableName",
          ],
        },
        {
          "color": "var(--cy-syntax-property)",
          "tag": [
            "propertyName",
          ],
        },
        {
          "color": "var(--cy-syntax-attribute)",
          "tag": [
            "attributeName",
          ],
        },
        {
          "color": "var(--cy-syntax-boolean)",
          "tag": [
            "bool",
            "null",
            "atom",
          ],
        },
        {
          "color": "var(--cy-syntax-regexp)",
          "tag": [
            "regexp",
          ],
        },
        {
          "color": "var(--cy-syntax-tag)",
          "tag": [
            "tagName",
          ],
        },
        {
          "color": "var(--cy-syntax-url)",
          "tag": [
            "url",
          ],
        },
        {
          "color": "var(--cy-syntax-string)",
          "tag": [
            "link",
          ],
        },
        {
          "color": "var(--cy-syntax-heading)",
          "fontWeight": "bold",
          "tag": [
            "heading",
          ],
        },
        {
          "color": "var(--cy-syntax-strong)",
          "fontWeight": "bold",
          "tag": [
            "strong",
          ],
        },
        {
          "color": "var(--cy-syntax-emphasis)",
          "fontStyle": "italic",
          "tag": [
            "emphasis",
          ],
        },
        {
          "tag": [
            "strikethrough",
          ],
          "textDecoration": "line-through",
        },
        {
          "color": "var(--cy-syntax-inline-code)",
          "tag": [
            "monospace",
          ],
        },
        {
          "color": "var(--cy-syntax-quote)",
          "tag": [
            "quoteMark",
          ],
        },
        {
          "color": "var(--cy-syntax-list-marker)",
          "tag": [
            "listMark",
          ],
        },
      ]
    `);
  });

  it("resolves Lezer tags to the palette variables", () => {
    const style = createCtrlYokeHighlightStyle();
    expect(createCtrlYokeHighlightStyle()).toBe(style);

    const rules = style.module?.getRules() ?? "";
    const ruleFor = (tag: Tag) => {
      const className = style.style([tag]);
      expect(className).toBeTruthy();
      return (
        rules.split("\n").find((line) => line.includes(`.${className} {`)) ?? ""
      );
    };

    expect(ruleFor(tags.keyword)).toContain("var(--cy-syntax-keyword)");
    expect(ruleFor(tags.controlKeyword)).toContain(
      "var(--cy-syntax-control-keyword)"
    );
    expect(ruleFor(tags.definition(tags.variableName))).toContain(
      "var(--cy-syntax-variable)"
    );
    expect(ruleFor(tags.heading1)).toMatch(
      /var\(--cy-syntax-heading\).*font-weight: bold/
    );
    expect(ruleFor(tags.strikethrough)).toContain(
      "text-decoration: line-through"
    );
  });
});

describe("resolveCodeMirrorLanguage", () => {
  it("resolves fence info strings and aliases", () => {
    expect(resolveCodeMirrorLanguage("ts")?.language.name).toBe("typescript");
    expect(resolveFenceLanguage("language-yml")).toBe(
      resolveFenceLanguage("yaml")
    );
    expect(resolveFenceLanguage("yaml")?.name).toBe("yaml");
    expect(resolveCodeMirrorLanguage("yaml")).toBeNull();
    expect(resolveCodeMirrorLanguage("JSON")?.language.name).toBe("json");
    expect(resolveCodeMirrorLanguage("md")?.language.name).toBe("markdown");
  });

  it("returns null for plain text and unsupported languages", () => {
    expect(resolveCodeMirrorLanguage(undefined)).toBeNull();
    expect(resolveCodeMirrorLanguage("")).toBeNull();
    expect(resolveCodeMirrorLanguage("not-a-language")).toBeNull();
    // refractor knows Go, but the workspace editor ships no CodeMirror mode.
    expect(resolveCodeMirrorLanguage("go")).toBeNull();
  });

  it("backs getLanguageExtension for file paths", () => {
    const extension = getLanguageExtension("src\\App.TSX");
    expect(Array.isArray(extension)).toBe(false);
    if (!extension || Array.isArray(extension)) {
      throw new Error("Expected TypeScript language support");
    }
    expect(extension.language.name).toBe("typescript");
    expect(getLanguageExtension("notes.txt")).toBeNull();
  });
});
