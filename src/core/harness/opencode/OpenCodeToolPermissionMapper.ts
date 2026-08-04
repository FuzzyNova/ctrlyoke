import {
  IToolPermissionMapper,
  PermissionContext,
  ToolPermissionConfig,
  ToolPermissionMapperBase,
  ToolPermissionApplication,
} from "../shared/interfaces/IToolPermissionMapper";
import type { PermissionCapabilityDescriptor } from "../../../types/CompatibilityTypes";
import { Log } from "../../../utils/Log";
import {
  HARNESS_IDS,
  PERMISSION_MODES,
} from "../../../types/DashboardConstants";
import type {
  SettingsJsonPermissionDecision,
  SettingsJsonPermissionPolicy,
} from "../shared/SettingsJsonMcpTracker";
import {
  containsOpenCodeConfigSubstitution,
  type OpenCodePermissionCollisionContext,
} from "./OpenCodeInlineConfig";

const MAX_PERMISSION_KEY_SUFFIX_ATTEMPTS = 1000;

const OPENCODE_PERMISSION_VERIFICATION = {
  kind: "behavioral-test",
  reference: "src/test/harness/inline-config.harness.test.ts",
  basis: "cli-version",
  verifiedVersions: [">=1.18.10"],
} as const;

const OPENCODE_PERMISSION_CAPABILITIES: PermissionCapabilityDescriptor = {
  mode: {
    fidelity: "exact",
    mechanism: "translated-cli",
    verification: OPENCODE_PERMISSION_VERIFICATION,
  },
  allowedTools: {
    fidelity: "exact",
    mechanism: "translated-cli",
    verification: OPENCODE_PERMISSION_VERIFICATION,
  },
  deniedTools: {
    fidelity: "exact",
    mechanism: "translated-cli",
    verification: OPENCODE_PERMISSION_VERIFICATION,
  },
};

const OPENCODE_TOOL_ALIASES: Readonly<Record<string, string>> = {
  shell: "bash",
  bash: "bash",
  run_shell_command: "bash",
  write: "edit",
  create: "edit",
  edit: "edit",
  multiedit: "edit",
  multi_edit: "edit",
  patch: "edit",
  str_replace: "edit",
  read: "read",
  glob: "glob",
  ls: "glob",
  list: "glob",
  list_directory: "glob",
  grep: "grep",
  task: "task",
  agent: "task",
  skill: "skill",
  lsp: "lsp",
  question: "question",
  webfetch: "webfetch",
  web_fetch: "webfetch",
  websearch: "websearch",
  web_search: "websearch",
};

/**
 * OpenCode CLI Tool Permission Mapper
 *
 * OpenCode uses config-file-driven permissions, not CLI flags.
 * Default behavior: all operations are allowed without approval.
 *
 * Permission overrides are translated here and delivered through
 * OPENCODE_CONFIG_CONTENT by OpenCodeCliProvider.
 *
 * - dangerouslyAllowAll / none: no ctrlyoke permission block
 * - allowAll: `"*": "allow"` plus deny overrides
 * - custom: `"*": "ask"` plus allow overrides, then deny overrides
 */
export class OpenCodeToolPermissionMapper
  extends ToolPermissionMapperBase
  implements IToolPermissionMapper
{
  readonly capabilities = OPENCODE_PERMISSION_CAPABILITIES;

  /** Prepare OpenCode's process-local permission policy. */
  async prepare(
    config: ToolPermissionConfig,
    _context: PermissionContext
  ): Promise<ToolPermissionApplication> {
    if (
      config.mode === PERMISSION_MODES.CUSTOM &&
      (config.allowedTools.length > 0 || config.deniedTools.length > 0)
    ) {
      Log.debug(
        "OpenCode: custom tool permissions are config-file driven, not via CLI flags"
      );
    }
    return {
      cliArgs: [],
      diagnostics: this.getToolTranslationDiagnostics(
        config,
        HARNESS_IDS.OPENCODE_CLI
      ),
      // OpenCode consumes this application through OPENCODE_CONFIG_CONTENT;
      // the provider applies the policy to its per-step accumulator.
    };
  }

  /**
   * Build the OpenCode `permission` block owned by ctrlyoke for this run.
   *
   * OpenCode evaluates matching patterns in insertion order with the final
   * match winning, so allow rules are inserted before deny rules. A bare tool
   * rule becomes the nested `"*"` rule when granular rules for the same tool
   * are also present.
   */
  buildPermissionPolicy(
    config: ToolPermissionConfig,
    collisionContext?: OpenCodePermissionCollisionContext
  ): SettingsJsonPermissionPolicy | undefined {
    if (
      config.mode === PERMISSION_MODES.NONE ||
      config.mode === PERMISSION_MODES.DANGEROUSLY_ALLOW_ALL
    ) {
      return undefined;
    }

    const topLevelKeys = collisionContext?.topLevelKeys ?? new Set<string>();
    const emittedTopLevelKeys = new Set<string>();
    const emittedToolKeys = new Map<string, string>();
    const emittedNestedKeys = new Map<string, Map<string, string>>();
    const catchAllKey = this.allocateKey(
      "*",
      topLevelKeys,
      emittedTopLevelKeys,
      "top-level catch-all"
    );
    const policy: SettingsJsonPermissionPolicy = {};
    if (catchAllKey === undefined) {
      return policy;
    }
    policy[catchAllKey] =
      config.mode === PERMISSION_MODES.ALLOW_ALL ? "allow" : "ask";

    if (config.mode === PERMISSION_MODES.CUSTOM) {
      this.appendRules(
        policy,
        config.allowedTools,
        "allow",
        collisionContext,
        emittedTopLevelKeys,
        emittedToolKeys,
        emittedNestedKeys
      );
    }
    this.appendRules(
      policy,
      config.deniedTools,
      "deny",
      collisionContext,
      emittedTopLevelKeys,
      emittedToolKeys,
      emittedNestedKeys
    );
    return policy;
  }

  private appendRules(
    policy: SettingsJsonPermissionPolicy,
    patterns: string[],
    decision: SettingsJsonPermissionDecision,
    collisionContext: OpenCodePermissionCollisionContext | undefined,
    emittedTopLevelKeys: Set<string>,
    emittedToolKeys: Map<string, string>,
    emittedNestedKeys: Map<string, Map<string, string>>
  ): void {
    for (const sourcePattern of patterns) {
      if (containsOpenCodeConfigSubstitution(sourcePattern)) {
        Log.warn(
          `[OpenCodePermissionMapper] Refusing tool pattern containing OpenCode substitution token: ${sourcePattern}`
        );
        continue;
      }
      const parsed = this.parsePattern(sourcePattern);
      if (!parsed) {
        Log.warn(
          `[OpenCodePermissionMapper] Invalid tool pattern: ${sourcePattern}, skipping`
        );
        continue;
      }

      const [sourceTool, sourceArgs] = parsed;
      const tool =
        OPENCODE_TOOL_ALIASES[sourceTool.toLowerCase()] ?? sourceTool;
      const argumentPattern = this.convertArgumentPattern(tool, sourceArgs);
      this.appendRule(
        policy,
        tool,
        argumentPattern,
        decision,
        collisionContext,
        emittedTopLevelKeys,
        emittedToolKeys,
        emittedNestedKeys
      );
    }
  }

  private appendRule(
    policy: SettingsJsonPermissionPolicy,
    tool: string,
    argumentPattern: string | undefined,
    decision: SettingsJsonPermissionDecision,
    collisionContext: OpenCodePermissionCollisionContext | undefined,
    emittedTopLevelKeys: Set<string>,
    emittedToolKeys: Map<string, string>,
    emittedNestedKeys: Map<string, Map<string, string>>
  ): void {
    let emittedTool = emittedToolKeys.get(tool);
    if (!emittedTool) {
      emittedTool = this.allocateKey(
        tool,
        collisionContext?.topLevelKeys ?? new Set<string>(),
        emittedTopLevelKeys,
        `tool ${tool}`
      );
      if (emittedTool === undefined) {
        return;
      }
      emittedToolKeys.set(tool, emittedTool);
    }

    const current = policy[emittedTool];

    if (argumentPattern === undefined) {
      if (current && typeof current === "object") {
        const nestedKey = this.getNestedKey(
          tool,
          "*",
          collisionContext,
          emittedNestedKeys,
          current
        );
        if (nestedKey === undefined) {
          return;
        }
        delete current[nestedKey];
        current[nestedKey] = decision;
      } else {
        delete policy[emittedTool];
        policy[emittedTool] = decision;
      }
      return;
    }

    const nestedKey = this.getNestedKey(
      tool,
      argumentPattern,
      collisionContext,
      emittedNestedKeys,
      current && typeof current === "object" ? current : undefined
    );
    if (nestedKey === undefined) {
      return;
    }
    let rules: Record<string, SettingsJsonPermissionDecision>;
    if (current && typeof current === "object") {
      rules = current;
    } else if (current) {
      const wildcardKey = this.getNestedKey(
        tool,
        "*",
        collisionContext,
        emittedNestedKeys,
        undefined
      );
      if (wildcardKey === undefined) {
        return;
      }
      rules = { [wildcardKey]: current };
    } else {
      rules = {};
    }
    delete rules[nestedKey];
    rules[nestedKey] = decision;
    delete policy[emittedTool];
    policy[emittedTool] = rules;
  }

  private getNestedKey(
    tool: string,
    desiredKey: string,
    collisionContext: OpenCodePermissionCollisionContext | undefined,
    emittedNestedKeys: Map<string, Map<string, string>>,
    currentRules: Record<string, unknown> | undefined
  ): string | undefined {
    let mappings = emittedNestedKeys.get(tool);
    if (!mappings) {
      mappings = new Map<string, string>();
      emittedNestedKeys.set(tool, mappings);
    }
    const existing = mappings.get(desiredKey);
    if (existing) {
      return existing;
    }

    const emitted = new Set(mappings.values());
    if (currentRules) {
      for (const key of Object.keys(currentRules)) {
        emitted.add(key);
      }
    }
    const key = this.allocateKey(
      desiredKey,
      collisionContext?.nestedKeysByTool.get(tool) ?? new Set<string>(),
      emitted,
      `nested permission pattern ${tool}.${desiredKey}`
    );
    if (key !== undefined) {
      mappings.set(desiredKey, key);
    }
    return key;
  }

  private allocateKey(
    desiredKey: string,
    userKeys: ReadonlySet<string>,
    emittedKeys: Set<string>,
    scope: string
  ): string | undefined {
    let candidate = desiredKey;
    for (
      let attempt = 0;
      attempt < MAX_PERMISSION_KEY_SUFFIX_ATTEMPTS;
      attempt++
    ) {
      if (!userKeys.has(candidate) && !emittedKeys.has(candidate)) {
        emittedKeys.add(candidate);
        return candidate;
      }
      candidate += "*";
    }

    Log.warn(
      `[OpenCodePermissionMapper] Could not emit collision-safe ${scope}; skipping rule`
    );
    return undefined;
  }

  private convertArgumentPattern(
    tool: string,
    sourceArgs: string
  ): string | undefined {
    if (!sourceArgs) {
      return undefined;
    }

    const inner = sourceArgs.slice(1, -1);
    if (!inner || inner === "*" || inner === "*:*") {
      return undefined;
    }
    if (tool !== "bash") {
      return inner;
    }

    const separator = inner.indexOf(":");
    if (separator === -1) {
      return inner;
    }
    const command = inner.slice(0, separator).trim();
    const argumentsPattern = inner.slice(separator + 1).trim();
    return argumentsPattern ? `${command} ${argumentsPattern}` : command;
  }
}
