import * as vscode from "vscode";
import { CommitMessageGenerator } from "../git/CommitMessageGenerator";

export class ScmCommitCommand {
  private readonly generator = new CommitMessageGenerator();

  async execute(context: vscode.ExtensionContext): Promise<void> {
    void context; // ExtensionContext reserved for future use (e.g., secrets, storage)

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      void vscode.window.showErrorMessage(
        "FlightPath: No workspace folder open."
      );
      return;
    }

    const cwd = workspaceFolders[0].uri.fsPath;

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.SourceControl,
        title: "FlightPath: Generating commit message...",
        cancellable: true,
      },
      async (_progress, token) => {
        const abortController = new AbortController();
        token.onCancellationRequested(() => abortController.abort());

        try {
          const result = await this.generator.generate(
            cwd,
            abortController.signal
          );

          if (!result) {
            void vscode.window.showInformationMessage(
              "FlightPath: No changes detected. Stage or modify files first."
            );
            return;
          }

          if (result.truncated) {
            void vscode.window.showWarningMessage(
              "FlightPath: Diff exceeded 8 KB and was truncated. Commit message may be incomplete."
            );
          }

          // Write the generated message to the SCM input box
          const inputBox = vscode.scm.inputBox;
          inputBox.value = result.message;

          if (!result.staged) {
            void vscode.window.showInformationMessage(
              "FlightPath: Generated from unstaged changes. Remember to stage files before committing."
            );
          }
        } catch (err) {
          if (token.isCancellationRequested) {
            return;
          }
          const message = err instanceof Error ? err.message : String(err);
          void vscode.window.showErrorMessage(`FlightPath: ${message}`);
        }
      }
    );
  }
}
