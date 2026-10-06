import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
} from "react";
import {
  COMPATIBILITY_DIAGNOSTIC_SEVERITIES,
  SETTING_SCOPES,
} from "@root/types/DashboardConstants";
import type { KeyValueKeyKind } from "@root/utils/KeyValueKeyKinds";
import { validateKeyValueKey } from "@root/utils/KeyValueKeyKinds";
import { useSecretRegistryStore } from "@store/secretRegistryStore";
import type { FieldDiagnostic as FieldDiagnosticItem } from "@utils/fieldValidation";
import { fieldValidationBorderClass } from "@utils/fieldValidation";
import {
  keyValueMapObjectToString,
  keyValueMapStringToObject,
  looksLikeLiteralCredential,
} from "./KeyValueMapHelpers";
import { FieldDiagnostic } from "./FieldDiagnostic";
import { Button } from "./Button";
import { Icon } from "./Icon";
import { schemaAriaLabel, schemaTitle } from "@utils/schemaPropertyLabels";

export interface KeyValueRowsEditorProps {
  label: string;
  id?: string;
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  /** Selects the key validation vocabulary. */
  keyKind: KeyValueKeyKind;
  /** Column heading and add-button noun, e.g. "variable" or "header". */
  entryNoun?: string;
  ariaLabel?: string;
  schemaPath?: string;
  disabled?: boolean;
  allowSecretReferences?: boolean;
}

interface KeyValueRow {
  id: string;
  key: string;
  value: string;
  pasteParseError?: boolean;
}

interface RowDiagnostics {
  key: FieldDiagnosticItem[];
  value: FieldDiagnosticItem[];
}

const SECRET_REFERENCE_PATTERN = /\$\{secret:([^}]+)\}/g;
let nextRowId = 0;

function createRowId(): string {
  nextRowId += 1;
  return `key-value-row-${nextRowId}`;
}

function rowsFromRecord(value: Record<string, string>): KeyValueRow[] {
  return Object.entries(value).map(([key, entryValue]) => ({
    id: createRowId(),
    key,
    value: entryValue,
  }));
}

function rowsToRecord(rows: readonly KeyValueRow[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of rows) {
    if (row.key.length > 0) result[row.key] = row.value;
  }
  return result;
}

function rowsFromPastedText(text: string, currentRowId: string): KeyValueRow[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);

  return lines.map((line, index) => {
    const parsed = keyValueMapStringToObject(line.trim());
    const parsedEntry = parsed && Object.entries(parsed)[0];
    if (parsedEntry) {
      return {
        id: index === 0 ? currentRowId : createRowId(),
        key: parsedEntry[0],
        value: parsedEntry[1],
      };
    }

    return {
      id: index === 0 ? currentRowId : createRowId(),
      key: line,
      value: "",
      pasteParseError: true,
    };
  });
}

function recordsEqual(
  left: Record<string, string>,
  right: Record<string, string>
): boolean {
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(
      ([key, value], index) =>
        rightEntries[index]?.[0] === key && rightEntries[index]?.[1] === value
    )
  );
}

function getSecretNames(
  entriesByScope: ReturnType<
    typeof useSecretRegistryStore.getState
  >["entriesByScope"]
): string[] {
  return [
    ...new Set([
      ...entriesByScope[SETTING_SCOPES.USER].map((entry) => entry.name),
      ...entriesByScope[SETTING_SCOPES.WORKSPACE].map((entry) => entry.name),
    ]),
  ].sort();
}

function getUnknownSecretDiagnostics(
  value: string,
  knownSecretNames: ReadonlySet<string>
): FieldDiagnosticItem[] {
  const diagnostics: FieldDiagnosticItem[] = [];
  const reportedNames = new Set<string>();

  for (const match of value.matchAll(SECRET_REFERENCE_PATTERN)) {
    const name = match[1];
    if (name && !knownSecretNames.has(name) && !reportedNames.has(name)) {
      reportedNames.add(name);
      diagnostics.push({
        severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        message: `Secret "${name}" is not configured in the secret registry.`,
      });
    }
  }

  return diagnostics;
}

function getRowDiagnostics(
  row: KeyValueRow,
  rows: readonly KeyValueRow[],
  keyKind: KeyValueKeyKind,
  allowSecretReferences: boolean,
  knownSecretNames: ReadonlySet<string>
): RowDiagnostics {
  const keyDiagnostics = validateKeyValueKey(
    keyKind,
    row.key,
    rows.map((candidate) => candidate.key),
    row.value
  );
  if (row.pasteParseError) {
    keyDiagnostics.unshift({
      severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.ERROR,
      message: "Pasted lines must use KEY=value format.",
    });
  }
  const valueDiagnostics: FieldDiagnosticItem[] = [];

  if (allowSecretReferences) {
    if (looksLikeLiteralCredential(row.key, row.value)) {
      valueDiagnostics.push({
        severity: COMPATIBILITY_DIAGNOSTIC_SEVERITIES.WARNING,
        message:
          "This value looks like a pasted credential. Use the secret picker so the value is resolved at run time.",
      });
    }
    valueDiagnostics.push(
      ...getUnknownSecretDiagnostics(row.value, knownSecretNames)
    );
  }

  return { key: keyDiagnostics, value: valueDiagnostics };
}

export function KeyValueRowsEditor({
  label,
  id,
  value,
  onChange,
  keyKind,
  entryNoun = "entry",
  ariaLabel = label,
  schemaPath,
  disabled = false,
  allowSecretReferences = false,
}: KeyValueRowsEditorProps) {
  const [rows, setRows] = useState<KeyValueRow[]>(() => rowsFromRecord(value));
  const rowsRef = useRef(rows);
  const lastCommittedValueRef = useRef<Record<string, string> | null>(null);
  const [isBulkEdit, setIsBulkEdit] = useState(false);
  const [bulkValue, setBulkValue] = useState(() =>
    keyValueMapObjectToString(value)
  );
  const bulkValueRef = useRef(bulkValue);
  const [openPickerRowId, setOpenPickerRowId] = useState<string | null>(null);
  const entriesByScope = useSecretRegistryStore(
    (state) => state.entriesByScope
  );
  const requestSecretEntries = useSecretRegistryStore(
    (state) => state.requestEntries
  );

  rowsRef.current = rows;

  useEffect(() => {
    if (!allowSecretReferences) return;
    requestSecretEntries(SETTING_SCOPES.USER);
    requestSecretEntries(SETTING_SCOPES.WORKSPACE);
  }, [allowSecretReferences, requestSecretEntries]);

  useEffect(() => {
    const currentValue = rowsToRecord(rowsRef.current);
    if (recordsEqual(value, currentValue)) return;

    // A parent commonly echoes the value just emitted while the user has
    // already started another edit. Do not let that echo remount/clobber the
    // still-live rows; a genuinely external value still synchronizes below.
    if (
      lastCommittedValueRef.current &&
      recordsEqual(value, lastCommittedValueRef.current)
    ) {
      return;
    }

    const nextRows = rowsFromRecord(value);
    rowsRef.current = nextRows;
    setRows(nextRows);
    lastCommittedValueRef.current = null;
  }, [value]);

  const secretNames = useMemo(
    () => (allowSecretReferences ? getSecretNames(entriesByScope) : []),
    [allowSecretReferences, entriesByScope]
  );
  const knownSecretNames = useMemo(() => new Set(secretNames), [secretNames]);
  const diagnosticsByRowId = useMemo(() => {
    const diagnostics = new Map<string, RowDiagnostics>();
    for (const row of rows) {
      diagnostics.set(
        row.id,
        getRowDiagnostics(
          row,
          rows,
          keyKind,
          allowSecretReferences,
          knownSecretNames
        )
      );
    }
    return diagnostics;
  }, [allowSecretReferences, keyKind, knownSecretNames, rows]);

  const commitRows = useCallback(
    (nextRows: readonly KeyValueRow[]) => {
      const nextValue = rowsToRecord(nextRows);
      lastCommittedValueRef.current = nextValue;
      onChange(nextValue);
    },
    [onChange]
  );

  const enterBulkEdit = useCallback(() => {
    const nextBulkValue = keyValueMapObjectToString(
      rowsToRecord(rowsRef.current)
    );
    bulkValueRef.current = nextBulkValue;
    setBulkValue(nextBulkValue);
    setOpenPickerRowId(null);
    setIsBulkEdit(true);
  }, []);

  const exitBulkEdit = useCallback(() => {
    const nextRows = rowsFromRecord(
      keyValueMapStringToObject(bulkValueRef.current) ?? {}
    );
    rowsRef.current = nextRows;
    setRows(nextRows);
    setIsBulkEdit(false);
    setOpenPickerRowId(null);
    commitRows(nextRows);
  }, [commitRows]);

  const updateRow = useCallback(
    (rowId: string, field: "key" | "value", nextValue: string) => {
      setRows((currentRows) =>
        currentRows.map((row) =>
          row.id === rowId
            ? { ...row, [field]: nextValue, pasteParseError: false }
            : row
        )
      );
    },
    []
  );

  const addRow = useCallback(() => {
    const nextRows = [
      ...rowsRef.current,
      { id: createRowId(), key: "", value: "" },
    ];
    rowsRef.current = nextRows;
    setRows(nextRows);
    setOpenPickerRowId(null);
    commitRows(nextRows);
  }, [commitRows]);

  const removeRow = useCallback(
    (rowId: string) => {
      const nextRows = rowsRef.current.filter((row) => row.id !== rowId);
      rowsRef.current = nextRows;
      setRows(nextRows);
      setOpenPickerRowId(null);
      commitRows(nextRows);
    },
    [commitRows]
  );

  const selectSecret = useCallback(
    (rowId: string, name: string) => {
      const nextRows = rowsRef.current.map((row) =>
        row.id === rowId ? { ...row, value: `\${secret:${name}}` } : row
      );
      rowsRef.current = nextRows;
      setRows(nextRows);
      setOpenPickerRowId(null);
      commitRows(nextRows);
    },
    [commitRows]
  );

  const handleKeyPaste = useCallback(
    (rowId: string, event: ClipboardEvent<HTMLInputElement>) => {
      const pastedText = event.clipboardData.getData("text");
      if (
        !pastedText ||
        (!pastedText.includes("=") && !pastedText.includes("\n"))
      ) {
        return;
      }

      const currentRows = rowsRef.current;
      const rowIndex = currentRows.findIndex((row) => row.id === rowId);
      if (rowIndex < 0) return;

      const pastedRows = rowsFromPastedText(pastedText, rowId);
      if (pastedRows.length === 0) return;

      event.preventDefault();
      const nextRows = [
        ...currentRows.slice(0, rowIndex),
        ...pastedRows,
        ...currentRows.slice(rowIndex + 1),
      ];
      rowsRef.current = nextRows;
      setRows(nextRows);
    },
    []
  );

  const controlId = id ?? `key-value-rows-${entryNoun}`;
  const labelId = `${controlId}-label`;

  const renderValueCell = (row: KeyValueRow, rowIndex: number) => {
    const rowDiagnostics = diagnosticsByRowId.get(row.id) ?? {
      key: [],
      value: [],
    };
    const valueDiagnosticId = `${row.id}-value-diagnostics`;
    const valueLabel = row.key ? `Value for ${row.key}` : `${entryNoun} value`;

    return (
      <div className="relative col-span-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
        <div className="flex min-w-0 gap-1">
          <input
            type="text"
            value={row.value}
            aria-label={valueLabel}
            aria-invalid={rowDiagnostics.value.length > 0 ? "true" : undefined}
            aria-describedby={
              rowDiagnostics.value.length > 0 ? valueDiagnosticId : undefined
            }
            disabled={disabled}
            onChange={(event) => updateRow(row.id, "value", event.target.value)}
            onBlur={() => commitRows(rowsRef.current)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && rowIndex === rows.length - 1) {
                event.preventDefault();
                addRow();
              }
            }}
            className={`h-7 min-w-0 flex-1 rounded-sm border bg-input-bg px-2 py-1 font-mono text-xs text-input-fg focus:border-focus-border focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60 ${fieldValidationBorderClass(rowDiagnostics.value)}`}
          />
          {allowSecretReferences && (
            <div className="relative shrink-0">
              <button
                type="button"
                aria-label={`Insert secret reference for ${row.key || "empty row"}`}
                title="Insert secret reference"
                disabled={disabled}
                onClick={() =>
                  setOpenPickerRowId((current) =>
                    current === row.id ? null : row.id
                  )
                }
                className="inline-flex h-7 w-7 items-center justify-center rounded-sm border border-input-border bg-input-bg text-description-fg hover:text-foreground focus:border-focus-border focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Icon name="key" />
              </button>
              {openPickerRowId === row.id && (
                <div
                  role="listbox"
                  aria-label={`Secrets for ${row.key || "empty row"}`}
                  className="absolute right-0 z-10 mt-1 flex max-h-48 min-w-48 flex-col overflow-auto rounded-sm border border-panel-border bg-input-bg p-1 shadow-lg"
                >
                  {secretNames.length > 0 ? (
                    secretNames.map((name) => (
                      <button
                        key={name}
                        type="button"
                        role="option"
                        aria-label={`Use secret ${name}`}
                        aria-selected={row.value === `\${secret:${name}}`}
                        onClick={() => selectSecret(row.id, name)}
                        className="rounded-sm px-2 py-1 text-left text-xs text-input-fg hover:bg-list-hover-bg focus:bg-list-hover-bg focus:outline-hidden"
                      >
                        {name} → $&#123;secret:{name}&#125;
                      </button>
                    ))
                  ) : (
                    <span className="px-2 py-1 text-xs text-description-fg">
                      No secrets configured.
                    </span>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <FieldDiagnostic
          id={valueDiagnosticId}
          diagnostics={rowDiagnostics.value}
          className="mt-1"
        />
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-2">
      <label
        id={labelId}
        className="text-xxs text-description-fg"
        title={schemaPath ? schemaTitle(schemaPath) : undefined}
      >
        {label}
      </label>
      <div
        id={controlId}
        role="group"
        aria-labelledby={schemaPath ? undefined : labelId}
        aria-label={schemaPath ? schemaAriaLabel(label, schemaPath) : ariaLabel}
        title={schemaPath ? schemaTitle(schemaPath) : undefined}
        className="flex min-w-0 flex-col gap-2"
      >
        <button
          type="button"
          aria-label={
            isBulkEdit ? "Exit bulk edit mode" : "Enter bulk edit mode"
          }
          aria-pressed={isBulkEdit}
          disabled={disabled}
          onClick={isBulkEdit ? exitBulkEdit : enterBulkEdit}
          className="self-start text-xs text-link-fg underline hover:no-underline focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isBulkEdit ? "Exit bulk edit" : "Bulk edit"}
        </button>
        {isBulkEdit ? (
          <textarea
            aria-label={`${ariaLabel} bulk editor`}
            placeholder="KEY=value\nANOTHER_KEY=value"
            value={bulkValue}
            onChange={(event) => {
              bulkValueRef.current = event.target.value;
              setBulkValue(event.target.value);
            }}
            disabled={disabled}
            rows={Math.max(3, rows.length)}
            className="w-full resize-none rounded-sm border border-input-border bg-input-bg px-2 py-1 font-mono text-xs text-input-fg focus:border-focus-border focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60"
          />
        ) : rows.length === 0 ? (
          <p className="rounded-sm border border-panel-border px-3 py-2 text-xs text-description-fg">
            No {entryNoun}s configured.
          </p>
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            {rows.map((row, rowIndex) => {
              const rowDiagnostics = diagnosticsByRowId.get(row.id) ?? {
                key: [],
                value: [],
              };
              const keyDiagnosticId = `${row.id}-key-diagnostics`;
              const nameLabel = row.key
                ? `Name for ${row.key}`
                : `${entryNoun} name`;

              return (
                <div
                  key={row.id}
                  className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto]"
                >
                  <div className="min-w-0">
                    <input
                      type="text"
                      value={row.key}
                      aria-label={nameLabel}
                      aria-invalid={
                        rowDiagnostics.key.length > 0 ? "true" : undefined
                      }
                      aria-describedby={
                        rowDiagnostics.key.length > 0
                          ? keyDiagnosticId
                          : undefined
                      }
                      disabled={disabled}
                      onChange={(event) =>
                        updateRow(row.id, "key", event.target.value)
                      }
                      onPaste={(event) => handleKeyPaste(row.id, event)}
                      onBlur={() => commitRows(rowsRef.current)}
                      className={`h-7 w-full min-w-0 rounded-sm border bg-input-bg px-2 py-1 font-mono text-xs text-input-fg focus:border-focus-border focus:outline-hidden disabled:cursor-not-allowed disabled:opacity-60 ${fieldValidationBorderClass(rowDiagnostics.key)}`}
                    />
                    <FieldDiagnostic
                      id={keyDiagnosticId}
                      diagnostics={rowDiagnostics.key}
                      className="mt-1"
                    />
                  </div>
                  {renderValueCell(row, rowIndex)}
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={disabled}
                    onClick={() => removeRow(row.id)}
                    aria-label={`Delete ${row.key || "empty row"}`}
                    title="Delete row"
                    className="col-start-2 row-start-1 h-7 shrink-0 px-1.5 sm:col-start-3 sm:row-start-1"
                  >
                    <Icon name="trash" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={addRow}
          className="self-start"
        >
          + Add {entryNoun}
        </Button>
      </div>
    </div>
  );
}
