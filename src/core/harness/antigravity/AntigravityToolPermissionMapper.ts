import * as os from "os";
import * as path from "path";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
  ToolPermissionApplication,
} from "../shared/interfaces/IToolPermissionMapper";
import {
  COMPATIBILITY_DIAGNOSTIC_CODES,
  PERMISSION_CAVEAT_CODES,
  capabilitySuiteVerification,
  type PermissionCapabilityDescriptor,
} from "../../../types/CompatibilityTypes";
import {
  CAPABILITY_VERIFICATION_STATUSES,
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  HARNESS_IDS,
  PERMISSION_MODES,
} from "../../../types/DashboardConstants";
import { normalizeAntigravityMcpServerId } from "../../../types/ToolPermissionUtils";
import { hasCliFlag } from "../../../utils/CliArgParser";
import { PATH_CONSTANTS } from "../../../utils/ConfigurationUtils";
import { escapeRegExp } from "../../../utils/TextUtils";
import { getAntigravitySettingsPath } from "../shared/StatuslineManager";

export const ANTIGRAVITY_RULE_LIST_KINDS = {
  ALLOW: "allow",
  DENY: "deny",
} as const;
type AntigravityRuleListKind =
  (typeof ANTIGRAVITY_RULE_LIST_KINDS)[keyof typeof ANTIGRAVITY_RULE_LIST_KINDS];
export interface AntigravityRuleConversion {
  readonly rules: string[];
  readonly lossy: string[];
}

const WHOLE_SHELL_TOOLS = new Set(["shell", "bash", "run_shell_command"]);
const FILE_READ_TOOLS = new Set(["read"]);
const FILE_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "create",
  "multiedit",
  "multi_edit",
  "patch",
  "str_replace",
]);
const UNAVAILABLE_TOOLS = new Set([
  "task",
  "agent",
  "skill",
  "question",
  "todo",
  "delete",
  "remove",
]);
const NO_SEARCH_TOOLS = new Set(["web_search", "search"]);
const READ_ONLY_LIST_TOOLS = new Set([
  "glob",
  "grep",
  "ls",
  "list",
  "list_directory",
  "lsp",
]);
const SHELL_ALLOW_TAIL = "(?:[ \\t][^;&|`$()<>\\r\\n]*)?";

/** Only a trailing `:*` is the prefix marker; any other colon is command text. */
const SHELL_PREFIX_MARKER = /^([\s\S]*?)\s*:\s*\*\s*$/;
/** Characters the deny regex's word boundaries treat as part of a word. */
const DENY_WORD_CHAR = /[\w.-]/;
const DENY_LEADING_BOUNDARY = String.raw`(?:.*[^\w.-])?`;
const DENY_TRAILING_BOUNDARY = String.raw`(?:[^\w.-].*)?`;

interface ShellCommandPattern {
  /** Regex source for the command words, or undefined for "any command". */
  readonly words: string | undefined;
  /** The pattern ended in `:*` (the command is a prefix). */
  readonly prefix: boolean;
  /** Raw command text the words were built from. */
  readonly command: string;
}

function parseShellCommand(
  inner: string,
  kind: AntigravityRuleListKind
): ShellCommandPattern {
  const marker = SHELL_PREFIX_MARKER.exec(inner);
  const command = (marker ? marker[1] : inner).trim();
  const prefix = marker !== null;
  if (!command || command === "*") return { words: undefined, prefix, command };
  const words = command.split(/\s+/).map((word) => {
    if (word === "*")
      return kind === ANTIGRAVITY_RULE_LIST_KINDS.ALLOW
        ? "[^\\s;&|`$()<>\\r\\n]+"
        : String.raw`\S+`;
    return escapeRegExp(word);
  });
  const wordJoiner =
    kind === ANTIGRAVITY_RULE_LIST_KINDS.ALLOW ? "[ \\t]+" : String.raw`\s+`;
  return { words: words.join(wordJoiner), prefix, command };
}

/**
 * Deny regex that matches the command anywhere in the raw line. The `[^\w.-]`
 * boundaries stop `git push` from matching `gitx push`, but only make sense
 * next to a word character: `rm -rf /` must still block `rm -rf /home`.
 */
function denyCommandRegex(words: string, command: string): string {
  const leading = DENY_WORD_CHAR.test(command[0])
    ? DENY_LEADING_BOUNDARY
    : ".*";
  const trailing = DENY_WORD_CHAR.test(command[command.length - 1])
    ? DENY_TRAILING_BOUNDARY
    : ".*";
  return `(?is)${leading}${words}${trailing}`;
}

const ANTIGRAVITY_PERMISSION_VERIFICATION = capabilitySuiteVerification([
  ">=1.4.10",
]);

export const ANTIGRAVITY_PERMISSION_CAPABILITIES: PermissionCapabilityDescriptor =
  {
    mode: {
      fidelity: "exact",
      mechanism: "translated-cli",
      verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
    },
    allowedTools: {
      fidelity: "partial",
      mechanism: "translated-cli",
      verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
      caveatCode: PERMISSION_CAVEAT_CODES.ANTIGRAVITY_RULE_TRANSLATION,
    },
    deniedTools: {
      fidelity: "partial",
      mechanism: "translated-cli",
      verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
      caveatCode: PERMISSION_CAVEAT_CODES.ANTIGRAVITY_RULE_TRANSLATION,
    },
  };

export class AntigravityToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  readonly capabilities = ANTIGRAVITY_PERMISSION_CAPABILITIES;
  readonly normalizeMcpServerId = normalizeAntigravityMcpServerId;
  readonly formatMcpToolName = (serverId: string, toolName: string): string =>
    `mcp__${normalizeAntigravityMcpServerId(serverId)}__${toolName}`;

  convertToAntigravityRules(
    patterns: readonly string[],
    listKind: AntigravityRuleListKind
  ): AntigravityRuleConversion {
    const rules = new Set<string>();
    const lossy = new Set<string>();
    for (const pattern of patterns) {
      const mcp = this.parseMcpPattern(pattern);
      if (mcp) {
        const server = normalizeAntigravityMcpServerId(mcp.serverId);
        rules.add(
          `mcp(${server}/${!mcp.toolName || mcp.toolName === "*" ? "*" : mcp.toolName})`
        );
        continue;
      }
      const parsed = this.parsePattern(pattern);
      if (!parsed) {
        lossy.add(pattern);
        continue;
      }
      const [rawTool, args] = parsed;
      const tool = rawTool.toLowerCase();
      if (WHOLE_SHELL_TOOLS.has(tool)) {
        const inner = args.replace(/^\(|\)$/g, "").trim();
        if (!inner || inner === "*" || inner === "*:*") rules.add("command(*)");
        else {
          const { words, prefix, command } = parseShellCommand(inner, listKind);
          if (!words) rules.add("command(*)");
          else if (listKind === ANTIGRAVITY_RULE_LIST_KINDS.ALLOW)
            rules.add(
              `command(regex:${words}${prefix ? SHELL_ALLOW_TAIL : ""})`
            );
          else rules.add(`command(regex:${denyCommandRegex(words, command)})`);
        }
      } else if (FILE_READ_TOOLS.has(tool)) rules.add("read_file(*)");
      else if (FILE_WRITE_TOOLS.has(tool)) rules.add("write_file(*)");
      else if (tool === "web_fetch" || tool === "webfetch") {
        const domain = args.replace(/^\(|\)$/g, "").trim();
        rules.add(`read_url(${domain || "*"})`);
      } else if (READ_ONLY_LIST_TOOLS.has(tool)) {
        if (listKind === ANTIGRAVITY_RULE_LIST_KINDS.ALLOW)
          rules.add("read_file(*)");
        else lossy.add(pattern);
      } else if (
        NO_SEARCH_TOOLS.has(tool) &&
        listKind === ANTIGRAVITY_RULE_LIST_KINDS.ALLOW
      ) {
        // search_web is ungated by Antigravity permission rules.
      } else if (NO_SEARCH_TOOLS.has(tool) || UNAVAILABLE_TOOLS.has(tool))
        lossy.add(pattern);
      else lossy.add(pattern);
    }
    return { rules: [...rules], lossy: [...lossy] };
  }

  async prepare(
    config: ToolPermissionConfig,
    context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    const cliArgs: string[] = [];
    const diagnostics = this.getToolTranslationDiagnostics(
      config,
      HARNESS_IDS.ANTIGRAVITY_CLI
    );
    switch (config.mode) {
      case PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL:
        cliArgs.push("--dangerously-skip-permissions");
        break;
      case PERMISSION_MODES.ALLOW_ALL:
      case PERMISSION_MODES.CUSTOM:
        // No --sandbox: containment is not an approval-mode concern (see
        // dev/implemented/HARNESS_SANDBOX_PLAN.md), and under agy's sandbox even a
        // rule-allowed command could not write the workspace.
        if (context.additionalArgs && hasSettingsFlag(context.additionalArgs)) {
          diagnostics.push({
            code: COMPATIBILITY_DIAGNOSTIC_CODES.ANTIGRAVITY_SETTINGS_COLLISION,
            severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
            harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
            capability: "allowedTools",
            state: {
              fidelity: "partial",
              mechanism: "translated-cli",
              verification: CAPABILITY_VERIFICATION_STATUSES.UNKNOWN,
            },
            message:
              "Antigravity permission translation was skipped because workflow additionalArgs supplies its own --settings session settings.",
          });
          break;
        }
        if (!context.workspaceRoot) break;
        const translatedAllow =
          config.mode === PERMISSION_MODES.CUSTOM
            ? this.convertToAntigravityRules(
                config.allowedTools ?? [],
                ANTIGRAVITY_RULE_LIST_KINDS.ALLOW
              )
            : { rules: [], lossy: [] };
        const translatedDeny = this.convertToAntigravityRules(
          config.deniedTools ?? [],
          ANTIGRAVITY_RULE_LIST_KINDS.DENY
        );
        const lossyCapabilities: ("allowedTools" | "deniedTools")[] = [];
        if (translatedAllow.lossy.length)
          lossyCapabilities.push("allowedTools");
        if (translatedDeny.lossy.length) lossyCapabilities.push("deniedTools");
        diagnostics.push(
          ...lossyCapabilities.map((capability) =>
            this.createLossyTranslationDiagnostic(
              HARNESS_IDS.ANTIGRAVITY_CLI,
              capability
            )
          )
        );
        const userRules = await this.readUserRules(context.environment);
        const permissions: { allow?: string[]; deny?: string[] } = {};
        if (config.mode === PERMISSION_MODES.CUSTOM) {
          const allow = uniqueRules([
            ...userRules.allow,
            ...translatedAllow.rules,
          ]);
          if (allow.length) permissions.allow = allow;
        }
        const deny = uniqueRules([...userRules.deny, ...translatedDeny.rules]);
        if (deny.length) permissions.deny = deny;
        const settings: Record<string, unknown> = {
          toolPermission:
            config.mode === PERMISSION_MODES.ALLOW_ALL
              ? "always-proceed"
              : "request-review",
        };
        if (Object.keys(permissions).length) settings.permissions = permissions;
        const settingsPath = path.join(
          context.workspaceRoot,
          PATH_CONSTANTS.CTRLYOKE_DIR,
          PATH_CONSTANTS.TEMP_DIR,
          `antigravity-permissions-${randomUUID()}.json`
        );
        cliArgs.push("--settings", settingsPath);
        return {
          cliArgs,
          diagnostics,
          mutations: [
            {
              path: settingsPath,
              intendedContent: JSON.stringify(settings, null, 2),
              description: "Write Antigravity per-run permission settings",
              apply: async () => {
                await fs.mkdir(path.dirname(settingsPath), { recursive: true });
                await fs.writeFile(
                  settingsPath,
                  JSON.stringify(settings, null, 2),
                  { encoding: "utf-8", flag: "wx" }
                );
              },
              restore: async () => {
                await fs.unlink(settingsPath).catch(() => undefined);
              },
            },
          ],
        };
      case PERMISSION_MODES.NONE:
      default:
        break;
    }
    return {
      cliArgs,
      diagnostics,
    };
  }

  private async readUserRules(
    environment?: NodeJS.ProcessEnv
  ): Promise<AntigravityUserPermissionRules> {
    try {
      return parseAntigravityUserPermissionRules(
        await fs.readFile(getAntigravityUserSettingsPath(environment), "utf-8")
      );
    } catch {
      return { allow: [], deny: [] };
    }
  }

  override hasFullPermissions(config: ToolPermissionConfig): boolean {
    return (
      config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL ||
      config.mode === PERMISSION_MODES.ALLOW_ALL
    );
  }
}
/** The user's global agy allow/deny lists, which ctrlyoke unions into its own. */
export interface AntigravityUserPermissionRules {
  readonly allow: string[];
  readonly deny: string[];
}

/** Path of the user's global agy `settings.json`, honoring an env snapshot. */
export function getAntigravityUserSettingsPath(
  environment: NodeJS.ProcessEnv = process.env
): string {
  return getAntigravitySettingsPath(
    environment.USERPROFILE || environment.HOME || os.homedir()
  );
}

/**
 * Read `permissions.{allow,deny}` from agy settings JSON. Malformed content or
 * non-string entries yield empty lists, as agy itself ignores them.
 */
export function parseAntigravityUserPermissionRules(
  content: string
): AntigravityUserPermissionRules {
  const stringRules = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((rule): rule is string => typeof rule === "string")
      : [];
  try {
    const value: unknown = JSON.parse(content);
    const permissions =
      value && typeof value === "object"
        ? (value as { permissions?: unknown }).permissions
        : undefined;
    if (!permissions || typeof permissions !== "object")
      return { allow: [], deny: [] };
    const lists = permissions as { allow?: unknown; deny?: unknown };
    return { allow: stringRules(lists.allow), deny: stringRules(lists.deny) };
  } catch {
    return { allow: [], deny: [] };
  }
}

function hasSettingsFlag(additionalArgs: string): boolean {
  // agy parses Go-style flags, so a single dash is accepted too.
  return hasCliFlag(additionalArgs, ["--settings", "-settings"]);
}

function uniqueRules(rules: readonly string[]): string[] {
  return [...new Set(rules)];
}
