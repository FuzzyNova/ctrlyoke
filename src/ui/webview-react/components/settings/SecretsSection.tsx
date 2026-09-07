import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useSecretRegistryStore } from "@store/secretRegistryStore";
import {
  SECRET_REGISTRY_STATES,
  SETTING_SCOPES,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";
import type {
  FullGlobalSettings,
  SecretRegistryEntry,
  SecretRegistryState,
  SettingSource,
} from "@root/types/WebviewMessageTypes";
import { formatRelativeTimeVerbose } from "@utils/time";
import {
  Button,
  CustomSelect,
  Modal,
  SettingToggleRow,
} from "@components/shared";
import { Icon } from "../shared/Icon";

interface SecretsSectionProps {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

type SecretDialogMode = "set" | "replace";

interface SecretDialogState {
  mode: SecretDialogMode;
  name: string;
}

const SECRET_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
// Names are restricted to this shape so a declaration is always a legal env var name and so
// the `!NAME` prompt-completion trigger never fires on ordinary lowercase prose or Markdown
// `![alt]` image syntax after a `!` (see SECRETS_AND_REDACTION_PLAN.md).
const SECRET_NAME_REQUIREMENT_TEXT =
  "Secret name must start with a capital letter and contain only capital letters, numbers, or underscores.";

const SCOPE_OPTIONS = [
  { value: SETTING_SCOPES.USER, label: "User" },
  { value: SETTING_SCOPES.WORKSPACE, label: "Workspace" },
];

function stateLabel(entry: SecretRegistryEntry): string {
  switch (entry.state) {
    case SECRET_REGISTRY_STATES.MANAGED_AND_SET: {
      const updated = formatRelativeTimeVerbose(entry.lastUpdated);
      return `Managed · set${updated ? ` · updated ${updated.toLowerCase()}` : ""}`;
    }
    case SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_DETECTED:
      return "From environment · detected";
    case SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_NOT_FOUND:
      return "From environment · not found";
  }
}

function stateClass(state: SecretRegistryState): string {
  return state === SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_NOT_FOUND
    ? "text-warning-fg"
    : "text-description-fg";
}

function usedByCount(entry: SecretRegistryEntry): number {
  return entry.usedBy.mcpServers.length + entry.usedBy.workflows.length;
}

function SecretUsage({ entry }: { entry: SecretRegistryEntry }) {
  const count = usedByCount(entry);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-description-fg hover:text-foreground">
        Used by ({count})
      </summary>
      {count === 0 ? (
        <p className="mt-1 text-description-fg">Not referenced.</p>
      ) : (
        <div className="mt-1 space-y-1 pl-3">
          {entry.usedBy.mcpServers.length > 0 && (
            <div>
              <span className="font-medium text-foreground">MCP:</span>{" "}
              {entry.usedBy.mcpServers.join(", ")}
            </div>
          )}
          {entry.usedBy.workflows.length > 0 && (
            <div>
              <span className="font-medium text-foreground">Workflows:</span>{" "}
              {entry.usedBy.workflows.join(", ")}
            </div>
          )}
        </div>
      )}
    </details>
  );
}

interface SecretRowProps {
  entry: SecretRegistryEntry;
  onReplace: (name: string) => void;
  onDelete: (name: string) => void;
  onSet: (name: string) => void;
}

function SecretRow({ entry, onReplace, onDelete, onSet }: SecretRowProps) {
  const isMissing =
    entry.state === SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_NOT_FOUND;
  const rowClass = isMissing
    ? "border-warning-fg border-opacity-40 bg-severity-warning-bg"
    : "border-panel-border";

  return (
    <div
      className={`grid gap-3 rounded border px-3 py-2 md:grid-cols-[minmax(10rem,1fr)_minmax(12rem,1fr)_minmax(11rem,1.2fr)_auto] ${rowClass}`}
      data-testid={`secret-row-${entry.name}`}
    >
      <div className="min-w-0">
        <code className="break-all text-sm text-foreground">{entry.name}</code>
        {entry.description && (
          <p className="mt-1 break-words text-xs text-description-fg">
            {entry.description}
          </p>
        )}
      </div>
      <div className={`text-xs ${stateClass(entry.state)}`}>
        {isMissing && <Icon name="warning" className="mr-1" />}
        {stateLabel(entry)}
      </div>
      <SecretUsage entry={entry} />
      <div className="flex items-start justify-end md:justify-start">
        {entry.state === SECRET_REGISTRY_STATES.MANAGED_AND_SET && (
          <div className="grid grid-cols-1 gap-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="border border-btn-border"
              onClick={() => onReplace(entry.name)}
            >
              Replace
            </Button>
            <Button
              type="button"
              variant="danger"
              size="sm"
              onClick={() => onDelete(entry.name)}
            >
              Delete
            </Button>
          </div>
        )}
        {entry.state ===
          SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_DETECTED && (
          <div className="grid grid-cols-1 gap-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="border border-btn-border"
              onClick={() => onSet(entry.name)}
            >
              Convert to managed
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="border border-btn-border"
              onClick={() => onDelete(entry.name)}
            >
              Remove declaration
            </Button>
          </div>
        )}
        {entry.state ===
          SECRET_REGISTRY_STATES.FROM_ENVIRONMENT_AND_NOT_FOUND && (
          <div className="grid grid-cols-1 gap-1">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="border border-btn-border"
              onClick={() => onSet(entry.name)}
            >
              Set value
            </Button>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="border border-btn-border"
              onClick={() => onDelete(entry.name)}
            >
              Remove declaration
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

interface SecretDialogProps {
  dialog: SecretDialogState | null;
  activeScope: SettingWriteScope;
  onClose: () => void;
}

function SecretDialog({ dialog, activeScope, onClose }: SecretDialogProps) {
  const setSecret = useSecretRegistryStore((state) => state.setSecret);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<SettingWriteScope>(activeScope);
  const [value, setValue] = useState("");
  const [description, setDescription] = useState("");
  const [multiline, setMultiline] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const valueInputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const setValueInputRef = (
    node: HTMLInputElement | HTMLTextAreaElement | null
  ) => {
    valueInputRef.current = node;
  };

  useEffect(() => {
    if (!dialog) return;
    setName(dialog.name);
    setScope(activeScope);
    setValue("");
    setDescription("");
    setMultiline(false);
    setNameError(null);
    const focusTimer = window.setTimeout(
      () => valueInputRef.current?.focus(),
      0
    );
    return () => window.clearTimeout(focusTimer);
  }, [activeScope, dialog]);

  if (!dialog) return null;

  const isReplace = dialog.mode === "replace";
  const validateName = (candidate: string): string | null => {
    if (!SECRET_NAME_PATTERN.test(candidate)) {
      return SECRET_NAME_REQUIREMENT_TEXT;
    }
    return null;
  };

  const handleSubmit = () => {
    const trimmedName = name.trim();
    const error = validateName(trimmedName);
    if (error) {
      setNameError(error);
      return;
    }

    // Clear all component-held secret state before handing the value to the
    // write-only store action. The store never retains the value.
    setName("");
    setValue("");
    setDescription("");
    setNameError(null);
    setMultiline(false);
    onClose();
    setSecret(
      trimmedName,
      scope,
      value,
      description.trim() ? description.trim() : undefined
    );
  };

  const valueLabel = multiline ? "Secret value (multi-line)" : "Secret value";

  return (
    <Modal
      isOpen
      onClose={onClose}
      title={isReplace ? `Replace ${dialog.name}` : "Set secret"}
      size="md"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            onClick={handleSubmit}
            disabled={!name.trim() || !value}
          >
            {isReplace ? "Replace" : "Set value"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div>
          <label
            htmlFor="secret-name"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            Name
          </label>
          <input
            id="secret-name"
            type="text"
            value={name}
            disabled={isReplace}
            onChange={(event) => {
              setName(event.target.value);
              setNameError(null);
            }}
            onBlur={() => setNameError(validateName(name.trim()))}
            aria-invalid={nameError ? "true" : undefined}
            aria-describedby={nameError ? "secret-name-error" : undefined}
            className="w-full rounded border border-input-border bg-input-bg px-2 py-1.5 font-mono text-sm text-input-fg focus:border-focus-border focus:outline-none disabled:opacity-60"
          />
          {nameError && (
            <p
              id="secret-name-error"
              role="alert"
              className="mt-1 text-xs text-error-fg"
            >
              {nameError}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="secret-value"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            {valueLabel}
          </label>
          {multiline ? (
            <textarea
              ref={setValueInputRef}
              id="secret-value"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              autoComplete="new-password"
              rows={6}
              style={{ WebkitTextSecurity: "disc" } as CSSProperties}
              className="w-full resize-y rounded border border-input-border bg-input-bg px-2 py-1.5 font-mono text-sm text-input-fg focus:border-focus-border focus:outline-none"
            />
          ) : (
            <input
              ref={setValueInputRef}
              id="secret-value"
              type="password"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                if (event.target.value.includes("\n")) setMultiline(true);
              }}
              autoComplete="new-password"
              className="w-full rounded border border-input-border bg-input-bg px-2 py-1.5 font-mono text-sm text-input-fg focus:border-focus-border focus:outline-none"
            />
          )}
          <label className="mt-2 flex items-center gap-2 text-xs text-description-fg">
            <input
              type="checkbox"
              checked={multiline}
              onChange={(event) => setMultiline(event.target.checked)}
            />
            Multi-line value (for example, a PEM private key)
          </label>
        </div>

        <div>
          <label
            htmlFor="secret-scope"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            Scope
          </label>
          <CustomSelect
            id="secret-scope"
            value={scope}
            onChange={(nextScope) => setScope(nextScope as SettingWriteScope)}
            options={SCOPE_OPTIONS}
            triggerAriaLabel="Secret scope"
          />
        </div>

        <div>
          <label
            htmlFor="secret-description"
            className="mb-1 block text-sm font-medium text-foreground"
          >
            Description{" "}
            <span className="font-normal text-description-fg">(optional)</span>
          </label>
          <input
            id="secret-description"
            type="text"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className="w-full rounded border border-input-border bg-input-bg px-2 py-1.5 text-sm text-input-fg focus:border-focus-border focus:outline-none"
          />
        </div>
      </div>
    </Modal>
  );
}

export function SecretsSection({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: SecretsSectionProps) {
  const sources = settings.sources as Record<string, SettingSource>;
  const entries = useSecretRegistryStore(
    (state) => state.entriesByScope[activeScope]
  );
  const loading = useSecretRegistryStore(
    (state) => state.loadingByScope[activeScope]
  );
  const lastAction = useSecretRegistryStore((state) => state.lastAction);
  const requestEntries = useSecretRegistryStore(
    (state) => state.requestEntries
  );
  const deleteSecret = useSecretRegistryStore((state) => state.deleteSecret);
  const [dialog, setDialog] = useState<SecretDialogState | null>(null);
  const lastRefreshedAction = useRef<typeof lastAction>(null);

  useEffect(() => {
    requestEntries(activeScope);
  }, [activeScope, requestEntries]);

  useEffect(() => {
    if (
      lastAction &&
      lastAction !== lastRefreshedAction.current &&
      lastAction.scope === activeScope
    ) {
      lastRefreshedAction.current = lastAction;
      requestEntries(activeScope);
    }
  }, [activeScope, lastAction, requestEntries]);

  const openSetDialog = (name = "") => setDialog({ mode: "set", name });
  const openReplaceDialog = (name: string) =>
    setDialog({ mode: "replace", name });

  return (
    <>
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-description-fg">
              Secrets
            </h3>
            <p className="mt-1 text-xs text-description-fg">
              Secrets let a workflow reference a credential by name instead of
              embedding it. Reference one inline in a prompt with{" "}
              <code className="text-foreground">!NAME</code> (for example{" "}
              <code className="text-foreground">!SUPABASE_PAT</code>), or grant
              it to a step explicitly with a{" "}
              <code className="text-foreground">secrets:</code> list — either
              way the harness is told only the name, never the value, alongside
              a short instruction on how to read it from its own environment.
            </p>
            <p className="mt-2 text-xs text-description-fg">
              Two entry kinds share that same reference. If a name is already
              exported in your shell, ctrlyoke reads it there and stores nothing
              — the common case. If it isn&apos;t, you can set a managed value
              below; ctrlyoke encrypts it in OS-backed storage and injects it as
              an environment variable into the harness&apos;s child process, and
              only for a step that actually grants that name.
            </p>
            <p className="mt-2 text-xs text-description-fg">
              Granted names can be used in prompts, MCP server env and headers,
              and hook or script commands. Values are resolved only when the
              process spawns and are redacted from logs, run history, previews,
              and exports — this tab itself only ever shows names, state,
              metadata, and usage, never secret contents.
            </p>
          </div>
          <Button
            type="button"
            variant="primary"
            size="sm"
            className="shrink-0 whitespace-nowrap"
            onClick={() => openSetDialog()}
          >
            <Icon name="add" className="mr-1" />
            Set secret
          </Button>
        </div>

        {loading && entries.length === 0 ? (
          <p className="text-sm text-description-fg">Loading secrets…</p>
        ) : entries.length === 0 ? (
          <p className="rounded border border-panel-border px-3 py-4 text-sm text-description-fg">
            No managed or declared secrets found for this scope.
          </p>
        ) : (
          <div className="space-y-2">
            <div className="hidden gap-3 px-3 text-xxs font-semibold uppercase tracking-wide text-description-fg md:grid md:grid-cols-[minmax(10rem,1fr)_minmax(12rem,1fr)_minmax(11rem,1.2fr)_auto]">
              <span>Name</span>
              <span>State</span>
              <span>Used by</span>
              <span>Actions</span>
            </div>
            {entries.map((entry) => (
              <SecretRow
                key={`${entry.scope}:${entry.name}`}
                entry={entry}
                onReplace={openReplaceDialog}
                onSet={openSetDialog}
                onDelete={(name) => deleteSecret(name, activeScope)}
              />
            ))}
          </div>
        )}

        <div className="border-t border-panel-border pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-description-fg mb-3">
            Secret Redaction
          </h3>
          <SettingToggleRow
            label="Heuristic secret redaction"
            description="The exact values of the secrets listed above are always redacted from logs, transports, exports, and history — this cannot be turned off. This setting adds broader pattern-based redaction (e.g. token=..., Bearer ..., private-key blocks) that also catches credentials ctrlyoke was never told about. Turn it off if those patterns are over-matching and corrupting legitimate output, such as code samples or public identifiers that merely look like credentials."
            checked={
              settings.settings.permissions.heuristicSecretRedactionEnabled
            }
            onChange={(v) =>
              onUpdate("permissions.heuristicSecretRedactionEnabled", v)
            }
            path="permissions.heuristicSecretRedactionEnabled"
            sources={sources}
            onReset={onReset}
            activeScope={activeScope}
          />
        </div>
      </div>
      <SecretDialog
        dialog={dialog}
        activeScope={activeScope}
        onClose={() => setDialog(null)}
      />
    </>
  );
}
