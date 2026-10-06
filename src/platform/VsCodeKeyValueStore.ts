import type * as vscode from "vscode";
import type { KeyValueStore } from "../core/HostPorts";

/** Adapts VS Code mementos to the shared host-neutral key/value contract. */
export class VsCodeKeyValueStore implements KeyValueStore {
  constructor(private readonly memento: vscode.Memento) {}

  get<T>(key: string): T | undefined {
    return this.memento.get<T>(key);
  }

  async update(key: string, value: unknown): Promise<void> {
    await this.memento.update(key, value);
  }
}
