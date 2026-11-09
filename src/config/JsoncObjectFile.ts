import * as fs from "fs";
import { parse, stripComments, type ParseError } from "jsonc-parser";
import { NODE_ERROR_CODES } from "../types/DashboardConstants";
import { hasErrnoCode } from "../utils/ErrorUtils";
import { stripLeadingBom } from "../utils/TextUtils";

export const JSONC_OBJECT_FILE_RESULT_KIND = {
  MISSING: "missing",
  EMPTY: "empty",
  INVALID: "invalid",
  OBJECT: "object",
} as const;

export type JsoncObjectFileReadResult =
  | { kind: typeof JSONC_OBJECT_FILE_RESULT_KIND.MISSING }
  | { kind: typeof JSONC_OBJECT_FILE_RESULT_KIND.EMPTY }
  | { kind: typeof JSONC_OBJECT_FILE_RESULT_KIND.INVALID }
  | {
      kind: typeof JSONC_OBJECT_FILE_RESULT_KIND.OBJECT;
      value: Record<string, unknown>;
    };

/** Read a JSONC file whose root must be an object. */
export function readJsoncObjectFile(
  filePath: string
): JsoncObjectFileReadResult {
  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch (error) {
    if (hasErrnoCode(error, NODE_ERROR_CODES.ENOENT)) {
      return { kind: JSONC_OBJECT_FILE_RESULT_KIND.MISSING };
    }
    return { kind: JSONC_OBJECT_FILE_RESULT_KIND.INVALID };
  }

  const normalizedContent = stripLeadingBom(content);
  if (stripComments(normalizedContent).trim() === "") {
    return { kind: JSONC_OBJECT_FILE_RESULT_KIND.EMPTY };
  }

  const errors: ParseError[] = [];
  const parsed: unknown = parse(normalizedContent, errors, {
    allowTrailingComma: true,
  });
  if (
    errors.length > 0 ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return { kind: JSONC_OBJECT_FILE_RESULT_KIND.INVALID };
  }

  return {
    kind: JSONC_OBJECT_FILE_RESULT_KIND.OBJECT,
    value: parsed as Record<string, unknown>,
  };
}
