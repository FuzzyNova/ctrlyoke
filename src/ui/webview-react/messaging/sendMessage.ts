import { getVsCodeApi, isStandalone } from "@hooks/useVsCodeApi";
import { MESSAGE_TYPES } from "@/types/messages";
import { WebviewLog } from "@utils/logger";
import { getWorkflowDefinitionMutation } from "@/utils/workflowMutation";
import { useWorkspaceViewerStore } from "@store/workspaceViewerStore";
import {
  THEME_KINDS,
  THEME_KIND_CSS_VAR,
} from "@root/types/DashboardConstants";
import { themeKindFromBodyClasses } from "@utils/themeKind";

function getPanelLifecycleActionLabel(type: string): string | undefined {
  switch (type) {
    case MESSAGE_TYPES.RUN:
    case MESSAGE_TYPES.EXECUTE_DRAFT:
    case MESSAGE_TYPES.CONTINUE_RUN:
    case MESSAGE_TYPES.SEED_NEW_RUN:
    case MESSAGE_TYPES.START_NEW_RUN_INSTEAD:
      return "run start requested";
    case MESSAGE_TYPES.PREPARE_NEW_RUN:
      return "new run preparation requested";
    case MESSAGE_TYPES.RESUME_RUN:
      return "run resume requested";
    case MESSAGE_TYPES.PAUSE_RUN:
      return "run pause requested";
    case MESSAGE_TYPES.CANCEL_PAUSE_RUN:
      return "run pause cancellation requested";
    case MESSAGE_TYPES.STOP_RUN:
    case MESSAGE_TYPES.STOP_CLI_RUN:
      return "run stop requested";
    default:
      return undefined;
  }
}

export function sendMessage(
  type: string,
  payload?: Record<string, unknown>
): void {
  const vscode = getVsCodeApi();
  const lifecycleActionLabel = getPanelLifecycleActionLabel(type);
  if (lifecycleActionLabel) WebviewLog.info(`[panel] ${lifecycleActionLabel}`);
  const definitionMutationTypes = new Set<string>([
    MESSAGE_TYPES.UPDATE_PROMPT,
    MESSAGE_TYPES.UPDATE_STEP_COLOR,
    MESSAGE_TYPES.UPDATE_STEPS,
    MESSAGE_TYPES.INSERT_WORKFLOW_STEP,
    MESSAGE_TYPES.UPDATE_FINAL_PROMPT,
    MESSAGE_TYPES.DELETE_PROMPT,
    MESSAGE_TYPES.REORDER_PROMPTS,
    MESSAGE_TYPES.UNDO_REDO_SYNC,
  ]);
  const mutation = getWorkflowDefinitionMutation();
  vscode.postMessage({
    type,
    ...payload,
    ...(definitionMutationTypes.has(type) &&
    !("mutation" in (payload ?? {})) &&
    mutation
      ? { mutation }
      : {}),
  });
}

export function captureAndSendThemeVars(
  vscodeApi: ReturnType<typeof getVsCodeApi>
): void {
  const computedStyle = window.getComputedStyle(document.documentElement);
  const vars: Record<string, string> = {};
  const inlineStyle = document.documentElement.style;
  for (let i = 0; i < inlineStyle.length; i++) {
    const prop = inlineStyle.item(i);
    if (prop.startsWith("--vscode-"))
      vars[prop] = computedStyle.getPropertyValue(prop).trim();
  }
  try {
    for (const sheet of document.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (rule instanceof CSSStyleRule && rule.selectorText === ":root") {
            for (const prop of rule.style) {
              if (prop.startsWith("--vscode-"))
                vars[prop] = computedStyle.getPropertyValue(prop).trim();
            }
          }
        }
      } catch {
        /* cross-origin sheet, skip */
      }
    }
  } catch {
    /* ignore */
  }
  vars[THEME_KIND_CSS_VAR] =
    themeKindFromBodyClasses(document.body.classList) ?? THEME_KINDS.LIGHT;
  vscodeApi.postMessage({ type: MESSAGE_TYPES.THEME_VARS_CAPTURED, vars });
}

export function openFile(path: string, line?: number): void {
  if (isStandalone) {
    useWorkspaceViewerStore.getState().openToFile(path, line, line);
    return;
  }
  sendMessage(MESSAGE_TYPES.OPEN_FILE, {
    path,
    lineStart: line,
    lineEnd: line,
  });
}
