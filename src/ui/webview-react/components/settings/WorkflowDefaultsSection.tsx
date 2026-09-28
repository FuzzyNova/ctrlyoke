import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { useSettingsDrawerTabOverrides } from "../../hooks/useSettingsDrawerTabOverrides";
import { DrawerTabBar } from "../shared/DrawerTabBar";
import {
  DRAWER_PAGES,
  DRAWER_TABS,
  type DrawerPage,
} from "../../types/drawerPages";
import { DefaultsHarnessPage } from "./defaults/DefaultsHarnessPage";
import { DefaultsContextPage } from "./defaults/DefaultsContextPage";
import { DefaultsValidationPage } from "./defaults/DefaultsValidationPage";
import { DefaultsMcpPage } from "./defaults/DefaultsMcpPage";
import { DefaultsHooksPage } from "./defaults/DefaultsHooksPage";
import { DefaultsPermissionsPage } from "./defaults/DefaultsPermissionsPage";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
  countsByPage?: ReadonlyMap<DrawerPage, number>;
  searchActive?: boolean;
  activePage: DrawerPage;
  onPageChange: (page: DrawerPage) => void;
}

export function WorkflowDefaultsSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
  countsByPage,
  searchActive = false,
  activePage,
  onPageChange,
}: Props) {
  const sources = settings.sources as Record<string, SettingSource>;
  const tabOverrides = useSettingsDrawerTabOverrides(
    sources,
    settings.settings.defaults.toolPermissions.mode
  );

  const pageProps = { settings, activeScope, onUpdate, onReset };

  return (
    <div className="flex flex-col h-full">
      <div
        data-settings-content-scroll
        className="flex-1 overflow-y-auto px-4 py-3"
      >
        {activePage === DRAWER_PAGES.HARNESS && (
          <DefaultsHarnessPage {...pageProps} />
        )}
        {activePage === DRAWER_PAGES.CONTEXT && (
          <DefaultsContextPage {...pageProps} />
        )}
        {activePage === DRAWER_PAGES.VALIDATION && (
          <DefaultsValidationPage {...pageProps} />
        )}
        {activePage === DRAWER_PAGES.MCP && <DefaultsMcpPage {...pageProps} />}
        {activePage === DRAWER_PAGES.HOOKS && (
          <DefaultsHooksPage {...pageProps} />
        )}
        {activePage === DRAWER_PAGES.PERMISSIONS && (
          <DefaultsPermissionsPage {...pageProps} />
        )}
      </div>
      <DrawerTabBar
        activeTab={activePage}
        onTabChange={onPageChange}
        ariaLabel="Workflow defaults"
        isNarrow={false}
        tabOverrides={tabOverrides}
        matchCount={
          searchActive
            ? (Object.fromEntries(
                DRAWER_TABS.map((tab) => [
                  tab.id,
                  countsByPage?.get(tab.id) ?? 0,
                ])
              ) as Partial<Record<DrawerPage, number>>)
            : undefined
        }
      />
    </div>
  );
}
