/**
 * Harness CLI version parsing, range matching, and the support-window policy.
 *
 * Pure (no VS Code or Node imports): the dashboard imports this through the
 * `@root/utils` alias to phrase the same guidance the extension host enforces.
 */
import {
  HARNESS_VERSION_STATUSES,
  type HarnessVersionStatus,
} from "../types/DashboardConstants";
import type { HarnessVersionRange } from "../types/CompatibilityTypes";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
}

/**
 * The CLI versions ctrlyoke supports for one harness.
 *
 * `minimum` is the oldest release inside the support window (see
 * `dev/reference/HARNESS_VERSION_SUPPORT.md`). A CLI below it is still launched,
 * with a warning that it may fail; ctrlyoke never refuses to try one. It is the
 * only version that ever warns a user, and it moves forward on the rolling
 * window or when a release breaks something, at which point code that only
 * exists to serve older versions is deleted.
 * `testedWith` is the release ctrlyoke was last verified against. It is
 * informational (docs only) and never produces a warning.
 */
export interface HarnessVersionPolicy {
  readonly minimum: string;
  readonly testedWith: string;
  /** Command the user runs to update the CLI in place. */
  readonly updateCommand: string;
}

/** A detected CLI version evaluated against its harness's policy. */
export interface HarnessVersionAssessment {
  status: HarnessVersionStatus;
  /** Normalized `major.minor.patch`, absent when the CLI's output had none. */
  installedVersion?: string;
  minimumVersion: string;
  testedWithVersion: string;
  updateCommand: string;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = version.match(/(?:^|[^\d])(\d+)\.(\d+)(?:\.(\d+))?/);
  if (!match) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
  };
}

function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  return (
    left.major - right.major ||
    left.minor - right.minor ||
    left.patch - right.patch
  );
}

type VersionComparator = ">" | ">=" | "<" | "<=" | "=" | "";

const VERSION_COMPARATORS: Record<
  VersionComparator,
  (comparison: number) => boolean
> = {
  ">": (comparison) => comparison > 0,
  ">=": (comparison) => comparison >= 0,
  "<": (comparison) => comparison < 0,
  "<=": (comparison) => comparison <= 0,
  "=": (comparison) => comparison === 0,
  "": (comparison) => comparison === 0,
};

function satisfiesComparator(
  version: ParsedVersion,
  operator: string,
  target: ParsedVersion
): boolean {
  const comparison = compareVersions(version, target);
  return operator in VERSION_COMPARATORS
    ? VERSION_COMPARATORS[operator as VersionComparator](comparison)
    : false;
}

/** Small semver-range evaluator for the declaration ranges used by the registry. */
export function versionSatisfies(
  installedVersion: string,
  range: HarnessVersionRange
): boolean {
  const version = parseVersion(installedVersion);
  if (!version) {
    return false;
  }

  return range.split("||").some((alternative) => {
    const expression = alternative.trim();
    if (!expression || expression === "*" || expression.toLowerCase() === "x") {
      return true;
    }

    if (expression.startsWith("^") || expression.startsWith("~")) {
      const operator = expression[0];
      const target = parseVersion(expression.slice(1));
      if (!target) {
        return false;
      }
      const upper =
        operator === "^"
          ? target.major > 0
            ? { major: target.major + 1, minor: 0, patch: 0 }
            : target.minor > 0
              ? { major: 0, minor: target.minor + 1, patch: 0 }
              : { major: 0, minor: 0, patch: target.patch + 1 }
          : { major: target.major, minor: target.minor + 1, patch: 0 };
      return (
        compareVersions(version, target) >= 0 &&
        compareVersions(version, upper) < 0
      );
    }

    return expression.split(/\s+/).every((token) => {
      const match = token.match(/^(>=|<=|>|<|=)?\s*(\d+(?:\.\d+){0,2}|[xX*])$/);
      if (!match) {
        return false;
      }
      if (/^[xX*]$/.test(match[2])) {
        return true;
      }
      const target = parseVersion(match[2]);
      return target
        ? satisfiesComparator(version, match[1] ?? "", target)
        : false;
    });
  });
}

/**
 * Evaluate a CLI's raw `--version` output against its policy. Unparseable or
 * missing output is `UNKNOWN` rather than `BELOW_MINIMUM`: a CLI that runs but
 * changed its banner should not be flagged by ctrlyoke's parser. Neither status
 * ever blocks the CLI from running.
 */
export function assessHarnessVersion(
  rawVersion: string | undefined,
  policy: HarnessVersionPolicy
): HarnessVersionAssessment {
  const parsed = rawVersion ? parseVersion(rawVersion) : undefined;
  const base = {
    minimumVersion: policy.minimum,
    testedWithVersion: policy.testedWith,
    updateCommand: policy.updateCommand,
  };
  if (!parsed) {
    return { status: HARNESS_VERSION_STATUSES.UNKNOWN, ...base };
  }
  const installedVersion = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  const status = versionSatisfies(installedVersion, `>=${policy.minimum}`)
    ? HARNESS_VERSION_STATUSES.SUPPORTED
    : HARNESS_VERSION_STATUSES.BELOW_MINIMUM;
  return { status, installedVersion, ...base };
}

/**
 * User-facing guidance for a version below the minimum, or undefined when the
 * version is fine. Shared by the run-time warning, the failure message, the
 * dashboard tooltips, and the CLI's startup log so all say the same thing.
 */
export function formatHarnessVersionGuidance(
  displayName: string,
  assessment: HarnessVersionAssessment | undefined
): string | undefined {
  if (
    !assessment?.installedVersion ||
    assessment.status !== HARNESS_VERSION_STATUSES.BELOW_MINIMUM
  ) {
    return undefined;
  }
  return `${displayName} ${assessment.installedVersion} is older than the minimum supported version ${assessment.minimumVersion} and may not work correctly. Update with: ${assessment.updateCommand}`;
}

/**
 * User-facing guidance for a missing CLI, wrapping the provider's bare
 * `installCommand`. Shared by the run-time refusal message and the dashboard
 * tooltips.
 */
export function formatHarnessInstallGuidance(installCommand: string): string {
  return `Install via: ${installCommand}`;
}
