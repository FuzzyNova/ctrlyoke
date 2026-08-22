import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";

/**
 * Sensor setup shared by every @dnd-kit sortable list in the dashboard:
 * pointer input with a small activation distance (so a plain click/tap isn't
 * swallowed as a drag) plus keyboard support.
 */
export function useSortableDndSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );
}
