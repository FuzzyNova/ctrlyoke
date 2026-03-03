import { EventEmitter } from "events";

/**
 * A typed event emitter that provides a similar API to vscode.EventEmitter<T>.
 * Uses Node.js EventEmitter under the hood, making it suitable for both
 * VS Code extension and standalone CLI contexts.
 */
export class TypedEmitter<T> {
  private readonly emitter = new EventEmitter();
  private static readonly EVENT_NAME = "event";

  /**
   * Fires the event with the given data.
   */
  fire(data: T): void {
    this.emitter.emit(TypedEmitter.EVENT_NAME, data);
  }

  /**
   * Subscribes to the event. Returns a dispose function.
   * This matches the vscode.Event<T> subscription pattern.
   */
  readonly event: (listener: (e: T) => void) => { dispose(): void } = (
    listener
  ) => {
    this.emitter.on(TypedEmitter.EVENT_NAME, listener);
    return {
      dispose: () => {
        this.emitter.off(TypedEmitter.EVENT_NAME, listener);
      },
    };
  };

  /**
   * Disposes this emitter and removes all listeners.
   */
  dispose(): void {
    this.emitter.removeAllListeners();
  }
}
