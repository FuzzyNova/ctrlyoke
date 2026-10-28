/**
 * The text the dashboard's screen-reader live region should say next.
 *
 * `ScreenReaderAnnouncer` renders it; anything may call `announce`. Each
 * announcement gets a fresh id so the same sentence twice in a row ("Step 2
 * completed." on a re-run) is still spoken: the announcer alternates between
 * two live regions by id, and a screen reader only speaks a region whose
 * content changed.
 *
 * Kept free of the output pipeline on purpose: `useMessageHandler` imports
 * this module, and pulling the announcement tracker in through it created an
 * import cycle with `@components/shared`.
 */
import { create } from "zustand";
import { OUTPUT_ANNOUNCEMENT_MODES } from "@root/types/DashboardConstants";
import { selectUiAccessibility, useSettingsStore } from "./settingsStore";

export interface Announcement {
  id: number;
  text: string;
}

interface AnnouncerState {
  announcement: Announcement | null;
  announce: (text: string) => void;
}

export const useAnnouncerStore = create<AnnouncerState>((set) => ({
  announcement: null,
  announce: (text) => {
    // Line breaks mean nothing in a live region; one line reads the same.
    const spoken = text.replace(/\s+/g, " ").trim();
    if (!spoken) return;
    set((state) => ({
      announcement: { id: (state.announcement?.id ?? 0) + 1, text: spoken },
    }));
  },
}));

/** Announce a waiting-for-input notification, unless announcements are off. */
export function announceAwaitingInput(body: string): void {
  const mode = selectUiAccessibility(
    useSettingsStore.getState()
  ).outputAnnouncements;
  if (mode === OUTPUT_ANNOUNCEMENT_MODES.NONE) return;
  useAnnouncerStore.getState().announce(`Waiting for input. ${body}`);
}
