import { MCP_SERVER_IDS, SETTING_SCOPES } from "@root/types/DashboardConstants";
import type { WorkflowValueDataSource } from "@root/completions/WorkflowFileCompletionCore";
import { useSecretRegistryStore } from "@store/secretRegistryStore";
import { useMcpManagerStore } from "@store/useMcpManagerStore";
import { useSettingsStore } from "@store/settingsStore";
import { isHarnessId } from "@root/types/DashboardConstants";

/**
 * The option lists the key/value completions draw on, read from the stores the
 * dashboard already keeps current. Read per request rather than captured, so a
 * list that arrives after the editor mounted is still offered.
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
    getMcpServers: () =>
      (useMcpManagerStore.getState().managedServers ?? [])
        .map((server) => server.id)
        .filter((id) => id !== MCP_SERVER_IDS.CTRLYOKE),
    getSecretNames: () => {
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
