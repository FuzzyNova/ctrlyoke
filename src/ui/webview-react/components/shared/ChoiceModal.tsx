import { useEffect, useState } from "react";
import { useChoiceStore } from "@store/choiceStore";
import { Button } from "./Button";
import { Modal } from "./Modal";

export function ChoiceModal() {
  const request = useChoiceStore((state) => state.requests[0] ?? null);
  const respond = useChoiceStore((state) => state.respond);
  const dismiss = useChoiceStore((state) => state.dismiss);
  const [selectedValue, setSelectedValue] = useState<string>("");

  useEffect(() => {
    setSelectedValue(request?.choices[0]?.value ?? "");
  }, [request]);

  if (!request) return null;

  return (
    <Modal
      isOpen
      onClose={dismiss}
      title={request.title}
      size="sm"
      footer={
        <div className="flex w-full items-center justify-end gap-2">
          <Button type="button" variant="secondary" onClick={dismiss}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="primary"
            disabled={!selectedValue}
            onClick={() => respond(selectedValue)}
          >
            Continue
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-description-fg">{request.detail}</p>
        <fieldset className="space-y-2">
          <legend className="sr-only">Choose a trust scope</legend>
          {request.choices.map((choice) => (
            <label
              key={choice.value}
              className="flex cursor-pointer items-center gap-2 rounded-sm border border-panel-border px-3 py-2 text-sm text-foreground"
            >
              <input
                type="radio"
                name={request.id}
                value={choice.value}
                checked={selectedValue === choice.value}
                onChange={() => setSelectedValue(choice.value)}
                className="h-3.5 w-3.5 shrink-0 accent-focus-border"
              />
              <span>{choice.label}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </Modal>
  );
}
