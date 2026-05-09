import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { vsCodeRawStorage } from "@utils/vsCodeStateStorage";
import type {
  WorkspaceEntry,
  SourceControlFile,
  DiffKind,
} from "@root/types/HostedWorkspaceViewerTypes";

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

  // File editor
  selectedFilePath: string | null;
  fileContent: string;
  originalFileContent: string;
  fileDirty: boolean;
  fileLoading: boolean;
  fileSaving: boolean;
  fileReadOnly: boolean;
  fileReadOnlyReason: string | undefined;
  fileDrafts: Record<string, CachedFileDraft>;

  // Mobile: in explorer tab, whether the file editor is shown (vs directory list)
  mobileEditorVisible: boolean;

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
  pushing: boolean;
  pulling: boolean;
  scmError: string | null;

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
  setExplorerLoading(loading: boolean): void;

  // File editor
  selectFile(path: string): void;
  setFileContent(content: string): void;
  setLoadedFileContent(path: string, content: string): void;
  discardFileDraft(path: string, diskContent: string): void;
  markFileSaved(content?: string): void;
  setFileLoading(loading: boolean): void;
  setFileSaving(saving: boolean): void;
  setFileReadOnly(readOnly: boolean, reason?: string): void;
  clearFile(): void;

  // Mobile editor visibility
  setMobileEditorVisible(v: boolean): void;

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
  setPushing(v: boolean): void;
  setPulling(v: boolean): void;
  setScmError(err: string | null): void;
  setError(err: string | null): void;
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

  selectedFilePath: null,
  fileContent: "",
  originalFileContent: "",
  fileDirty: false,
  fileLoading: false,
  fileSaving: false,
  fileReadOnly: false,
  fileReadOnlyReason: undefined,
  fileDrafts: {},

  mobileEditorVisible: false,

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
  pushing: false,
  pulling: false,
  scmError: null,

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
          committing: false,
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
        });
      },

      // --- Mobile ---

      setMobileEditorVisible(v) {
        set({ mobileEditorVisible: v });
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
        set({ selectedDiffPath: path });
      },

      clearDiff() {
        set({
          selectedDiffPath: null,
          diffOldContent: "",
          diffNewContent: "",
          diffLanguage: undefined,
          diffKind: null,
          diffLoading: false,
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
    }),
    {
      name: "flightpath-workspace-viewer-state",
      skipHydration: true,
      storage: createJSONStorage(() => vsCodeRawStorage),
      partialize: (state) => ({
        fileDrafts: state.fileDrafts,
      }),
    }
  )
);
