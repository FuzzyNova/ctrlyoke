import { quoteTomlBasicString } from "../shared/InlineToml";
import { CODEX_EXEC_ARGUMENTS } from "./CodexProtocolConstants";

export const CODEX_APP_SERVER_ARGS = [
  "app-server",
  "--listen",
  "stdio://",
] as const;

export interface CodexAppServerArgumentTranslation {
  args: string[];
  additionalWritableRoots: string[];
}

/**
 * Translate exec-only flags into app-server process config. The app-server
 * accepts shared `-c` overrides, but not exec's model, sandbox, image, or
 * writable-root flags.
 */
export function buildCodexAppServerArgs(args: readonly string[]): string[] {
  return translateCodexAppServerArgs(args).args;
}

export function getCodexAppServerAdditionalWritableRoots(
  args: readonly string[]
): string[] {
  return translateCodexAppServerArgs(args).additionalWritableRoots;
}

function translateCodexAppServerArgs(
  args: readonly string[]
): CodexAppServerArgumentTranslation {
  const result: string[] = [];
  const additionalWritableRoots: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const next = args[index + 1];

    if (argument === CODEX_EXEC_ARGUMENTS.RESUME) {
      index++;
      continue;
    }

    if (
      argument === CODEX_EXEC_ARGUMENTS.JSON ||
      argument === CODEX_EXEC_ARGUMENTS.SKIP_GIT_REPO_CHECK ||
      argument === CODEX_EXEC_ARGUMENTS.PROMPT_STDIN
    ) {
      continue;
    }

    if (
      argument === CODEX_EXEC_ARGUMENTS.IMAGE ||
      argument === CODEX_EXEC_ARGUMENTS.IMAGE_SHORT
    ) {
      index++;
      continue;
    }
    if (
      argument.startsWith(`${CODEX_EXEC_ARGUMENTS.IMAGE}=`) ||
      argument.startsWith(`${CODEX_EXEC_ARGUMENTS.IMAGE_SHORT}=`)
    ) {
      continue;
    }

    if (argument === CODEX_EXEC_ARGUMENTS.ADD_DIR) {
      if (next !== undefined) {
        additionalWritableRoots.push(next);
        index++;
      }
      continue;
    }
    if (argument.startsWith(`${CODEX_EXEC_ARGUMENTS.ADD_DIR}=`)) {
      additionalWritableRoots.push(
        argument.slice(CODEX_EXEC_ARGUMENTS.ADD_DIR.length + 1)
      );
      continue;
    }

    if (
      argument === CODEX_EXEC_ARGUMENTS.MODEL ||
      argument === CODEX_EXEC_ARGUMENTS.MODEL_SHORT
    ) {
      if (next !== undefined) {
        result.push(
          CODEX_EXEC_ARGUMENTS.CONFIG_OVERRIDE,
          `model=${quoteTomlBasicString(next)}`
        );
        index++;
      }
      continue;
    }
    if (
      argument.startsWith(`${CODEX_EXEC_ARGUMENTS.MODEL}=`) ||
      argument.startsWith(`${CODEX_EXEC_ARGUMENTS.MODEL_SHORT}=`)
    ) {
      result.push(
        CODEX_EXEC_ARGUMENTS.CONFIG_OVERRIDE,
        `model=${quoteTomlBasicString(argument.slice(argument.indexOf("=") + 1))}`
      );
      continue;
    }

    if (
      argument === CODEX_EXEC_ARGUMENTS.SANDBOX ||
      argument === CODEX_EXEC_ARGUMENTS.SANDBOX_SHORT
    ) {
      if (next !== undefined) {
        result.push(
          CODEX_EXEC_ARGUMENTS.CONFIG_OVERRIDE,
          `sandbox_mode=${quoteTomlBasicString(next)}`
        );
        index++;
      }
      continue;
    }
    if (
      argument.startsWith(`${CODEX_EXEC_ARGUMENTS.SANDBOX}=`) ||
      argument.startsWith(`${CODEX_EXEC_ARGUMENTS.SANDBOX_SHORT}=`)
    ) {
      result.push(
        CODEX_EXEC_ARGUMENTS.CONFIG_OVERRIDE,
        `sandbox_mode=${quoteTomlBasicString(argument.slice(argument.indexOf("=") + 1))}`
      );
      continue;
    }

    if (
      argument === CODEX_EXEC_ARGUMENTS.ASK_FOR_APPROVAL ||
      argument === CODEX_EXEC_ARGUMENTS.ASK_FOR_APPROVAL_SHORT
    ) {
      if (next !== undefined) {
        result.push(
          CODEX_EXEC_ARGUMENTS.CONFIG_OVERRIDE,
          `approval_policy=${quoteTomlBasicString(next)}`
        );
        index++;
      }
      continue;
    }
    if (
      argument.startsWith(`${CODEX_EXEC_ARGUMENTS.ASK_FOR_APPROVAL}=`) ||
      argument.startsWith(`${CODEX_EXEC_ARGUMENTS.ASK_FOR_APPROVAL_SHORT}=`)
    ) {
      result.push(
        CODEX_EXEC_ARGUMENTS.CONFIG_OVERRIDE,
        `approval_policy=${quoteTomlBasicString(argument.slice(argument.indexOf("=") + 1))}`
      );
      continue;
    }

    if (
      argument === CODEX_EXEC_ARGUMENTS.DANGEROUSLY_BYPASS ||
      argument === CODEX_EXEC_ARGUMENTS.YOLO
    ) {
      result.push(
        CODEX_EXEC_ARGUMENTS.CONFIG_OVERRIDE,
        `approval_policy=${quoteTomlBasicString("never")}`,
        CODEX_EXEC_ARGUMENTS.CONFIG_OVERRIDE,
        `sandbox_mode=${quoteTomlBasicString("danger-full-access")}`
      );
      continue;
    }

    result.push(argument);
  }

  return { args: result, additionalWritableRoots };
}
