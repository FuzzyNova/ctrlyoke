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
  constructor(
    private readonly consoleApi: ConsoleFeedbackApi = console
  ) {}

  notify(message: UserFeedback): void {
    const text = formatUserFeedback(message);
    switch (message.severity) {
      case "warning":
        this.consoleApi.warn(text);
        return;
      case "error":
        this.consoleApi.error(text);
        return;
      case "info":
      case "success":
        this.consoleApi.log(text);
        return;
    }
  }
}
