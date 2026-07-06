import * as path from "path";
import * as os from "os";
import * as fs from "fs/promises";
import { createHash } from "crypto";
import { ICliProvider, HarnessConfig } from "../shared/interfaces/ICliProvider";
import { INotificationMonitor } from "../shared/interfaces/INotificationMonitor";
import { IResponseParser } from "../shared/interfaces/IResponseParser";
import {
  IToolPermissionMapper,
  ToolPermissionConfig,
} from "../shared/interfaces/IToolPermissionMapper";
import { HARNESS_IDS, type HookEvent } from "../../../types/DashboardConstants";
import type {
  McpServerConfig,
  PromptStep,
  UserHookConfig,
  WorkflowStep,
} from "../../../types/CtrlYokeTypes";
import type { ResolvedProperties } from "../../../utils/PropertyResolver";
import { ConfigurationUtils } from "../../../utils/ConfigurationUtils";
import { CliProviderUtils } from "../shared/CliProviderUtils";
import { parseArgString } from "../../../utils/CliArgParser";
import { withFileLock } from "../../../utils/FileLockUtils";
import { MODEL_NONE } from "../../../utils/ModelConstants";
import { AntigravityResponseParser } from "./AntigravityResponseParser";
import { AntigravityNotificationMonitor } from "./AntigravityNotificationMonitor";
import { AntigravityToolPermissionMapper } from "./AntigravityToolPermissionMapper";
import { AntigravityLogParser } from "./AntigravityLogParser";

const ANTIGRAVITY_MIN_VERSION = "1.0.15";

type AntigravityHookGroup = Record<
  "PreToolUse" | "PostToolUse" | "PreInvocation" | "PostInvocation" | "Stop",
  unknown[] | null
>;

export class AntigravityCliProvider implements ICliProvider {
  readonly config: HarnessConfig = {
    name: "agy",
    harnessId: HARNESS_IDS.ANTIGRAVITY_CLI,
    displayName: "Antigravity CLI",
    terminalName: "Antigravity",
    installHint: "Install via: npm install -g @google/antigravity-cli",
    shouldStreamHeadlessOutput: true,
    usesInteractiveNotificationMonitor: true,
  };

  readonly responseParser: IResponseParser = new AntigravityResponseParser();
  readonly notificationMonitor: INotificationMonitor =
    new AntigravityNotificationMonitor();
  readonly toolPermissionMapper: IToolPermissionMapper =
    new AntigravityToolPermissionMapper();
  readonly logParser = new AntigravityLogParser();

  async buildCliArgs(
    _prompt: PromptStep,
    _isInteractive: boolean,
    _extensionPath: string,
    _workspaceRoot: string | undefined,
    sessionId: string | undefined,
    workflowContext?: {
      promptIndex: number;
      allPrompts: WorkflowStep[];
      filePath?: string;
      resolvedProperties?: ResolvedProperties;
      workingFilePath?: string;
    }
  ): Promise<string[]> {
    const args: string[] = [];
    const resolvedModel = workflowContext?.resolvedProperties?.model;
    const resolvedResumeSession =
      workflowContext?.resolvedProperties?.resumeSession;

    const model = this.validateAndGetModel(resolvedModel);
    if (model) {
      args.push("--model", model);
    }

    if (
      CliProviderUtils.shouldResumeSession(resolvedResumeSession, sessionId)
    ) {
      args.push("--conversation", sessionId!);
    }

    const additionalArgs = workflowContext?.resolvedProperties?.additionalArgs;
    if (additionalArgs) {
      args.push(...parseArgString(additionalArgs));
    }

    return args;
  }

  buildHeadlessArgs(baseArgs: string[], prompt: string): string[] {
    return ["--print", prompt, ...baseArgs];
  }

  buildInteractiveArgs(baseArgs: string[], promptText: string): string[] {
    return ["--prompt-interactive", promptText, ...baseArgs];
  }

  formatFileReference(relativeFilePath: string): string {
    return relativeFilePath;
  }

  buildPermissionArgs(
    toolPermissions: ToolPermissionConfig | null | undefined
  ): string[] {
    if (toolPermissions === null) {
      return [];
    }
    const config = toolPermissions ?? {
      mode: ConfigurationUtils.getCliToolPermissions(),
      allowedTools: ConfigurationUtils.getCliAllowedTools(),
      deniedTools: ConfigurationUtils.getCliDeniedTools(),
    };
    return this.toolPermissionMapper.buildArgs(config);
  }

  async buildNotificationHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const workflowKey = workingFilePath ?? workspaceRoot;
    const scriptPath = path.join(
      extensionPath,
      "out",
      "scripts",
      "ctrlyoke-antigravity-hook.js"
    );
    const notifyDir =
      this.notificationMonitor.getNotificationDirectory(workspaceRoot);
    const hookConfig = this.notificationMonitor.buildHookConfig(
      scriptPath,
      notifyDir,
      workspaceRoot,
      userHooks,
      [
        ...new Set<HookEvent>([
          "sessionStart",
          "stop",
          ...enabledNotificationHookEvents,
        ]),
      ]
    );
    if (hookConfig.type !== "json") {
      throw new Error("Unexpected Antigravity hook config type");
    }

    await this.writeGlobalHooksConfig(
      workflowKey,
      hookConfig.config as Record<string, AntigravityHookGroup>
    );
    return [];
  }

  async buildHeadlessUserHookArgs(
    extensionPath: string,
    workspaceRoot: string,
    _promptIndex: number,
    workingFilePath: string | undefined,
    userHooks: UserHookConfig[] | undefined,
    enabledNotificationHookEvents: HookEvent[]
  ): Promise<string[]> {
    const workflowKey = workingFilePath ?? workspaceRoot;
    if (
      (userHooks?.length ?? 0) === 0 &&
      enabledNotificationHookEvents.length === 0
    ) {
      return [];
    }

    const hookConfig = this.notificationMonitor.buildHookConfig(
      path.join(
        extensionPath,
        "out",
        "scripts",
        "ctrlyoke-antigravity-hook.js"
      ),
      this.notificationMonitor.getNotificationDirectory(workspaceRoot),
      workspaceRoot,
      userHooks,
      enabledNotificationHookEvents
    );
    if (hookConfig.type !== "json") {
      throw new Error("Unexpected Antigravity hook config type");
    }

    await this.writeGlobalHooksConfig(
      workflowKey,
      hookConfig.config as Record<string, AntigravityHookGroup>
    );
    return [];
  }

  async cleanupWorkspaceArtifacts(
    workspaceRoot: string,
    workingFilePath?: string
  ): Promise<void> {
    const workflowKey = workingFilePath ?? workspaceRoot;
    const groupName = this.getHookGroupName(workflowKey);
    const hooksPath = this.getGlobalHooksPath();

    await withFileLock(hooksPath, async () => {
      const current = await this.readHooksFile();
      if (!(groupName in current)) {
        return;
      }
      delete current[groupName];
      await this.writeHooksFile(current);
    });
  }

  async checkAvailability(): Promise<boolean> {
    const version = await this.getVersion();
    return version
      ? this.compareVersions(version, ANTIGRAVITY_MIN_VERSION) >= 0
      : false;
  }

  async getVersion(): Promise<string | undefined> {
    return CliProviderUtils.getCliVersion("agy --version", {
      parseVersion: (stdout) => {
        const match = stdout.match(/(\d+\.\d+\.\d+)/);
        return match?.[1];
      },
    });
  }

  async extractSessionIdFromLogs(
    _promptText: string,
    _startTime: Date
  ): Promise<string | undefined> {
    const workspaceRoot = process.cwd();
    return await this.logParser.readSessionIdFromLastConversations(
      workspaceRoot
    );
  }

  getMcpConfigArgs(
    _mcpServerPath: string | undefined,
    _workspaceRoot: string,
    _workingFilePath?: string,
    _additionalEnv?: Record<string, string>,
    _userServers?: McpServerConfig[]
  ): Promise<string[] | null> {
    return Promise.resolve(null);
  }

  getMcpConfigFilePath(): null {
    return null;
  }

  private validateAndGetModel(requestedModel?: string): string | undefined {
    if (!requestedModel || requestedModel === MODEL_NONE) {
      return undefined;
    }
    return requestedModel;
  }

  private getGlobalHooksPath(): string {
    return path.join(os.homedir(), ".gemini", "config", "hooks.json");
  }

  private getHookGroupName(workflowKey: string): string {
    const hash = createHash("sha1")
      .update(workflowKey)
      .digest("hex")
      .slice(0, 12);
    return `ctrlyoke-${hash}`;
  }

  private async writeGlobalHooksConfig(
    workflowKey: string,
    config: Record<string, AntigravityHookGroup>
  ): Promise<void> {
    const hooksPath = this.getGlobalHooksPath();
    const groupSpec = Object.values(config)[0];
    if (!groupSpec) {
      return;
    }
    const groupName = this.getHookGroupName(workflowKey);

    await withFileLock(hooksPath, async () => {
      const current = await this.readHooksFile();
      current[groupName] = groupSpec;
      await this.writeHooksFile(current);
    });
  }

  private async readHooksFile(): Promise<Record<string, AntigravityHookGroup>> {
    const hooksPath = this.getGlobalHooksPath();
    try {
      const content = await fs.readFile(hooksPath, "utf8");
      const parsed = JSON.parse(content);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, AntigravityHookGroup>;
      }
    } catch {
      // Ignore missing/invalid files and recreate a minimal object.
    }
    return {};
  }

  private async writeHooksFile(
    hooks: Record<string, AntigravityHookGroup>
  ): Promise<void> {
    const hooksPath = this.getGlobalHooksPath();
    await fs.mkdir(path.dirname(hooksPath), { recursive: true });
    await fs.writeFile(hooksPath, JSON.stringify(hooks, null, 2), "utf8");
  }

  private compareVersions(a: string, b: string): number {
    const aParts = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const bParts = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
    const length = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < length; i += 1) {
      const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
      if (diff !== 0) {
        return diff;
      }
    }
    return 0;
  }
}
