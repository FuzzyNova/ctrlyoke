import { applyEdits, modify, parse } from "jsonc-parser";
import type { LanguageServerDefinition } from "../types/CtrlYokeSettings";
import { LANGUAGE_SERVER_CATALOG } from "../server/lsp/LanguageServerCatalog";
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
import { detectFormattingOptions } from "./WorkflowSourceEditor";
import { readFileForEdit, writeTextFileAtomic } from "./AtomicFileUtils";

type JsonObject = Record<string, unknown>;
export interface HarnessLspExportResult {
  filePath: string;
  exportedCount: number;
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
function languageMap(
  definition: LanguageServerDefinition,
  catalogMap?: Record<string, string>
): Record<string, string> {
  const result: Record<string, string> = {};
  const known: Record<string, string> = {
    ts: "typescript",
    tsx: "typescriptreact",
    js: "javascript",
    jsx: "javascriptreact",
    mts: "typescript",
    cts: "typescript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    pyw: "python",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    less: "less",
    json: "json",
    jsonc: "jsonc",
    yml: "yaml",
    yaml: "yaml",
    md: "markdown",
    markdown: "markdown",
    go: "go",
    rs: "rust",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    cs: "csharp",
    java: "java",
    lua: "lua",
    toml: "toml",
  };
  for (const extension of definition.extensions) {
    const normalized = extension.replace(/^\./, "");
    const mapped = catalogMap?.[normalized] ?? known[normalized];
    const language =
      (mapped && definition.languages.includes(mapped) ? mapped : undefined) ??
      (definition.languages.length === 1
        ? definition.languages[0]
        : undefined) ??
      (definition.extensions.length === definition.languages.length
        ? definition.languages[definition.extensions.indexOf(extension)]
        : undefined);
    if (language) result[`.${normalized}`] = language;
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
  definition: LanguageServerDefinition,
  catalogMap?: Record<string, string>
): JsonObject {
  const { command, args, env } = common(definition);
  if (targetId === LSP_EXPORT_TARGET_IDS.QWEN_WORKSPACE)
    return {
      command,
      ...(args.length ? { args } : {}),
      extensionToLanguage: languageMap(definition, catalogMap),
      ...(env ? { env } : {}),
    };
  if (
    targetId === LSP_EXPORT_TARGET_IDS.COPILOT_WORKSPACE ||
    targetId === LSP_EXPORT_TARGET_IDS.COPILOT_USER
  )
    return {
      command,
      ...(args.length ? { args } : {}),
      fileExtensions: languageMap(definition, catalogMap),
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
    let text = await readFileForEdit(filePath, "{}");
    const options = detectFormattingOptions(text, 2);
    const catalogMap = LANGUAGE_SERVER_CATALOG.find(
      (entry) => entry.id === id
    )?.extensionToLanguage;
    if (targetId === LSP_EXPORT_TARGET_IDS.CCLSP_WORKSPACE) {
      const document = parse(text) as JsonObject;
      const entries: unknown[] = Array.isArray(document.servers)
        ? document.servers.slice()
        : [];
      const entry = toEntry(targetId, definition, catalogMap);
      const matchingIndex = entries.findIndex(
        (item) =>
          isObject(item) &&
          (item.name === id ||
            (Array.isArray(item.extensions) &&
              item.extensions.length === definition.extensions.length &&
              item.extensions.every((extension) =>
                definition.extensions.includes(
                  String(extension).replace(/^\./, "")
                )
              )))
      );
      if (matchingIndex < 0) entries.push(entry);
      else
        entries[matchingIndex] = {
          ...(entries[matchingIndex] as JsonObject),
          ...entry,
        };
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
      const entry = toEntry(targetId, definition, catalogMap);
      let existing: unknown;
      try {
        existing = parse(text);
      } catch {
        existing = undefined;
      }
      if (
        key &&
        (targetId === LSP_EXPORT_TARGET_IDS.OPENCODE_WORKSPACE ||
          targetId === LSP_EXPORT_TARGET_IDS.OPENCODE_USER)
      ) {
        const parsed = existing as JsonObject | undefined;
        const current = parsed?.[key];
        const servers: JsonObject = isObject(current) ? { ...current } : {};
        const prior = servers[id];
        servers[id] = isObject(prior) ? { ...prior, ...entry } : entry;
        text = applyEdits(
          text,
          modify(text, [key], servers, { formattingOptions: options })
        );
      } else {
        const container =
          key && isObject((existing as JsonObject | undefined)?.[key])
            ? ((existing as JsonObject)[key] as JsonObject)
            : undefined;
        const previous = key
          ? container?.[id]
          : (existing as JsonObject | undefined)?.[id];
        const mergedEntry = isObject(previous)
          ? { ...previous, ...entry }
          : entry;
        const edits = key
          ? modify(text, [key, id], mergedEntry, { formattingOptions: options })
          : modify(text, [id], mergedEntry, { formattingOptions: options });
        text = applyEdits(text, edits);
      }
    }
    await writeTextFileAtomic(filePath, text);
    return { filePath, exportedCount: 1 };
  }
}
