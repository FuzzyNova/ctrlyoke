import {
  CTRLYOKE_FILE_KINDS,
  WORKFLOW_LOCATION_ROLES,
  WORKFLOW_OBJECT_KINDS,
  type CtrlYokeFileKind,
  type WorkflowLocationRole,
} from "../types/DashboardConstants";
import { splitPromptMarkdown } from "./WorkflowDocumentLocation";
import { getJsonTextSpans } from "./WorkflowLocationJson";
import { getYamlTextSpans } from "./WorkflowLocationYaml";
import { createTextSpan, type WorkflowTextSpan } from "./WorkflowTextDecoding";

export type { WorkflowTextSpan } from "./WorkflowTextDecoding";

/**
 * Every prompt (or, with `role`, script) value in a ctrlyoke file, as the
 * loader decodes it, with a map from decoded offsets back to the document.
 *
 * Rules that work on prompt text (`findCodeRanges`, reference scanning,
 * prompt lint) run on `span.text` and report through `span.toSourceOffset`.
 * Running them on the raw file is wrong: a YAML block body is indented (so a
 * fence looks indented past CommonMark's three spaces) and JSON strings are
 * escaped. Pure: no `vscode`, no `fs`. Like `getWorkflowLocation`, this
 * facade imports the YAML half statically and is for the Node and VS Code
 * hosts.
 */
export function getWorkflowTextSpans(
  text: string,
  kind: CtrlYokeFileKind,
  role: WorkflowLocationRole = WORKFLOW_LOCATION_ROLES.PROMPT_TEXT
): WorkflowTextSpan[] {
  switch (kind) {
    case CTRLYOKE_FILE_KINDS.WORKFLOW_JSON:
      return getJsonTextSpans(text, role);
    case CTRLYOKE_FILE_KINDS.WORKFLOW_YAML:
      return getYamlTextSpans(text, role, kind);
    case CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN:
      return role === WORKFLOW_LOCATION_ROLES.PROMPT_TEXT
        ? [promptMarkdownBody(text)]
        : [];
  }
}

/**
 * The body after the frontmatter, trimmed as `PromptFileParser` trims it.
 * Nothing else is decoded, so offsets map 1:1.
 */
function promptMarkdownBody(text: string): WorkflowTextSpan {
  const { body } = splitPromptMarkdown(text);
  const raw = text.slice(body.start, body.end);
  const trimmed = raw.trim();
  const start = body.start + (trimmed ? raw.indexOf(trimmed) : 0);
  const sourceRange = { start, end: start + trimmed.length };
  const sourceOffsets = Array.from(
    { length: trimmed.length + 1 },
    (_, index) => start + index
  );
  return createTextSpan(
    {
      kind: CTRLYOKE_FILE_KINDS.PROMPT_MARKDOWN,
      path: [],
      objectKind: WORKFLOW_OBJECT_KINDS.PROMPT_FILE_BODY,
      role: WORKFLOW_LOCATION_ROLES.PROMPT_TEXT,
      sourceRange,
    },
    { text: trimmed, sourceOffsets }
  );
}
