import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
  ToolPermissionApplication,
} from "../shared/interfaces/IToolPermissionMapper";
import {
  PERMISSION_CAVEAT_CODES,
  capabilitySuiteVerification,
  type PermissionCapabilityDescriptor,
} from "../../../types/CompatibilityTypes";
import {
  HARNESS_IDS,
  PERMISSION_MODES,
} from "../../../types/DashboardConstants";
import { normalizeAntigravityMcpServerId } from "../../../types/ToolPermissionUtils";

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
const SHELL_ALLOW_TAIL = "(?:\\s[^;&|`$()<>\\r\\n]*)?";

function escapeRegexWord(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function commandWords(
  inner: string,
  kind: AntigravityRuleListKind
): string | undefined {
  const colon = inner.indexOf(":");
  const command = (colon < 0 ? inner : inner.slice(0, colon)).trim();
  if (!command || command === "*") return undefined;
  const words = command.split(/\s+/).map((word) => {
    if (word === "*")
      return kind === ANTIGRAVITY_RULE_LIST_KINDS.ALLOW
        ? "[^\\s;&|`$()<>\\r\\n]+"
        : String.raw`\S+`;
    return escapeRegexWord(word);
  });
  return words.join(String.raw`\s+`);
}

const ANTIGRAVITY_PERMISSION_VERIFICATION = capabilitySuiteVerification([
  ">=1.1.12",
]);

export const ANTIGRAVITY_PERMISSION_CAPABILITIES: PermissionCapabilityDescriptor =
  {
    mode: {
      fidelity: "partial",
      mechanism: "native",
      verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
      caveatCode: PERMISSION_CAVEAT_CODES.COARSE_PERMISSION_MODES,
    },
    allowedTools: {
      fidelity: "unsupported",
      mechanism: "none",
      verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
      caveatCode: PERMISSION_CAVEAT_CODES.COARSE_PERMISSION_MODES,
    },
    deniedTools: {
      fidelity: "unsupported",
      mechanism: "none",
      verification: ANTIGRAVITY_PERMISSION_VERIFICATION,
      caveatCode: PERMISSION_CAVEAT_CODES.COARSE_PERMISSION_MODES,
    },
  };

export class AntigravityToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  readonly capabilities = ANTIGRAVITY_PERMISSION_CAPABILITIES;
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
          const words = commandWords(inner, listKind);
          if (!words) rules.add("command(*)");
          else if (listKind === ANTIGRAVITY_RULE_LIST_KINDS.ALLOW) {
            const colon = inner.indexOf(":");
            const hasAnyArgs =
              colon >= 0 && inner.slice(colon + 1).trim() === "*";
            rules.add(
              `command(regex:${words}${hasAnyArgs ? SHELL_ALLOW_TAIL : ""})`
            );
          } else
            rules.add(
              `command(regex:(?is)(?:.*[^\\w.-])?${words}(?:[^\\w.-].*)?)`
            );
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
    _context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    let cliArgs: string[];
    switch (config.mode) {
      case PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL:
        cliArgs = ["--dangerously-skip-permissions"];
        break;
      case PERMISSION_MODES.ALLOW_ALL:
        // agy has no native allow-list flag. Do not use its dangerous bypass
        // here: it would silently ignore ctrlyoke's deny list.
        cliArgs = [];
        break;
      case PERMISSION_MODES.CUSTOM:
        cliArgs = ["--sandbox"];
        break;
      case PERMISSION_MODES.NONE:
      default:
        cliArgs = [];
        break;
    }
    return {
      cliArgs,
      diagnostics: this.getToolTranslationDiagnostics(
        config,
        HARNESS_IDS.ANTIGRAVITY_CLI
      ),
    };
  }

  override hasFullPermissions(config: ToolPermissionConfig): boolean {
    return config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL;
  }
}
