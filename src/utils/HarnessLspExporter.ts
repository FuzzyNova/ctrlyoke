import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  applyEdits,
  modify,
  parse,
  type FormattingOptions,
} from "jsonc-parser";
import type { LanguageServerDefinition } from "../types/CtrlYokeSettings";
import {
  LSP_EXPORT_TARGET_IDS,
  SETTING_SCOPES,
  type LspExportTargetId,
  type SettingWriteScope,
} from "../types/DashboardConstants";
import {
  getCclspConfigPaths,
  getCopilotWorkspaceLspConfigPaths,
  getHomeLspConfigPath,
  getOpenCodeUserLspConfigPath,
  getOpenCodeWorkspaceLspConfigPath,
  getQwenWorkspaceLspConfigPath,
} from "./LspConfigPaths";

type JsonObject = Record<string, unknown>;
export interface HarnessLspExportResult {
  filePath: string;
  exportedCount: number;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function formatting(text: string): FormattingOptions {
  const match = text.match(/\n([ \t]+)/);
  return {
    insertSpaces: Boolean(match && match[1]![0] !== "\t"),
    tabSize: match && match[1]![0] !== "\t" ? match[1]!.length : 2,
    eol: text.includes("\r\n") ? "\r\n" : "\n",
  };
}
async function read(pathname: string): Promise<string> {
  try {
    return await fs.readFile(pathname, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "{}";
    throw error;
  }
}
async function write(pathname: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(pathname), { recursive: true });
  const temp = `${pathname}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, text, "utf8");
    await fs.rename(temp, pathname);
  } catch (error) {
    await fs.unlink(temp).catch(() => undefined);
    throw error;
  }
}
function languageMap(
  definition: LanguageServerDefinition
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const extension of definition.extensions) {
    const language =
      definition.languages.find((candidate) => candidate !== "plaintext") ??
      definition.languages[0];
    if (language) result[`.${extension.replace(/^\./, "")}`] = language;
  }
  return result;
}
function common(definition: LanguageServerDefinition) {
  return {
    command: definition.command[0] ?? "",
    args: definition.command.slice(1),
    ...(definition.env && Object.keys(definition.env).length
      ? { env: definition.env }
      : {}),
  };
}
function toEntry(
  targetId: LspExportTargetId,
  definition: LanguageServerDefinition
): JsonObject {
  const { command, args, env } = common(definition);
  if (targetId === LSP_EXPORT_TARGET_IDS.QWEN_WORKSPACE)
    return {
      command,
      ...(args.length ? { args } : {}),
      extensionToLanguage: languageMap(definition),
      ...(env ? { env } : {}),
    };
  if (
    targetId === LSP_EXPORT_TARGET_IDS.COPILOT_WORKSPACE ||
    targetId === LSP_EXPORT_TARGET_IDS.COPILOT_USER
  )
    return {
      command,
      ...(args.length ? { args } : {}),
      fileExtensions: languageMap(definition),
      ...(env ? { env } : {}),
    };
  if (
    targetId === LSP_EXPORT_TARGET_IDS.OPENCODE_WORKSPACE ||
    targetId === LSP_EXPORT_TARGET_IDS.OPENCODE_USER
  )
    return {
      command: definition.command,
      extensions: definition.extensions.map(
        (extension) => `.${extension.replace(/^\./, "")}`
      ),
      ...(env ? { env } : {}),
    };
  return {
    extensions: definition.extensions.map((extension) =>
      extension.replace(/^\./, "")
    ),
    command: definition.command,
  };
}
function resolvePath(
  targetId: LspExportTargetId,
  scope: SettingWriteScope,
  root?: string
): string {
  if (scope === SETTING_SCOPES.WORKSPACE && !root)
    throw new Error("Workspace-scoped LSP export requires an open workspace.");
  switch (targetId) {
    case LSP_EXPORT_TARGET_IDS.QWEN_WORKSPACE:
      return getQwenWorkspaceLspConfigPath(root!);
    case LSP_EXPORT_TARGET_IDS.COPILOT_WORKSPACE:
      return getCopilotWorkspaceLspConfigPaths(root!)[0]!;
    case LSP_EXPORT_TARGET_IDS.COPILOT_USER:
      return getHomeLspConfigPath();
    case LSP_EXPORT_TARGET_IDS.OPENCODE_WORKSPACE:
      return getOpenCodeWorkspaceLspConfigPath(root!);
    case LSP_EXPORT_TARGET_IDS.OPENCODE_USER:
      return getOpenCodeUserLspConfigPath();
    case LSP_EXPORT_TARGET_IDS.CCLSP_WORKSPACE:
      return getCclspConfigPaths(root!)[0]!;
  }
}

export class HarnessLspExporter {
  constructor(private readonly workspaceRoot?: string) {}
  async export(
    id: string,
    definition: LanguageServerDefinition,
    targetId: LspExportTargetId,
    scope: SettingWriteScope
  ): Promise<HarnessLspExportResult> {
    const filePath = resolvePath(targetId, scope, this.workspaceRoot);
    let text = await read(filePath);
    const options = formatting(text);
    if (targetId === LSP_EXPORT_TARGET_IDS.CCLSP_WORKSPACE) {
      const document = parse(text) as JsonObject;
      const entries: unknown[] = Array.isArray(document.servers)
        ? document.servers.slice()
        : [];
      const entry = toEntry(targetId, definition);
      const alreadyPresent = entries.some(
        (item) =>
          isObject(item) && JSON.stringify(item) === JSON.stringify(entry)
      );
      if (!alreadyPresent) entries.push(entry);
      text = applyEdits(
        text,
        modify(text, ["servers"], entries, { formattingOptions: options })
      );
    } else {
      const key =
        targetId === LSP_EXPORT_TARGET_IDS.OPENCODE_WORKSPACE ||
        targetId === LSP_EXPORT_TARGET_IDS.OPENCODE_USER
          ? "lsp"
          : targetId === LSP_EXPORT_TARGET_IDS.COPILOT_WORKSPACE ||
              targetId === LSP_EXPORT_TARGET_IDS.COPILOT_USER
            ? "lspServers"
            : undefined;
      const entry = toEntry(targetId, definition);
      const edits = key
        ? modify(text, [key, id], entry, { formattingOptions: options })
        : modify(text, [id], entry, { formattingOptions: options });
      text = applyEdits(text, edits);
    }
    await write(filePath, text);
    return { filePath, exportedCount: 1 };
  }
}
