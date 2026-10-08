import type { ReactNode } from "react";
import {
  KEYBOARD_KEYS,
  type SettingWriteScope,
} from "@root/types/DashboardConstants";

export function encodeManagerTarget(
  id: string,
  scope: SettingWriteScope
): string {
  return `${id}:${scope}`;
}

export function decodeManagerTarget(encoded: string): {
  id: string;
  scope: SettingWriteScope;
} {
  const colonIndex = encoded.lastIndexOf(":");
  return {
    id: encoded.slice(0, colonIndex),
    scope: encoded.slice(colonIndex + 1) as SettingWriteScope,
  };
}

export function ScopeBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-panel-border bg-list-hover-bg px-1.5 py-0.5 text-xxs font-medium leading-none text-foreground">
      {label}
    </span>
  );
}

export function ManagerConfirmModal({
  title,
  children,
  confirmLabel = "Confirm",
  backdropLabel,
  onConfirm,
  onCancel,
}: {
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  backdropLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-modal flex items-center justify-center bg-black/40"
      role="button"
      tabIndex={0}
      aria-label={backdropLabel ?? `Close ${title}`}
      onKeyDown={(event) => {
        if (
          event.target === event.currentTarget &&
          (event.key === KEYBOARD_KEYS.ENTER ||
            event.key === " " ||
            event.key === KEYBOARD_KEYS.ESCAPE)
        ) {
          event.preventDefault();
          onCancel();
        }
      }}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        className="mx-4 w-full max-w-sm rounded-sm border border-panel-border bg-editor-bg p-4 shadow-lg"
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <p className="mb-2 text-sm font-semibold text-foreground">{title}</p>
        <div className="mb-4 text-xs text-description-fg">{children}</div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-sm border border-btn-border bg-btn-secondary-bg px-3 py-1 text-xs text-btn-secondary-fg hover:bg-btn-secondary-hover"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-sm bg-btn-bg px-3 py-1 text-xs text-btn-fg hover:bg-btn-hover"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
