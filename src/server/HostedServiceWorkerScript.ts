import * as fs from "fs";
import * as path from "path";
import {
  HOSTED_ICON_PATHS,
  SERVICE_WORKER_BADGE_MESSAGE_TYPES,
} from "../types/DashboardConstants";

const CLEAR_BADGE_MESSAGE_TYPE_PLACEHOLDER =
  "__FLIGHTPATH_CLEAR_BADGE_MESSAGE_TYPE__";
const INCREMENT_BADGE_MESSAGE_TYPE_PLACEHOLDER =
  "__FLIGHTPATH_INCREMENT_BADGE_MESSAGE_TYPE__";
const NOTIFICATION_ICON_PATH_PLACEHOLDER =
  "__FLIGHTPATH_NOTIFICATION_ICON_PATH__";
const NOTIFICATION_BADGE_PATH_PLACEHOLDER =
  "__FLIGHTPATH_NOTIFICATION_BADGE_PATH__";
const SERVICE_WORKER_TEMPLATE_CANDIDATE_PATHS = [
  path.join(__dirname, "server", "flightpath-service-worker.js"),
  path.join(__dirname, "flightpath-service-worker.js"),
];

let cachedTemplate: string | undefined;

export function buildHostedServiceWorkerScript(): string {
  return renderHostedServiceWorkerScript(getHostedServiceWorkerTemplate());
}

export function renderHostedServiceWorkerScript(template: string): string {
  let script = replacePlaceholder(
    template,
    CLEAR_BADGE_MESSAGE_TYPE_PLACEHOLDER,
    SERVICE_WORKER_BADGE_MESSAGE_TYPES.CLEAR_NOTIFICATION_BADGE
  );
  script = replacePlaceholder(
    script,
    INCREMENT_BADGE_MESSAGE_TYPE_PLACEHOLDER,
    SERVICE_WORKER_BADGE_MESSAGE_TYPES.INCREMENT_NOTIFICATION_BADGE
  );
  script = replacePlaceholder(
    script,
    NOTIFICATION_ICON_PATH_PLACEHOLDER,
    HOSTED_ICON_PATHS.APP_ICON_PNG
  );
  script = replacePlaceholder(
    script,
    NOTIFICATION_BADGE_PATH_PLACEHOLDER,
    HOSTED_ICON_PATHS.FAVICON_PNG
  );
  return script;
}

function getHostedServiceWorkerTemplate(): string {
  if (!cachedTemplate) {
    const templatePath = SERVICE_WORKER_TEMPLATE_CANDIDATE_PATHS.find((file) =>
      fs.existsSync(file)
    );
    if (!templatePath) {
      throw new Error("Hosted service worker template file was not found");
    }

    cachedTemplate = fs.readFileSync(templatePath, "utf8");
  }
  return cachedTemplate;
}

function replacePlaceholder(
  template: string,
  placeholder: string,
  value: string
): string {
  const placeholderLiteral = JSON.stringify(placeholder);
  if (!template.includes(placeholderLiteral)) {
    throw new Error(
      `Missing hosted service worker placeholder: ${placeholder}`
    );
  }

  return template.replaceAll(placeholderLiteral, JSON.stringify(value));
}
