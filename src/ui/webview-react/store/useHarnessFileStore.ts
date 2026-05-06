import { create } from "zustand";
import { MESSAGE_TYPES, HARNESS_FILE_TYPES, type HarnessFileType } from "@/types/messages";
import type { ManagedFile } from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@hooks/useMessageHandler";

interface HarnessFileState {
  managedFiles: ManagedFile[];
  activeType: HarnessFileType;
  loading: boolean;
  error: string | null;

  setActiveType: (type: HarnessFileType) => void;
  setFiles: (files: ManagedFile[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  requestFiles: () => void;
  exportFile: (
    sourcePath: string,
    harnessId: string,
    fileType: HarnessFileType,
    overwrite: boolean,
    scope: "workspace" | "user"
  ) => void;
  deleteFile: (
    name: string,
    harnessId: string,
    fileType: HarnessFileType,
    scope: "workspace" | "user"
  ) => void;
  syncAll: (
    files: Array<{ sourcePath: string; name: string }>,
    targetHarnessId: string,
    fileType: HarnessFileType,
    scope: "workspace" | "user"
  ) => void;
  deleteAll: (
    harnessId: string,
    fileType: HarnessFileType,
    scope: "workspace" | "user"
  ) => void;
  openHarnessDir: (
    harnessId: string,
    fileType: HarnessFileType,
    scope: "workspace" | "user"
  ) => void;
}

export const useHarnessFileStore = create<HarnessFileState>((set, get) => ({
  managedFiles: [],
  activeType: HARNESS_FILE_TYPES.AGENT,
  loading: false,
  error: null,

  setActiveType: (type) => {
    set({ activeType: type });
    get().requestFiles();
  },

  setFiles: (files) => set({ managedFiles: files, loading: false }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error, loading: false }),

  requestFiles: () => {
    set({ loading: true, error: null });
    sendMessage(MESSAGE_TYPES.REQUEST_HARNESS_FILES, {
      fileType: get().activeType,
    });
  },

  exportFile: (sourcePath, harnessId, fileType, overwrite, scope) => {
    set({ loading: true, error: null });
    sendMessage(MESSAGE_TYPES.EXPORT_TO_HARNESS, {
      sourcePath,
      harnessId,
      fileType,
      overwrite,
      scope,
    });
  },

  deleteFile: (name, harnessId, fileType, scope) => {
    set({ loading: true, error: null });
    sendMessage(MESSAGE_TYPES.DELETE_FROM_HARNESS, {
      name,
      harnessId,
      fileType,
      scope,
    });
  },

  syncAll: (files, targetHarnessId, fileType, scope) => {
    set({ loading: true, error: null });
    sendMessage(MESSAGE_TYPES.SYNC_ALL_TO_HARNESS, {
      files,
      targetHarnessId,
      fileType,
      scope,
    });
  },

  deleteAll: (harnessId, fileType, scope) => {
    set({ loading: true, error: null });
    sendMessage(MESSAGE_TYPES.DELETE_ALL_FROM_HARNESS, { harnessId, fileType, scope });
  },

  openHarnessDir: (harnessId, fileType, scope) => {
    sendMessage(MESSAGE_TYPES.OPEN_HARNESS_DIR, { harnessId, fileType, scope });
  },
}));
