import {
  CTRLYOKE_FILE_KINDS,
  WORKFLOW_LOCATION_ROLES,
  WORKFLOW_OBJECT_KINDS,
  type CtrlYokeFileKind,
} from "../types/DashboardConstants";
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

interface PromptMarkdownParts {
  readonly frontmatter?: { readonly text: string; readonly start: number };
  readonly body: WorkflowTextRange;
}

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** `.prompt.md` is an optional YAML frontmatter block, then prompt text. */
function splitPromptMarkdown(text: string): PromptMarkdownParts {
  const match = FRONTMATTER.exec(text);
  if (!match) return { body: { start: 0, end: text.length } };
  const start = match[0].indexOf(match[1]);
  return {
    frontmatter: { text: match[1], start },
    body: { start: match[0].length, end: text.length },
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
