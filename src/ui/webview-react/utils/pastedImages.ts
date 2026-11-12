import { StateEffect, StateField } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  MESSAGE_TYPES,
  USER_FEEDBACK_SEVERITY,
} from "@root/types/DashboardConstants";
import {
  MAX_PASTED_IMAGE_BYTES,
  PASTED_IMAGE_SAVE_TIMEOUT_MS,
  PASTING_IMAGE_PLACEHOLDER,
  mimeTypeToImageExtension,
} from "@/types/messages";
import { buildFileReference } from "@root/utils/ContextReferenceBuilder";
import { notifyUser } from "@utils/notifyUser";

/** One image taken from the clipboard, with the MIME type it was offered as. */
export interface ClipboardImage {
  blob: Blob;
  mimeType: string;
}

interface PastedImageTransport {
  postMessage: (message: unknown) => void;
}

const IMAGE_MIME_PREFIX = "image/";
const READ_FAILED_MESSAGE = "Failed to read pasted image";
const TOO_LARGE_MESSAGE = "Pasted image exceeds the maximum allowed size";
const SAVE_FAILED_MESSAGE = "Failed to save pasted image";

// One sequence space for every SAVE_PASTED_IMAGE request in the webview, so a
// reply is never claimed by an editor that did not send it.
let lastPastedImageSeq = 0;
export function nextPastedImageSeq(): number {
  return ++lastPastedImageSeq;
}

/** The image items of a native paste event (Ctrl/Cmd+V). */
export function clipboardEventImages(event: ClipboardEvent): ClipboardImage[] {
  const items = event.clipboardData?.items;
  if (!items) return [];
  return Array.from(items).flatMap((item) => {
    if (!item.type.startsWith(IMAGE_MIME_PREFIX)) return [];
    const file = item.getAsFile();
    return file ? [{ blob: file, mimeType: item.type }] : [];
  });
}

/**
 * The images on the clipboard, read through the async Clipboard API, as a
 * context-menu Paste needs (there is no paste event to read them from). An
 * item offered in several image formats contributes one image, preferring a
 * format ctrlyoke can save.
 */
export async function readClipboardImages(): Promise<ClipboardImage[]> {
  if (!navigator.clipboard?.read) return [];
  const items = await navigator.clipboard.read();
  const images: ClipboardImage[] = [];
  for (const item of items) {
    const imageTypes = item.types.filter((type) =>
      type.startsWith(IMAGE_MIME_PREFIX)
    );
    const mimeType =
      imageTypes.find((type) => mimeTypeToImageExtension(type)) ??
      imageTypes[0];
    if (mimeType) images.push({ blob: await item.getType(mimeType), mimeType });
  }
  return images;
}

/** The images ctrlyoke can save; each unsupported one is reported to the user. */
export function supportedClipboardImages(
  images: readonly ClipboardImage[]
): ClipboardImage[] {
  return images.filter((image) => {
    if (mimeTypeToImageExtension(image.mimeType)) return true;
    notifyUser(
      `Unsupported image type: ${image.mimeType}`,
      USER_FEEDBACK_SEVERITY.ERROR
    );
    return false;
  });
}

/**
 * Reads the image and sends it to the extension host as SAVE_PASTED_IMAGE
 * under `seq`; the host answers with PASTED_IMAGE_SAVED. `onError` runs
 * instead when the image cannot be read or is too large to send.
 */
export function postPastedImage(
  transport: PastedImageTransport,
  seq: number,
  image: ClipboardImage,
  onError: (message: string) => void
): void {
  const reader = new FileReader();
  reader.onload = () => {
    const result = typeof reader.result === "string" ? reader.result : "";
    const base64 = result.slice(result.indexOf(",") + 1);
    if (!base64) {
      onError(READ_FAILED_MESSAGE);
      return;
    }
    // Approximate decoded size before shipping a large payload via postMessage.
    if (Math.floor((base64.length * 3) / 4) > MAX_PASTED_IMAGE_BYTES) {
      onError(TOO_LARGE_MESSAGE);
      return;
    }
    transport.postMessage({
      type: MESSAGE_TYPES.SAVE_PASTED_IMAGE,
      seq,
      dataBase64: base64,
      mimeType: image.mimeType,
    });
  };
  reader.onerror = () => onError(READ_FAILED_MESSAGE);
  reader.readAsDataURL(image.blob);
}

/**
 * Saves the image through the extension host and resolves with its
 * workspace-relative path. Tells the user when the save is slow to answer.
 */
export function savePastedImage(
  transport: PastedImageTransport,
  image: ClipboardImage
): Promise<string> {
  const seq = nextPastedImageSeq();
  return new Promise<string>((resolve, reject) => {
    const stillWaiting = setTimeout(
      () =>
        notifyUser(
          "Still waiting for the pasted image to be saved",
          USER_FEEDBACK_SEVERITY.INFO
        ),
      PASTED_IMAGE_SAVE_TIMEOUT_MS
    );
    const settle = () => {
      clearTimeout(stillWaiting);
      window.removeEventListener("message", handleMessage);
    };
    const handleMessage = (event: MessageEvent) => {
      const message = event.data as {
        type?: string;
        seq?: number;
        relativePath?: string;
        error?: string;
      } | null;
      if (
        message?.type !== MESSAGE_TYPES.PASTED_IMAGE_SAVED ||
        message.seq !== seq
      )
        return;
      settle();
      if (message.relativePath) resolve(message.relativePath);
      else reject(new Error(message.error || SAVE_FAILED_MESSAGE));
    };
    window.addEventListener("message", handleMessage);
    postPastedImage(transport, seq, image, (error) => {
      settle();
      reject(new Error(error));
    });
  });
}

interface PlaceholderRange {
  from: number;
  to: number;
}

const addPastedImagePlaceholder = StateEffect.define<{
  id: number;
  range: PlaceholderRange;
}>();
const removePastedImagePlaceholder = StateEffect.define<number>();

/**
 * Where each `[Pasting image…]` placeholder inserted by
 * {@link pasteImagesAsReferences} sits now, kept current through edits made
 * while its save is in flight.
 */
export const pastedImagePlaceholderField = StateField.define<
  ReadonlyMap<number, PlaceholderRange>
>({
  create: () => new Map(),
  update: (ranges, transaction) => {
    let next = ranges;
    if (transaction.docChanged && ranges.size > 0) {
      next = new Map(
        [...ranges].map(([id, range]) => [
          id,
          {
            from: transaction.changes.mapPos(range.from, 1),
            to: transaction.changes.mapPos(range.to, -1),
          },
        ])
      );
    }
    for (const effect of transaction.effects) {
      if (effect.is(addPastedImagePlaceholder)) {
        next = new Map(next).set(effect.value.id, effect.value.range);
      } else if (effect.is(removePastedImagePlaceholder)) {
        const remaining = new Map(next);
        remaining.delete(effect.value);
        next = remaining;
      }
    }
    return next;
  },
});

let lastPlaceholderId = 0;

/**
 * Replaces the selection with a placeholder per image, saves each image
 * through the extension host and swaps its placeholder for an `@` reference
 * to the saved file. The view needs {@link pastedImagePlaceholderField}. A
 * reply that can no longer land (the view closed, or the placeholder was
 * edited away) is reported to the user instead.
 */
export function pasteImagesAsReferences(
  view: EditorView,
  images: readonly ClipboardImage[],
  transport: PastedImageTransport
): void {
  for (const image of supportedClipboardImages(images)) {
    const id = ++lastPlaceholderId;
    const { from, to } = view.state.selection.main;
    const end = from + PASTING_IMAGE_PLACEHOLDER.length;
    view.dispatch({
      changes: { from, to, insert: PASTING_IMAGE_PLACEHOLDER },
      selection: { anchor: end },
      effects: addPastedImagePlaceholder.of({ id, range: { from, to: end } }),
      userEvent: "input.paste",
      scrollIntoView: true,
    });

    const settle = (replacement: string): boolean => {
      if (!view.dom.isConnected) return false;
      const range = view.state
        .field(pastedImagePlaceholderField, false)
        ?.get(id);
      if (!range) return false;
      const intact =
        view.state.sliceDoc(range.from, range.to) === PASTING_IMAGE_PLACEHOLDER;
      view.dispatch({
        ...(intact
          ? { changes: { from: range.from, to: range.to, insert: replacement } }
          : {}),
        effects: removePastedImagePlaceholder.of(id),
      });
      return intact;
    };

    savePastedImage(transport, image).then(
      (relativePath) => {
        // Trailing space terminates the @ref token so the user can keep typing.
        const reference = `${buildFileReference(relativePath)} `;
        if (!settle(reference)) {
          notifyUser(
            `Pasted image saved at ${reference.trimEnd()}`,
            USER_FEEDBACK_SEVERITY.INFO
          );
        }
      },
      (error: unknown) => {
        settle("");
        notifyUser(
          error instanceof Error ? error.message : SAVE_FAILED_MESSAGE,
          USER_FEEDBACK_SEVERITY.ERROR
        );
      }
    );
  }
}
