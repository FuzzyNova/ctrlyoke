import { TypedEmitter } from "./TypedEmitter";

/**
 * Tracks the child processes that currently own this process's terminal: the
 * ones spawned with `stdio: "inherit"`, which in practice are the standalone
 * CLI's interactive harness TUIs. While one does, nothing else may write to
 * stdout. The TUI owns the screen, and an interleaved write corrupts what it
 * draws.
 */
export class InheritedTerminalOwnership {
  private owners = 0;
  private readonly changed = new TypedEmitter<boolean>();
  /**
   * Fires `true` when the first owner takes the terminal and `false` when the
   * last one gives it back.
   */
  readonly onDidChange = this.changed.event;

  isOwned(): boolean {
    return this.owners > 0;
  }

  /** Take the terminal. The returned function gives it back; repeat calls do nothing. */
  acquire(): () => void {
    this.owners += 1;
    if (this.owners === 1) {
      this.changed.fire(true);
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.owners -= 1;
      if (this.owners === 0) {
        this.changed.fire(false);
      }
    };
  }
}

/** The one terminal this process has, shared by every spawner and writer. */
export const inheritedTerminalOwnership = new InheritedTerminalOwnership();
