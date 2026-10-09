import { linter, type Diagnostic } from "@codemirror/lint";
import { forceLinting } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";
import type { CtrlYokeFileKind } from "@root/types/DashboardConstants";
import { MESSAGE_TYPES as MESSAGE_TYPE_VALUES } from "@root/types/DashboardConstants";
import type { WorkflowFileSupport } from "./loadWorkflowFileSupport";

interface WorkflowDiagnosticsMessage {
  readonly type: typeof MESSAGE_TYPE_VALUES.WORKFLOW_DOCUMENT_DIAGNOSTICS;
  readonly seq: number;
  readonly issues: readonly {
    readonly path: string;
    readonly message: string;
    readonly severity: "error" | "warning";
  }[];
}

interface ValidationTransport {
  postMessage(message: unknown): void;
}

let nextSequence = 0;

/** Debounced host validation; schema and YAML code remains in the lazy chunk. */
export function createWorkflowDocumentLintExtension(options: {
  kind: CtrlYokeFileKind;
  getSupport: () => WorkflowFileSupport | null;
  transport: ValidationTransport;
}): Extension {
  let latestSequence = 0;
  const pending = new Map<number, (diagnostics: Diagnostic[]) => void>();
  const onMessage = (event: MessageEvent) => {
    const message = event.data as WorkflowDiagnosticsMessage | undefined;
    if (message?.type !== MESSAGE_TYPE_VALUES.WORKFLOW_DOCUMENT_DIAGNOSTICS)
      return;
    const resolve = pending.get(message.seq);
    if (!resolve) return;
    pending.delete(message.seq);
    if (message.seq !== latestSequence) {
      resolve([]);
      return;
    }
    const support = options.getSupport();
    if (!support) {
      resolve([]);
      return;
    }
    resolve(
      message.issues.flatMap((issue) => {
        const text = documentTextBySequence.get(message.seq) ?? "";
        const range = support.findRangeForPath(
          text,
          support.workflowPathFromInstancePath(issue.path),
          options.kind
        );
        if (!range) return [];
        return [
          {
            from: range.start,
            to: Math.min(text.length, Math.max(range.start + 1, range.end)),
            severity: issue.severity,
            message: issue.message,
          },
        ];
      })
    );
    documentTextBySequence.delete(message.seq);
  };
  const documentTextBySequence = new Map<number, string>();
  window.addEventListener("message", onMessage);
  return [
    linter(
      (view) =>
        new Promise<Diagnostic[]>((resolve) => {
          if (!options.getSupport()) {
            resolve([]);
            return;
          }
          const seq = ++nextSequence;
          latestSequence = seq;
          for (const [oldSeq, oldResolve] of pending) {
            pending.delete(oldSeq);
            documentTextBySequence.delete(oldSeq);
            oldResolve([]);
          }
          const text = view.state.doc.toString();
          pending.set(seq, resolve);
          documentTextBySequence.set(seq, text);
          options.transport.postMessage({
            type: MESSAGE_TYPE_VALUES.VALIDATE_WORKFLOW_DOCUMENT,
            text,
            kind: options.kind,
            seq,
          });
        }),
      { delay: 400 }
    ),
    ViewPlugin.define(() => ({
      destroy() {
        window.removeEventListener("message", onMessage);
        for (const resolve of pending.values()) resolve([]);
        pending.clear();
        documentTextBySequence.clear();
      },
    })),
  ];
}

export { forceLinting };
