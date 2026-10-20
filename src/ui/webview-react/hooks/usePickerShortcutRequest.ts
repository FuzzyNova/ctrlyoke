import { useEffect, useRef } from "react";
import { useUiStore, type PickerShortcutRequest } from "@store/uiStore";
import {
  PICKER_SHORTCUT_REQUEST_TTL_MS,
  type PickerShortcutTarget,
} from "@root/types/DashboardConstants";

/**
 * Calls `onRequest` for each live picker shortcut request aimed at one of
 * `targets` — including one already pending when the caller mounts, which is
 * how a picker that only mounts in response to the press (the workflow
 * properties panel expanding, a footer popup opening) still receives it.
 *
 * Observing is not claiming: the picker that acts on the request clears it
 * with `clearPickerShortcutRequest(request.nonce)`; containers that merely
 * reveal that picker leave it pending. A request older than
 * PICKER_SHORTCUT_REQUEST_TTL_MS is dropped instead of delivered.
 */
export function usePickerShortcutRequest<T extends PickerShortcutTarget>(
  targets: readonly T[] | undefined,
  onRequest: (request: PickerShortcutRequest & { target: T }) => void
): void {
  const request = useUiStore((state) => {
    const pending = state.pickerShortcutRequest;
    return pending && isRequestFor(pending, targets) ? pending : null;
  });
  const onRequestRef = useRef(onRequest);
  onRequestRef.current = onRequest;

  useEffect(() => {
    if (!request) return;
    if (Date.now() - request.issuedAt > PICKER_SHORTCUT_REQUEST_TTL_MS) {
      useUiStore.getState().clearPickerShortcutRequest(request.nonce);
      return;
    }
    onRequestRef.current(request);
  }, [request]);
}

function isRequestFor<T extends PickerShortcutTarget>(
  request: PickerShortcutRequest,
  targets: readonly T[] | undefined
): request is PickerShortcutRequest & { target: T } {
  return targets?.some((target) => target === request.target) ?? false;
}
