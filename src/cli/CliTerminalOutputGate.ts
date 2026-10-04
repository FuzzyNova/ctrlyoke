import type { InheritedTerminalOwnership } from "../utils/InheritedTerminalOwnership";

type TerminalOwnership = Pick<
  InheritedTerminalOwnership,
  "isOwned" | "onDidChange"
>;

/**
 * Holds the CLI's own terminal output while a harness TUI owns the terminal.
 *
 * A parallel group's headless members run beside its one interactive member,
 * and status lines, script verdicts and step headers can arrive while that
 * member's TUI is on screen. Writing them then would corrupt the TUI, so each
 * render is deferred, in order, and replayed once the TUI exits. Renders are
 * held as calls rather than captured text so the formatter sees them in their
 * original order and keeps its per-step prefixes intact.
 */
export class CliTerminalOutputGate {
  private readonly deferred: Array<() => void> = [];
  private readonly subscription: { dispose(): void };

  /**
   * @param onTerminalReturned Called each time the terminal comes back, with
   *   the number of renders about to be replayed, before replaying them.
   */
  constructor(
    private readonly ownership: TerminalOwnership,
    private readonly onTerminalReturned: (deferredCount: number) => void
  ) {
    this.subscription = ownership.onDidChange((owned) => {
      if (!owned) {
        this.replay();
      }
    });
  }

  /** Render now, or once the terminal is free again. */
  write(render: () => void): void {
    if (this.ownership.isOwned()) {
      this.deferred.push(render);
      return;
    }
    render();
  }

  dispose(): void {
    this.subscription.dispose();
  }

  private replay(): void {
    const pending = this.deferred.splice(0);
    this.onTerminalReturned(pending.length);
    for (const render of pending) {
      render();
    }
  }
}
