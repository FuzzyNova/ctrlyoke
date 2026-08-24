import { useUiStore } from "@store/uiStore";

/**
 * True when the lineage currently displayed is one the extension created for
 * its own internal use (e.g. commit message generation), not a user-authored
 * workflow. Every property that matters for such a lineage is overridden by
 * its owning feature on the next run regardless of what is shown here (see
 * `CommitSection.tsx` / `buildCommitWorkflowOverrides`), so editing it in the
 * dashboard has no durable effect — components use this to lock down
 * workflow-mutating controls the same way they do for CLI-managed or deleted
 * workflows.
 */
export function useIsSystemGeneratedWorkflow(): boolean {
  return useUiStore((s) => s.viewedLineageIsSystemGenerated);
}
