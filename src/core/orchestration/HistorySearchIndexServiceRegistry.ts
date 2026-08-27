import * as path from "path";
import { HistorySearchIndexService } from "./HistorySearchIndexService";

const sharedServices = new Map<string, HistorySearchIndexService>();

function normalizeWorkspaceFolderPath(workspaceFolderPath: string): string {
  const resolvedPath = path.resolve(workspaceFolderPath);
  return process.platform === "win32"
    ? resolvedPath.toLowerCase()
    : resolvedPath;
}

/**
 * Returns the process-wide history index service for one workspace folder.
 * The resolved path keeps equivalent relative/trailing-separator forms
 * together, while the Windows case fold matches the platform's path rules.
 */
export function getSharedHistorySearchIndexService(
  workspaceFolderPath: string
): HistorySearchIndexService {
  const key = normalizeWorkspaceFolderPath(workspaceFolderPath);
  let service = sharedServices.get(key);
  if (!service) {
    service = new HistorySearchIndexService();
    sharedServices.set(key, service);
  }
  return service;
}
