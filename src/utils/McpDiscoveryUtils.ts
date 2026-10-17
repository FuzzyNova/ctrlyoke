/**
 * MCP server discovery utilities.
 *
 * Reads local MCP server configurations from well-known config file locations
 * and fetches servers from the Anthropic MCP registry.
 *
 * All I/O runs in the extension host (Node.js) — never in the webview.
 */

import * as fs from "fs/promises";
import { parse, type ParseError } from "jsonc-parser";
import type {
  LocalMcpServerEntry,
  RegistryMcpEntry,
} from "../types/WebviewMessageTypes";
import { Log } from "./Log";
import {
  MCP_CONFIG_ENTRY_TYPES,
  MCP_CONFIG_KEYS,
  MCP_REGISTRY_PACKAGE_TYPES,
  MCP_TRANSPORTS,
  getMcpLocalSource,
  HARNESS_IDS,
  SETTING_SCOPES,
  SPECIAL_TARGET_IDS,
  type McpTransport,
} from "../types/DashboardConstants";
import {
  getClaudeUserConfigPath,
  getClaudeWorkspaceMcpConfigPath,
  getCodexUserMcpConfigPath,
  getCodexWorkspaceMcpConfigPath,
  getAntigravityUserMcpConfigPath,
  getAntigravityWorkspaceMcpConfigPath,
  getCopilotUserMcpConfigPath,
  getCopilotWorkspaceMcpConfigPaths,
  getOpenCodeUserMcpConfigPath,
  getOpenCodeWorkspaceMcpConfigPath,
  getQwenUserMcpConfigPath,
  getQwenWorkspaceMcpConfigPath,
  getVscodeUserMcpConfigPath,
  getVscodeWorkspaceMcpConfigPath,
} from "./McpConfigPaths";

type LocalSource = LocalMcpServerEntry["source"];

const TOML_MCP_SERVERS_TABLE_KEY = "mcp_servers";
const TOML_MCP_ASSIGNMENT_KEYS = {
  ARGS: "args",
  URL: "url",
  TRANSPORT: "transport",
} as const;
type JsonRecord = Record<string, unknown>;

interface LocalConfigDescriptor {
  path: string;
  source: LocalSource;
  format:
    | "vscode-json"
    | "claude-json"
    | "copilot-json"
    | "qwen-json"
    | "antigravity-json"
    | "opencode-json"
    | "codex-toml";
}

function isPlainObject(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function toStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const record: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string") {
      record[key] = item;
    }
  }

  return Object.keys(record).length > 0 ? record : undefined;
}

/**
 * Reads a JSON/JSONC file and returns its parsed content, or null on any error.
 * VS Code config files use JSONC format, including trailing commas.
 */
async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    const errors: ParseError[] = [];
    const parsed = parse(content, errors, { allowTrailingComma: true });
    return errors.length === 0 ? parsed : null;
  } catch {
    return null;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

function buildLocalEntry(
  id: string,
  source: LocalSource,
  filePath: string,
  config: {
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    transport?: McpTransport;
    headers?: Record<string, string>;
  }
): LocalMcpServerEntry | null {
  const hasCommand =
    typeof config.command === "string" && config.command.length > 0;
  const hasUrl = typeof config.url === "string" && config.url.length > 0;
  if (!hasCommand && !hasUrl) {
    return null;
  }

  return {
    id,
    source,
    path: filePath,
    ...(hasCommand ? { command: config.command } : {}),
    ...(config.args?.length ? { args: config.args } : {}),
    ...(config.env ? { env: config.env } : {}),
    ...(hasUrl ? { url: config.url } : {}),
    ...(config.transport ? { transport: config.transport } : {}),
    ...(config.headers ? { headers: config.headers } : {}),
  };
}

function normalizeVscodeServerMap(
  map: JsonRecord,
  source: LocalSource,
  filePath: string
): LocalMcpServerEntry[] {
  return Object.entries(map).flatMap(([id, value]) => {
    if (!isPlainObject(value)) {
      return [];
    }

    const entryType = value.type;
    const isRemote =
      entryType === MCP_CONFIG_ENTRY_TYPES.HTTP ||
      entryType === MCP_TRANSPORTS.SSE;
    const entry = buildLocalEntry(id, source, filePath, {
      command: typeof value.command === "string" ? value.command : undefined,
      args: isStringArray(value.args) ? value.args : undefined,
      env: toStringRecord(value.env),
      url: typeof value.url === "string" ? value.url : undefined,
      transport: isRemote
        ? entryType === MCP_TRANSPORTS.SSE
          ? MCP_TRANSPORTS.SSE
          : MCP_TRANSPORTS.STREAMABLE_HTTP
        : undefined,
      headers: toStringRecord(value.headers),
    });

    return entry ? [entry] : [];
  });
}

function normalizeClaudeServerMap(
  map: JsonRecord,
  source: LocalSource,
  filePath: string
): LocalMcpServerEntry[] {
  return Object.entries(map).flatMap(([id, value]) => {
    if (!isPlainObject(value)) {
      return [];
    }

    const entryType = value.type;
    const transport =
      entryType === MCP_TRANSPORTS.SSE
        ? MCP_TRANSPORTS.SSE
        : typeof value.url === "string"
          ? MCP_TRANSPORTS.STREAMABLE_HTTP
          : undefined;

    const entry = buildLocalEntry(id, source, filePath, {
      command: typeof value.command === "string" ? value.command : undefined,
      args: isStringArray(value.args) ? value.args : undefined,
      env: toStringRecord(value.env),
      url: typeof value.url === "string" ? value.url : undefined,
      transport,
      headers: toStringRecord(value.headers),
    });

    return entry ? [entry] : [];
  });
}

function normalizeCopilotServerMap(
  map: JsonRecord,
  source: LocalSource,
  filePath: string
): LocalMcpServerEntry[] {
  return Object.entries(map).flatMap(([id, value]) => {
    if (!isPlainObject(value)) {
      return [];
    }

    const entryType = value.type;
    const isLocal =
      entryType === MCP_CONFIG_ENTRY_TYPES.LOCAL ||
      entryType === MCP_CONFIG_ENTRY_TYPES.STDIO;
    const transport =
      entryType === MCP_TRANSPORTS.SSE
        ? MCP_TRANSPORTS.SSE
        : entryType === MCP_CONFIG_ENTRY_TYPES.HTTP
          ? MCP_TRANSPORTS.STREAMABLE_HTTP
          : undefined;

    const entry = buildLocalEntry(id, source, filePath, {
      command:
        isLocal && typeof value.command === "string"
          ? value.command
          : undefined,
      args: isStringArray(value.args) ? value.args : undefined,
      env: toStringRecord(value.env),
      url: typeof value.url === "string" ? value.url : undefined,
      transport,
      headers: toStringRecord(value.headers),
    });

    return entry ? [entry] : [];
  });
}

function normalizeQwenServerMap(
  map: JsonRecord,
  source: LocalSource,
  filePath: string
): LocalMcpServerEntry[] {
  return Object.entries(map).flatMap(([id, value]) => {
    if (!isPlainObject(value)) {
      return [];
    }

    const entry = buildLocalEntry(id, source, filePath, {
      command: typeof value.command === "string" ? value.command : undefined,
      args: isStringArray(value.args) ? value.args : undefined,
      env: toStringRecord(value.env),
      url:
        typeof value.httpUrl === "string"
          ? value.httpUrl
          : typeof value.url === "string"
            ? value.url
            : undefined,
      transport:
        typeof value.httpUrl === "string"
          ? MCP_TRANSPORTS.STREAMABLE_HTTP
          : typeof value.url === "string"
            ? MCP_TRANSPORTS.SSE
            : undefined,
      headers: toStringRecord(value.headers),
    });

    return entry ? [entry] : [];
  });
}

function normalizeAntigravityServerMap(
  map: JsonRecord,
  source: LocalSource,
  filePath: string
): LocalMcpServerEntry[] {
  return Object.entries(map).flatMap(([id, value]) => {
    if (!isPlainObject(value)) {
      return [];
    }

    const remoteUrl =
      typeof value.serverUrl === "string"
        ? value.serverUrl
        : typeof value.url === "string"
          ? value.url
          : undefined;

    const entry = buildLocalEntry(id, source, filePath, {
      command: typeof value.command === "string" ? value.command : undefined,
      args: isStringArray(value.args) ? value.args : undefined,
      env: toStringRecord(value.env),
      url: remoteUrl,
      transport: remoteUrl ? MCP_TRANSPORTS.STREAMABLE_HTTP : undefined,
      headers: toStringRecord(value.headers),
    });

    return entry ? [entry] : [];
  });
}

function normalizeOpenCodeServerMap(
  map: JsonRecord,
  source: LocalSource,
  filePath: string
): LocalMcpServerEntry[] {
  return Object.entries(map).flatMap(([id, value]) => {
    if (!isPlainObject(value)) {
      return [];
    }

    const commandValue = value.command;
    const commandParts = isStringArray(commandValue) ? commandValue : undefined;
    const entryType = value.type;

    const entry = buildLocalEntry(id, source, filePath, {
      command: commandParts?.[0],
      args:
        commandParts && commandParts.length > 1
          ? commandParts.slice(1)
          : undefined,
      env: toStringRecord(value.environment),
      url: typeof value.url === "string" ? value.url : undefined,
      transport:
        entryType === MCP_CONFIG_ENTRY_TYPES.REMOTE &&
        typeof value.url === "string"
          ? MCP_TRANSPORTS.STREAMABLE_HTTP
          : undefined,
      headers: toStringRecord(value.headers),
    });

    return entry ? [entry] : [];
  });
}

function unquoteTomlString(value: string): string {
  const quote = value[0];
  if ((quote !== `"` && quote !== `'`) || value[value.length - 1] !== quote) {
    return value;
  }

  const inner = value.slice(1, -1);
  if (quote === `'`) {
    return inner;
  }

  return inner.replace(
    /\\(["\\bfnrt]|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/g,
    (_match, escape: string) => {
      if (escape.startsWith("u") || escape.startsWith("U")) {
        return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
      }

      switch (escape) {
        case "b":
          return "\b";
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        case "f":
          return "\f";
        default:
          return escape;
      }
    }
  );
}

function splitTomlList(text: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: `"` | `'` | null = null;
  let depth = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    const previous = index > 0 ? text[index - 1] : "";

    if (quote) {
      current += char;
      if (char === quote && previous !== "\\") {
        quote = null;
      }
      continue;
    }

    if (char === `"` || char === `'`) {
      quote = char;
      current += char;
      continue;
    }

    if (char === "[" || char === "{") {
      depth += 1;
      current += char;
      continue;
    }

    if (char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }

    if (char === "," && depth === 0) {
      const trimmed = current.trim();
      if (trimmed) {
        items.push(trimmed);
      }
      current = "";
      continue;
    }

    current += char;
  }

  const trimmed = current.trim();
  if (trimmed) {
    items.push(trimmed);
  }

  return items;
}

function parseTomlInlineTable(
  value: string
): Record<string, string> | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    return undefined;
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return undefined;
  }

  const entries: Record<string, string> = {};
  for (const pair of splitTomlList(inner)) {
    const eqIndex = pair.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const rawKey = pair.slice(0, eqIndex).trim();
    const rawValue = pair.slice(eqIndex + 1).trim();
    const key = unquoteTomlString(rawKey);
    if (rawValue.startsWith(`"`) || rawValue.startsWith(`'`)) {
      entries[key] = unquoteTomlString(rawValue);
    }
  }

  return Object.keys(entries).length > 0 ? entries : undefined;
}

function parseTomlStringArray(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return undefined;
  }

  const inner = trimmed.slice(1, -1).trim();
  if (!inner) {
    return [];
  }

  const items = splitTomlList(inner).flatMap((item) => {
    if (item.startsWith(`"`) || item.startsWith(`'`)) {
      return [unquoteTomlString(item)];
    }
    return [];
  });

  return items;
}

/**
 * The dotted key inside a `[table]` or `[[array]]` header line, or null when
 * the line is not a header. A trailing `# comment` is allowed.
 */
export function parseTomlTableHeader(line: string): string | null {
  const match = line.match(/^\s*(\[\[?)(.*?)(\]\]?)(?:\s*#.*)?\s*$/);
  if (!match) return null;
  const isArray = match[1] === "[[";
  if (isArray ? match[3] !== "]]" : match[3] !== "]") return null;
  return match[2]!.trim();
}

/**
 * Split a TOML dotted key into its unquoted parts, allowing whitespace around
 * the dots and quoted parts that contain dots. Null when it does not parse.
 */
function splitTomlDottedKey(key: string): string[] | null {
  const parts: string[] = [];
  let index = 0;
  const skipSpace = () => {
    while (index < key.length && /[ \t]/.test(key[index]!)) index += 1;
  };
  while (true) {
    skipSpace();
    const quote = key[index];
    if (quote === '"' || quote === "'") {
      let close = index + 1;
      while (close < key.length && key[close] !== quote) {
        close += quote === '"' && key[close] === "\\" ? 2 : 1;
      }
      if (close >= key.length) return null;
      parts.push(unquoteTomlString(key.slice(index, close + 1)));
      index = close + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(key.slice(index));
      if (!bare) return null;
      parts.push(bare[0]);
      index += bare[0].length;
    }
    skipSpace();
    if (index === key.length) return parts;
    if (key[index] !== ".") return null;
    index += 1;
  }
}

/**
 * Line indices of the real table headers in a TOML document. Lines inside a
 * multi-line string or a multi-line array are content, even when they look
 * like `[header]`.
 */
export function findTomlTableHeaderLines(lines: readonly string[]): number[] {
  const headers: number[] = [];
  let multilineQuote: string | null = null;
  let arrayDepth = 0;
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex]!;
    if (
      multilineQuote === null &&
      arrayDepth === 0 &&
      parseTomlTableHeader(line) !== null
    ) {
      headers.push(lineIndex);
      continue;
    }
    let index = 0;
    while (index < line.length) {
      if (multilineQuote !== null) {
        const close = line.indexOf(multilineQuote, index);
        if (close < 0) break;
        index = close + 3;
        multilineQuote = null;
        continue;
      }
      const char = line[index]!;
      if (char === "#") break;
      const triple = line.slice(index, index + 3);
      if (triple === '"""' || triple === "'''") {
        multilineQuote = triple;
        index += 3;
        continue;
      }
      if (char === '"' || char === "'") {
        let close = index + 1;
        while (close < line.length && line[close] !== char) {
          close += char === '"' && line[close] === "\\" ? 2 : 1;
        }
        index = close + 1;
        continue;
      }
      if (char === "[") arrayDepth += 1;
      else if (char === "]" && arrayDepth > 0) arrayDepth -= 1;
      index += 1;
    }
  }
  return headers;
}

export interface TomlMcpServerAssignment {
  id: string;
  key: string[];
  value: string;
  startLine: number;
  endLine: number;
}

/**
 * Find assignments owned by individual servers inside a bare
 * `[mcp_servers]` table. The returned line range includes a multi-line value.
 */
export function findTomlMcpServerAssignments(
  lines: readonly string[]
): TomlMcpServerAssignment[] {
  const headerLines = new Set(findTomlTableHeaderLines(lines));
  const assignments: TomlMcpServerAssignment[] = [];
  let inMcpServers = false;

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    if (headerLines.has(lineIndex)) {
      inMcpServers =
        parseTomlTableHeader(lines[lineIndex]!) === TOML_MCP_SERVERS_TABLE_KEY;
      continue;
    }
    if (!inMcpServers) continue;

    const firstLine = lines[lineIndex]!;
    const equals = firstLine.indexOf("=");
    if (equals <= 0) continue;
    const key = splitTomlDottedKey(firstLine.slice(0, equals).trim());
    if (!key || key.length === 0) continue;

    let value = firstLine.slice(equals + 1).trim();
    let endLine = lineIndex;
    let squareDepth = 0;
    let braceDepth = 0;
    let quote: string | null = null;
    let escaped = false;
    const scanValue = (chunk: string) => {
      for (const char of chunk) {
        if (quote) {
          if (escaped) escaped = false;
          else if (char === "\\" && quote === '"') escaped = true;
          else if (char === quote) quote = null;
          continue;
        }
        if (char === "#") break;
        if (char === '"' || char === "'") quote = char;
        else if (char === "[") squareDepth += 1;
        else if (char === "]") squareDepth = Math.max(0, squareDepth - 1);
        else if (char === "{") braceDepth += 1;
        else if (char === "}") braceDepth = Math.max(0, braceDepth - 1);
      }
    };
    scanValue(value);
    while (
      (squareDepth > 0 || braceDepth > 0 || quote !== null) &&
      endLine + 1 < lines.length
    ) {
      endLine += 1;
      const continuation = lines[endLine]!;
      value += `\n${continuation}`;
      scanValue(continuation);
    }

    assignments.push({
      id: key[0]!,
      key: key.slice(1),
      value,
      startLine: lineIndex,
      endLine,
    });
    lineIndex = endLine;
  }
  return assignments;
}

/** Which part of an `[mcp_servers.<id>...]` server a TOML table header opens. */
const TOML_MCP_SERVER_TABLES = {
  SERVER: "server",
  ENV: MCP_CONFIG_KEYS.ENV,
  HEADERS: MCP_CONFIG_KEYS.HEADERS,
  /** Any other subtable; it belongs to the server but discovery ignores it. */
  OTHER: "other",
} as const;
type TomlMcpServerTable =
  (typeof TOML_MCP_SERVER_TABLES)[keyof typeof TOML_MCP_SERVER_TABLES];

function parseTomlMcpServerKey(
  sectionName: string
): { id: string; table: TomlMcpServerTable } | null {
  const parts = splitTomlDottedKey(sectionName);
  if (!parts || parts[0] !== TOML_MCP_SERVERS_TABLE_KEY || !parts[1])
    return null;
  const id = parts[1];
  if (parts.length === 2) return { id, table: TOML_MCP_SERVER_TABLES.SERVER };
  if (parts.length === 3 && parts[2] === TOML_MCP_SERVER_TABLES.ENV) {
    return { id, table: TOML_MCP_SERVER_TABLES.ENV };
  }
  if (parts.length === 3 && parts[2] === TOML_MCP_SERVER_TABLES.HEADERS) {
    return { id, table: TOML_MCP_SERVER_TABLES.HEADERS };
  }
  return { id, table: TOML_MCP_SERVER_TABLES.OTHER };
}

/** Return the owning MCP server id for a Codex TOML section or subtable. */
export function getTomlMcpServerSectionId(sectionName: string): string | null {
  return parseTomlMcpServerKey(sectionName)?.id ?? null;
}

type TomlMcpServerConfig = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: McpTransport;
  headers?: Record<string, string>;
};

function setTomlMcpServerValue(
  config: TomlMcpServerConfig,
  key: string[],
  value: string
): void {
  if (key.length === 0) {
    for (const pair of splitTomlList(value.trim().replace(/^\{|\}$/g, ""))) {
      const equals = pair.indexOf("=");
      if (equals > 0) {
        setTomlMcpServerValue(
          config,
          [unquoteTomlString(pair.slice(0, equals).trim())],
          pair.slice(equals + 1).trim()
        );
      }
    }
    return;
  }
  const [field, nestedKey] = key;
  if (!field) return;
  if (field === MCP_CONFIG_KEYS.COMMAND && value.trim().startsWith('"')) {
    config.command = unquoteTomlString(value.trim());
  } else if (field === TOML_MCP_ASSIGNMENT_KEYS.ARGS) {
    config.args = parseTomlStringArray(value);
  } else if (
    field === TOML_MCP_ASSIGNMENT_KEYS.URL &&
    /^["']/.test(value.trim())
  ) {
    config.url = unquoteTomlString(value.trim());
  } else if (
    field === TOML_MCP_ASSIGNMENT_KEYS.TRANSPORT &&
    /^["']/.test(value.trim())
  ) {
    const transport = unquoteTomlString(value.trim());
    if (transport === MCP_TRANSPORTS.SSE) config.transport = MCP_TRANSPORTS.SSE;
    else if (
      transport === MCP_TRANSPORTS.STREAMABLE_HTTP ||
      transport === MCP_CONFIG_ENTRY_TYPES.HTTP
    )
      config.transport = MCP_TRANSPORTS.STREAMABLE_HTTP;
  } else if (
    field === MCP_CONFIG_KEYS.ENV ||
    field === MCP_CONFIG_KEYS.HEADERS
  ) {
    const target = field;
    if (nestedKey) {
      if (/^["']/.test(value.trim())) {
        config[target] = config[target] ?? {};
        config[target]![unquoteTomlString(nestedKey)] = unquoteTomlString(
          value.trim()
        );
      }
    } else {
      config[target] = parseTomlInlineTable(value) ?? config[target];
    }
  }
}

function normalizeCodexToml(
  text: string,
  source: LocalSource,
  filePath: string
): LocalMcpServerEntry[] {
  const results = new Map<string, LocalMcpServerEntry>();
  const lines = text.split(/\r?\n/);
  let currentId: string | null = null;
  let currentTable: TomlMcpServerTable = TOML_MCP_SERVER_TABLES.SERVER;
  let currentConfig: TomlMcpServerConfig | null = null;
  const assignments = new Map(
    findTomlMcpServerAssignments(lines).map((assignment) => [
      assignment.startLine,
      assignment,
    ])
  );
  const assignmentConfigs = new Map<string, TomlMcpServerConfig>();

  const flushCurrent = () => {
    if (!currentId || !currentConfig) {
      return;
    }
    const entry = buildLocalEntry(currentId, source, filePath, currentConfig);
    if (entry) {
      results.set(currentId, entry);
    }
  };

  const headerLines = new Set(findTomlTableHeaderLines(lines));
  for (const [lineIndex, rawLine] of lines.entries()) {
    const assignment = assignments.get(lineIndex);
    if (assignment) {
      const config = assignmentConfigs.get(assignment.id) ?? {};
      assignmentConfigs.set(assignment.id, config);
      setTomlMcpServerValue(config, assignment.key, assignment.value);
      continue;
    }
    const sectionName = headerLines.has(lineIndex)
      ? parseTomlTableHeader(rawLine)
      : null;
    if (sectionName) {
      const nextSection = parseTomlMcpServerKey(sectionName);
      if (sectionName === TOML_MCP_SERVERS_TABLE_KEY) {
        flushCurrent();
        currentId = null;
        currentConfig = null;
        currentTable = TOML_MCP_SERVER_TABLES.SERVER;
        continue;
      }
      if (!nextSection || nextSection.id !== currentId) {
        flushCurrent();
        currentId = nextSection?.id ?? null;
        currentConfig = nextSection ? {} : null;
      }
      currentTable = nextSection?.table ?? TOML_MCP_SERVER_TABLES.SERVER;
      continue;
    }

    if (
      !currentId ||
      !currentConfig ||
      currentTable === TOML_MCP_SERVER_TABLES.OTHER
    ) {
      continue;
    }

    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const eqIndex = line.indexOf("=");
    if (eqIndex <= 0) {
      continue;
    }

    const key = line.slice(0, eqIndex).trim();
    const value = line.slice(eqIndex + 1).trim();

    if (
      currentTable === MCP_CONFIG_KEYS.ENV ||
      currentTable === MCP_CONFIG_KEYS.HEADERS
    ) {
      if (value.startsWith(`"`) || value.startsWith(`'`)) {
        const target = currentTable;
        currentConfig[target] = currentConfig[target] ?? {};
        currentConfig[target]![key] = unquoteTomlString(value);
      }
      continue;
    }

    if (
      key === MCP_CONFIG_KEYS.COMMAND &&
      (value.startsWith(`"`) || value.startsWith(`'`))
    ) {
      currentConfig.command = unquoteTomlString(value);
      continue;
    }

    if (key === TOML_MCP_ASSIGNMENT_KEYS.ARGS) {
      currentConfig.args = parseTomlStringArray(value);
      continue;
    }

    if (
      key === TOML_MCP_ASSIGNMENT_KEYS.URL &&
      (value.startsWith(`"`) || value.startsWith(`'`))
    ) {
      currentConfig.url = unquoteTomlString(value);
      continue;
    }

    if (
      key === TOML_MCP_ASSIGNMENT_KEYS.TRANSPORT &&
      (value.startsWith(`"`) || value.startsWith(`'`))
    ) {
      const transport = unquoteTomlString(value);
      if (transport === MCP_TRANSPORTS.SSE) {
        currentConfig.transport = MCP_TRANSPORTS.SSE;
      } else if (
        transport === MCP_TRANSPORTS.STREAMABLE_HTTP ||
        transport === MCP_CONFIG_ENTRY_TYPES.HTTP
      ) {
        currentConfig.transport = MCP_TRANSPORTS.STREAMABLE_HTTP;
      }
      continue;
    }

    if (key === MCP_CONFIG_KEYS.ENV) {
      currentConfig.env = parseTomlInlineTable(value);
      continue;
    }

    if (key === MCP_CONFIG_KEYS.HEADERS) {
      currentConfig.headers = parseTomlInlineTable(value);
      continue;
    }

    if (key.startsWith("env.")) {
      const envKey = key.slice(4).trim();
      if (value.startsWith(`"`) || value.startsWith(`'`)) {
        currentConfig.env = currentConfig.env ?? {};
        currentConfig.env[envKey] = unquoteTomlString(value);
      }
      continue;
    }

    if (key.startsWith("headers.")) {
      const headerKey = key.slice(8).trim();
      if (value.startsWith(`"`) || value.startsWith(`'`)) {
        currentConfig.headers = currentConfig.headers ?? {};
        currentConfig.headers[headerKey] = unquoteTomlString(value);
      }
    }
  }

  flushCurrent();
  for (const [id, config] of assignmentConfigs) {
    const entry = buildLocalEntry(id, source, filePath, config);
    if (entry) results.set(id, entry);
  }
  return [...results.values()];
}

async function discoverFromDescriptor(
  descriptor: LocalConfigDescriptor
): Promise<LocalMcpServerEntry[]> {
  if (descriptor.format === "codex-toml") {
    const text = await readTextFile(descriptor.path);
    if (!text) {
      return [];
    }
    return normalizeCodexToml(text, descriptor.source, descriptor.path);
  }

  const parsed = await readJsonFile(descriptor.path);
  if (!isPlainObject(parsed)) {
    return [];
  }

  if (descriptor.format === "vscode-json" && isPlainObject(parsed.servers)) {
    return normalizeVscodeServerMap(
      parsed.servers,
      descriptor.source,
      descriptor.path
    );
  }

  if (descriptor.format === "claude-json" && isPlainObject(parsed.mcpServers)) {
    return normalizeClaudeServerMap(
      parsed.mcpServers,
      descriptor.source,
      descriptor.path
    );
  }

  if (
    descriptor.format === "copilot-json" &&
    isPlainObject(parsed.mcpServers)
  ) {
    return normalizeCopilotServerMap(
      parsed.mcpServers,
      descriptor.source,
      descriptor.path
    );
  }

  if (descriptor.format === "qwen-json" && isPlainObject(parsed.mcpServers)) {
    return normalizeQwenServerMap(
      parsed.mcpServers,
      descriptor.source,
      descriptor.path
    );
  }

  if (
    descriptor.format === "antigravity-json" &&
    isPlainObject(parsed.mcpServers)
  ) {
    return normalizeAntigravityServerMap(
      parsed.mcpServers,
      descriptor.source,
      descriptor.path
    );
  }

  if (descriptor.format === "opencode-json" && isPlainObject(parsed.mcp)) {
    return normalizeOpenCodeServerMap(
      parsed.mcp,
      descriptor.source,
      descriptor.path
    );
  }

  return [];
}

function getLocalConfigDescriptors(
  workspaceRoot: string
): LocalConfigDescriptor[] {
  return [
    {
      path: getVscodeWorkspaceMcpConfigPath(workspaceRoot),
      source: getMcpLocalSource(
        SPECIAL_TARGET_IDS.VSCODE,
        SETTING_SCOPES.WORKSPACE
      ),
      format: "vscode-json",
    },
    {
      path: getClaudeWorkspaceMcpConfigPath(workspaceRoot),
      source: getMcpLocalSource(
        HARNESS_IDS.CLAUDE_CLI,
        SETTING_SCOPES.WORKSPACE
      ),
      format: "claude-json",
    },
    ...getCopilotWorkspaceMcpConfigPaths(workspaceRoot).map((filePath) => ({
      path: filePath,
      source: getMcpLocalSource(
        HARNESS_IDS.COPILOT_CLI,
        SETTING_SCOPES.WORKSPACE
      ),
      format: "copilot-json" as const,
    })),
    {
      path: getCodexWorkspaceMcpConfigPath(workspaceRoot),
      source: getMcpLocalSource(
        HARNESS_IDS.CODEX_CLI,
        SETTING_SCOPES.WORKSPACE
      ),
      format: "codex-toml",
    },
    {
      path: getOpenCodeWorkspaceMcpConfigPath(workspaceRoot),
      source: getMcpLocalSource(
        HARNESS_IDS.OPENCODE_CLI,
        SETTING_SCOPES.WORKSPACE
      ),
      format: "opencode-json",
    },
    {
      path: getQwenWorkspaceMcpConfigPath(workspaceRoot),
      source: getMcpLocalSource(HARNESS_IDS.QWEN_CLI, SETTING_SCOPES.WORKSPACE),
      format: "qwen-json",
    },
    {
      path: getAntigravityWorkspaceMcpConfigPath(workspaceRoot),
      source: getMcpLocalSource(
        HARNESS_IDS.ANTIGRAVITY_CLI,
        SETTING_SCOPES.WORKSPACE
      ),
      format: "antigravity-json",
    },
    {
      path: getVscodeUserMcpConfigPath(),
      source: getMcpLocalSource(SPECIAL_TARGET_IDS.VSCODE, SETTING_SCOPES.USER),
      format: "vscode-json",
    },
    {
      path: getClaudeUserConfigPath(),
      source: getMcpLocalSource(HARNESS_IDS.CLAUDE_CLI, SETTING_SCOPES.USER),
      format: "claude-json",
    },
    {
      path: getCopilotUserMcpConfigPath(),
      source: getMcpLocalSource(HARNESS_IDS.COPILOT_CLI, SETTING_SCOPES.USER),
      format: "copilot-json",
    },
    {
      path: getCodexUserMcpConfigPath(),
      source: getMcpLocalSource(HARNESS_IDS.CODEX_CLI, SETTING_SCOPES.USER),
      format: "codex-toml",
    },
    {
      path: getOpenCodeUserMcpConfigPath(),
      source: getMcpLocalSource(HARNESS_IDS.OPENCODE_CLI, SETTING_SCOPES.USER),
      format: "opencode-json",
    },
    {
      path: getQwenUserMcpConfigPath(),
      source: getMcpLocalSource(HARNESS_IDS.QWEN_CLI, SETTING_SCOPES.USER),
      format: "qwen-json",
    },
    {
      path: getAntigravityUserMcpConfigPath(),
      source: getMcpLocalSource(
        HARNESS_IDS.ANTIGRAVITY_CLI,
        SETTING_SCOPES.USER
      ),
      format: "antigravity-json",
    },
  ];
}

/**
 * Discovers MCP servers from all known local config files.
 *
 * Sources are ordered from highest-priority workspace config to lower-priority
 * user config. First discovered entry wins on duplicate server IDs.
 */
async function discoverLocalMcpServers(
  workspaceRoot: string
): Promise<LocalMcpServerEntry[]> {
  const results: LocalMcpServerEntry[] = [];
  const seenEntries = new Set<string>();

  for (const descriptor of getLocalConfigDescriptors(workspaceRoot)) {
    const entries = await discoverFromDescriptor(descriptor);
    for (const entry of entries) {
      const entryKey = `${entry.source}:${entry.path}:${entry.id}`;
      if (seenEntries.has(entryKey)) {
        continue;
      }
      seenEntries.add(entryKey);
      results.push(entry);
    }
  }

  return results;
}

// ============================================================================
// MCP Registry (registry.modelcontextprotocol.io)
// ============================================================================

/**
 * Raw response shape from the MCP registry.
 * Based on verified live API responses from 2026-03-31.
 * Not exported — only used internally.
 */
interface McpIoRegistryResponse {
  servers?: McpIoRegistryItem[];
  metadata?: {
    count?: number;
    nextCursor?: string;
  };
}

/**
 * Each item in the registry has a `server` (standard MCP fields) and `_meta` (registry enrichment).
 */
interface McpIoRegistryItem {
  server?: {
    name?: string;
    title?: string;
    description?: string;
    version?: string;
    websiteUrl?: string;
    packages?: Array<{
      registryType?: string;
      identifier?: string;
      runtimeHint?: string;
      runtimeArguments?: string[];
      environmentVariables?: Array<{ name?: string; description?: string }>;
    }>;
    remotes?: Array<{
      type?: string;
      url?: string;
      headers?: Array<{
        name?: string;
        description?: string;
        isRequired?: boolean;
        isSecret?: boolean;
      }>;
    }>;
  };
  _meta?: {
    "io.modelcontextprotocol.registry/official"?: {
      status?: string;
      isLatest?: boolean;
      publishedAt?: string;
      updatedAt?: string;
      statusChangedAt?: string;
    };
  };
}

const MCP_REGISTRY_URL =
  "https://registry.modelcontextprotocol.io/v0.1/servers";

async function fetchMcpRegistry(
  options: {
    limit?: number;
    cursor?: string;
    search?: string;
    updatedSince?: string;
  } = {}
): Promise<{ servers: RegistryMcpEntry[]; nextCursor?: string }> {
  const { limit = 50, cursor, search, updatedSince } = options;
  const params = new URLSearchParams({ limit: String(limit) });
  if (cursor) params.set("cursor", cursor);
  if (search) params.set("search", search);
  if (updatedSince) params.set("updated_since", updatedSince);

  const url = `${MCP_REGISTRY_URL}?${params}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "ctrlyoke-VSCode-Extension/1.0" },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(
      `MCP registry returned ${response.status}: ${response.statusText}`
    );
  }

  const data = (await response.json()) as McpIoRegistryResponse;
  const items = data.servers ?? [];

  const entries = items.flatMap((item): RegistryMcpEntry[] => {
    const s = item.server;
    const meta = item._meta?.["io.modelcontextprotocol.registry/official"];
    if (!s) return [];

    if (meta?.isLatest === false) return [];

    const id = s.name ?? "";
    if (!id) return [];

    const name = s.title ?? s.name ?? id;
    const description = s.description ?? "";

    const entry: RegistryMcpEntry = {
      id,
      name,
      description,
      verified: true,
    };

    if (meta?.updatedAt) {
      entry.updatedAt = meta.updatedAt;
    }

    const firstRemote = s.remotes?.[0];
    if (firstRemote?.url) {
      entry.remoteUrl = firstRemote.url;
      entry.remoteTransport =
        firstRemote.type === MCP_TRANSPORTS.SSE
          ? MCP_TRANSPORTS.SSE
          : MCP_TRANSPORTS.STREAMABLE_HTTP;
      const headerDefs = (firstRemote.headers ?? []).filter((h) => h.name);
      if (headerDefs.length > 0) {
        entry.remoteHeaders = headerDefs.map((h) => ({
          name: h.name!,
          description: h.description,
          isRequired: h.isRequired,
          isSecret: h.isSecret,
        }));
      }
    }

    const npmPkg = s.packages?.find(
      (p) => p.registryType === MCP_REGISTRY_PACKAGE_TYPES.NPM
    );
    const anyPkg = s.packages?.[0];
    const pkg = npmPkg ?? anyPkg;

    if (pkg?.identifier) {
      entry.packageName = pkg.identifier;
      const runtimeHint = pkg.runtimeHint ?? "npx";
      const runtimeArgs =
        pkg.runtimeArguments && pkg.runtimeArguments.length > 0
          ? pkg.runtimeArguments
          : runtimeHint !== "uvx"
            ? ["-y"]
            : [];
      entry.installCommand = [runtimeHint, ...runtimeArgs, pkg.identifier]
        .filter(Boolean)
        .join(" ");

      const envVars = pkg.environmentVariables;
      if (envVars && envVars.length > 0) {
        entry.envVars = envVars.flatMap((e) =>
          e.name ? [{ name: e.name, description: e.description }] : []
        );
      }
    }

    return [entry];
  });

  return { servers: entries, nextCursor: data.metadata?.nextCursor };
}

export async function safeDiscoverLocalMcpServers(
  workspaceRoot: string
): Promise<{ servers: LocalMcpServerEntry[]; error?: string }> {
  try {
    const servers = await discoverLocalMcpServers(workspaceRoot);
    return { servers };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    Log.warn("[McpDiscovery] local scan failed:", msg);
    return { servers: [], error: msg };
  }
}

export async function safeFetchMcpRegistry(
  options: { cursor?: string; search?: string; updatedSince?: string } = {}
): Promise<{
  servers: RegistryMcpEntry[];
  nextCursor?: string;
  error?: string;
}> {
  try {
    const result = await fetchMcpRegistry({
      cursor: options.cursor,
      search: options.search,
      updatedSince: options.updatedSince,
    });
    return result;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    Log.warn("[McpDiscovery] registry fetch failed:", msg);
    return { servers: [], error: msg };
  }
}
