import { randomUUID } from "crypto";

/** Create a collision-resistant sibling path for an atomic file replacement. */
export function uniqueAtomicTempPath(targetPath: string): string {
  return `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
}
