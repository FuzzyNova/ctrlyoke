import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { vsCodeRawStorage } from "@utils/vsCodeStateStorage";
import type {
  SourceControlFile,
  DiffKind,
  WorkspaceCommitInfo,
  WorkspaceRepo,
  WorkspaceSearchResult,
  WorkspaceSearchScope,
  WorkspaceDiffEntry,
  WorkspaceImageDiffSides,
  WorkspaceScmDiffResponse,
} from "@root/types/HostedWorkspaceViewerTypes";
import {
  DIFF_PAYLOAD_KINDS,
  type DiffPayloadKind,
} from "@root/types/DashboardConstants";
import type { ParsedDiffFile } from "@utils/rdvAdapter";
import { workspaceGitRefDiff, workspaceWorktreeDiff } from "@utils/hostedApi";
import { parseUnifiedDiffToFiles } from "@utils/rdvAdapter";

// ============================================================================
// Types
// ============================================================================

export type PendingNavigation =
  | { type: "file"; filePath: string; startLine?: number; endLine?: number }
  | { type: "directory"; dirPath: string };

export interface PendingFileHistory {
  path: string;
  repoId: string | null;
  generation: number;
}

function normalizeWorkspacePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

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
  activeTab: "explorer" | "sourceControl" | "search";

  // Explorer
  explorerPath: string;

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
  diffPayloadKind: DiffPayloadKind | null;
  diffImage: WorkspaceImageDiffSides | null;
  diffLoading: boolean;

  // Search
  searchQuery: string;
  searchScope: WorkspaceSearchScope;
  searchIncludeGitIgnored: boolean;
  searchResults: WorkspaceSearchResult[];
  searchLoading: boolean;
  searchTruncated: boolean;

  // Commit area
  commitMessage: string;
  committing: boolean;
  generatingCommitMessage: boolean;
  pushing: boolean;
  pulling: boolean;
  scmError: string | null;

  // Commit history
  currentBranch: string | null;
  detached: boolean;
  previousBranch: string | null;

  // Multi-file git-ref diff (e.g. from clicking a ~<hash> link in browser mode)
  diffFiles: ParsedDiffFile[] | null;
  diffNonTextEntries: WorkspaceDiffEntry[];
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
  // File-history projection (set externally, consumed by WorkspaceSourceControlPane)
  fileHistoryPath: string | null;
  fileHistoryRepoId: string | null;
  fileHistoryActive: boolean;
  pendingFileHistory: PendingFileHistory | null;
  fileHistoryGeneration: number;

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
  setActiveTab(tab: "explorer" | "sourceControl" | "search"): void;

  // Explorer
  setExplorerPath(path: string): void;

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
  setDiffData(response: WorkspaceScmDiffResponse): void;
  setDiffLoading(loading: boolean): void;
  setCommitMessage(msg: string): void;
  setCommitting(v: boolean): void;
  setGeneratingCommitMessage(v: boolean): void;
  setPushing(v: boolean): void;
  setPulling(v: boolean): void;
  setScmError(err: string | null): void;
  setError(err: string | null): void;

  // Search
  setSearchQuery(query: string): void;
  setSearchScope(scope: WorkspaceSearchScope): void;
  setSearchIncludeGitIgnored(include: boolean): void;
  setSearchResults(results: WorkspaceSearchResult[]): void;
  setSearchLoading(loading: boolean): void;
  setSearchTruncated(truncated: boolean): void;

  // Commit history metadata used by the context menu and detached banner.
  setCurrentBranch(branch: string | null): void;
  setPreviousBranch(branch: string | null): void;
  setDetached(detached: boolean): void;

  // Git-ref diff (browser multi-file pane)
  openToGitRef(ref: string): Promise<void>;
  /** Diff a recorded worktree run's branch against its recorded base commit. */
  openToWorktreeDiff(
    sourceCheckoutRoot: string,
    baseCommit: string,
    branchName: string
  ): Promise<void>;

  // Pending navigation
  openToFile(filePath: string, startLine?: number, endLine?: number): void;
  openToDirectory(dirPath: string): void;
  clearPendingNavigation(): void;
  openToDiff(path: string): void;
  clearPendingDiff(): void;
  openToFileHistory(path: string): void;
  clearPendingFileHistory(): void;
  closeFileHistoryView(): void;
}

// ============================================================================
// Initial state
// ============================================================================

const INITIAL_STATE: WorkspaceViewerState = {
  isOpen: false,
  activeTab: "explorer",

  explorerPath: "",

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
  diffPayloadKind: null,
  diffImage: null,
  diffLoading: false,

  searchQuery: "",
  searchScope: "both",
  searchIncludeGitIgnored: false,
  searchResults: [],
  searchLoading: false,
  searchTruncated: false,

  commitMessage: "",
  committing: false,
  generatingCommitMessage: false,
  pushing: false,
  pulling: false,
  scmError: null,

  currentBranch: null,
  detached: false,
  previousBranch: null,

  diffFiles: null,
  diffNonTextEntries: [],
  diffRefLabel: null,
  diffRefLoading: false,
  diffCommitInfo: null,
  diffRef: null,

  pendingNavigation: null,
  pendingDiff: null,
  fileHistoryPath: null,
  fileHistoryRepoId: null,
  fileHistoryActive: false,
  pendingFileHistory: null,
  fileHistoryGeneration: 0,

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
          fileLoading: false,
          fileSaving: false,
          sourceControlLoading: false,
          diffLoading: false,
          searchLoading: false,
          searchResults: [],
          searchTruncated: false,
          searchQuery: "",
          diffFiles: null,
          diffRefLabel: null,
          diffRefLoading: false,
          diffCommitInfo: null,
          diffRef: null,
          pendingDiff: null,
          pendingFileHistory: null,
          fileHistoryActive: false,
          fileHistoryPath: null,
          fileHistoryRepoId: null,
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
                diffPayloadKind: null,
                diffImage: null,
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
          fileHistoryPath: null,
          fileHistoryRepoId: null,
          fileHistoryActive: false,
          pendingFileHistory: null,
          diffPayloadKind: null,
          diffImage: null,
          diffFiles: null,
          diffNonTextEntries: [],
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
          diffPayloadKind: null,
          diffImage: null,
          diffLoading: false,
          diffFiles: null,
          diffNonTextEntries: [],
          diffRefLabel: null,
          diffRefLoading: false,
          diffCommitInfo: null,
          diffRef: null,
          pendingDiff: null,
          fileHistoryPath: null,
          fileHistoryRepoId: null,
          fileHistoryActive: false,
          pendingFileHistory: null,
        });
      },

      setDiffData(response) {
        const isText = response.payloadKind === DIFF_PAYLOAD_KINDS.TEXT;
        set({
          diffOldContent: isText ? response.oldContent : "",
          diffNewContent: isText ? response.newContent : "",
          diffLanguage: isText ? response.language : undefined,
          diffKind: response.kind,
          diffPayloadKind: response.payloadKind,
          diffImage:
            response.payloadKind === DIFF_PAYLOAD_KINDS.IMAGE
              ? response.image
              : null,
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

      // --- Search ---

      setSearchQuery(query) {
        set({ searchQuery: query });
      },

      setSearchScope(scope) {
        set({ searchScope: scope });
      },

      setSearchIncludeGitIgnored(include) {
        set({ searchIncludeGitIgnored: include });
      },

      setSearchResults(results) {
        set({ searchResults: results });
      },

      setSearchLoading(loading) {
        set({ searchLoading: loading });
      },

      setSearchTruncated(truncated) {
        set({ searchTruncated: truncated });
      },

      // --- Commit history metadata ---

      setCurrentBranch(branch) {
        set({ currentBranch: branch });
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
          diffNonTextEntries: [],
          diffFiles: null,
          diffRefLabel: null,
          diffRefLoading: true,
          diffCommitInfo: null,
          diffRef: ref,
          pendingDiff: null,
          pendingFileHistory: null,
          fileHistoryActive: false,
          fileHistoryPath: null,
          fileHistoryRepoId: null,
        });
        try {
          const { unifiedDiff, commitInfo, nonTextEntries } =
            await workspaceGitRefDiff(ref, get().selectedRepoId ?? undefined);
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
            diffNonTextEntries: nonTextEntries ?? [],
            diffRefLabel,
            diffRefLoading: false,
            diffCommitInfo: commitInfo ?? null,
          });
        } catch {
          set({ diffRefLoading: false });
        }
      },

      async openToWorktreeDiff(sourceCheckoutRoot, baseCommit, branchName) {
        set({
          isOpen: true,
          activeTab: "sourceControl",
          selectedDiffPath: null,
          diffFiles: null,
          diffNonTextEntries: [],
          diffRefLabel: null,
          diffRefLoading: true,
          diffCommitInfo: null,
          diffRef: null,
          pendingDiff: null,
          pendingFileHistory: null,
          fileHistoryActive: false,
          fileHistoryPath: null,
          fileHistoryRepoId: null,
        });
        try {
          const { unifiedDiff, nonTextEntries } = await workspaceWorktreeDiff(
            sourceCheckoutRoot,
            baseCommit,
            branchName
          );
          set({
            diffFiles: parseUnifiedDiffToFiles(unifiedDiff),
            diffNonTextEntries: nonTextEntries ?? [],
            diffRefLabel: `Branch ${branchName}`,
            diffRefLoading: false,
          });
        } catch {
          set({ diffRefLoading: false });
        }
      },

      // --- Pending navigation ---

      openToFile(filePath, startLine, endLine) {
        // Select the target synchronously so navigation history records the
        // destination immediately, before WorkspaceExplorerPane consumes the
        // pending request and starts the asynchronous file fetch.
        get().selectFile(filePath);
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
          fileHistoryPath: null,
          fileHistoryRepoId: null,
          fileHistoryActive: false,
          pendingFileHistory: null,
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

      openToFileHistory(path) {
        const normalizedPath = normalizeWorkspacePath(path);
        const repoId = get().selectedRepoId;
        const generation = get().fileHistoryGeneration + 1;
        set({
          isOpen: true,
          activeTab: "sourceControl",
          selectedDiffPath: null,
          pendingDiff: null,
          fileHistoryPath: normalizedPath,
          fileHistoryRepoId: repoId,
          fileHistoryActive: true,
          pendingFileHistory: {
            path: normalizedPath,
            repoId,
            generation,
          },
          fileHistoryGeneration: generation,
          // Leaving ref mode for the file-history projection.
          diffFiles: null,
          diffNonTextEntries: [],
          diffRefLabel: null,
          diffRefLoading: false,
          diffCommitInfo: null,
          diffRef: null,
        });
      },

      clearPendingFileHistory() {
        set({ pendingFileHistory: null });
      },

      closeFileHistoryView() {
        set({ fileHistoryActive: false, pendingFileHistory: null });
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
