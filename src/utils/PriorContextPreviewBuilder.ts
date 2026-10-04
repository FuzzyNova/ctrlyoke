import {
  buildPriorContextXmlFromItems,
  refToPriorContext,
} from "../core/HarnessIntegration";
import { type WorkflowStep } from "../types/CtrlYokeTypes";
import { RunOutputResolver } from "../core/orchestration/RunOutputResolver";
import { parseInlinePriorContextBody } from "./FileReferenceParser";
import { parseMergedPriorContextBody } from "./PriorContextMerge";

/**
 * Builds the exact XML preview a user will see in the editor when they
 * Ctrl+click an inline $prior-context reference ($previous, $step:N, etc.).
 *
 * Uses the same body parser, `refToPriorContext` mapping, and
 * `buildPriorContextXmlFromItems` function as live harness injection — if
 * any of those change, the preview changes too.
 */
export class PriorContextPreviewBuilder {
  /**
   * Build the <priorContext> XML preview for a given inline ref string.
   *
   * @param ref       The raw ref body, e.g. "previous", "previous:3", "step:1,3", "all"
   * @param stepCount Number of steps that precede the current prompt (0-based count)
   * @param steps     The workflow steps array from the working file
   * @returns XML string matching the actual injection format, or a comment when
   *          no context is available (step not yet run, or out-of-range index)
   */
  static async buildPreview(
    ref: string,
    stepCount: number,
    steps: readonly WorkflowStep[],
    resolver: RunOutputResolver,
    manifestPath: string
  ): Promise<string> {
    const mergedContexts = parseMergedPriorContextBody(ref);
    const parsed = parseInlinePriorContextBody(ref);
    const contexts = mergedContexts ?? (parsed ? [refToPriorContext(parsed.ref)] : []);
    const items = contexts.length > 0
      ? await resolver.resolvePriorContextItems(
          manifestPath,
          contexts,
          steps,
          stepCount
        )
      : [];

    if (items.length === 0) {
      return `<!-- $${ref}: no prior context available at this step position (step output may not have run yet) -->`;
    }

    return buildPriorContextXmlFromItems(items);
  }
}
