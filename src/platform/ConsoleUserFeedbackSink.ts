import { USER_FEEDBACK_SEVERITY } from "../types/DashboardConstants";
import {
  formatUserFeedback,
  type UserFeedback,
  type UserFeedbackSink,
} from "../core/UserFeedbackSink";

interface ConsoleFeedbackApi {
  log(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Delivers operational feedback to the process console without importing VS Code. */
export class ConsoleUserFeedbackSink implements UserFeedbackSink {
  constructor(private readonly consoleApi: ConsoleFeedbackApi = console) {}

  notify(message: UserFeedback): void {
    const text = formatUserFeedback(message);
    switch (message.severity) {
      case USER_FEEDBACK_SEVERITY.WARNING:
        this.consoleApi.warn(text);
        return;
      case USER_FEEDBACK_SEVERITY.ERROR:
        this.consoleApi.error(text);
        return;
      case USER_FEEDBACK_SEVERITY.INFO:
      case USER_FEEDBACK_SEVERITY.SUCCESS:
        this.consoleApi.log(text);
        return;
    }
  }
}
