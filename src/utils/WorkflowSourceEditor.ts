import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";
import {
  isCollection,
  isMap,
  isSeq,
  parseDocument,
  stringify,
  type Node,
  type YAMLMap,
} from "yaml";

export type WorkflowSourceFormat = "yaml" | "json";

const UTF8_BOM = "\uFEFF";

/** Match the indentation and line endings used by JSONC source editors. */
export function detectFormattingOptions(
  text: string,
  defaultTabSize = 4
): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const firstIndentMatch = text.match(/\n([ \t]+)/);
  if (firstIndentMatch) {
    const indent = firstIndentMatch[1]!;
    if (indent[0] === "\t") {
      return { insertSpaces: false, tabSize: 4, eol };
    }
    return { insertSpaces: true, tabSize: indent.length, eol };
  }
  return { insertSpaces: false, tabSize: defaultTabSize, eol };
}

/** Parse JSON/JSONC workflow source without discarding comments on disk. */
export function parseWorkflowSourceJson(raw: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(stripBom(raw), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  if (errors.length > 0) {
    throw new SyntaxError(`Invalid JSON workflow source: ${errors[0]!.error}`);
  }
  return parsed;
}

/**
 * Set one top-level property while retaining the user's source formatting.
 * JSON uses the JSONC parser so comments in `.json` workflow files survive.
 */
export function setWorkflowSourceTopLevelKey(
  raw: string,
  format: WorkflowSourceFormat,
  key: string,
  value: unknown
): string {
  const hasBom = raw.startsWith(UTF8_BOM);
  const source = stripBom(raw);
  let edited: string;
  if (format === "yaml") {
    const document = parseDocument(source, {
      merge: true,
      prettyErrors: false,
      toStringDefaults: { lineWidth: 0 },
    });
    if (document.errors.length > 0) {
      throw document.errors[0];
    }
    if (!isMap(document.contents)) {
      throw new Error("The active workflow file has an invalid root object.");
    }
    edited = setYamlTopLevelKey(source, document, key, value);
  } else {
    const parsed = parseWorkflowSourceJson(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("The active workflow file has an invalid root object.");
    }

    const edits = modify(source, [key], value, {
      formattingOptions: detectFormattingOptions(source),
    });
    edited = applyEdits(source, edits);
  }

  return hasBom ? `${UTF8_BOM}${edited}` : edited;
}

function stripBom(text: string): string {
  return text.startsWith(UTF8_BOM) ? text.slice(1) : text;
}

function setYamlTopLevelKey(
  source: string,
  document: ReturnType<typeof parseDocument>,
  key: string,
  value: unknown
): string {
  const root = document.contents;
  if (!isMap(root)) {
    throw new Error("The active workflow file has an invalid root object.");
  }

  const pair = root.items.find((item) => item.key && String(item.key) === key);
  const existingValue = pair?.value as Node | null | undefined;
  if (existingValue?.range) {
    const [start, end] = existingValue.range;
    if (start !== undefined && end !== undefined) {
      const replacement = renderYamlValue(value, existingValue, source, start);
      const eol = source.includes("\r\n") ? "\r\n" : "\n";
      const preservedLineEnding =
        !isCollection(existingValue) || existingValue.flow
          ? ""
          : /(?:\r\n|\n)$/.test(source.slice(0, end))
            ? eol
            : "";
      return `${source.slice(0, start)}${replacement}${preservedLineEnding}${source.slice(end)}`;
    }
  }

  if (root.flow && root.range?.[1] !== undefined) {
    const closeBrace = source.lastIndexOf("}", root.range[1] - 1);
    if (closeBrace >= 0) {
      const separator = root.items.length > 0 ? ", " : "";
      const flowValue = stringify(value, {
        collectionStyle: "flow",
        lineWidth: 0,
      }).trim();
      return `${source.slice(0, closeBrace)}${separator}${key}: ${flowValue}${source.slice(closeBrace)}`;
    }
  }

  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  const sequenceIndent = inferSequenceIndent(root, source);
  const itemText = stringify(value, { lineWidth: 0 }).trimEnd();
  const indentedItems = itemText
    .split(/\r?\n/)
    .map((line) => `${sequenceIndent}${line}`)
    .join(eol);
  const prefix = source.length > 0 && !source.endsWith("\n") ? eol : "";
  return `${source}${prefix}${key}:${eol}${indentedItems}${eol}`;
}

function renderYamlValue(
  value: unknown,
  existing: Node,
  source: string,
  start: number
): string {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const indent = source.slice(lineStart, start).match(/^[ \t]*/)?.[0] ?? "";
  const eol = source.includes("\r\n") ? "\r\n" : "\n";
  // A scalar or empty value sits on the key's line, where only flow style is valid.
  if (!isCollection(existing) || existing.flow) {
    const flowValue = stringify(value, {
      collectionStyle: "flow",
      lineWidth: 0,
    }).trim();
    return source[start - 1] === ":" ? ` ${flowValue}` : flowValue;
  }
  return stringify(value, { lineWidth: 0 })
    .trimEnd()
    .split(/\r?\n/)
    .map((line, index) => (index === 0 ? line : `${indent}${line}`))
    .join(eol);
}

function inferSequenceIndent(root: YAMLMap, source: string): string {
  for (const item of root.items) {
    if (isSeq(item.value) && item.value.range) {
      const start = item.value.range[0];
      if (start !== undefined) {
        const lineStart = source.lastIndexOf("\n", start - 1) + 1;
        return source.slice(lineStart, start).match(/^[ \t]*/)?.[0] ?? "";
      }
    }
  }
  const formatting = detectFormattingOptions(source);
  return formatting.insertSpaces ? " ".repeat(formatting.tabSize ?? 4) : "";
}
