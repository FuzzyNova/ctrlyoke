import * as assert from "assert";
import { suite, test } from "mocha";
import type * as vscode from "vscode";
import type { KeyValueStore } from "../../core/HostPorts";
import { VsCodeKeyValueStore } from "../../platform/VsCodeKeyValueStore";

class MemoryKeyValueStore implements KeyValueStore {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

suite("KeyValueStore contract", () => {
  const stores: Array<readonly [string, () => KeyValueStore]> = [
    ["memory store", () => new MemoryKeyValueStore()],
    [
      "VS Code memento adapter",
      () => {
        const values = new Map<string, unknown>();
        const memento = {
          keys: () => [...values.keys()],
          get: <T>(key: string) => values.get(key) as T | undefined,
          update: async (key: string, value: unknown) => {
            values.set(key, value);
          },
        } as vscode.Memento;
        return new VsCodeKeyValueStore(memento);
      },
    ],
  ];

  for (const [name, createStore] of stores) {
    test(`${name} supports typed get and update`, async () => {
      const store = createStore();
      assert.strictEqual(store.get<string>("missing"), undefined);
      await store.update("lastDirectory", "C:/workspace/exports");
      assert.strictEqual(
        store.get<string>("lastDirectory"),
        "C:/workspace/exports"
      );
      await store.update("lastDirectory", undefined);
      assert.strictEqual(store.get<string>("lastDirectory"), undefined);
    });
  }
});
