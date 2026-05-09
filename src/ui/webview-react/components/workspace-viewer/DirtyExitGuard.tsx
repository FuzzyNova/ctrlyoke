import { useState, useEffect } from "react";

interface DirtyExitGuardProps {
  isOpen: boolean;
  filePath: string;
  onSave: () => Promise<void>;
  onDiscard: () => void;
  onCancel: () => void;
}

/**
 * In-app modal dialog shown when the user tries to navigate away from an
 * unsaved file. Offers Save, Discard, and Cancel actions.
 */
export function DirtyExitGuard({
  isOpen,
  filePath,
  onSave,
  onDiscard,
  onCancel,
}: DirtyExitGuardProps) {
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (isOpen) setSaving(false);
  }, [isOpen]);

  if (!isOpen) return null;

  const fileName = filePath.split("/").pop() ?? filePath;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="absolute inset-0 bg-black/50 z-10 flex items-center justify-center">
      <div className="bg-panel-bg border border-panel-border rounded-lg shadow-xl w-80 max-w-[90%] p-5 flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold text-editor-fg">
            Unsaved changes
          </h3>
          <p className="text-xs text-editor-fg opacity-70">
            Do you want to save changes to{" "}
            <span className="font-medium">{fileName}</span>?
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <button
            onClick={handleSave}
            disabled={saving}
            className="w-full py-1.5 px-3 text-sm rounded bg-btn-bg text-btn-fg hover:bg-btn-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? "Saving…" : "Save"}
          </button>
          <button
            onClick={onDiscard}
            disabled={saving}
            className="w-full py-1.5 px-3 text-sm rounded border border-panel-border text-editor-fg hover:bg-list-hover-bg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Discard changes
          </button>
          <button
            onClick={onCancel}
            disabled={saving}
            className="w-full py-1.5 px-3 text-sm rounded text-editor-fg opacity-60 hover:opacity-100 hover:bg-list-hover-bg disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
