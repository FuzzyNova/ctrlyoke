import { PREVIEW_PROMPT_CATEGORIES } from "@root/types/DashboardConstants";
import type {
  StepExecutionPreview,
  WorkspaceMutationPreview,
} from "@root/types/ExecutionPreviewTypes";

export const STEP_TIMELINE_ENTRY_KINDS = {
  PAYLOAD: "payload",
  MUTATION: "mutation",
  COMMAND: "command",
} as const;

export type StepTimelineEntryKind =
  (typeof STEP_TIMELINE_ENTRY_KINDS)[keyof typeof STEP_TIMELINE_ENTRY_KINDS];

export type StepTimelineEntry =
  | {
      kind: typeof STEP_TIMELINE_ENTRY_KINDS.PAYLOAD;
      fileCount: number;
      totalByteCount: number;
    }
  | {
      kind: typeof STEP_TIMELINE_ENTRY_KINDS.MUTATION;
      mutation: WorkspaceMutationPreview;
    }
  | {
      kind: typeof STEP_TIMELINE_ENTRY_KINDS.COMMAND;
      cwd: string;
      executable: string;
    };

/** Builds the chronological payload, mutation, and command entries for a step. */
export function buildStepTimeline(
  step: StepExecutionPreview
): StepTimelineEntry[] {
  const entries: StepTimelineEntry[] = [];
  const payloadSections = step.prompt?.sections.filter(
    (section) => section.category !== PREVIEW_PROMPT_CATEGORIES.FILE_REFERENCE
  );

  if (payloadSections && payloadSections.length > 0) {
    entries.push({
      kind: STEP_TIMELINE_ENTRY_KINDS.PAYLOAD,
      fileCount: payloadSections.length,
      totalByteCount: payloadSections.reduce(
        (total, section) => total + section.byteCount,
        0
      ),
    });
  }

  for (const mutation of step.workspaceMutations) {
    entries.push({
      kind: STEP_TIMELINE_ENTRY_KINDS.MUTATION,
      mutation,
    });
  }

  if (step.command) {
    entries.push({
      kind: STEP_TIMELINE_ENTRY_KINDS.COMMAND,
      cwd: step.command.cwd,
      executable: step.command.executable,
    });
  }

  return entries;
}
