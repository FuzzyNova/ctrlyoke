import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { hoverTooltip, ViewPlugin } from "@codemirror/view";
import {
  WORKFLOW_LOCATION_ROLES,
  MESSAGE_TYPES,
  type CtrlYokeFileKind,
} from "@root/types/DashboardConstants";
import type {
  ContextReferenceResolver,
  ContextReferenceValidationResult,
} from "@root/utils/PromptDiagnosticRules";
import { toCodeMirrorPromptDiagnostic } from "@utils/promptDiagnosticCodeMirror";
import type { WorkflowFileSupport } from "./loadWorkflowFileSupport";

interface ContextRefsValidationMessage {
  readonly type: typeof MESSAGE_TYPES.CONTEXT_REFS_VALIDATION;
  readonly seq: number;
  readonly results: readonly ContextReferenceValidationResult[];
}

interface ValidationTransport {
  postMessage(message: unknown): void;
}

// Kept separate from the prompt editor's sequence space (which starts at 0).
let nextValidationSequence = 1_000_000_000;

/** Prompt lint uses the shared span runner and host resolver round trip. */
export function createWorkflowPromptLintExtension(options: {
  kind: CtrlYokeFileKind;
  getSupport: () => WorkflowFileSupport | null;
  transport: ValidationTransport;
  getSettingsPreCondition?: () => unknown;
}): Extension {
  let latestLint = 0;
  const pending = new Map<
    number,
    (results: ContextReferenceValidationResult[]) => void
  >();
  const onMessage = (event: MessageEvent) => {
    const message = event.data as ContextRefsValidationMessage | undefined;
    if (message?.type !== MESSAGE_TYPES.CONTEXT_REFS_VALIDATION) return;
    const resolve = pending.get(message.seq);
    if (!resolve) return;
    pending.delete(message.seq);
    resolve([...message.results]);
  };
  const resolveReferences: ContextReferenceResolver = (references) => {
    if (references.length === 0) return Promise.resolve([]);
    const seq = ++nextValidationSequence;
    return new Promise((resolve) => {
      pending.set(seq, resolve);
      options.transport.postMessage({
        type: MESSAGE_TYPES.VALIDATE_CONTEXT_REFS,
        references,
        seq,
      });
    });
  };

  return [
    linter(
      async (view): Promise<Diagnostic[]> => {
        const lintSequence = ++latestLint;
        const support = options.getSupport();
        if (!support) return [];
        const diagnostics = await support.getWorkflowPromptDiagnostics(
          view.state.doc.toString(),
          options.kind,
          resolveReferences,
          options.getSettingsPreCondition?.()
        );
        if (lintSequence !== latestLint) return [];
        return diagnostics.map((diagnostic) =>
          toCodeMirrorPromptDiagnostic(diagnostic)
        );
      },
      { delay: 300 }
    ),
    ViewPlugin.define(() => {
      window.addEventListener("message", onMessage);
      return {
        destroy() {
          window.removeEventListener("message", onMessage);
          for (const resolve of pending.values()) resolve([]);
          pending.clear();
        },
      };
    }),
  ];
}

/** Shows the generated schema description when hovering an authorable key. */
export function createWorkflowOutlineHoverExtension(options: {
  kind: CtrlYokeFileKind;
  getSupport: () => WorkflowFileSupport | null;
}): Extension {
  return hoverTooltip(
    (view, position) => {
      const support = options.getSupport();
      if (!support) return null;
      const location = support.getWorkflowLocation(
        view.state.doc.toString(),
        position,
        options.kind
      );
      if (location.role !== WORKFLOW_LOCATION_ROLES.KEY || !location.key)
        return null;
      const description =
        support.WORKFLOW_SCHEMA_OUTLINE[location.objectKind]?.properties[
          location.key
        ]?.description;
      if (!description) return null;
      const line = view.state.doc.lineAt(position);
      const keyStart = view.state.doc
        .sliceString(line.from, line.to)
        .indexOf(location.key);
      if (keyStart < 0) return null;
      const from = line.from + keyStart;
      return {
        pos: from,
        end: from + location.key.length,
        create() {
          const dom = document.createElement("div");
          dom.className = "cm-tooltip-workflow-outline";
          dom.textContent = description;
          return { dom };
        },
      };
    },
    { hoverTime: 300 }
  );
}
