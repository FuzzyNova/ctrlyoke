import { KEYBOARD_KEYS } from "@root/types/DashboardConstants";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  FocusEvent,
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent,
} from "react";
import { DndContext, closestCenter, type DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  horizontalListSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type {
  TerminalMobileBarLayout,
  TerminalShortcut,
} from "@root/types/CtrlYokeSettings";
import type {
  FullGlobalSettings,
  SettingSource,
  SettingWriteScope,
} from "@root/types/WebviewMessageTypes";
import {
  DEFAULT_TERMINAL_BAR_LAYOUT,
  TERMINAL_BAR_CTRL_ID,
  TERMINAL_BAR_ITEM_REGISTRY,
  reconcileTerminalBarLayout,
} from "@root/utils/TerminalControlBarFormat";
import { generateId } from "@utils/string";
import { DRAG_HANDLE_TOUCH_ACTION_STYLE } from "@utils/dndKit";
import { useSortableDndSensors } from "@hooks/useSortableDndSensors";
import { Button } from "../shared/Button";
import { LocalTextInput } from "../shared/LocalInputs";
import { SettingInputRow } from "../shared/SettingInputRow";
import { Icon } from "../shared/Icon";

const CUSTOM_SHORTCUTS_PATH = "terminal.mobileCustomShortcuts";
const BAR_LAYOUT_PATH = "terminal.mobileBarLayout";

interface Props {
  settings: FullGlobalSettings;
  activeScope: SettingWriteScope;
  onUpdate: (path: string, value: unknown) => void;
  onReset: (path: string) => void;
}

type LegacyTerminalShortcut = Omit<TerminalShortcut, "id"> & {
  id?: string;
};

type EditorItem = {
  id: string;
  label: string;
  glyph?: string;
  isCtrl: boolean;
};

const EMPTY_LAYOUT: TerminalMobileBarLayout = {
  bar: [],
  popup: [],
  hidden: [],
};

function normalizeShortcuts(
  shortcuts: readonly LegacyTerminalShortcut[]
): TerminalShortcut[] {
  const usedIds = new Set<string>();
  return shortcuts.map((shortcut) => {
    const existingId = shortcut.id?.trim();
    const id =
      existingId && !usedIds.has(existingId) ? existingId : generateId();
    usedIds.add(id);
    return { ...shortcut, id };
  });
}

function layoutsEqual(
  left: TerminalMobileBarLayout,
  right: TerminalMobileBarLayout
): boolean {
  return (["bar", "popup", "hidden"] as const).every(
    (key) =>
      left[key].length === right[key].length &&
      left[key].every((id, index) => id === right[key][index])
  );
}

function moveTo(
  layout: TerminalMobileBarLayout,
  id: string,
  target: keyof TerminalMobileBarLayout
): TerminalMobileBarLayout {
  const next: TerminalMobileBarLayout = {
    bar: layout.bar.filter((itemId) => itemId !== id),
    popup: layout.popup.filter((itemId) => itemId !== id),
    hidden: layout.hidden.filter((itemId) => itemId !== id),
  };
  next[target].push(id);
  return next;
}

function resolveEditorItem(
  id: string,
  customShortcuts: readonly TerminalShortcut[]
): EditorItem | null {
  if (id === TERMINAL_BAR_CTRL_ID) {
    return { id, label: "Ctrl", isCtrl: true };
  }

  const registryItem =
    TERMINAL_BAR_ITEM_REGISTRY[id as keyof typeof TERMINAL_BAR_ITEM_REGISTRY];
  if (registryItem) {
    return {
      id,
      label: registryItem.label,
      glyph: "glyph" in registryItem ? registryItem.glyph : undefined,
      isCtrl: false,
    };
  }

  const customShortcut = customShortcuts.find((shortcut) => shortcut.id === id);
  if (!customShortcut) return null;

  return {
    id,
    label: customShortcut.label.trim() || "Unnamed shortcut",
    isCtrl: false,
  };
}

function updateShortcut(
  shortcuts: readonly TerminalShortcut[],
  id: string,
  patch: Partial<TerminalShortcut>
): TerminalShortcut[] {
  return shortcuts.map((shortcut) =>
    shortcut.id === id ? { ...shortcut, ...patch } : shortcut
  );
}

// xterm modifier number: shift=1, alt=2, ctrl=4 → sum + 1
function xtermModNum(e: KeyboardEvent): number {
  return (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0) + 1;
}

// Human labels here ("Ctrl+C" etc.) describe literal PTY control-key byte
// sequences, not app-level shortcuts — terminals never remap these to Cmd on
// macOS, so do not run them through @utils/platform's formatShortcut.
function keyEventToCapture(
  e: KeyboardEvent
): { sequence: string; humanLabel: string } | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;

  const ctrl = e.ctrlKey;
  const alt = e.altKey;
  const shift = e.shiftKey;

  const modParts: string[] = [];
  if (ctrl) modParts.push("Ctrl");
  if (alt) modParts.push("Alt");
  if (shift) modParts.push("Shift");

  const label = (...extra: string[]) =>
    [...modParts, ...extra].join("+") || extra.join("+");

  const ARROWS: Record<string, [string, string]> = {
    ArrowUp: ["A", "↑"],
    ArrowDown: ["B", "↓"],
    ArrowRight: ["C", "→"],
    ArrowLeft: ["D", "←"],
  };
  if (e.key in ARROWS) {
    const [code, glyph] = ARROWS[e.key];
    const mod = xtermModNum(e);
    const sequence = mod > 1 ? `\\x1b[1;${mod}${code}` : `\\x1b[${code}`;
    return { sequence, humanLabel: label(glyph) };
  }

  if (e.key === KEYBOARD_KEYS.ESCAPE && !ctrl && !alt && !shift)
    return { sequence: "\\x1b", humanLabel: "Esc" };
  if (e.key === KEYBOARD_KEYS.TAB && !ctrl && !alt)
    return shift
      ? { sequence: "\\x1b[Z", humanLabel: "Shift+Tab" }
      : { sequence: "\\t", humanLabel: "Tab" };
  if (e.key === KEYBOARD_KEYS.ENTER && !ctrl && !alt && !shift)
    return { sequence: "\\r", humanLabel: "Enter" };
  if (e.key === "Backspace" && !ctrl && !alt && !shift)
    return { sequence: "\\x7f", humanLabel: "Backspace" };
  if (e.key === "Delete") {
    const mod = xtermModNum(e);
    return {
      sequence: mod > 1 ? `\\x1b[3;${mod}~` : "\\x1b[3~",
      humanLabel: label("Del"),
    };
  }
  if (e.key === "Insert")
    return { sequence: "\\x1b[2~", humanLabel: label("Ins") };
  if (e.key === "Home")
    return { sequence: "\\x1b[H", humanLabel: label("Home") };
  if (e.key === "End") return { sequence: "\\x1b[F", humanLabel: label("End") };
  if (e.key === "PageUp")
    return { sequence: "\\x1b[5~", humanLabel: label("PgUp") };
  if (e.key === "PageDown")
    return { sequence: "\\x1b[6~", humanLabel: label("PgDn") };

  if (e.key.length === 1) {
    const upper = e.key.toUpperCase();
    const charCode = upper.charCodeAt(0) - 64;

    if (ctrl && alt && charCode >= 1 && charCode <= 26) {
      return {
        sequence: `\\x1b\\x${charCode.toString(16).padStart(2, "0")}`,
        humanLabel: `Ctrl+Alt+${upper}`,
      };
    }
    if (ctrl && !alt && charCode >= 1 && charCode <= 26) {
      return {
        sequence: `\\x${charCode.toString(16).padStart(2, "0")}`,
        humanLabel: `Ctrl+${upper}`,
      };
    }
    if (alt && !ctrl) {
      return { sequence: `\\x1b${e.key}`, humanLabel: `Alt+${upper}` };
    }
    if (!ctrl && !alt) {
      return { sequence: e.key, humanLabel: e.key };
    }
  }

  return null;
}

function sequenceToHumanLabel(sequence: string): string | null {
  if (!sequence) return null;
  if (sequence === "\\t") return "Tab";
  if (sequence === "\\r") return "Enter";
  if (sequence === "\\x1b") return "Esc";
  if (sequence === "\\x7f") return "Backspace";
  if (sequence === "\\x1b[3~") return "Del";
  if (sequence === "\\x1b[2~") return "Ins";
  if (sequence === "\\x1b[H") return "Home";
  if (sequence === "\\x1b[F") return "End";
  if (sequence === "\\x1b[5~") return "PgUp";
  if (sequence === "\\x1b[6~") return "PgDn";
  if (sequence === "\\x1b[Z") return "Shift+Tab";

  const ctrlMatch = sequence.match(/^\\x([01][0-9a-fA-F])$/);
  if (ctrlMatch) {
    const code = Number.parseInt(ctrlMatch[1], 16);
    if (code >= 1 && code <= 26)
      return `Ctrl+${String.fromCharCode(code + 64)}`;
  }

  const ctrlAlt = sequence.match(/^\\x1b\\x([01][0-9a-fA-F])$/);
  if (ctrlAlt) {
    const code = Number.parseInt(ctrlAlt[1], 16);
    if (code >= 1 && code <= 26)
      return `Ctrl+Alt+${String.fromCharCode(code + 64)}`;
  }

  const ARROW_GLYPHS: Record<string, string> = {
    A: "↑",
    B: "↓",
    C: "→",
    D: "←",
  };
  const arrow = sequence.match(/^\\x1b\[([ABCD])$/);
  if (arrow) return ARROW_GLYPHS[arrow[1]] ?? null;

  const arrowMod = sequence.match(/^\\x1b\[1;(\d+)([ABCD])$/);
  if (arrowMod) {
    const mod = Number.parseInt(arrowMod[1]) - 1;
    const glyph = ARROW_GLYPHS[arrowMod[2]];
    if (glyph) {
      const parts: string[] = [];
      if (mod & 4) parts.push("Ctrl");
      if (mod & 2) parts.push("Alt");
      if (mod & 1) parts.push("Shift");
      parts.push(glyph);
      return parts.join("+");
    }
  }

  const delMod = sequence.match(/^\\x1b\[3;(\d+)~$/);
  if (delMod) {
    const mod = Number.parseInt(delMod[1]) - 1;
    const parts: string[] = [];
    if (mod & 4) parts.push("Ctrl");
    if (mod & 2) parts.push("Alt");
    if (mod & 1) parts.push("Shift");
    parts.push("Del");
    return parts.join("+");
  }

  const altChar = sequence.match(/^\\x1b([!-~])$/);
  if (altChar) return `Alt+${altChar[1].toUpperCase()}`;

  return null;
}

function KeyCaptureInput({
  sequence,
  ariaLabel,
  onSequenceChange,
  onCapture,
}: {
  sequence: string;
  ariaLabel?: string;
  onSequenceChange: (sequence: string) => void;
  onCapture: (sequence: string, humanLabel: string) => void;
}) {
  const [capturing, setCapturing] = useState(false);
  const [editing, setEditing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const captureButtonRef = useRef<HTMLButtonElement>(null);
  const humanLabel = sequenceToHumanLabel(sequence);

  const startCapture = (event: MouseEvent) => {
    event.stopPropagation();
    if (capturing) {
      setCapturing(false);
      return;
    }
    setEditing(false);
    setCapturing(true);
    setTimeout(() => captureButtonRef.current?.focus(), 0);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!capturing) return;
    if (event.key === KEYBOARD_KEYS.ESCAPE) {
      setCapturing(false);
      return;
    }
    event.preventDefault();
    const result = keyEventToCapture(event.nativeEvent);
    if (result) {
      onCapture(result.sequence, result.humanLabel);
      setCapturing(false);
    }
  };

  const handleBlur = (event: FocusEvent<HTMLButtonElement>) => {
    if (!containerRef.current?.contains(event.relatedTarget as Node)) {
      setCapturing(false);
    }
  };

  if (editing) {
    return (
      <LocalTextInput
        autoFocus
        value={sequence}
        placeholder="\\x1b[1;5A"
        aria-label={ariaLabel}
        title="Literal escape notation: \\x1b[A, \\t, \\r"
        onCommit={(next) => {
          if (next !== sequence) onSequenceChange(next);
          setEditing(false);
        }}
        className="min-w-0 flex-1 bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground font-mono focus:outline-hidden focus:border-focus-border"
      />
    );
  }

  return (
    <div ref={containerRef} className="min-w-0 flex-1">
      <div
        className={`flex items-center gap-1 bg-input-bg border rounded-sm px-2 py-1 text-sm h-[30px] ${
          capturing ? "border-focus-border" : "border-input-border"
        }`}
      >
        <button
          ref={captureButtonRef}
          type="button"
          aria-label={ariaLabel}
          onKeyDown={handleKeyDown}
          onBlur={handleBlur}
          onClick={() => {
            if (!capturing) setEditing(true);
          }}
          title={humanLabel && sequence ? `Sequence: ${sequence}` : undefined}
          className={`flex-1 min-w-0 truncate text-left focus:outline-hidden ${
            capturing
              ? "text-description-fg italic text-xs"
              : sequence
                ? humanLabel
                  ? "text-foreground"
                  : "text-description-fg font-mono text-xs"
                : "text-input-placeholder italic text-xs"
          }`}
        >
          {capturing
            ? "Press a key combination…"
            : sequence
              ? (humanLabel ?? sequence)
              : "\\x1b[1;5A"}
        </button>
        <button
          type="button"
          className={`icon-btn w-5 h-5 shrink-0 p-0 ${capturing ? "text-focus-border" : ""}`}
          title={
            capturing
              ? "Press Esc to cancel"
              : "Click then press a key combination to capture"
          }
          aria-label="Capture key combination"
          onClick={startCapture}
        >
          <Icon name="keyboard" className="codicon-sm" />
        </button>
      </div>
    </div>
  );
}

function SortableBarChip({
  item,
  index,
  onDemote,
  onHide,
}: {
  item: EditorItem;
  index: number;
  onDemote: () => void;
  onHide: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });
  const style = {
    transform: transform ? `translate3d(${transform.x}px, 0, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex w-20 shrink-0 flex-col items-center gap-1 rounded-sm border border-input-border bg-input-bg px-1.5 py-1"
    >
      <button
        type="button"
        className="cursor-grab text-description-fg hover:text-foreground active:cursor-grabbing"
        style={DRAG_HANDLE_TOUCH_ACTION_STYLE}
        {...listeners}
        {...attributes}
        aria-label={`Drag to reorder ${item.label}, position ${index + 1}`}
      >
        <Icon name="grabber" className="text-xs" />
      </button>
      <span
        className="truncate text-center text-xs text-foreground"
        title={item.label}
      >
        {item.glyph ?? item.label}
      </span>
      <button
        type="button"
        className="icon-btn h-5 w-5 p-0 text-description-fg hover:text-foreground"
        onClick={item.isCtrl ? onHide : onDemote}
        title={
          item.isCtrl
            ? "Modifier key — must be in the bar to be shown; hide it here instead of moving it to the shortcut list."
            : "Move to shortcut list"
        }
        aria-label={
          item.isCtrl
            ? "Hide Ctrl modifier"
            : `Move ${item.label} to shortcut list`
        }
      >
        <Icon name={item.isCtrl ? "eye-closed" : "arrow-down"} />
      </button>
    </div>
  );
}

function SortablePopupRow({
  item,
  shortcut,
  index,
  onPromote,
  onHide,
  onDelete,
  onUpdateShortcut,
}: {
  item: EditorItem;
  shortcut?: TerminalShortcut;
  index: number;
  onPromote: () => void;
  onHide: () => void;
  onDelete: () => void;
  onUpdateShortcut: (patch: Partial<TerminalShortcut>) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: item.id });
  const style = {
    transform: transform ? `translate3d(0, ${transform.y}px, 0)` : undefined,
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2 rounded-sm border border-input-border bg-input-bg px-2 py-1"
    >
      <button
        type="button"
        className="shrink-0 cursor-grab text-description-fg hover:text-foreground active:cursor-grabbing"
        style={DRAG_HANDLE_TOUCH_ACTION_STYLE}
        {...listeners}
        {...attributes}
        aria-label={`Drag to reorder ${item.label}, position ${index + 1}`}
      >
        <Icon name="grabber" className="text-xs" />
      </button>
      <span className="w-5 shrink-0 text-center text-xs text-description-fg">
        {index + 1}
      </span>
      {shortcut ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <LocalTextInput
            value={shortcut.label}
            placeholder="Label"
            aria-label={`Shortcut ${index + 1} label`}
            onCommit={(label) => onUpdateShortcut({ label })}
            className="min-w-0 flex-1 bg-input-bg border border-input-border rounded-sm px-2 py-1 text-sm text-foreground focus:outline-hidden focus:border-focus-border"
          />
          <KeyCaptureInput
            sequence={shortcut.sequence}
            ariaLabel={`Shortcut ${index + 1} sequence`}
            onSequenceChange={(sequence) => onUpdateShortcut({ sequence })}
            onCapture={(sequence, humanLabel) =>
              onUpdateShortcut({
                sequence,
                ...(shortcut.label === "" ? { label: humanLabel } : {}),
              })
            }
          />
        </div>
      ) : (
        <span
          className="min-w-0 flex-1 truncate text-sm text-foreground"
          title={item.label}
        >
          {item.glyph ? `${item.glyph} ${item.label}` : item.label}
        </span>
      )}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className="icon-btn h-6 w-6 p-0"
          title="Move to control bar"
          aria-label={`Move ${item.label} to control bar`}
          onClick={onPromote}
        >
          <Icon name="arrow-up" />
        </button>
        <button
          type="button"
          className="icon-btn h-6 w-6 p-0"
          title="Hide shortcut"
          aria-label={`Hide ${item.label}`}
          onClick={onHide}
        >
          <Icon name="eye-closed" />
        </button>
        {shortcut && (
          <button
            type="button"
            className="icon-btn h-6 w-6 p-0 text-error-fg hover:text-error-fg"
            title="Delete shortcut permanently"
            aria-label={`Delete ${item.label}`}
            onClick={onDelete}
          >
            <Icon name="trash" />
          </button>
        )}
      </div>
    </div>
  );
}

export function TerminalControlBarEditor({
  settings,
  activeScope,
  onUpdate,
  onReset,
}: Props) {
  const terminal = settings.settings.terminal;
  const sources = settings.sources as Record<string, SettingSource>;
  const rawShortcuts =
    terminal.mobileCustomShortcuts as LegacyTerminalShortcut[];
  const customShortcuts = useMemo(
    () => normalizeShortcuts(rawShortcuts),
    [rawShortcuts]
  );
  const customIds = useMemo(
    () => customShortcuts.map((shortcut) => shortcut.id),
    [customShortcuts]
  );
  const needsIdBackfill = customShortcuts.some(
    (shortcut, index) => shortcut.id !== rawShortcuts[index]?.id
  );

  useEffect(() => {
    if (needsIdBackfill) {
      onUpdate(CUSTOM_SHORTCUTS_PATH, customShortcuts);
    }
  }, [customShortcuts, needsIdBackfill, onUpdate]);

  const incomingLayout = terminal.mobileBarLayout ?? EMPTY_LAYOUT;
  const reconciledLayout = useMemo(
    () => reconcileTerminalBarLayout(incomingLayout, customIds),
    [customIds, incomingLayout]
  );
  const [draftLayout, setDraftLayout] = useState(reconciledLayout);
  const pendingLayoutRef = useRef<TerminalMobileBarLayout | null>(null);

  useEffect(() => {
    if (pendingLayoutRef.current) {
      if (layoutsEqual(pendingLayoutRef.current, reconciledLayout)) {
        pendingLayoutRef.current = null;
      }
      return;
    }
    setDraftLayout(reconciledLayout);
  }, [reconciledLayout]);

  const commitLayout = (nextLayout: TerminalMobileBarLayout) => {
    pendingLayoutRef.current = nextLayout;
    setDraftLayout(nextLayout);
    onUpdate(BAR_LAYOUT_PATH, nextLayout);
  };

  const sensors = useSortableDndSensors();

  const customShortcutsById = useMemo(
    () => new Map(customShortcuts.map((shortcut) => [shortcut.id, shortcut])),
    [customShortcuts]
  );
  const barItems = draftLayout.bar
    .map((id) => resolveEditorItem(id, customShortcuts))
    .filter((item): item is EditorItem => item !== null);
  const popupItems = draftLayout.popup
    .map((id) => resolveEditorItem(id, customShortcuts))
    .filter((item): item is EditorItem => item !== null);
  const hiddenItems = draftLayout.hidden
    .map((id) => resolveEditorItem(id, customShortcuts))
    .filter((item): item is EditorItem => item !== null);

  const handleBarDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const oldIndex = draftLayout.bar.indexOf(String(event.active.id));
    const newIndex = draftLayout.bar.indexOf(String(event.over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    commitLayout({
      ...draftLayout,
      bar: arrayMove(draftLayout.bar, oldIndex, newIndex),
    });
  };

  const handlePopupDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const oldIndex = draftLayout.popup.indexOf(String(event.active.id));
    const newIndex = draftLayout.popup.indexOf(String(event.over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    commitLayout({
      ...draftLayout,
      popup: arrayMove(draftLayout.popup, oldIndex, newIndex),
    });
  };

  const updateCustomShortcut = (
    id: string,
    patch: Partial<TerminalShortcut>
  ) => {
    onUpdate(CUSTOM_SHORTCUTS_PATH, updateShortcut(customShortcuts, id, patch));
  };

  const deleteCustomShortcut = (id: string) => {
    onUpdate(
      CUSTOM_SHORTCUTS_PATH,
      customShortcuts.filter((shortcut) => shortcut.id !== id)
    );
    commitLayout({
      bar: draftLayout.bar.filter((itemId) => itemId !== id),
      popup: draftLayout.popup.filter((itemId) => itemId !== id),
      hidden: draftLayout.hidden.filter((itemId) => itemId !== id),
    });
  };

  const resetBuiltInLayout = () => {
    const customIdSet = new Set(customIds);
    const isCustomId = (id: string) => customIdSet.has(id);
    commitLayout({
      bar: DEFAULT_TERMINAL_BAR_LAYOUT.bar.filter((id) => !isCustomId(id)),
      popup: [
        ...DEFAULT_TERMINAL_BAR_LAYOUT.popup.filter((id) => !isCustomId(id)),
        ...customIds,
      ],
      hidden: DEFAULT_TERMINAL_BAR_LAYOUT.hidden.filter(
        (id) => !isCustomId(id)
      ),
    });
  };

  const addShortcut = () => {
    const id = generateId();
    onUpdate(CUSTOM_SHORTCUTS_PATH, [
      ...customShortcuts,
      { id, label: "", sequence: "" },
    ]);
    commitLayout(moveTo(draftLayout, id, "popup"));
  };

  return (
    <SettingInputRow
      settingKey="terminal.mobileCustomShortcuts"
      sources={sources}
      onReset={onReset}
      activeScope={activeScope}
    >
      <section
        className="space-y-3 rounded-sm border border-panel-border bg-panel-bg p-2"
        aria-label="Mobile control bar layout"
      >
        <div>
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-description-fg">
              Control bar items
            </h4>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={resetBuiltInLayout}
            >
              Reset to default
            </Button>
          </div>
          <p className="mt-1 text-xs text-description-fg">
            Drag items to arrange the bar and the More menu. Move items between
            lists to choose where they appear.
          </p>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleBarDragEnd}
        >
          <SortableContext
            items={barItems.map((item) => item.id)}
            strategy={horizontalListSortingStrategy}
          >
            <div
              className="flex min-h-[92px] gap-1 overflow-x-auto pb-1"
              aria-label="Control bar items"
            >
              {barItems.map((item, index) => (
                <SortableBarChip
                  key={item.id}
                  item={item}
                  index={index}
                  onDemote={() =>
                    commitLayout(moveTo(draftLayout, item.id, "popup"))
                  }
                  onHide={() =>
                    commitLayout(moveTo(draftLayout, item.id, "hidden"))
                  }
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>

        <div className="border-t border-panel-border pt-2">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-description-fg">
            Shortcut list
          </h4>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={handlePopupDragEnd}
          >
            <SortableContext
              items={popupItems.map((item) => item.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="space-y-1" aria-label="Shortcut list items">
                {popupItems.map((item, index) => (
                  <SortablePopupRow
                    key={item.id}
                    item={item}
                    index={index}
                    shortcut={customShortcutsById.get(item.id)}
                    onPromote={() =>
                      commitLayout(moveTo(draftLayout, item.id, "bar"))
                    }
                    onHide={() =>
                      commitLayout(moveTo(draftLayout, item.id, "hidden"))
                    }
                    onDelete={() => deleteCustomShortcut(item.id)}
                    onUpdateShortcut={(patch) =>
                      updateCustomShortcut(item.id, patch)
                    }
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
          {popupItems.length === 0 && (
            <p className="text-xs text-description-fg">
              No shortcuts in the list.
            </p>
          )}
        </div>

        <div className="border-t border-panel-border pt-2">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-description-fg">
            Hidden items
          </h4>
          <div className="space-y-1" aria-label="Hidden control bar items">
            {hiddenItems.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between gap-2 rounded-sm border border-panel-border bg-list-hover-bg px-2 py-1 text-description-fg opacity-70"
              >
                <span className="truncate text-sm" title={item.label}>
                  {item.glyph ? `${item.glyph} ${item.label}` : item.label}
                </span>
                <button
                  type="button"
                  className="icon-btn h-6 w-6 shrink-0 p-0"
                  title={
                    item.isCtrl
                      ? "Restore Ctrl to the control bar"
                      : "Restore to shortcut list"
                  }
                  aria-label={
                    item.isCtrl
                      ? "Restore Ctrl to the control bar"
                      : `Restore ${item.label}`
                  }
                  onClick={() =>
                    commitLayout(
                      moveTo(
                        draftLayout,
                        item.id,
                        item.isCtrl ? "bar" : "popup"
                      )
                    )
                  }
                >
                  <Icon name="eye" />
                </button>
              </div>
            ))}
          </div>
          {hiddenItems.length === 0 && (
            <p className="text-xs text-description-fg">No hidden items.</p>
          )}
        </div>

        <div className="border-t border-panel-border pt-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-description-fg">
              Add a custom shortcut for an escape sequence.
            </p>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={addShortcut}
            >
              + Add shortcut
            </Button>
          </div>
          <p className="mt-2 text-xs text-description-fg">
            Click the keyboard icon then press a key combination to capture it.
            Click the sequence display to edit the raw escape notation manually
            (e.g. \\x1b[A, \\t, \\r).
          </p>
        </div>
      </section>
    </SettingInputRow>
  );
}
