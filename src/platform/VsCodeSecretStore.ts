import * as vscode from "vscode";
import type { SecretStore } from "./SecretStore";

/** Adapt VS Code's encrypted SecretStorage to the shared SecretStore contract. */
export class VsCodeSecretStore implements SecretStore {
  constructor(private readonly storage: vscode.SecretStorage) {}

  get(key: string): Thenable<string | undefined> {
    return this.storage.get(key);
  }

  store(key: string, value: string): Thenable<void> {
    return this.storage.store(key, value);
  }

  delete(key: string): Thenable<void> {
    return this.storage.delete(key);
  }

  keys(): Thenable<string[]> {
    return this.storage.keys();
  }
}
