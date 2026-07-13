import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { vsCodeRawStorage } from "@utils/vsCodeStateStorage";
import type {
  WorkspaceEntry,
  SourceControlFile,
  DiffKind,
  WorkspaceCommitLogEntry,
  WorkspaceCommitInfo,
  WorkspaceRepo,
} from "@root/types/HostedWorkspaceViewerTypes";
import type { ParsedDiffFile } from "@utils/rdvAdapter";
import { workspaceGitRefDiff } from "@utils/hostedApi";
import { parseUnifiedDiffToFiles } from "@utils/rdvAdapter";

// ============================================================================
// Types
// ============================================================================

export type PendingNavigation =
  | { type: "file"; filePath: string; startLine?: number; endLine?: number }
  | { type: "directory"; dirPath: string };

/**
 * Match a viewer path to the repo that owns it, for defaulting the SCM repo
 * selector to follow the open file. Viewer paths are folder-name-prefixed with
 * the root name in multi-root (`secondary/foo.ts`); the server supplies the
 * authoritative prefix → repo-id map (`prefixRepoIds`) so we never guess from
 * `label`/`id` — those diverge from the prefix when a root sits below its git
 * toplevel. Returns null for unprefixed/unknown paths (single-root falls back
 * to the first repo).
 *
 * The first-segment split mirrors `firstViewerSegment` in
 * `platform/WorkspaceViewerPath.ts`, which can't be imported here (it pulls in
 * `node:path`); keep the two in sync.
 */
function repoIdForPath(
  path: string | null,
  prefixRepoIds: Record<string, string>
): string | null {
  if (!path) return null;
  const firstSegment = path.replace(/\\/g, "/").split("/")[0];
  return prefixRepoIds[firstSegment] ?? null;
}

// ============================================================================
// State
// ============================================================================

interface CachedFileDraft {
  content: string;
}

interface WorkspaceViewerState {
  isOpen: boolean;
  activeTab: "explorer" | "sourceControl";

  // Explorer
  explorerPath: string;
  explorerEntries: WorkspaceEntry[];
  explorerLoading: boolean;
  explorerIsGitRepo: boolean;

  // File editor
  selectedFilePath: string | null;
  fileContent: string;
  originalFileContent: string;
  fileDirty: boolean;
  fileLoading: boolean;
  fileSaving: boolean;
  fileReadOnly: boolean;
  fileReadOnlyReason: string | undefined;
  /** `data:` URI for a known image file, rendered as an inline <img> instead of the text editor. Null for non-image files. */
  fileImageDataUri: string | null;
  fileDrafts: Record<string, CachedFileDraft>;

  // Mobile: in explorer tab, whether the file editor is shown (vs directory list)
  mobileEditorVisible: boolean;

  // Mobile: in source control tab, whether the diff is shown (vs changed-file list)
  mobileDiffVisible: boolean;

  // Repos (multi-repo workspaces). Empty/one → the repo selector stays hidden.
  repos: WorkspaceRepo[];
  /** Server-supplied viewer-path prefix → repo-id map (authoritative; see `repoIdForPath`). */
  prefixRepoIds: Record<string, string>;
  /** Repo whose SCM state (status, diff, commit, history) the pane currently shows. */
  selectedRepoId: string | null;

  // Source control
  sourceControlFiles: SourceControlFile[];
  sourceControlLoading: boolean;
  selectedDiffPath: string | null;
  diffOldContent: string;
  diffNewContent: string;
  diffLanguage: string | undefined;
  diffKind: DiffKind | null;
  diffLoading: boolean;

  // Commit area
  commitMessage: string;
  committing: boolean;
  generatingCommitMessage: boolean;
  pushing: boolean;
  pulling: boolean;
  scmError: string | null;

  // Commit history
  commitHistory: WorkspaceCommitLogEntry[];
  commitHistoryLoading: boolean;
  commitHistoryHasMore: boolean;
  currentBranch: string | null;
  detached: boolean;
  previousBranch: string | null;

  // Multi-file git-ref diff (e.g. from clicking a ~<hash> link in browser mode)
  diffFiles: ParsedDiffFile[] | null;
  diffRefLabel: string | null;
  diffRefLoading: boolean;
  /** Full commit metadata, present only when diffFiles came from a single commit ref. */
  diffCommitInfo: WorkspaceCommitInfo | null;
  /**
   * Raw git ref currently shown in the diff pane (commit hash or
   * `~diff`/`~staged`/`~stash:N`). Drives navigation URLs for commit/ref views.
   */
  diffRef: string | null;

  // Pending navigation (set externally, consumed by WorkspaceExplorerPane)
  pendingNavigation: PendingNavigation | null;
  // Pending diff selection (set externally, consumed by WorkspaceSourceControlPane)
  pendingDiff: string | null;

  // General
  error: string | null;
}

// ============================================================================
// Actions
// ============================================================================

interface WorkspaceViewerActions {
  // Modal control
  open(): void;
  close(): void;
  reset(): void;
  setActiveTab(tab: "explorer" | "sourceControl"): void;

  // Explorer
  setExplorerPath(path: string): void;
  setExplorerEntries(entries: WorkspaceEntry[]): void;
  setExplorerIsGitRepo(isGitRepo: boolean): void;
  setExplorerLoading(loading: boolean): void;

  // File editor
  selectFile(path: string): void;
  setFileContent(content: string): void;
  setLoadedFileContent(path: string, content: string): void;
  /** Load a known image file for inline <img> preview (read-only, no text content). */
  setLoadedImage(path: string, imageDataUri: string): void;
  discardFileDraft(path: string, diskContent: string): void;
  markFileSaved(content?: string): void;
  setFileLoading(loading: boolean): void;
  setFileSaving(saving: boolean): void;
  setFileReadOnly(readOnly: boolean, reason?: string): void;
  clearFile(): void;

  // Mobile editor visibility
  setMobileEditorVisible(v: boolean): void;
  setMobileDiffVisible(v: boolean): void;

  // Repos
  setRepos(repos: WorkspaceRepo[], prefixRepoIds: Record<string, string>): void;
  setSelectedRepoId(id: string | null): void;

  // Source control
  setSourceControlFiles(files: SourceControlFile[]): void;
  setSourceControlLoading(loading: boolean): void;
  selectDiff(path: string | null): void;
  clearDiff(): void;
  setDiffData(
    oldContent: string,
    newContent: string,
    language: string | undefined,
    kind: DiffKind
  ): void;
  setDiffLoading(loading: boolean): void;
  setCommitMessage(msg: string): void;
  setCommitting(v: boolean): void;
  setGeneratingCommitMessage(v: boolean): void;
  setPushing(v: boolean): void;
  setPulling(v: boolean): void;
  setScmError(err: string | null): void;
  setError(err: string | null): void;

  // Commit history
  setCommitHistory(
    commits: WorkspaceCommitLogEntry[],
    hasMore: boolean,
    currentBranch: string | null,
    detached: boolean
  ): void;
  appendCommitHistory(
    commits: WorkspaceCommitLogEntry[],
    hasMore: boolean
  ): void;
  setCommitHistoryLoading(v: boolean): void;
  setPreviousBranch(branch: string | null): void;
  setDetached(detached: boolean): void;

  // Git-ref diff (browser multi-file pane)
  openToGitRef(ref: string): Promise<void>;

  // Pending navigation
  openToFile(filePath: string, startLine?: number, endLine?: number): void;
  openToDirectory(dirPath: string): void;
  clearPendingNavigation(): void;
  openToDiff(path: string): void;
  clearPendingDiff(): void;
}

// ============================================================================
// Initial state
// ============================================================================

const INITIAL_STATE: WorkspaceViewerState = {
  isOpen: false,
  activeTab: "explorer",

  explorerPath: "",
  explorerEntries: [],
  explorerLoading: false,
  explorerIsGitRepo: false,

  selectedFilePath: null,
  fileContent: "",
  originalFileContent: "",
  fileDirty: false,
  fileLoading: false,
  fileSaving: false,
  fileReadOnly: false,
  fileReadOnlyReason: undefined,
  fileImageDataUri: null,
  fileDrafts: {},

  mobileEditorVisible: false,
  mobileDiffVisible: false,

  repos: [],
  prefixRepoIds: {},
  selectedRepoId: null,

  sourceControlFiles: [],
  sourceControlLoading: false,
  selectedDiffPath: null,
  diffOldContent: "",
  diffNewContent: "",
  diffLanguage: undefined,
  diffKind: null,
  diffLoading: false,

  commitMessage: "",
  committing: false,
  generatingCommitMessage: false,
  pushing: false,
  pulling: false,
  scmError: null,

  commitHistory: [],
  commitHistoryLoading: false,
  commitHistoryHasMore: false,
  currentBranch: null,
  detached: false,
  previousBranch: null,

  diffFiles: null,
  diffRefLabel: null,
  diffRefLoading: false,
  diffCommitInfo: null,
  diffRef: null,

  pendingNavigation: null,
  pendingDiff: null,

  error: null,
};

// ============================================================================
// Store
// ============================================================================

export const useWorkspaceViewerStore = create<
  WorkspaceViewerState & WorkspaceViewerActions
>()(
  persist(
    (set, get) => ({
      ...INITIAL_STATE,

      // --- Modal control ---

      open() {
        set({ isOpen: true });
      },

      close() {
        set({
          isOpen: false,
          explorerLoading: false,
          fileLoading: false,
          fileSaving: false,
          sourceControlLoading: false,
          diffLoading: false,
          diffFiles: null,
          diffRefLabel: null,
          diffRefLoading: false,
          diffCommitInfo: null,
          diffRef: null,
          pendingDiff: null,
          commitHistoryLoading: false,
          committing: false,
          generatingCommitMessage: false,
          pushing: false,
          pulling: false,
          scmError: null,
          error: null,
        });
      },

      reset() {
        set({ ...INITIAL_STATE });
      },

      setActiveTab(tab) {
        set({ activeTab: tab });
      },

      // --- Explorer ---

      setExplorerPath(path) {
        set({ explorerPath: path });
      },

      setExplorerEntries(entries) {
        set({ explorerEntries: entries });
      },

      setExplorerIsGitRepo(isGitRepo) {
        set({ explorerIsGitRepo: isGitRepo });
      },

      setExplorerLoading(loading) {
        set({ explorerLoading: loading });
      },

      // --- File editor ---

      selectFile(path) {
        const draft = get().fileDrafts[path];
        set({
          selectedFilePath: path,
          fileContent: draft?.content ?? "",
          originalFileContent: "",
          fileDirty: draft !== undefined,
          fileReadOnly: false,
          fileReadOnlyReason: undefined,
          fileImageDataUri: null,
        });
      },

      setFileContent(content) {
        const { selectedFilePath, originalFileContent, fileDrafts } = get();
        const fileDirty = content !== originalFileContent;
        const nextDrafts =
          selectedFilePath === null
            ? fileDrafts
            : fileDirty
              ? { ...fileDrafts, [selectedFilePath]: { content } }
              : Object.fromEntries(
                  Object.entries(fileDrafts).filter(
                    ([path]) => path !== selectedFilePath
                  )
                );

        set({ fileContent: content, fileDirty, fileDrafts: nextDrafts });
      },

      setLoadedFileContent(path, content) {
        const draft = get().fileDrafts[path];
        const fileContent = draft?.content ?? content;
        const fileDirty = fileContent !== content;
        const nextDrafts =
          draft !== undefined && !fileDirty
            ? Object.fromEntries(
                Object.entries(get().fileDrafts).filter(
                  ([draftPath]) => draftPath !== path
                )
              )
            : get().fileDrafts;

        set({
          selectedFilePath: path,
          fileContent,
          originalFileContent: content,
          fileDirty,
          fileDrafts: nextDrafts,
          fileImageDataUri: null,
        });
      },

      setLoadedImage(path, imageDataUri) {
        set({
          selectedFilePath: path,
          fileContent: "",
          originalFileContent: "",
          fileDirty: false,
          fileReadOnly: false,
          fileReadOnlyReason: undefined,
          fileImageDataUri: imageDataUri,
        });
      },

      discardFileDraft(path, diskContent) {
        const nextDrafts = Object.fromEntries(
          Object.entries(get().fileDrafts).filter(
            ([draftPath]) => draftPath !== path
          )
        );

        set({
          selectedFilePath: path,
          fileContent: diskContent,
          originalFileContent: diskContent,
          fileDirty: false,
          fileDrafts: nextDrafts,
          fileImageDataUri: null,
        });
      },

      markFileSaved(content) {
        const { selectedFilePath, fileDrafts } = get();
        const savedContent = content ?? get().fileContent;
        const nextDrafts =
          selectedFilePath === null
            ? fileDrafts
            : Object.fromEntries(
                Object.entries(fileDrafts).filter(
                  ([path]) => path !== selectedFilePath
                )
              );

        set({
          fileContent: savedContent,
          originalFileContent: savedContent,
          fileDirty: false,
          fileDrafts: nextDrafts,
        });
      },

      setFileLoading(loading) {
        set({ fileLoading: loading });
      },

      setFileSaving(saving) {
        set({ fileSaving: saving });
      },

      setFileReadOnly(readOnly, reason) {
        set({
          fileReadOnly: readOnly,
          fileReadOnlyReason: readOnly ? reason : undefined,
        });
      },

      clearFile() {
        set({
          selectedFilePath: null,
          fileContent: "",
          originalFileContent: "",
          fileDirty: false,
          fileReadOnly: false,
          fileReadOnlyReason: undefined,
          fileImageDataUri: null,
        });
      },

      // --- Mobile ---

      setMobileEditorVisible(v) {
        set({ mobileEditorVisible: v });
      },

      setMobileDiffVisible(v) {
        set({ mobileDiffVisible: v });
      },

      // --- Repos ---

      setRepos(repos, prefixRepoIds) {
        const { selectedRepoId, selectedDiffPath, selectedFilePath } = get();
        const stillValid =
          selectedRepoId !== null &&
          repos.some((repo) => repo.id === selectedRepoId);
        const next = stillValid
          ? selectedRepoId
          : (repoIdForPath(
              selectedDiffPath ?? selectedFilePath,
              prefixRepoIds
            ) ??
            repos[0]?.id ??
            null);
        set({ repos, prefixRepoIds, selectedRepoId: next });
      },

      setSelectedRepoId(id) {
        set({ selectedRepoId: id });
      },

      // --- Source control ---

      setSourceControlFiles(files) {
        const selectedDiffPath = get().selectedDiffPath;
        const selectedStillExists =
          selectedDiffPath !== null &&
          files.some((file) => file.path === selectedDiffPath);

        set({
          sourceControlFiles: files,
          ...(selectedDiffPath !== null && !selectedStillExists
            ? {
                selectedDiffPath: null,
                diffOldContent: "",
                diffNewContent: "",
                diffLanguage: undefined,
                diffKind: null,
                diffLoading: false,
              }
            : {}),
        });
      },

      setSourceControlLoading(loading) {
        set({ sourceControlLoading: loading });
      },

      selectDiff(path) {
        set({
          selectedDiffPath: path,
          diffFiles: null,
          diffRefLabel: null,
          diffRefLoading: false,
          diffCommitInfo: null,
          diffRef: null,
        });
      },

      clearDiff() {
        set({
          selectedDiffPath: null,
          diffOldContent: "",
          diffNewContent: "",
          diffLanguage: undefined,
          diffKind: null,
          diffLoading: false,
          diffFiles: null,
          diffRefLabel: null,
          diffRefLoading: false,
          diffCommitInfo: null,
          diffRef: null,
          pendingDiff: null,
        });
      },

      setDiffData(oldContent, newContent, language, kind) {
        set({
          diffOldContent: oldContent,
          diffNewContent: newContent,
          diffLanguage: language,
          diffKind: kind,
        });
      },

      setDiffLoading(loading) {
        set({ diffLoading: loading });
      },

      setCommitMessage(msg) {
        set({ commitMessage: msg });
      },

      setCommitting(v) {
        set({ committing: v });
      },

      setGeneratingCommitMessage(v) {
        set({ generatingCommitMessage: v });
      },

      setPushing(v) {
        set({ pushing: v });
      },

      setPulling(v) {
        set({ pulling: v });
      },

      setScmError(err) {
        set({ scmError: err });
      },

      setError(err) {
        set({ error: err });
      },

      // --- Commit history ---

      setCommitHistory(commits, hasMore, currentBranch, detached) {
        set({
          commitHistory: commits,
          commitHistoryHasMore: hasMore,
          currentBranch,
          detached,
        });
      },

      appendCommitHistory(commits, hasMore) {
        set((state) => ({
          commitHistory: [...state.commitHistory, ...commits],
          commitHistoryHasMore: hasMore,
        }));
      },

      setCommitHistoryLoading(v) {
        set({ commitHistoryLoading: v });
      },

      setPreviousBranch(branch) {
        set({ previousBranch: branch });
      },

      setDetached(detached) {
        set({ detached });
      },

      // --- Git-ref diff (browser multi-file) ---

      async openToGitRef(ref) {
        set({
          isOpen: true,
          activeTab: "sourceControl",
          // Clear single-file diff so the pane switches to ref mode
          selectedDiffPath: null,
          diffFiles: null,
          diffRefLabel: null,
          diffRefLoading: true,
          diffCommitInfo: null,
          diffRef: ref,
          pendingDiff: null,
        });
        try {
          const { unifiedDiff, commitInfo } = await workspaceGitRefDiff(
            ref,
            get().selectedRepoId ?? undefined
          );
          const diffFiles = parseUnifiedDiffToFiles(unifiedDiff);
          const shortRef = ref.startsWith("~") ? ref.slice(1) : ref;
          const diffRefLabel =
            ref === "~diff"
              ? "Working Tree Changes"
              : ref === "~staged"
                ? "Staged Changes"
                : ref.startsWith("~stash:")
                  ? `Stash #${ref.slice("~stash:".length)}`
                  : `Commit ${shortRef.slice(0, 7)}`;
          set({
            diffFiles,
            diffRefLabel,
            diffRefLoading: false,
            diffCommitInfo: commitInfo ?? null,
          });
        } catch {
          set({ diffRefLoading: false });
        }
      },

      // --- Pending navigation ---

      openToFile(filePath, startLine, endLine) {
        set({
          isOpen: true,
          activeTab: "explorer",
          pendingNavigation: { type: "file", filePath, startLine, endLine },
        });
      },

      openToDirectory(dirPath) {
        set({
          isOpen: true,
          activeTab: "explorer",
          pendingNavigation: { type: "directory", dirPath },
        });
      },

      clearPendingNavigation() {
        set({ pendingNavigation: null });
      },

      openToDiff(path) {
        set({
          isOpen: true,
          activeTab: "sourceControl",
          selectedDiffPath: path,
          pendingDiff: path,
          // Leaving ref mode for a single-file diff.
          diffFiles: null,
          diffRefLabel: null,
          diffRefLoading: false,
          diffCommitInfo: null,
          diffRef: null,
        });
      },

      clearPendingDiff() {
        set({ pendingDiff: null });
      },
    }),
    {
      name: "ctrlyoke-workspace-viewer-state",
      skipHydration: true,
      storage: createJSONStorage(() => vsCodeRawStorage),
      partialize: (state) => ({
        fileDrafts: state.fileDrafts,
      }),
    }
  )
);
