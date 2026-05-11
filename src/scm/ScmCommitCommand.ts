import * as vscode from "vscode";
import { CommitMessageGenerator } from "../git/CommitMessageGenerator";
import { commitMessageGenerationTracker } from "../git/CommitMessageGenerationTracker";
import { VSCODE_CONTEXT_KEYS } from "../types/DashboardConstants";

export class ScmCommitCommand {
  private readonly generator = new CommitMessageGenerator();
  private activeAbortController: AbortController | null = null;

  cancel(): void {
    this.activeAbortController?.abort();
  }

  async execute(context: vscode.ExtensionContext): Promise<void> {
    void context; // ExtensionContext reserved for future use (e.g., secrets, storage)

    if (this.activeAbortController) {
      this.cancel();
      return;
    }

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders?.length) {
      void vscode.window.showErrorMessage(
        "FlightPath: No workspace folder open."
      );
      return;
    }

    const cwd = workspaceFolders[0].uri.fsPath;
    this.activeAbortController = new AbortController();
    await vscode.commands.executeCommand(
      "setContext",
      VSCODE_CONTEXT_KEYS.GENERATING_COMMIT_MESSAGE,
      true
    );

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.SourceControl,
          title: "FlightPath: Generating commit message...",
          cancellable: true,
        },
        async (_progress, token) => {
          // Capture before any await so cancel() can't null it out underneath us.
          const abortController = this.activeAbortController!;
          token.onCancellationRequested(() => abortController.abort());

          try {
            // Capture any existing text as instructions before overwriting it
            const existingText = vscode.scm.inputBox.value.trim() || undefined;

            const diffResult = await this.generator.getDiff(cwd);
            if (!diffResult) {
              void vscode.window.showInformationMessage(
                "FlightPath: No changes detected. Stage or modify files first."
              );
              return;
            }

            commitMessageGenerationTracker.setLastRecord({
              source: "scm",
              workingDirectory: cwd,
              commands: diffResult.commands,
              output: diffResult.diff,
              staged: diffResult.staged,
              truncated: diffResult.truncated,
              includesUntrackedFiles: diffResult.includesUntrackedFiles,
              generatedAt: Date.now(),
            });

            const message = await this.generator.generateMessage(
              diffResult.diff,
              cwd,
              abortController.signal,
              existingText
            );

            if (diffResult.truncated) {
              void vscode.window.showWarningMessage(
                "FlightPath: Diff exceeded 8 KB and was truncated. Commit message may be incomplete."
              );
            }

            // Write the generated message to the SCM input box
            const inputBox = vscode.scm.inputBox;
            inputBox.value = message;

            if (!diffResult.staged) {
              void vscode.window.showInformationMessage(
                "FlightPath: Generated from unstaged changes. Remember to stage files before committing."
              );
            }
          } catch (err) {
            if (token.isCancellationRequested || abortController.signal.aborted) {
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`FlightPath: ${message}`);
          }
        }
      );
    } finally {
      this.activeAbortController = null;
      await vscode.commands.executeCommand(
        "setContext",
        VSCODE_CONTEXT_KEYS.GENERATING_COMMIT_MESSAGE,
        false
      );
    }
  }
}
