import { CtrlYokeConfigService } from "../../config/CtrlYokeConfigService";
import { CTRLYOKE_SETTINGS_DEFAULTS } from "../../types/CtrlYokeSettings";
import { SETTING_SCOPES } from "../../types/DashboardConstants";

/** One shared source for the scoped language-server settings readers. */
export function createLanguageServerSettingsReaders(config: CtrlYokeConfigService) {
  return {
    userSettings: () => ({ languageServers: (config.getScoped("languageServers", SETTING_SCOPES.USER) ?? CTRLYOKE_SETTINGS_DEFAULTS.languageServers) as typeof CTRLYOKE_SETTINGS_DEFAULTS.languageServers }),
    workspaceSettings: () => ({ languageServers: (config.getScoped("languageServers", SETTING_SCOPES.WORKSPACE) ?? CTRLYOKE_SETTINGS_DEFAULTS.languageServers) as typeof CTRLYOKE_SETTINGS_DEFAULTS.languageServers }),
  };
}
