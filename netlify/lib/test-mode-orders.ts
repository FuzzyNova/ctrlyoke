const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

/** Whether a Lemon Squeezy test-mode event may issue or renew a license. */
export function shouldIssueTestModeLicense(
  testMode: boolean | undefined,
  allowTestModeOrders: string | undefined
): boolean {
  if (testMode !== true) return true;
  return (
    allowTestModeOrders !== undefined &&
    TRUTHY_ENV_VALUES.has(allowTestModeOrders.trim().toLowerCase())
  );
}
