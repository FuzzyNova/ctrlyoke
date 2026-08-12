import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import { SETTING_SCOPES } from "@root/types/DashboardConstants";
import { LocalTextInput } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

/** Machine-level checkout placement settings and the effective root policy. */
export function WorktreesSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const sources = settings.sources as Record<string, SettingSource>;
  const configuredRoot = settings.settings.worktrees.root.trim();
  const userScopeOnly = activeScope === SETTING_SCOPES.WORKSPACE;
  const effectiveRoot = configuredRoot || "Automatic repository worktree root";
  const effectiveTier = configuredRoot
    ? "User-configured root"
    : "Automatic: repository sibling, then user fallback";

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-1 tracking-wide">
          Worktrees
        </h3>
        <p className="text-xs text-description-fg">
          Worktree directories are shared machine configuration. The resolver
          tries a configured root first, then the repository sibling, then the
          user fallback when the earlier location is unavailable.
        </p>
      </div>

      <SettingInputRow
        label="Worktree root"
        description="Absolute or ~-prefixed directory where named worktrees are placed."
        id="worktrees-root"
        path="worktrees.root"
        sources={sources}
        onReset={onReset}
        activeScope={activeScope}
      >
        <LocalTextInput
          id="worktrees-root"
          value={settings.settings.worktrees.root}
          onCommit={(value) => onUpdate("worktrees.root", value)}
          disabled={userScopeOnly}
          placeholder="Automatic"
          className="w-full bg-input-bg border border-input-border rounded px-2 py-1 text-sm text-foreground focus:outline-none focus:border-focus-border disabled:opacity-60 disabled:cursor-not-allowed"
        />
        {userScopeOnly && (
          <p className="text-xs text-warning-fg mt-1" role="note">
            Worktree root is user-scoped and cannot be changed from workspace
            scope. Switch the scope selector to User to edit it.
          </p>
        )}
      </SettingInputRow>

      <div className="border-t border-panel-border pt-4">
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-xs text-description-fg">Effective root</span>
          <span className="text-xxs text-description-fg">
            ({effectiveTier})
          </span>
        </div>
        <div
          id="worktrees-effective-root"
          role="status"
          className="w-full rounded border border-input-border bg-input-bg px-2 py-1 text-sm text-description-fg font-mono break-all"
        >
          {effectiveRoot}
        </div>
        <p className="text-xs text-description-fg mt-1">
          The automatic sibling and fallback paths are selected per repository
          when execution resolves the worktree.
        </p>
      </div>
    </div>
  );
}
