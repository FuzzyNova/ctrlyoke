import React from "react";
import { useAnnouncerStore } from "@store/announcerStore";
import { useOutputAnnouncer } from "@hooks/useOutputAnnouncer";

const LIVE_REGION_SLOTS = [0, 1] as const;

/**
 * The dashboard's screen-reader live region, kept apart from the visual
 * output stream (the output pane is virtualized and carries no live region of
 * its own). Two polite regions take turns so a repeated sentence is still
 * spoken; both exist, empty, from mount, because a screen reader ignores
 * text in a live region that was inserted together with it.
 */
export const ScreenReaderAnnouncer: React.FC = () => {
  useOutputAnnouncer();
  const announcement = useAnnouncerStore((state) => state.announcement);
  const activeSlot = announcement ? announcement.id % 2 : null;

  return (
    <div className="sr-only">
      {LIVE_REGION_SLOTS.map((slot) => (
        <div
          key={slot}
          aria-live="polite"
          aria-atomic="true"
          data-testid={`screen-reader-announcer-${slot}`}
        >
          {activeSlot === slot ? announcement?.text : ""}
        </div>
      ))}
    </div>
  );
};
