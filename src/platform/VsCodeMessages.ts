import * as vscode from "vscode";
import { logUserFeedback } from "../core/UserFeedbackSink";
import {
  USER_FEEDBACK_SEVERITY,
  type UserFeedbackSeverity,
} from "../types/DashboardConstants";

/**
 * Logging wrappers for VS Code's native message APIs, for the few messages
 * that need action buttons or options and so cannot go through a
 * `UserFeedbackSink`. Each one writes the message to the session log (see
 * {@link logUserFeedback}) before showing it, exactly like
 * `notifyUserFeedback`. Lint forbids calling `vscode.window.show*Message`
 * anywhere else. Prefer `notifyUserFeedback` for a plain message: it honors the
 * user's toast level and reaches hosted dashboard clients too.
 */

type MessageArgs<T extends string> =
  [...items: T[]] | [options: vscode.MessageOptions, ...items: T[]];

type NativeSeverity = Exclude<
  UserFeedbackSeverity,
  typeof USER_FEEDBACK_SEVERITY.SUCCESS
>;

function show<T extends string>(
  severity: NativeSeverity,
  message: string,
  rest: MessageArgs<T>,
  error?: unknown
): Thenable<T | undefined> {
  const [first] = rest;
  const detail =
    typeof first === "object" && first !== null ? first.detail : undefined;
  logUserFeedback({ severity, message, detail }, error);
  // `rest` is one of the overloads' own argument lists; TypeScript cannot
  // pick an overload for a union spread, hence the widened signature.
  const args = rest as [vscode.MessageOptions, ...T[]];
  switch (severity) {
    case USER_FEEDBACK_SEVERITY.ERROR:
      return vscode.window.showErrorMessage(message, ...args);
    case USER_FEEDBACK_SEVERITY.WARNING:
      return vscode.window.showWarningMessage(message, ...args);
    case USER_FEEDBACK_SEVERITY.INFO:
      return vscode.window.showInformationMessage(message, ...args);
  }
}

/** Log, then show a native error message. */
export function showErrorMessage<T extends string>(
  message: string,
  ...rest: MessageArgs<T>
): Thenable<T | undefined> {
  return show(USER_FEEDBACK_SEVERITY.ERROR, message, rest);
}

/** Log (with the caught error's stack), then show a native error message. */
export function showErrorMessageFor<T extends string>(
  error: unknown,
  message: string,
  ...rest: MessageArgs<T>
): Thenable<T | undefined> {
  return show(USER_FEEDBACK_SEVERITY.ERROR, message, rest, error);
}

/** Log, then show a native warning message. */
export function showWarningMessage<T extends string>(
  message: string,
  ...rest: MessageArgs<T>
): Thenable<T | undefined> {
  return show(USER_FEEDBACK_SEVERITY.WARNING, message, rest);
}

/** Log, then show a native information message. */
export function showInformationMessage<T extends string>(
  message: string,
  ...rest: MessageArgs<T>
): Thenable<T | undefined> {
  return show(USER_FEEDBACK_SEVERITY.INFO, message, rest);
}
