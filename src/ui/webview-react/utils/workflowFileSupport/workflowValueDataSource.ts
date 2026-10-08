import { MCP_SERVER_IDS, SETTING_SCOPES } from "@root/types/DashboardConstants";
import type { WorkflowValueDataSource } from "@root/completions/WorkflowFileCompletionCore";
import { useSecretRegistryStore } from "@store/secretRegistryStore";
import { useMcpManagerStore } from "@store/useMcpManagerStore";
import { useSettingsStore } from "@store/settingsStore";
import { isHarnessId } from "@root/types/DashboardConstants";

// Only the MCP manager and secrets panels load these lists, so the first
// completion that needs one asks for it. The answer lands in the store, and the
// next keystroke's completion offers it.
let requestedSecretScopes = false;

function ensureMcpServersRequested(): void {
  const { managedServers, isLoadingRegistry, requestServers } =
    useMcpManagerStore.getState();
  if (managedServers === undefined && !isLoadingRegistry) requestServers();
}

function ensureSecretsRequested(): void {
  if (requestedSecretScopes) return;
  requestedSecretScopes = true;
  const { requestEntries } = useSecretRegistryStore.getState();
  requestEntries(SETTING_SCOPES.USER);
  requestEntries(SETTING_SCOPES.WORKSPACE);
}

/**
 * The option lists the key/value completions draw on, read from the stores the
 * dashboard keeps current. Read per request rather than captured, so a list
 * that arrives after the editor mounted is still offered.
 */
export function createStoreWorkflowValueDataSource(): WorkflowValueDataSource {
  return {
    getModels: (harness) => {
      if (!isHarnessId(harness)) return [];
      return useSettingsStore
        .getState()
        .getModelsForHarness(harness)
        .map((model) => ({ id: model.value, label: model.label }));
    },
    getAgents: () =>
      useSettingsStore.getState().availableAgents.map((agent) => agent.name),
    getSkills: () =>
      useSettingsStore.getState().availableSkills.map((skill) => skill.name),
    getMcpServers: () => {
      ensureMcpServersRequested();
      return (useMcpManagerStore.getState().managedServers ?? [])
        .map((server) => server.id)
        .filter((id) => id !== MCP_SERVER_IDS.CTRLYOKE);
    },
    getSecretNames: () => {
      ensureSecretsRequested();
      const { entriesByScope } = useSecretRegistryStore.getState();
      return [
        ...new Set(
          [SETTING_SCOPES.USER, SETTING_SCOPES.WORKSPACE].flatMap((scope) =>
            entriesByScope[scope].map((entry) => entry.name)
          )
        ),
      ];
    },
    getDefaultHarness: () => useSettingsStore.getState().globalSettings.harness,
  };
}
