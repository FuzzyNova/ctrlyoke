import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import {
  MESSAGE_TYPES,
  SETTING_PATHS,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import { useVsCodeApi } from "@hooks/useVsCodeApi";
import { SettingInputRow } from "../../shared/SettingInputRow";
import { SettingToggleRow } from "../../shared/SettingToggleRow";
import { TrustedRootsListEditor } from "../../shared/TrustedRootsListEditor";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

/**
 * `permissions.trustedExternalRoots` and the file-link trust offer that adds
 * to it. Rendered at the end of Workflow Defaults → Permissions: a workflow's
 * own `trustedExternalRoots` are added to these.
 */
export function TrustedExternalRootsRows({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const vscode = useVsCodeApi();
  const permissions = settings.settings.permissions;
  const ui = settings.settings.ui;
  const sources = settings.sources as Record<string, SettingSource>;
  const rowProps = { sources, onReset, activeScope };
  const isWorkspaceScope = activeScope === SETTING_SCOPES.WORKSPACE;
  const scopedEntries = !isWorkspaceScope
    ? (
        settings.externalFileRootsByScope?.user ??
        permissions.trustedExternalRoots
      ).map((path) => ({ path }))
    : (
        settings.externalFileRootsByScope?.workspace ??
        permissions.trustedExternalRoots.map((path) => ({ path }))
      ).map((entry) => (typeof entry === "string" ? { path: entry } : entry));

  const writeRoots = (paths: string[]) =>
    onUpdate(SETTING_PATHS.PERMISSIONS_TRUSTED_EXTERNAL_ROOTS, paths);

  const handleBrowseExternalRoot = () => {
    vscode.postMessage({
      type: MESSAGE_TYPES.BROWSE_AND_ADD_EXTERNAL_ROOT,
      scope: activeScope,
    });
  };

  const handleDecisionChange = (path: string, decision: "allow" | "deny") => {
    vscode.postMessage({
      type: MESSAGE_TYPES.UPDATE_EXTERNAL_ROOT_DECISION,
      scope: activeScope,
      path,
      decision,
    });
  };

  return (
    <>
      <SettingInputRow
        settingKey="permissions.trustedExternalRoots"
        id="trusted-external-roots"
        {...rowProps}
      >
        <TrustedRootsListEditor
          entries={scopedEntries}
          showDecisionStatus={isWorkspaceScope}
          onAdd={(path) =>
            writeRoots([...scopedEntries.map((entry) => entry.path), path])
          }
          onBrowse={handleBrowseExternalRoot}
          onRemove={(path) =>
            writeRoots(
              scopedEntries
                .map((entry) => entry.path)
                .filter((entryPath) => entryPath !== path)
            )
          }
          onDecisionChange={isWorkspaceScope ? handleDecisionChange : undefined}
        />
        <p className="text-xs text-description-fg mt-1">
          Absolute directories outside the workspace that ctrlyoke may read for
          prompt attachments and open from file links, and that harnesses are
          given access to. Workspace files are always allowed. Entries added at
          workspace scope need a one-time approval before they take effect.
        </p>
      </SettingInputRow>
      <SettingToggleRow
        settingKey="ui.offerTrustForUntrustedFileLinks"
        checked={ui.offerTrustForUntrustedFileLinks}
        onChange={(v) => onUpdate("ui.offerTrustForUntrustedFileLinks", v)}
        {...rowProps}
      />
    </>
  );
}
