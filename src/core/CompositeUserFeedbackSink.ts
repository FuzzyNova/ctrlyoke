import type { UserFeedback, UserFeedbackSink } from "./UserFeedbackSink";

/** Fans one background feedback event out to every configured host surface. */
export class CompositeUserFeedbackSink implements UserFeedbackSink {
  constructor(private readonly sinks: readonly UserFeedbackSink[]) {}

  notify(message: UserFeedback): void {
    for (const sink of this.sinks) {
      sink.notify(message);
    }
  }
}
