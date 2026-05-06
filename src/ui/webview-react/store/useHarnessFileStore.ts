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
    overwrite: boolean,
    scope: "workspace" | "user"
  ) => void;
  deleteFile: (
    name: string,
    harnessId: string,
    fileType: "agent" | "skill",
    scope: "workspace" | "user"
  ) => void;
  syncAll: (
    files: Array<{ sourcePath: string; name: string }>,
    targetHarnessId: string,
    fileType: "agent" | "skill",
    scope: "workspace" | "user"
  ) => void;
  deleteAll: (
    harnessId: string,
    fileType: "agent" | "skill",
    scope: "workspace" | "user"
  ) => void;
  openHarnessDir: (
    harnessId: string,
    fileType: "agent" | "skill",
    scope: "workspace" | "user"
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
