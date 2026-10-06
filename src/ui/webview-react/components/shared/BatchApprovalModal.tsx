import { useEffect, useState } from "react";
import { useBatchApprovalStore } from "@store/batchApprovalStore";
import { Button } from "./Button";
import { Modal } from "./Modal";

/**
 * Renders whichever UserInteractionPort batch-approval request is currently
 * pending (see src/ui/UserInteractionPort.ts) — a checklist the user reviews
 * once per request, defaulting every item to "approve." Mounted once,
 * globally, in App.tsx.
 */
export function BatchApprovalModal() {
  const request = useBatchApprovalStore((state) => state.requests[0] ?? null);
  const respond = useBatchApprovalStore((state) => state.respond);
  const dismiss = useBatchApprovalStore((state) => state.dismiss);
  const [checkedValues, setCheckedValues] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!request) return;
    setCheckedValues(
      new Set(
        request.items.filter((item) => item.checked).map((item) => item.value)
      )
    );
  }, [request]);

  if (!request) return null;

  const toggle = (value: string) => {
    setCheckedValues((previous) => {
      const next = new Set(previous);
      if (next.has(value)) {
        next.delete(value);
      } else {
        next.add(value);
      }
      return next;
    });
  };

  const handleConfirm = () => {
    const approvedValues = request.items
      .map((item) => item.value)
      .filter((value) => checkedValues.has(value));
    const deniedValues = request.items
      .map((item) => item.value)
      .filter((value) => !checkedValues.has(value));
    respond(approvedValues, deniedValues);
  };

  return (
    <Modal
      isOpen
      onClose={dismiss}
      title={request.title}
      size="sm"
      wrapTitle
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={dismiss}>
            Ask me later
          </Button>
          <Button type="button" variant="primary" onClick={handleConfirm}>
            Confirm
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-description-fg">{request.description}</p>
        <div className="space-y-1.5">
          {request.items.map((item) => (
            <label
              key={item.value}
              className="flex items-center gap-2 rounded-sm border border-panel-border px-2 py-1.5"
            >
              <input
                type="checkbox"
                checked={checkedValues.has(item.value)}
                onChange={() => toggle(item.value)}
                className="h-3.5 w-3.5 shrink-0 accent-focus-border"
              />
              <code className="break-all text-sm text-foreground">
                {item.label}
              </code>
            </label>
          ))}
        </div>
      </div>
    </Modal>
  );
}
