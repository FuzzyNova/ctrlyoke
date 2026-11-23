import { useMemo } from "react";
import type { SettingWriteScope } from "@/types/messages";
import {
  COMMUNITY_TEMPLATES,
  COMMUNITY_TEMPLATES_URLS,
  SETTING_WRITE_SCOPE_LABELS,
  buildCustomTemplateId,
  getCommunityTemplateSourceUrl,
} from "@root/types/DashboardConstants";
import type { CommunityTemplateEntry } from "@root/types/WebviewMessageTypes";
import {
  getCommunityInstallKey,
  useCommunityTemplatesStore,
} from "@store/communityTemplatesStore";
import { useUiStore } from "@store/uiStore";
import { Icon } from "../shared/Icon";

interface Props {
  activeScope: SettingWriteScope;
  /** Open this installed template's card in the Defaults column. */
  onSetDefaults: (templateId: string) => void;
}

function matchesQuery(entry: CommunityTemplateEntry, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = [
    entry.id,
    entry.name,
    entry.description,
    entry.author ?? "",
    ...entry.tags,
  ]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

const ROW_BUTTON_CLASS =
  "shrink-0 rounded-sm border border-panel-border px-2 py-0.5 text-xs text-description-fg transition-colors hover:border-focus-border hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40";

/**
 * Settings → Templates, Community templates column: browse the community
 * template library and install a template into the drawer's active scope. The
 * list is read through the extension host only when the user asks for it
 * (**Browse community templates** or **Refresh**), never when the tab opens:
 * like the MCP registry and skills.sh, nothing reaches a third party until the
 * user chooses to browse.
 */
export function CommunityTemplatesPage({ activeScope, onSetDefaults }: Props) {
  const templates = useCommunityTemplatesStore((state) => state.templates);
  const isLoading = useCommunityTemplatesStore((state) => state.isLoading);
  const error = useCommunityTemplatesStore((state) => state.error);
  const query = useCommunityTemplatesStore((state) => state.query);
  const installs = useCommunityTemplatesStore((state) => state.installs);
  const requestIndex = useCommunityTemplatesStore(
    (state) => state.requestIndex
  );
  const setQuery = useCommunityTemplatesStore((state) => state.setQuery);
  const installTemplate = useCommunityTemplatesStore(
    (state) => state.installTemplate
  );
  const catalog = useUiStore((state) => state.templateCatalog);

  const installedIds = useMemo(
    () => new Set(catalog.map((template) => template.id)),
    [catalog]
  );
  const visible = useMemo(
    () => (templates ?? []).filter((entry) => matchesQuery(entry, query)),
    [templates, query]
  );
  const scopeLabel = SETTING_WRITE_SCOPE_LABELS[activeScope];

  return (
    <div
      className="space-y-3"
      data-settings-search-id="landmark:templates.discover"
      data-testid="community-templates-page"
    >
      <p className="text-xs text-description-fg">
        Templates shared by ctrlyoke users in the{" "}
        <a
          href={COMMUNITY_TEMPLATES_URLS.REPO}
          target="_blank"
          rel="noreferrer"
          className="text-link-fg hover:underline"
        >
          {COMMUNITY_TEMPLATES.label}
        </a>{" "}
        library, downloaded from {COMMUNITY_TEMPLATES.cdnHost}. Installing one
        copies it into your {scopeLabel} templates. To share your own, open a
        pull request; see{" "}
        <a
          href={COMMUNITY_TEMPLATES_URLS.CONTRIBUTING}
          target="_blank"
          rel="noreferrer"
          className="text-link-fg hover:underline"
        >
          how to contribute
        </a>
        .
      </p>
      <p
        className="flex items-start gap-1.5 rounded-sm border border-panel-border px-2 py-1.5 text-xs text-description-fg"
        role="note"
      >
        <Icon name="warning" className="mt-0.5 text-warning-fg" />
        <span>
          Community templates are written by third parties and can run commands
          and scripts. Review a template&apos;s source before you run a workflow
          made from it.
        </span>
      </p>

      {templates === undefined && !isLoading && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => requestIndex()}
            className={ROW_BUTTON_CLASS}
          >
            Browse community templates
          </button>
          <span className="text-xxs text-description-fg">
            Downloads the list from {COMMUNITY_TEMPLATES.cdnHost}.
          </span>
        </div>
      )}

      {templates !== undefined && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by name, author or tag…"
            aria-label="Filter community templates"
            className="min-w-[220px] flex-1 rounded-sm border border-input-border bg-input-bg px-2 py-1 text-xs text-input-fg focus:border-focus-border focus:outline-hidden"
          />
          <button
            type="button"
            onClick={() => requestIndex(true)}
            disabled={isLoading}
            className={ROW_BUTTON_CLASS}
            title="Download the list again"
          >
            Refresh
          </button>
        </div>
      )}

      {isLoading && (
        <p className="flex items-center gap-1.5 text-xs text-description-fg">
          <Icon name="loading" className="codicon-modifier-spin" />
          Loading community templates…
        </p>
      )}
      {!isLoading && error && (
        <div
          className="space-y-1 rounded-sm border border-panel-border px-2 py-1.5 text-xs"
          role="alert"
        >
          <p className="text-error-fg">
            Could not load the community templates: {error}
          </p>
          <p className="text-description-fg">
            Check your connection, then choose Refresh.
          </p>
        </div>
      )}
      {!isLoading && !error && templates?.length === 0 && (
        <p className="text-xs text-description-fg italic">
          The community library has no templates yet.
        </p>
      )}
      {!isLoading &&
        !error &&
        templates !== undefined &&
        templates.length > 0 &&
        visible.length === 0 && (
          <p className="text-xs text-description-fg italic">
            No community templates match “{query.trim()}”.
          </p>
        )}

      <ul className="space-y-2" aria-label="Community templates">
        {!isLoading &&
          visible.map((entry) => {
            const localId = buildCustomTemplateId(activeScope, entry.id);
            const install =
              installs[getCommunityInstallKey(activeScope, entry.id)];
            const installed = installedIds.has(localId);
            return (
              <li
                key={entry.id}
                className="flex items-start justify-between gap-2 rounded-sm border border-panel-border px-2 py-1.5"
                data-testid={`community-template-${entry.id}`}
              >
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="text-xs font-medium text-foreground">
                    {entry.name}
                    {entry.author && (
                      <span className="ml-1 font-normal text-description-fg">
                        by {entry.author}
                      </span>
                    )}
                  </div>
                  {entry.description && (
                    <p className="text-xs text-description-fg">
                      {entry.description}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5 text-xxs text-description-fg">
                    <span className="font-mono">{entry.id}</span>
                    {entry.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-sm border border-panel-border px-1"
                      >
                        {tag}
                      </span>
                    ))}
                    <a
                      href={getCommunityTemplateSourceUrl(entry.file)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-link-fg hover:underline"
                      title={`View ${entry.file} on GitHub`}
                    >
                      View source
                    </a>
                  </div>
                  {install?.error && (
                    <p className="text-xs text-error-fg" role="alert">
                      {install.error}
                    </p>
                  )}
                  {installed && install?.localTemplateId && (
                    <button
                      type="button"
                      onClick={() => onSetDefaults(localId)}
                      className="text-xs text-link-fg hover:underline"
                    >
                      Set defaults
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  disabled={installed || install?.installing}
                  onClick={() => installTemplate(entry.id, activeScope)}
                  className={ROW_BUTTON_CLASS}
                  aria-label={
                    installed
                      ? `${entry.name} is installed in ${scopeLabel} templates`
                      : `Install ${entry.name} to ${scopeLabel} templates`
                  }
                >
                  {installed
                    ? "Installed"
                    : install?.installing
                      ? "Installing…"
                      : "Install"}
                </button>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
