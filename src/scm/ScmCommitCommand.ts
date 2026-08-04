import * as vscode from "vscode";
import { CommitMessageGenerator } from "../git/CommitMessageGenerator";
import { commitMessageGenerationTracker } from "../git/CommitMessageGenerationTracker";
import { VSCODE_CONTEXT_KEYS } from "../types/DashboardConstants";
import { Log } from "../utils/Log";
import { getVsCodeWorkspaceRoot } from "../platform/VsCodeWorkspaceRoot";
import { pathsEqual } from "../utils/PathCasing";

interface GitRepository {
  rootUri: vscode.Uri;
  inputBox: { value: string };
}
interface GitExtension {
  getAPI(version: 1): { repositories: GitRepository[] };
}

function getGitInputBox(cwd: string): { value: string } | undefined {
  try {
    const gitExt =
      vscode.extensions.getExtension<GitExtension>("vscode.git")?.exports;
    const api = gitExt?.getAPI(1);
    const repo =
      api?.repositories.find((r) => pathsEqual(r.rootUri.fsPath, cwd)) ??
      api?.repositories[0];
    return repo?.inputBox;
  } catch {
    return undefined;
  }
}

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
        "ctrlyoke: No workspace folder open."
      );
      return;
    }

    const cwd = getVsCodeWorkspaceRoot();
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
          title: "ctrlyoke: Generating commit message...",
          cancellable: true,
        },
        async (_progress, token) => {
          // Capture before any await so cancel() can't null it out underneath us.
          const abortController = this.activeAbortController!;
          token.onCancellationRequested(() => abortController.abort());

          try {
            const inputBox = getGitInputBox(cwd);
            const existingText = inputBox?.value.trim() || undefined;

            const diffResult = await this.generator.getDiff(cwd);
            if (!diffResult) {
              void vscode.window.showInformationMessage(
                "ctrlyoke: No changes detected. Stage or modify files first."
              );
              return;
            }

            const { message, prompt, cliCommand } =
              await this.generator.generateMessage(
                diffResult.diff,
                cwd,
                abortController.signal,
                existingText
              );

            commitMessageGenerationTracker.setLastRecord({
              source: "scm",
              workingDirectory: cwd,
              commands: diffResult.commands,
              output: diffResult.diff,
              staged: diffResult.staged,
              truncated: diffResult.truncated,
              includesUntrackedFiles: diffResult.includesUntrackedFiles,
              generatedAt: Date.now(),
              prompt,
              generatedMessage: message,
              cliCommand,
            });

            if (diffResult.truncated) {
              void vscode.window.showWarningMessage(
                "ctrlyoke: Diff exceeded 8 KB and was truncated. Commit message may be incomplete."
              );
            }

            // Write the generated message to the SCM input box
            if (inputBox) {
              inputBox.value = message;
            }

            if (!diffResult.staged) {
              void vscode.window.showInformationMessage(
                "ctrlyoke: Generated from unstaged changes. Remember to stage files before committing."
              );
            }
          } catch (err) {
            if (
              token.isCancellationRequested ||
              abortController.signal.aborted
            ) {
              return;
            }
            Log.error("Commit message generation failed", err);
            const message = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(`ctrlyoke: ${message}`);
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
