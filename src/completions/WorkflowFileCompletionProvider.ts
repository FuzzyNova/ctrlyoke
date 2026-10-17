import * as vscode from "vscode";
import { getVsCodeWorkspaceRoot } from "../platform/VsCodeWorkspaceRoot";
import {
  MODEL_OPTION_VALUES,
  PROMPT_PROPERTIES,
  WORKFLOW_LOCATION_ROLES,
} from "../types/DashboardConstants";
import type { SecretRegistryService } from "../ui/SecretRegistryService";
import { AgentDiscovery } from "../utils/AgentDiscovery";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import { buildHarnessModelOptions } from "../utils/HarnessModelOptions";
import { McpRegistryFileManager } from "../utils/McpRegistryFileManager";
import { SkillDiscovery } from "../utils/SkillDiscovery";
import { toVSCodeWorkflowCompletionItem } from "./CompletionHelpers";
import { getCtrlYokeFileKind } from "./CtrlYokeFileKind";
import {
  getWorkflowLocation,
  parseWorkflowDocumentRoot,
} from "./WorkflowDocumentLocation";
import {
  getWorkflowFileCompletions,
  type WorkflowModelOption,
  type WorkflowValueDataSource,
} from "./WorkflowFileCompletionCore";

/** The option lists a completion request needs; each is read only when its field is under the cursor. */
interface WorkflowValueLists {
  agents: readonly string[];
  skills: readonly string[];
  mcpServers: readonly string[];
  secrets: readonly string[];
}

const NO_VALUE_LISTS: WorkflowValueLists = {
  agents: [],
  skills: [],
  mcpServers: [],
  secrets: [],
};

/**
 * The dynamic lists the completion core offers, from the same services the
 * dashboard's pickers read. Models and the default harness are synchronous;
 * the discovery-backed lists are fetched up front by the provider.
 */
class VsCodeWorkflowValueDataSource implements WorkflowValueDataSource {
  constructor(private readonly lists: WorkflowValueLists) {}

  getModels(harness: string): readonly WorkflowModelOption[] {
    return (buildHarnessModelOptions()[harness] ?? [])
      .filter((model) => model.value !== MODEL_OPTION_VALUES.NONE)
      .map((model) => ({ id: model.value, label: model.label }));
  }

  getAgents(): readonly string[] {
    return this.lists.agents;
  }

  getSkills(): readonly string[] {
    return this.lists.skills;
  }

  getMcpServers(): readonly string[] {
    return this.lists.mcpServers;
  }

  getSecretNames(): readonly string[] {
    return this.lists.secrets;
  }

  getDefaultHarness(): string | undefined {
    return ConfigurationUtils.getIntegrationMode();
  }
}

/**
 * Key and value completions for every ctrlyoke workflow file (YAML, JSON and
 * `.prompt.md` frontmatter), driven by `getWorkflowFileCompletions`. Prompt
 * text is `PromptCompletionProvider`'s; this provider returns nothing there,
 * and nothing for script text, comments or unknown objects.
 */
export class WorkflowFileCompletionProvider
  implements vscode.CompletionItemProvider
{
  constructor(
    private readonly getSecretRegistry?: () => SecretRegistryService | undefined
  ) {}

  async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _token?: vscode.CancellationToken,
    context?: vscode.CompletionContext
  ): Promise<vscode.CompletionList | undefined> {
    const kind = getCtrlYokeFileKind(document.fileName);
    if (!kind) return undefined;

    const text = document.getText();
    const offset = document.offsetAt(position);
    const location = getWorkflowLocation(text, offset, kind);
    if (
      location.role !== WORKFLOW_LOCATION_ROLES.KEY &&
      location.role !== WORKFLOW_LOCATION_ROLES.VALUE
    ) {
      return undefined;
    }
    // Space opens a value list after `key: `. At a key position nothing has
    // been typed yet, so the next Enter would accept a key instead of
    // breaking the line.
    if (
      context?.triggerCharacter === " " &&
      location.role === WORKFLOW_LOCATION_ROLES.KEY
    ) {
      return undefined;
    }

    const lists = await this.loadLists(location.path);
    const { items, replaceRange } = getWorkflowFileCompletions({
      text,
      offset,
      location,
      documentRoot: parseWorkflowDocumentRoot(text, kind),
      data: new VsCodeWorkflowValueDataSource(lists),
    });
    if (items.length === 0) return undefined;

    const range = new vscode.Range(
      document.positionAt(replaceRange.start),
      document.positionAt(replaceRange.end)
    );
    // VS Code filters on the range text. A JSON range starts on the opening
    // quote, which the bare label never matches, so filter on the quoted text.
    const startsOnQuote = text[replaceRange.start] === '"';
    return new vscode.CompletionList(
      items.map((item) => {
        const vscodeItem = toVSCodeWorkflowCompletionItem(item, range);
        if (startsOnQuote && !item.filterText) {
          vscodeItem.filterText = (item.insertText ?? item.label).replace(
            /^[\s,]+/,
            ""
          );
        }
        return vscodeItem;
      }),
      false
    );
  }

  /** Reads only the list the cursor's field offers; discovery touches the file system. */
  private async loadLists(
    path: readonly (string | number)[]
  ): Promise<WorkflowValueLists> {
    const field = [...path].reverse().find((part) => typeof part === "string");
    const workspaceRoot = getVsCodeWorkspaceRoot();
    switch (field) {
      case PROMPT_PROPERTIES.AGENT:
        return {
          ...NO_VALUE_LISTS,
          agents: (await AgentDiscovery.discoverAgents(workspaceRoot)).map(
            (agent) => agent.name
          ),
        };
      case PROMPT_PROPERTIES.SKILLS:
        return {
          ...NO_VALUE_LISTS,
          skills: (await SkillDiscovery.discoverSkills(workspaceRoot)).map(
            (skill) => skill.name
          ),
        };
      case PROMPT_PROPERTIES.MCP_SERVERS:
        return {
          ...NO_VALUE_LISTS,
          mcpServers: (
            await new McpRegistryFileManager(workspaceRoot).readAll()
          ).map((server) => server.id),
        };
      case PROMPT_PROPERTIES.SECRETS:
        return {
          ...NO_VALUE_LISTS,
          secrets: workspaceRoot
            ? ((await this.getSecretRegistry?.()?.getCompletionNames()) ?? [])
            : [],
        };
      default:
        return NO_VALUE_LISTS;
    }
  }
}
