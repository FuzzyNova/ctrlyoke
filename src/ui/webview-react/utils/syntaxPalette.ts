import { HighlightStyle } from "@codemirror/language";
import { Tag, tags } from "@lezer/highlight";

/**
 * Single source for syntax colours across the dashboard.
 *
 * Each role resolves to a `--cy-syntax-<role>` CSS custom property whose
 * per-theme values live in `styles/globals.css` (with the table explaining
 * where each colour came from). Two generators read {@link SYNTAX_ROLE_SPECS}:
 *
 * - {@link createCtrlYokeHighlightStyle} — the CodeMirror `HighlightStyle`
 *   (Lezer tags) for the workspace editor and, later, the prompt editor.
 * - {@link buildSyntaxTokenStyles} — the refractor CSS for output code blocks
 *   and diffs (`.cy-syntax` / `.diff` token classes).
 */
export const SYNTAX_ROLES = {
  KEYWORD: "keyword",
  CONTROL_KEYWORD: "control-keyword",
  STRING: "string",
  NUMBER: "number",
  COMMENT: "comment",
  FUNCTION: "function",
  TYPE: "type",
  VARIABLE: "variable",
  PROPERTY: "property",
  ATTRIBUTE: "attribute",
  BOOLEAN: "boolean",
  REGEXP: "regexp",
  TAG: "tag",
  SELECTOR: "selector",
  URL: "url",
  HEADING: "heading",
  STRONG: "strong",
  EMPHASIS: "emphasis",
  INLINE_CODE: "inline-code",
  QUOTE: "quote",
  LIST_MARKER: "list-marker",
} as const;

export type SyntaxRole = (typeof SYNTAX_ROLES)[keyof typeof SYNTAX_ROLES];

/** CSS custom property name for a role, e.g. `--cy-syntax-keyword`. */
export function syntaxRoleVariable(role: SyntaxRole): string {
  return `--cy-syntax-${role}`;
}

/** CSS colour value for a role, e.g. `var(--cy-syntax-keyword)`. */
export function syntaxRoleColor(role: SyntaxRole): string {
  return `var(${syntaxRoleVariable(role)})`;
}

/**
 * Lezer tags every markdown mark as `processingInstruction`. The markdown
 * configuration in `codemirrorLanguage.ts` retags `QuoteMark` and `ListMark`
 * with these (children of `processingInstruction`, so an unconfigured theme
 * still treats them as marks) so the quote and list-marker roles can colour
 * them the way refractor already does.
 */
export const QUOTE_MARK_TAG = Tag.define(
  "quoteMark",
  tags.processingInstruction
);
export const LIST_MARK_TAG = Tag.define("listMark", tags.processingInstruction);

interface SyntaxRoleSpec {
  /** Colour role; omitted for entries that only change font style/decoration. */
  role?: SyntaxRole;
  /** Lezer tags styled by the CodeMirror HighlightStyle. */
  tags: readonly Tag[];
  /** refractor (Prism) token classes styled in output code blocks. */
  tokenClasses: readonly string[];
  fontWeight?: "bold";
  fontStyle?: "italic";
  textDecoration?: "line-through";
}

/**
 * Role → Lezer tags and refractor token classes. Order matters for the
 * refractor CSS: rules at equal specificity resolve by source order, and
 * refractor's markdown grammar aliases `title` to `important`, so the
 * markdown entries come last.
 */
export const SYNTAX_ROLE_SPECS: readonly SyntaxRoleSpec[] = [
  {
    role: SYNTAX_ROLES.KEYWORD,
    tags: [
      tags.keyword,
      tags.definitionKeyword,
      tags.modifier,
      tags.operatorKeyword,
      tags.moduleKeyword,
    ],
    tokenClasses: ["keyword", "atrule", "important", "entity"],
  },
  {
    role: SYNTAX_ROLES.CONTROL_KEYWORD,
    tags: [tags.controlKeyword],
    tokenClasses: [],
  },
  {
    role: SYNTAX_ROLES.STRING,
    tags: [tags.string, tags.character, tags.attributeValue],
    tokenClasses: ["string", "char", "attr-value"],
  },
  {
    role: SYNTAX_ROLES.NUMBER,
    tags: [tags.number],
    tokenClasses: ["number"],
  },
  {
    role: SYNTAX_ROLES.COMMENT,
    tags: [tags.comment],
    tokenClasses: ["comment", "prolog", "doctype", "cdata"],
  },
  {
    role: SYNTAX_ROLES.FUNCTION,
    tags: [
      tags.function(tags.variableName),
      tags.function(tags.propertyName),
      tags.function(tags.name),
    ],
    tokenClasses: ["function", "annotation", "decorator"],
  },
  {
    role: SYNTAX_ROLES.TYPE,
    tags: [tags.className, tags.typeName, tags.namespace],
    tokenClasses: ["class-name", "maybe-class-name", "builtin", "namespace"],
  },
  {
    role: SYNTAX_ROLES.VARIABLE,
    tags: [tags.variableName],
    tokenClasses: ["variable", "parameter", "constant"],
  },
  {
    role: SYNTAX_ROLES.PROPERTY,
    tags: [tags.propertyName],
    tokenClasses: ["property"],
  },
  {
    role: SYNTAX_ROLES.ATTRIBUTE,
    tags: [tags.attributeName],
    tokenClasses: ["attr-name"],
  },
  {
    role: SYNTAX_ROLES.BOOLEAN,
    tags: [tags.bool, tags.null, tags.atom],
    tokenClasses: ["boolean", "null", "symbol"],
  },
  {
    role: SYNTAX_ROLES.REGEXP,
    tags: [tags.regexp],
    tokenClasses: ["regex"],
  },
  {
    role: SYNTAX_ROLES.TAG,
    tags: [tags.tagName],
    tokenClasses: ["tag"],
  },
  {
    role: SYNTAX_ROLES.SELECTOR,
    tags: [],
    tokenClasses: [
      "selector",
      "selector-class",
      "selector-id",
      "selector-pseudo-class",
      "selector-pseudo-element",
    ],
  },
  {
    role: SYNTAX_ROLES.URL,
    tags: [tags.url],
    tokenClasses: ["url"],
  },
  // Markdown. Link text takes the string colour, as VS Code's
  // `string.other.link.title.markdown` scope does.
  {
    role: SYNTAX_ROLES.STRING,
    tags: [tags.link],
    tokenClasses: [],
  },
  {
    role: SYNTAX_ROLES.HEADING,
    tags: [tags.heading],
    tokenClasses: ["title"],
    fontWeight: "bold",
  },
  {
    role: SYNTAX_ROLES.STRONG,
    tags: [tags.strong],
    tokenClasses: ["bold"],
    fontWeight: "bold",
  },
  {
    role: SYNTAX_ROLES.EMPHASIS,
    tags: [tags.emphasis],
    tokenClasses: ["italic"],
    fontStyle: "italic",
  },
  {
    tags: [tags.strikethrough],
    tokenClasses: ["strike"],
    textDecoration: "line-through",
  },
  {
    role: SYNTAX_ROLES.INLINE_CODE,
    tags: [tags.monospace],
    tokenClasses: ["code-snippet"],
  },
  {
    role: SYNTAX_ROLES.QUOTE,
    tags: [QUOTE_MARK_TAG],
    tokenClasses: ["blockquote"],
  },
  {
    role: SYNTAX_ROLES.LIST_MARKER,
    tags: [LIST_MARK_TAG],
    tokenClasses: ["list"],
  },
];

function styleProperties(spec: SyntaxRoleSpec): Record<string, string> {
  const properties: Record<string, string> = {};
  if (spec.role) properties.color = syntaxRoleColor(spec.role);
  if (spec.fontWeight) properties.fontWeight = spec.fontWeight;
  if (spec.fontStyle) properties.fontStyle = spec.fontStyle;
  if (spec.textDecoration) properties.textDecoration = spec.textDecoration;
  return properties;
}

/** The HighlightStyle spec, exported separately so tests can snapshot it. */
export function getCtrlYokeHighlightSpec() {
  return SYNTAX_ROLE_SPECS.filter((spec) => spec.tags.length > 0).map(
    (spec) => ({ tag: [...spec.tags], ...styleProperties(spec) })
  );
}

let cachedHighlightStyle: HighlightStyle | undefined;

/** Shared CodeMirror HighlightStyle mapping Lezer tags to `--cy-syntax-*`. */
export function createCtrlYokeHighlightStyle(): HighlightStyle {
  cachedHighlightStyle ??= HighlightStyle.define(getCtrlYokeHighlightSpec());
  return cachedHighlightStyle;
}

const TOKEN_SCOPES = [".cy-syntax", ".diff"] as const;

function toCssDeclarations(properties: Record<string, string>): string {
  return Object.entries(properties)
    .map(
      ([name, value]) =>
        `  ${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}: ${value};`
    )
    .join("\n");
}

/** refractor token CSS for output code blocks and diffs. */
export function buildSyntaxTokenStyles(): string {
  const rules = SYNTAX_ROLE_SPECS.filter(
    (spec) => spec.tokenClasses.length > 0
  ).map((spec) => {
    const selectors = TOKEN_SCOPES.flatMap((scope) =>
      spec.tokenClasses.map((token) => `${scope} .token.${token}`)
    );
    return `${selectors.join(",\n")} {\n${toCssDeclarations(styleProperties(spec))}\n}`;
  });

  return [
    "/* ctrlyoke - refractor tokens, coloured by the shared --cy-syntax-* palette */",
    ".cy-syntax {\n  color: var(--vscode-editor-foreground, #d4d4d4);\n}",
    ".cy-syntax .token,\n.diff .token {\n  color: inherit;\n}",
    ...rules,
  ].join("\n\n");
}
