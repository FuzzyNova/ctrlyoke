export interface CommitMessageGenerationRecord {
  source: "scm" | "workspace-viewer";
  workingDirectory: string;
  commands: string[];
  output: string;
  staged: boolean;
  truncated: boolean;
  includesUntrackedFiles: boolean;
  generatedAt: number;
  prompt?: string;
  generatedMessage?: string;
  cliCommand?: string;
  workflowKey?: string;
  runRef?: string;
}

type Listener = (record: CommitMessageGenerationRecord | null) => void;

class CommitMessageGenerationTracker {
  private lastRecord: CommitMessageGenerationRecord | null = null;
  private readonly listeners = new Set<Listener>();

  getLastRecord(): CommitMessageGenerationRecord | null {
    return this.lastRecord;
  }

  setLastRecord(record: CommitMessageGenerationRecord): void {
    this.lastRecord = record;
    for (const listener of this.listeners) {
      listener(record);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export const commitMessageGenerationTracker =
  new CommitMessageGenerationTracker();
