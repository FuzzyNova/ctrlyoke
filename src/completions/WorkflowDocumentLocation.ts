import {
  CTRLYOKE_FILE_KINDS,
  WORKFLOW_LOCATION_ROLES,
  WORKFLOW_OBJECT_KINDS,
  type CtrlYokeFileKind,
} from "../types/DashboardConstants";
import { locateMarkdownFrontmatter } from "../utils/MarkdownFrontmatter";
import {
  findJsonRangeForPath,
  getJsonWorkflowLocation,
} from "./WorkflowLocationJson";
import type {
  WorkflowLocation,
  WorkflowPath,
  WorkflowTextRange,
} from "./WorkflowLocationTypes";
import {
  findYamlRangeForPath,
  getYamlWorkflowLocation,
} from "./WorkflowLocationYaml";

export {
  WORKFLOW_TEXT_FIELDS,
  type WorkflowLocation,
  type WorkflowPath,
  type WorkflowTextRange,
} from "./WorkflowLocationTypes";

/**
 * Where the cursor is in a ctrlyoke file, and what the schema says lives there.
 * Pure: no `vscode`, no `fs`. The hosted webview imports `WorkflowLocationJson`
 * and loads `WorkflowLocationYaml` lazily instead of this facade.
 */
export function getWorkflowLocation(
  text: string,
  offset: number,
  kind: CtrlYokeFileKind
): WorkflowLocation {
  switch (kind) {
    case CTRLYOKE_FILE_KINDS.WORKFLOW_JSON:
      return getJsonWorkflowLocation(text, offset);
    case CTRLYOKE_FILE_KINDS.WORKFLOW_YAML:
      return getYamlWorkflowLocation(text, offset, kind);
    case CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN:
      return getMarkdownWorkflowLocation(text, offset);
  }
}

/**
 * The inverse of `getWorkflowLocation`, for diagnostics: the range of the node
 * at `path`, or of the nearest ancestor that exists.
 */
export function findRangeForPath(
  text: string,
  path: WorkflowPath,
  kind: CtrlYokeFileKind
): WorkflowTextRange | undefined {
  switch (kind) {
    case CTRLYOKE_FILE_KINDS.WORKFLOW_JSON:
      return findJsonRangeForPath(text, path);
    case CTRLYOKE_FILE_KINDS.WORKFLOW_YAML:
      return findYamlRangeForPath(text, path);
    case CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN: {
      const { frontmatter, body } = splitPromptMarkdown(text);
      if (path.length === 0 || !frontmatter) return body;
      const range = findYamlRangeForPath(frontmatter.text, path);
      return range && shiftRange(range, frontmatter.start);
    }
  }
}

export interface PromptMarkdownParts {
  readonly frontmatter?: { readonly text: string; readonly start: number };
  readonly body: WorkflowTextRange;
}

/**
 * `.prompt.md` is an optional YAML frontmatter block, then prompt text. Uses
 * the loader's own splitter, so a BOM or an empty block is handled the same.
 */
export function splitPromptMarkdown(text: string): PromptMarkdownParts {
  const { frontmatter, bodyStart } = locateMarkdownFrontmatter(text);
  const body = { start: bodyStart, end: text.length };
  if (!frontmatter) return { body };
  return {
    frontmatter: {
      text: text.slice(frontmatter.start, frontmatter.end),
      start: frontmatter.start,
    },
    body,
  };
}

const shiftRange = (
  range: WorkflowTextRange,
  by: number
): WorkflowTextRange => ({ start: range.start + by, end: range.end + by });

function getMarkdownWorkflowLocation(
  text: string,
  offset: number
): WorkflowLocation {
  const kind = CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN;
  const { frontmatter, body } = splitPromptMarkdown(text);
  if (offset >= body.start) {
    return {
      kind,
      path: [],
      role: WORKFLOW_LOCATION_ROLES.PROMPT_TEXT,
      objectKind: WORKFLOW_OBJECT_KINDS.PROMPT_FILE_BODY,
      siblingKeys: [],
      valueRange: body,
    };
  }
  const frontmatterLocation =
    frontmatter &&
    offset >= frontmatter.start &&
    offset <= frontmatter.start + frontmatter.text.length
      ? getYamlWorkflowLocation(frontmatter.text, offset - frontmatter.start)
      : undefined;
  if (!frontmatter || !frontmatterLocation) {
    // On a `---` fence line: nothing to complete.
    return {
      kind,
      path: [],
      role: WORKFLOW_LOCATION_ROLES.NONE,
      objectKind: WORKFLOW_OBJECT_KINDS.PROMPT_FILE_FRONTMATTER,
      siblingKeys: [],
    };
  }
  // Frontmatter holds only metadata, so its scalars are never prompt text.
  const isText =
    frontmatterLocation.role === WORKFLOW_LOCATION_ROLES.PROMPT_TEXT ||
    frontmatterLocation.role === WORKFLOW_LOCATION_ROLES.SCRIPT_TEXT;
  return {
    ...frontmatterLocation,
    kind,
    objectKind: WORKFLOW_OBJECT_KINDS.PROMPT_FILE_FRONTMATTER,
    role: isText ? WORKFLOW_LOCATION_ROLES.VALUE : frontmatterLocation.role,
    valueRange:
      frontmatterLocation.valueRange &&
      shiftRange(frontmatterLocation.valueRange, frontmatter.start),
  };
}
