import { useState } from "react";
import type {
  FullGlobalSettings,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { DrawerTabBar } from "../shared/DrawerTabBar";
import { DRAWER_PAGES, type DrawerPage } from "../../types/drawerPages";
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
}

export function WorkflowDefaultsSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const [activePage, setActivePage] = useState<DrawerPage>(
    DRAWER_PAGES.HARNESS
  );

  const pageProps = { settings, activeScope, onUpdate, onReset };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto px-4 py-3">
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
        onTabChange={setActivePage}
        isNarrow={false}
      />
    </div>
  );
}

