import { useEffect, useMemo, useState } from "react";
import {
  MESSAGE_TYPES,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@/types/messages";
import type { LanguageServerDefinition } from "@root/types/CtrlYokeSettings";
import {
  LANGUAGE_SERVER_INSTALL_KINDS,
  LANGUAGE_SERVER_SELECTIONS,
  LANGUAGE_SERVER_STATUSES,
  LSP_EXPORT_TARGET_IDS,
} from "@root/types/DashboardConstants";
import {
  useLanguageServerStore,
  LANGUAGE_SERVER_TABS,
  type LanguageServerStatus,
} from "@store/useLanguageServerStore";
import { useSettingsStore } from "@store/settingsStore";
import { sendMessage } from "@hooks/useMessageHandler";
import {
  ScopeBadge,
  encodeManagerTarget,
  decodeManagerTarget,
} from "@components/shared/ManagerUi";
import { FlyoutActionDropdown } from "@components/shared/FlyoutActionDropdown";
import { buildManagerExportGroups } from "@components/shared/ManagerExportGroups";

const STATUS_LABELS: Record<LanguageServerStatus, string> = {
  [LANGUAGE_SERVER_STATUSES.RUNNING]: "Running",
  [LANGUAGE_SERVER_STATUSES.STARTING]: "Starting",
  [LANGUAGE_SERVER_STATUSES.IDLE]: "Idle",
  [LANGUAGE_SERVER_STATUSES.STOPPED]: "Stopped",
  [LANGUAGE_SERVER_STATUSES.NOT_INSTALLED]: "Not installed",
  [LANGUAGE_SERVER_STATUSES.LIMIT_REACHED]: "Limit reached",
  [LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL]: "Needs approval",
  [LANGUAGE_SERVER_STATUSES.CRASHED]: "Crashed",
};
const STATUS_CLASSES: Record<LanguageServerStatus, string> = {
  [LANGUAGE_SERVER_STATUSES.RUNNING]: "border-success-border text-success-fg",
  [LANGUAGE_SERVER_STATUSES.STARTING]: "border-focus-border text-foreground",
  [LANGUAGE_SERVER_STATUSES.IDLE]: "border-panel-border text-description-fg",
  [LANGUAGE_SERVER_STATUSES.STOPPED]: "border-panel-border text-description-fg",
  [LANGUAGE_SERVER_STATUSES.NOT_INSTALLED]:
    "border-panel-border text-description-fg",
  [LANGUAGE_SERVER_STATUSES.LIMIT_REACHED]:
    "border-warning-border text-warning-fg",
  [LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL]:
    "border-warning-border text-warning-fg",
  [LANGUAGE_SERVER_STATUSES.CRASHED]: "border-error-border text-error-fg",
};
/** Mirrors the fallback in `LanguageServerResolver.resolveLanguageServer`. */
const AUTOMATIC_DESCRIPTION =
  "Automatic uses the first installed catalog server for the language, in catalog order. A selected server that isn't installed also falls back to Automatic; Off disables language features for that language.";
type Props = { activeScope: SettingWriteScope };
type FormState = {
  id: string;
  command: string;
  originalCommand: string[] | null;
  commandModified: boolean;
  languages: string;
  extensions: string;
  rootMarkers: string;
  env: string;
};
const EMPTY_FORM: FormState = {
  id: "",
  command: "",
  originalCommand: null,
  commandModified: false,
  languages: "",
  extensions: "",
  rootMarkers: "",
  env: "",
};
const COMMAND_FIELD = "command";

function formatArgv(argv: string[]): string {
  return argv
    .map((argument) =>
      /[\s"']/u.test(argument)
        ? `"${argument.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"')}"`
        : argument
    )
    .join(" ");
}

function parseArgv(value: string): string[] {
  const argv: string[] = [];
  let argument = "";
  let quote: "'" | '"' | null = null;
  let started = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote === '"' && character === "\\") {
      const next = value[index + 1];
      if (next === '"' || next === "\\") {
        argument += next;
        index += 1;
      } else {
        argument += character;
      }
      started = true;
    } else if (quote === "'" && character === "'") {
      quote = null;
      started = true;
    } else if (quote === '"' && character === '"') {
      quote = null;
      started = true;
    } else if (!quote && (character === '"' || character === "'")) {
      quote = character;
      started = true;
    } else if (!quote && /\s/u.test(character)) {
      if (started) {
        argv.push(argument);
        argument = "";
        started = false;
      }
    } else {
      argument += character;
      started = true;
    }
  }

  if (started) argv.push(argument);
  return argv;
}

export function LanguageServersSection({ activeScope }: Props) {
  const definitions = useLanguageServerStore((s) => s.definitions);
  const catalog = useLanguageServerStore((s) => s.catalog);
  const detectedLanguages = useLanguageServerStore((s) => s.detectedLanguages);
  const approvedWorkspaceDefinitionIds = useLanguageServerStore(
    (s) => s.approvedWorkspaceDefinitionIds
  );
  const probes = useLanguageServerStore((s) => s.probes);
  const statuses = useLanguageServerStore((s) => s.statuses);
  const hostPlatform = useLanguageServerStore((s) => s.hostPlatform);
  const localServers = useLanguageServerStore((s) => s.localServers);
  const localError = useLanguageServerStore((s) => s.localError);
  const loading = useLanguageServerStore((s) => s.loading);
  const scanning = useLanguageServerStore((s) => s.scanning);
  const query = useLanguageServerStore((s) => s.query);
  const tab = useLanguageServerStore((s) => s.tab);
  const installing = useLanguageServerStore((s) => s.installing);
  const exportedTargets = useLanguageServerStore((s) => s.exportedTargets);
  const exportResult = useLanguageServerStore((s) => s.exportResult);
  const requestServers = useLanguageServerStore((s) => s.requestServers);
  const requestLocalScan = useLanguageServerStore((s) => s.requestLocalScan);
  const setQuery = useLanguageServerStore((s) => s.setQuery);
  const setTab = useLanguageServerStore((s) => s.setTab);
  const install = useLanguageServerStore((s) => s.install);
  const saveDefinition = useLanguageServerStore((s) => s.saveDefinition);
  const deleteDefinition = useLanguageServerStore((s) => s.deleteDefinition);
  const restart = useLanguageServerStore((s) => s.restart);
  const requestApproval = useLanguageServerStore((s) => s.requestApproval);
  const stop = useLanguageServerStore((s) => s.stop);
  const fullSettings = useSettingsStore((s) => s.fullGlobalSettings);
  const globalSettings = useSettingsStore((s) => s.globalSettings);
  const currentSettings = fullSettings ?? globalSettings;
  const hasWorkspaceRoot = Boolean(globalSettings.workspaceRoot?.trim());
  const selections = useMemo(
    () =>
      (
        currentSettings as {
          languageServers?: { use?: Record<string, string | false> };
        } | null
      )?.languageServers?.use ?? {},
    [currentSettings]
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);

  useEffect(() => {
    requestServers();
  }, [requestServers]);

  const languages = detectedLanguages;
  const probeById = useMemo(
    () => new Map(probes.map((probe) => [probe.id, probe])),
    [probes]
  );
  const definitionById = useMemo(
    () => new Map(definitions.map((entry) => [entry.id, entry])),
    [definitions]
  );
  const filteredCatalog = useMemo(
    () =>
      catalog.filter((entry) =>
        `${entry.displayName} ${entry.id} ${entry.languages.join(" ")}`
          .toLowerCase()
          .includes(query.trim().toLowerCase())
      ),
    [catalog, query]
  );
  const automaticTooltip = (language: string) => {
    const automatic = catalog.find(
      (entry) =>
        entry.languages.includes(language) && probeById.get(entry.id)?.detected
    );
    return `Automatic: uses the first installed catalog server for ${language}. ${
      automatic
        ? `Currently ${automatic.displayName}.`
        : "None is installed, so this language has no server."
    }`;
  };
  const activeDefinition = form?.id ? definitionById.get(form.id) : undefined;
  const saveForm = () => {
    if (!form?.id.trim() || !form.command.trim()) return;
    const definition: LanguageServerDefinition = {
      command:
        form.originalCommand && !form.commandModified
          ? form.originalCommand
          : parseArgv(form.command),
      languages: form.languages.split(/[\s,]+/).filter(Boolean),
      extensions: form.extensions
        .split(/[\s,]+/)
        .map((value) => value.replace(/^\./, ""))
        .filter(Boolean),
      rootMarkers: form.rootMarkers.split(/[\s,]+/).filter(Boolean),
      ...(form.env.trim()
        ? {
            env: Object.fromEntries(
              form.env
                .split(/\n/)
                .map((line) => {
                  const separator = line.indexOf("=");
                  return separator < 0
                    ? null
                    : [
                        line.slice(0, separator).trim(),
                        line.slice(separator + 1).trim(),
                      ];
                })
                .filter((parts): parts is [string, string] =>
                  Boolean(parts?.[0])
                )
            ),
          }
        : {}),
    };
    saveDefinition(form.id.trim(), definition, activeScope);
    setForm(null);
  };
  const addLocal = (entry: (typeof localServers)[number]) =>
    saveDefinition(entry.id, entry.definition, activeScope);
  const requestSelectWrite = (language: string, value: string) =>
    sendMessage(MESSAGE_TYPES.UPDATE_GLOBAL_SETTING, {
      path: `languageServers.use.${language}`,
      value:
        value === LANGUAGE_SERVER_SELECTIONS.OFF
          ? false
          : value === LANGUAGE_SERVER_SELECTIONS.AUTOMATIC
            ? undefined
            : value,
      scope: activeScope,
    });
  const copyInstallCommand = async (entry: (typeof catalog)[number]) => {
    const command =
      entry.install.kind === LANGUAGE_SERVER_INSTALL_KINDS.COMMAND
        ? entry.install.commands[
            hostPlatform ??
              (window.navigator.platform.startsWith("Win")
                ? "win32"
                : window.navigator.platform.startsWith("Mac")
                  ? "darwin"
                  : "linux")
          ]
        : `npm install --prefix <ctrlyokeStateHome>/lsp ${entry.install.packages.join(" ")}`;
    if (command) await navigator.clipboard?.writeText(command);
  };
  const rows = useMemo(() => {
    const ids = new Set([
      ...catalog
        .filter((entry) => probeById.get(entry.id)?.detected)
        .map((entry) => entry.id),
      ...Object.values(selections).filter(
        (id): id is string => typeof id === "string"
      ),
      ...definitions.map((entry) => entry.id),
    ]);
    return [...ids].map((id) => ({
      id,
      catalogEntry: catalog.find((entry) => entry.id === id),
      managed: definitionById.get(id),
      probe: probeById.get(id),
      status: [...statuses].reverse().find((status) => status.id === id),
    }));
  }, [catalog, definitions, definitionById, probeById, selections, statuses]);

  return (
    <div
      className="space-y-4"
      data-landmark="landmark:language-servers:servers"
      data-settings-search-id="landmark:language-servers:servers"
    >
      <div>
        <h3 className="text-xs font-semibold uppercase text-description-fg mb-1 tracking-wide">
          Language servers
        </h3>
        <p className="text-xs text-description-fg">
          Used by the browser workspace editor and, in{" "}
          <code>ctrlyoke server</code>, by <code>#</code> symbol completions.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="min-w-0 space-y-3 rounded-sm border border-panel-border p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-description-fg">
            Configured
          </h3>
          <div className="space-y-1.5 rounded-sm border border-panel-border p-2">
            <div className="text-xs font-semibold text-foreground">
              Languages
            </div>
            <p className="text-xxs text-description-fg">
              {AUTOMATIC_DESCRIPTION}
            </p>
            {languages.map((language) => (
              <label
                key={language}
                className="flex items-center justify-between gap-2 text-xs"
              >
                <span className="min-w-0 truncate font-mono text-foreground">
                  {language}
                </span>
                <select
                  aria-label={`${language} language server`}
                  title={automaticTooltip(language)}
                  value={
                    selections[language] === false
                      ? LANGUAGE_SERVER_SELECTIONS.OFF
                      : typeof selections[language] === "string"
                        ? selections[language]
                        : LANGUAGE_SERVER_SELECTIONS.AUTOMATIC
                  }
                  onChange={(event) =>
                    requestSelectWrite(language, event.target.value)
                  }
                  className="w-48 shrink-0 rounded-sm border border-input-border bg-input-bg px-2 py-1 text-xs text-input-fg"
                >
                  <option
                    value={LANGUAGE_SERVER_SELECTIONS.AUTOMATIC}
                    title={automaticTooltip(language)}
                  >
                    Automatic
                  </option>
                  <option value={LANGUAGE_SERVER_SELECTIONS.OFF}>Off</option>
                  {catalog
                    .filter((entry) => entry.languages.includes(language))
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.displayName}
                      </option>
                    ))}
                  {definitions
                    .filter((entry) =>
                      entry.definition.languages.includes(language)
                    )
                    .map((entry) => (
                      <option key={entry.id} value={entry.id}>
                        {entry.id} (managed)
                      </option>
                    ))}
                </select>
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-foreground">Servers</h3>
            <button
              type="button"
              onClick={() => setForm({ ...EMPTY_FORM })}
              className="rounded-sm border border-panel-border px-2 py-1 text-xs text-foreground hover:border-focus-border"
            >
              Add server
            </button>
          </div>
          {loading && rows.length === 0 ? (
            <p className="text-xs text-description-fg">
              Loading language servers…
            </p>
          ) : (
            rows.map((row) => {
              const liveStatus =
                row.status?.status ??
                (row.managed?.scope === SETTING_SCOPES.WORKSPACE &&
                !approvedWorkspaceDefinitionIds.includes(row.id)
                  ? LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL
                  : row.probe?.detected
                    ? LANGUAGE_SERVER_STATUSES.STOPPED
                    : LANGUAGE_SERVER_STATUSES.NOT_INSTALLED);
              const status =
                row.managed?.scope === SETTING_SCOPES.WORKSPACE &&
                approvedWorkspaceDefinitionIds.includes(row.id) &&
                liveStatus === LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL
                  ? LANGUAGE_SERVER_STATUSES.STOPPED
                  : liveStatus;
              const canRestart =
                status === LANGUAGE_SERVER_STATUSES.RUNNING ||
                status === LANGUAGE_SERVER_STATUSES.IDLE ||
                status === LANGUAGE_SERVER_STATUSES.CRASHED ||
                row.status?.status === LANGUAGE_SERVER_STATUSES.STOPPED;
              const definition = row.managed?.definition ?? row.catalogEntry;
              const exportGroups = buildManagerExportGroups({
                hasWorkspaceRoot,
                workspaceTargetIds: [
                  LSP_EXPORT_TARGET_IDS.QWEN_WORKSPACE,
                  LSP_EXPORT_TARGET_IDS.COPILOT_WORKSPACE,
                  LSP_EXPORT_TARGET_IDS.OPENCODE_WORKSPACE,
                  LSP_EXPORT_TARGET_IDS.CCLSP_WORKSPACE,
                ],
                userTargetIds: [
                  LSP_EXPORT_TARGET_IDS.COPILOT_USER,
                  LSP_EXPORT_TARGET_IDS.OPENCODE_USER,
                ],
                labelForTarget: (id) =>
                  ({
                    [LSP_EXPORT_TARGET_IDS.QWEN_WORKSPACE]: "Qwen Code",
                    [LSP_EXPORT_TARGET_IDS.COPILOT_WORKSPACE]: "Copilot CLI",
                    [LSP_EXPORT_TARGET_IDS.COPILOT_USER]: "Copilot CLI",
                    [LSP_EXPORT_TARGET_IDS.OPENCODE_WORKSPACE]: "opencode",
                    [LSP_EXPORT_TARGET_IDS.OPENCODE_USER]: "opencode",
                    [LSP_EXPORT_TARGET_IDS.CCLSP_WORKSPACE]: "cclsp",
                  })[id] ?? id,
                presentKeys: new Set(exportedTargets[row.id] ?? []),
                descriptionForTarget: (id) =>
                  ({
                    [LSP_EXPORT_TARGET_IDS.QWEN_WORKSPACE]: ".lsp.json",
                    [LSP_EXPORT_TARGET_IDS.COPILOT_WORKSPACE]:
                      ".github/lsp.json",
                    [LSP_EXPORT_TARGET_IDS.COPILOT_USER]:
                      "~/.copilot/lsp-config.json",
                    [LSP_EXPORT_TARGET_IDS.OPENCODE_WORKSPACE]: "opencode.json",
                    [LSP_EXPORT_TARGET_IDS.OPENCODE_USER]:
                      "~/.config/opencode/opencode.json",
                    [LSP_EXPORT_TARGET_IDS.CCLSP_WORKSPACE]: "cclsp.json",
                  })[id] ?? id,
              });
              const envKeys = row.managed?.definition.env
                ? Object.keys(row.managed.definition.env)
                : [];
              return (
                <article
                  key={encodeManagerTarget(
                    row.id,
                    row.managed?.scope ?? activeScope
                  )}
                  className="rounded-sm border border-panel-border"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2 p-2">
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded(expanded === row.id ? null : row.id)
                      }
                      className="min-w-0 flex-1 text-left"
                    >
                      <span className="block truncate text-xs font-semibold text-foreground">
                        {row.catalogEntry?.displayName ?? row.id}
                      </span>
                      <span className="block truncate font-mono text-xxs text-description-fg">
                        {row.id} · {definition?.languages.join(", ")}
                      </span>
                    </button>
                    <span
                      title={
                        status === LANGUAGE_SERVER_STATUSES.CRASHED
                          ? row.status?.detail
                          : undefined
                      }
                      className={`rounded-sm border px-1.5 py-0.5 text-xxs ${STATUS_CLASSES[status]}`}
                    >
                      {STATUS_LABELS[status]}
                    </span>
                    <div className="flex gap-1">
                      {row.managed?.scope === SETTING_SCOPES.WORKSPACE &&
                        status === LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL && (
                          <button
                            type="button"
                            onClick={requestApproval}
                            className="rounded-sm border border-panel-border px-1.5 py-0.5 text-xxs"
                          >
                            Approve
                          </button>
                        )}
                      {canRestart && (
                        <>
                          <button
                            type="button"
                            onClick={() => restart(row.id)}
                            className="rounded-sm border border-panel-border px-1.5 py-0.5 text-xxs"
                          >
                            Restart
                          </button>
                          {(status === LANGUAGE_SERVER_STATUSES.RUNNING ||
                            status === LANGUAGE_SERVER_STATUSES.IDLE ||
                            status === LANGUAGE_SERVER_STATUSES.CRASHED) && (
                            <button
                              type="button"
                              onClick={() => stop(row.id)}
                              className="rounded-sm border border-panel-border px-1.5 py-0.5 text-xxs"
                            >
                              Stop
                            </button>
                          )}
                        </>
                      )}
                      {row.managed && (
                        <>
                          <FlyoutActionDropdown
                            label="Save"
                            icon="save"
                            iconOnly
                            groups={exportGroups}
                            onSelect={(encoded) => {
                              const { id: targetId, scope } =
                                decodeManagerTarget(encoded);
                              sendMessage(MESSAGE_TYPES.EXPORT_LSP_DEFINITION, {
                                id: row.id,
                                targetId,
                                scope,
                              });
                            }}
                          />
                          <button
                            type="button"
                            onClick={() =>
                              setForm({
                                id: row.id,
                                command: formatArgv(
                                  row.managed!.definition.command
                                ),
                                originalCommand:
                                  row.managed!.definition.command,
                                commandModified: false,
                                languages:
                                  row.managed!.definition.languages.join(", "),
                                extensions:
                                  row.managed!.definition.extensions.join(", "),
                                rootMarkers:
                                  row.managed!.definition.rootMarkers.join(
                                    ", "
                                  ),
                                env: Object.entries(
                                  row.managed!.definition.env ?? {}
                                )
                                  .map(([key, value]) => `${key}=${value}`)
                                  .join("\n"),
                              })
                            }
                            className="rounded-sm border border-panel-border px-1.5 py-0.5 text-xxs"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              deleteDefinition(row.id, row.managed!.scope)
                            }
                            className="rounded-sm border border-panel-border px-1.5 py-0.5 text-xxs"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  {((row.managed?.scope === SETTING_SCOPES.WORKSPACE &&
                    status === LANGUAGE_SERVER_STATUSES.NEEDS_APPROVAL) ||
                    (Object.values(selections).includes(row.id) &&
                      !row.probe?.detected)) && (
                    <div className="flex items-center justify-between gap-2 border-t border-panel-border px-2 py-1 text-xxs text-description-fg">
                      <span>
                        This workspace wants <code>{row.id}</code>
                        {row.managed?.scope === SETTING_SCOPES.WORKSPACE
                          ? ". Approval is requested when servers are approved."
                          : "."}
                      </span>
                      {row.catalogEntry?.install.kind ===
                        LANGUAGE_SERVER_INSTALL_KINDS.NPM && (
                        <button
                          type="button"
                          onClick={() => install(row.id)}
                          className="rounded-sm border border-panel-border px-1.5 py-0.5"
                        >
                          Install
                        </button>
                      )}
                    </div>
                  )}
                  {expanded === row.id && (
                    <div className="grid gap-1 border-t border-panel-border px-2 py-2 text-xxs text-description-fg sm:grid-cols-2">
                      <div>
                        Command:{" "}
                        <code>{formatArgv(definition?.command ?? [])}</code>
                      </div>
                      <div>
                        Resolved:{" "}
                        <code>{row.probe?.resolvedPath ?? "not found"}</code>
                      </div>
                      <div>
                        Root markers:{" "}
                        {definition?.rootMarkers.join(", ") || "none"}
                      </div>
                      <div>
                        Environment keys: {envKeys.join(", ") || "none"}
                      </div>
                      {row.managed && <ScopeBadge label={row.managed.scope} />}
                    </div>
                  )}
                </article>
              );
            })
          )}
          {form && (
            <div className="space-y-2 rounded-sm border border-focus-border p-2">
              <div className="text-xs font-semibold">
                {activeDefinition ? "Edit server" : "Add server"}
              </div>
              {(
                [
                  "id",
                  "command",
                  "languages",
                  "extensions",
                  "rootMarkers",
                  "env",
                ] as const
              ).map((field) => (
                <label
                  key={field}
                  className="block text-xxs text-description-fg"
                >
                  {field}
                  {field === "env" ? (
                    <textarea
                      aria-label={field}
                      rows={4}
                      value={form[field]}
                      onChange={(event) =>
                        setForm({ ...form, [field]: event.target.value })
                      }
                      className="mt-0.5 w-full rounded-sm border border-input-border bg-input-bg px-2 py-1 font-mono text-xs text-input-fg"
                    />
                  ) : (
                    <input
                      aria-label={field}
                      value={form[field]}
                      onChange={(event) =>
                        setForm({
                          ...form,
                          [field]: event.target.value,
                          ...(field === COMMAND_FIELD
                            ? { commandModified: true }
                            : {}),
                        })
                      }
                      className="mt-0.5 w-full rounded-sm border border-input-border bg-input-bg px-2 py-1 font-mono text-xs text-input-fg"
                    />
                  )}
                </label>
              ))}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={saveForm}
                  disabled={!form.id.trim() || !form.command.trim()}
                  className="rounded-sm bg-btn-bg px-2 py-1 text-xs text-btn-fg disabled:opacity-50"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setForm(null)}
                  className="rounded-sm border border-panel-border px-2 py-1 text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </section>
        <section className="min-w-0 space-y-3 rounded-sm border border-panel-border p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-description-fg">
            Discover
          </h3>
          <div className="flex items-center gap-1">
            <div
              className="flex gap-1"
              role="tablist"
              aria-label="Discover language servers"
            >
              {[
                [LANGUAGE_SERVER_TABS.CATALOG, "Catalog"],
                [LANGUAGE_SERVER_TABS.LOCAL, "Local configs"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  role="tab"
                  aria-selected={tab === value}
                  onClick={() => setTab(value as typeof tab)}
                  className={`rounded-sm border px-2 py-1 text-xs ${tab === value ? "border-btn-bg bg-btn-bg text-btn-fg" : "border-panel-border text-description-fg"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={
                tab === LANGUAGE_SERVER_TABS.CATALOG
                  ? requestServers
                  : requestLocalScan
              }
              disabled={tab === LANGUAGE_SERVER_TABS.LOCAL && scanning}
              title={
                tab === LANGUAGE_SERVER_TABS.CATALOG
                  ? "Re-detect installed catalog servers"
                  : "Re-scan harness configs for language servers"
              }
              className="ml-auto rounded-sm border border-panel-border px-2 py-1 text-xs disabled:opacity-50"
            >
              {tab === LANGUAGE_SERVER_TABS.LOCAL && scanning
                ? "Scanning…"
                : "Scan again"}
            </button>
          </div>
          {tab === LANGUAGE_SERVER_TABS.CATALOG ? (
            <>
              <input
                aria-label="Filter language server catalog"
                placeholder="Filter catalog…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="w-full rounded-sm border border-input-border bg-input-bg px-2 py-1 text-xs text-input-fg"
              />
              <div className="space-y-2">
                {filteredCatalog.map((entry) => {
                  const detected = probeById.get(entry.id)?.detected;
                  const installState = installing[entry.id];
                  const selected = Object.values(selections).includes(entry.id);
                  return (
                    <article
                      key={entry.id}
                      className="rounded-sm border border-panel-border p-2"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-foreground">
                            {entry.displayName}
                          </div>
                          <div className="font-mono text-xxs text-description-fg">
                            {entry.id} · {entry.languages.join(", ")}
                          </div>
                          <p className="mt-1 text-xxs text-description-fg">
                            {entry.description}
                          </p>
                        </div>
                        <span className="shrink-0 text-xxs text-description-fg">
                          {detected ? "Detected" : "Not installed"}
                        </span>
                      </div>
                      <div className="mt-2 flex flex-wrap gap-1">
                        {entry.install.kind ===
                          LANGUAGE_SERVER_INSTALL_KINDS.NPM &&
                        detected !== true ? (
                          <button
                            type="button"
                            onClick={() => install(entry.id)}
                            disabled={Boolean(
                              installing[entry.id] &&
                              !installing[entry.id]?.failed
                            )}
                            className="rounded-sm bg-btn-bg px-2 py-1 text-xxs text-btn-fg"
                          >
                            {installing[entry.id]?.label ?? "Install"}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => void copyInstallCommand(entry)}
                          className="rounded-sm border border-panel-border px-2 py-1 text-xxs"
                        >
                          Copy install command
                        </button>
                        <a
                          href={entry.homepage}
                          target="_blank"
                          rel="noreferrer"
                          className="rounded-sm border border-panel-border px-2 py-1 text-xxs"
                        >
                          Homepage
                        </a>
                        {selected && (
                          <span className="px-1 py-1 text-xxs text-description-fg">
                            Selected
                          </span>
                        )}
                      </div>
                      {installState?.failed && (
                        <p role="alert" className="mt-1 text-xxs text-error-fg">
                          {installState.label}
                          {installState.copyableCommand && (
                            <button
                              type="button"
                              className="ml-2 underline"
                              onClick={() =>
                                void navigator.clipboard?.writeText(
                                  installState.copyableCommand!
                                )
                              }
                            >
                              Copy install command
                            </button>
                          )}
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>
            </>
          ) : (
            <>
              {localError && (
                <p role="alert" className="text-xs text-error-fg">
                  {localError}
                </p>
              )}
              {localServers.map((entry) => (
                <article
                  key={`${entry.source}:${entry.id}`}
                  className="flex items-center justify-between gap-2 rounded-sm border border-panel-border p-2"
                >
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-foreground">
                      {entry.id}
                    </div>
                    <div className="truncate font-mono text-xxs text-description-fg">
                      {entry.source} · {entry.path}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => addLocal(entry)}
                    className="rounded-sm bg-btn-bg px-2 py-1 text-xxs text-btn-fg"
                  >
                    Import
                  </button>
                </article>
              ))}
              {!scanning && localServers.length === 0 && (
                <p className="text-xs text-description-fg">
                  No local language server configurations found.
                </p>
              )}
            </>
          )}
        </section>
      </div>
      {exportResult && (
        <p
          role="status"
          className={`text-xs ${exportResult.success ? "text-success-fg" : "text-error-fg"}`}
        >
          {exportResult.success
            ? `Exported ${exportResult.id} to ${exportResult.targetId} (${exportResult.scope}).`
            : `Could not export ${exportResult.id}: ${exportResult.error ?? "Unknown error"}`}
        </p>
      )}
    </div>
  );
}
