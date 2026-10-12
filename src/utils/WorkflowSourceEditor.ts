import {
  applyEdits,
  modify,
  parse as parseJsonc,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser";
import { isMap, parseDocument } from "yaml";

export type WorkflowSourceFormat = "yaml" | "json";

/** Parse JSON/JSONC workflow source without discarding comments on disk. */
export function parseWorkflowSourceJson(raw: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, {
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
  if (format === "yaml") {
    const document = parseDocument(raw, {
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
    document.setIn([key], value);
    return String(document);
  }

  const parsed = parseWorkflowSourceJson(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The active workflow file has an invalid root object.");
  }

  const edits = modify(raw, [key], value, {
    formattingOptions: detectFormattingOptions(raw),
  });
  return applyEdits(raw, edits);
}

function detectFormattingOptions(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const firstIndentMatch = text.match(/\n([ \t]+)/);
  if (firstIndentMatch) {
    const indent = firstIndentMatch[1]!;
    if (indent[0] === "\t") {
      return { insertSpaces: false, tabSize: 4, eol };
    }
    return { insertSpaces: true, tabSize: indent.length, eol };
  }
  return { insertSpaces: false, tabSize: 4, eol };
}
