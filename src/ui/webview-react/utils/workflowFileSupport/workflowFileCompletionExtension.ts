import type {
  Completion,
  CompletionContext,
  CompletionResult,
  CompletionSource,
} from "@codemirror/autocomplete";
import type { Extension } from "@codemirror/state";
import { tooltips } from "@codemirror/view";
import { fuzzyMatchRanges } from "@root/completions/FuzzyRanking";
import {
  WORKFLOW_LOCATION_ROLES,
  WORKFLOW_OBJECT_KINDS,
  type CtrlYokeFileKind,
} from "@root/types/DashboardConstants";
import { COMPLETION_KIND_ICONS } from "@root/types/SymbolKindConstants";
import type { WorkflowValueDataSource } from "@root/completions/WorkflowFileCompletionCore";
import type { WorkflowLocation } from "@root/completions/WorkflowLocationTypes";
import { getWorkflowInsertEscape } from "@root/completions/WorkflowInsertEscape";
import { DEFAULT_COMPLETION_ICON } from "@utils/atomicReferences";
import { keyboardTooltipSpace } from "@utils/keyboardTooltipSpace";
import type { PromptCompletionClient } from "@utils/promptCompletion/createPromptCompletionClient";
import {
  createWorkflowContextCompletionSource,
  promptTokenLanguageDataExtension,
} from "@utils/promptCompletion/promptTokenCompletionExtension";
import { getContextualPriorCompletions } from "@root/completions/PromptContextCompletions";
import { findCustomCompletionContext } from "@utils/promptCompletion/promptCompletionResult";
import type { WorkflowFileSupport } from "./loadWorkflowFileSupport";
import {
  HOST_RANGE_COMPLETION_KINDS,
  requestHostRangeCompletions,
  type HostRangeCompletionTransport,
} from "./hostedRangeCompletions";

export interface WorkflowFileCompletionExtensionOptions {
  kind: CtrlYokeFileKind;
  /** The lazily loaded location/completion modules; null until the chunk arrives. */
  getSupport: () => WorkflowFileSupport | null;
  getDataSource: () => WorkflowValueDataSource;
  /** Settings-level pre-condition used by the runtime property resolver. */
  getSettingsPreCondition?: () => unknown;
  promptClient: PromptCompletionClient;
  transport: HostRangeCompletionTransport;
}

/** The word being typed, which the typed text is matched against. */
const WORD_PREFIX = /[\w.\-@$]*$/;

function locate(
  options: WorkflowFileCompletionExtensionOptions,
  context: CompletionContext
): { support: WorkflowFileSupport; location: WorkflowLocation } | null {
  const support = options.getSupport();
  if (!support) return null;
  const location = support.getWorkflowLocation(
    context.state.doc.toString(),
    context.pos,
    options.kind
  );
  return { support, location };
}

function toCompletion(
  item: {
    label: string;
    kind: number;
    insertText: string;
    detail?: string;
    documentation?: string;
  },
  index: number
): Completion {
  return {
    label: item.label,
    detail: item.detail,
    info: item.documentation,
    type: COMPLETION_KIND_ICONS[item.kind] || DEFAULT_COMPLETION_ICON,
    apply: item.insertText,
    boost: -index,
  };
}

/** Key and value items from the shared core, at KEY and VALUE positions. */
function createKeyValueSource(
  options: WorkflowFileCompletionExtensionOptions
): CompletionSource {
  return (context): CompletionResult | null => {
    const located = locate(options, context);
    if (!located) return null;
    const { support, location } = located;
    const isKey = location.role === WORKFLOW_LOCATION_ROLES.KEY;
    if (!isKey && location.role !== WORKFLOW_LOCATION_ROLES.VALUE) return null;

    const text = context.state.doc.toString();
    const { items, replaceRange } = support.getWorkflowFileCompletions({
      text,
      offset: context.pos,
      location,
      documentRoot: support.parseWorkflowDocumentRoot(text, options.kind),
      data: options.getDataSource(),
    });
    if (items.length === 0) return null;

    // The replace range can include a JSON key's quotes, which would never
    // match a label, so match on the word typed so far and filter here.
    const typed = WORD_PREFIX.exec(
      text.slice(replaceRange.start, context.pos)
    )?.[0];
    // Don't open the key list on every indentation space; values open at once.
    if (!typed && isKey && !context.explicit) return null;
    const matching = typed
      ? items.filter(
          (item) =>
            fuzzyMatchRanges(item.filterText ?? item.label, typed).length > 0
        )
      : items;
    if (matching.length === 0) return null;

    return {
      from: replaceRange.start,
      to: replaceRange.end,
      filter: false,
      options: [...matching]
        .sort((a, b) => (a.sortText ?? "").localeCompare(b.sortText ?? ""))
        .map(toCompletion),
    };
  };
}

/** Script text and tool-permission values stay host-backed. */
function createHostRangeSource(
  options: WorkflowFileCompletionExtensionOptions
): CompletionSource {
  return (context): Promise<CompletionResult | null> | null => {
    const located = locate(options, context);
    const range = located?.location.valueRange;
    if (!located || !range) return null;
    const { location } = located;
    const isScript = location.role === WORKFLOW_LOCATION_ROLES.SCRIPT_TEXT;
    const isPermission =
      location.role === WORKFLOW_LOCATION_ROLES.VALUE &&
      location.objectKind === WORKFLOW_OBJECT_KINDS.TOOL_PERMISSIONS;
    if (!isScript && !isPermission) return null;
    if (context.pos < range.start || context.pos > range.end) return null;

    const controller = new AbortController();
    context.addEventListener("abort", () => controller.abort());
    return requestHostRangeCompletions(
      options.transport,
      isScript
        ? HOST_RANGE_COMPLETION_KINDS.SCRIPT
        : HOST_RANGE_COMPLETION_KINDS.PERMISSION,
      context.state.doc.toString(),
      range,
      context.pos,
      controller.signal
    );
  };
}

/** `@ # ~ $ ! /` completions, only inside prompt text. */
function createPromptTokenSource(
  options: WorkflowFileCompletionExtensionOptions
): CompletionSource {
  return (context) => {
    const located = locate(options, context);
    if (located?.location.role !== WORKFLOW_LOCATION_ROLES.PROMPT_TEXT)
      return null;
    // The client finds the trigger on the whole line. In compact JSON that
    // can be an `@` in an earlier field, and accepting an item would then
    // overwrite everything from there to the cursor.
    const valueStart = located.location.valueRange?.start;
    if (valueStart !== undefined) {
      const line = context.state.doc.lineAt(context.pos);
      const trigger = findCustomCompletionContext(
        line.text.slice(0, context.pos - line.from),
        line.from
      );
      if (trigger && trigger.from < valueStart) return null;
    }
    const workflowSource = createWorkflowContextCompletionSource(
      options.promptClient,
      (completionContext) =>
        options
          .getSupport()
          ?.getWorkflowPromptCompletionContext(
            completionContext.state.doc.toString(),
            options.kind,
            completionContext.pos,
            options.getSettingsPreCondition?.()
          ),
      getContextualPriorCompletions,
      () => getWorkflowInsertEscape(located.location)
    );
    return workflowSource(context);
  };
}

/**
 * Everything ctrlyoke adds to the workspace editor for a workflow file: key and
 * value completion, host-backed script/permission completion and prompt-token
 * completion. Sources are registered as language data, the mechanism a language
 * server's completion also uses, so they merge into one dropdown with
 * `basicSetup`'s and any server's instead of replacing them.
 */
export function createWorkflowFileCompletionExtension(
  options: WorkflowFileCompletionExtensionOptions
): Extension {
  return [
    tooltips({ parent: document.body, tooltipSpace: keyboardTooltipSpace }),
    promptTokenLanguageDataExtension({
      sources: [
        createKeyValueSource(options),
        createHostRangeSource(options),
        createPromptTokenSource(options),
      ],
    }),
  ];
}
