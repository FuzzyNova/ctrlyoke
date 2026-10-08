import * as fs from "fs";
import * as path from "path";
import {
  HOSTED_CONNECTION_LIVENESS,
  LOG_LEVELS,
  MESSAGE_TYPES,
  THEME_KINDS,
  THEME_KIND_BODY_CLASSES,
  THEME_KIND_CSS_VAR,
  VSCODE_THEME_BODY_CLASSES,
} from "../types/DashboardConstants";

const CONNECTION_CONFIG_PLACEHOLDER = "__CTRLYOKE_HOSTED_CONNECTION_CONFIG__";
const STANDALONE_SHIM_TEMPLATE_CANDIDATE_PATHS = [
  path.join(__dirname, "server", "standalone-shim.js"),
  path.join(__dirname, "standalone-shim.js"),
];

export function buildHostedStandaloneShimScript(workspaceKey: string): string {
  return renderHostedStandaloneShimScript(
    getStandaloneShimTemplate(),
    workspaceKey
  );
}

export function renderHostedStandaloneShimScript(
  template: string,
  workspaceKey: string
): string {
  const placeholderLiteral = JSON.stringify(CONNECTION_CONFIG_PLACEHOLDER);
  if (!template.includes(placeholderLiteral)) {
    throw new Error(
      `Missing hosted standalone shim placeholder: ${CONNECTION_CONFIG_PLACEHOLDER}`
    );
  }

  return template.replaceAll(
    placeholderLiteral,
    JSON.stringify({
      heartbeatType: MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT,
      heartbeatAckType: MESSAGE_TYPES.HOSTED_CONNECTION_HEARTBEAT_ACK,
      logMessageType: MESSAGE_TYPES.LOG_MESSAGE,
      readyType: MESSAGE_TYPES.READY,
      themeVarsUpdatedType: MESSAGE_TYPES.THEME_VARS_UPDATED,
      themeKindCssVar: THEME_KIND_CSS_VAR,
      themeBodyClassesByKind: THEME_KIND_BODY_CLASSES,
      fallbackThemeBodyClasses: THEME_KIND_BODY_CLASSES[THEME_KINDS.LIGHT],
      allThemeBodyClasses: Object.values(VSCODE_THEME_BODY_CLASSES),
      workspaceKey,
      logLevels: {
        debug: LOG_LEVELS.DEBUG,
        info: LOG_LEVELS.INFO,
        warn: LOG_LEVELS.WARN,
      },
      ...HOSTED_CONNECTION_LIVENESS,
    })
  );
}

function getStandaloneShimTemplate(): string {
  const templatePath = STANDALONE_SHIM_TEMPLATE_CANDIDATE_PATHS.find((file) =>
    fs.existsSync(file)
  );
  if (!templatePath) {
    throw new Error("Hosted standalone shim template file was not found");
  }

  // Unlike the service-worker template, this stays uncached so a development
  // rebuild followed by a hosted-page reload serves the newly copied shim even
  // before the extension host itself restarts.
  return fs.readFileSync(templatePath, "utf8");
}
