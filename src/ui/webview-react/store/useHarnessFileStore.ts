import { create } from "zustand";
import { MESSAGE_TYPES } from "@/types/messages";
import type { ManagedFile } from "@root/types/WebviewMessageTypes";
import { sendMessage } from "@hooks/useMessageHandler";

interface HarnessFileState {
  managedFiles: ManagedFile[];
  activeType: "agent" | "skill";
  loading: boolean;
  error: string | null;

  setActiveType: (type: "agent" | "skill") => void;
  setFiles: (files: ManagedFile[]) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  requestFiles: () => void;
  exportFile: (
    sourcePath: string,
    harnessId: string,
    fileType: "agent" | "skill",
    overwrite?: boolean
  ) => void;
  importFile: (
    sourcePath: string,
    fileType: "agent" | "skill",
    overwrite?: boolean
  ) => void;
  deleteFile: (
    name: string,
    harnessId: string,
    fileType: "agent" | "skill"
  ) => void;
  syncAll: (
    files: Array<{ sourcePath: string; name: string }>,
    targetHarnessId: string,
    fileType: "agent" | "skill"
  ) => void;
  deleteAll: (harnessId: string, fileType: "agent" | "skill") => void;
  openHarnessDir: (
    harnessId: string,
    fileType: "agent" | "skill"
  ) => void;
}

export const useHarnessFileStore = create<HarnessFileState>((set, get) => ({
  managedFiles: [],
  activeType: "agent",
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

  exportFile: (sourcePath, harnessId, fileType, overwrite = false) => {
    set({ loading: true, error: null });
    sendMessage(MESSAGE_TYPES.EXPORT_TO_HARNESS, {
      sourcePath,
      harnessId,
      fileType,
      overwrite,
    });
  },

  importFile: (sourcePath, fileType, overwrite = false) => {
    set({ loading: true, error: null });
    sendMessage(MESSAGE_TYPES.IMPORT_TO_FLIGHTPATH, {
      sourcePath,
      fileType,
      overwrite,
    });
  },

  deleteFile: (name, harnessId, fileType) => {
    set({ loading: true, error: null });
    sendMessage(MESSAGE_TYPES.DELETE_FROM_HARNESS, {
      name,
      harnessId,
      fileType,
    });
  },

  syncAll: (files, targetHarnessId, fileType) => {
    set({ loading: true, error: null });
    sendMessage(MESSAGE_TYPES.SYNC_ALL_TO_HARNESS, {
      files,
      targetHarnessId,
      fileType,
    });
  },

  deleteAll: (harnessId, fileType) => {
    set({ loading: true, error: null });
    sendMessage(MESSAGE_TYPES.DELETE_ALL_FROM_HARNESS, { harnessId, fileType });
  },

  openHarnessDir: (harnessId, fileType) => {
    sendMessage(MESSAGE_TYPES.OPEN_HARNESS_DIR, { harnessId, fileType });
  },
}));
