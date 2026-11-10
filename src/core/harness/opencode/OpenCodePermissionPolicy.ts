export type OpenCodePermissionDecision = "allow" | "ask" | "deny";
export type OpenCodePermissionPolicy = Record<
  string,
  OpenCodePermissionDecision | Record<string, OpenCodePermissionDecision>
>;
