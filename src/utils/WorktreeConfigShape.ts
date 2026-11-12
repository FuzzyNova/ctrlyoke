import {
  CHECKOUT_VALUE_KINDS,
  WORKTREE_CHECKOUT_FIELD,
  WORKTREE_MODES,
} from "../types/DashboardConstants";
import type {
  WorktreeConfig,
  WorktreeObjectConfig,
} from "../types/CtrlYokeTypes";

export type CheckoutValueKind =
  (typeof CHECKOUT_VALUE_KINDS)[keyof typeof CHECKOUT_VALUE_KINDS];

/** Classify checkout values independently of the host platform. */
export function classifyCheckoutValue(value: string): CheckoutValueKind {
  return value === "~" ||
    /^~[\\/]/.test(value) ||
    value.startsWith("/") ||
    value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/.test(value)
    ? CHECKOUT_VALUE_KINDS.PATH
    : CHECKOUT_VALUE_KINDS.NAME;
}

/** Convert shorthand worktree selections to the object form used by the UI. */
export function toWorktreeObjectConfig(
  value: WorktreeConfig | undefined
): WorktreeObjectConfig | false {
  if (value === undefined || value === false) return false;
  if (value === true) return { mode: WORKTREE_MODES.MANAGED };
  if (typeof value === "string") {
    return { mode: WORKTREE_MODES.NAMED, branch: value };
  }
  if (value.mode === WORKTREE_MODES.MANAGED && "checkout" in value) {
    const { checkout: _checkout, ...managed } = value;
    return managed as WorktreeObjectConfig;
  }
  return value;
}

/**
 * The worktree a workflow runs with: its authored value when set, otherwise the
 * inherited settings value. Returns a copy so callers can't mutate either source.
 */
export function effectiveWorktreeObjectConfig(
  authored: WorktreeConfig | undefined,
  inherited: WorktreeConfig | undefined
): WorktreeObjectConfig | false {
  const effective = toWorktreeObjectConfig(
    authored === undefined ? inherited : authored
  );
  return effective === false ? false : { ...effective };
}

/**
 * Set one field of an object worktree config. An empty `checkout` removes the
 * key, because a stored `checkout: ""` is invalid and "empty" means "derive
 * the checkout from the branch".
 */
export function withWorktreeField<T extends object>(
  config: T,
  field: string,
  value: string | boolean
): T {
  const next = { ...config, [field]: value } as T & { checkout?: unknown };
  if (
    field === WORKTREE_CHECKOUT_FIELD &&
    typeof value === "string" &&
    !value.trim()
  ) {
    delete next.checkout;
  }
  return next;
}
