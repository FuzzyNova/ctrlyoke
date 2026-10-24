import { useUiStore } from "@store/uiStore";

/**
 * True when the lineage on screen is a favorite. Favorites live on the
 * recent-workflows rows, which are fetched on every handshake; a lineage not
 * in that list (or a list not loaded yet) reads as not favorite, so callers
 * that relax a safeguard for favorites keep it until the row arrives.
 */
export function useIsDisplayedWorkflowFavorite(): boolean {
  return useUiStore((s) => {
    const workflowKey = s.displayedViewAddress?.workflowKey;
    return (
      workflowKey !== undefined &&
      s.recentWorkflows.some(
        (workflow) =>
          workflow.address.workflowKey === workflowKey &&
          (workflow.isFavorite ?? false)
      )
    );
  });
}
