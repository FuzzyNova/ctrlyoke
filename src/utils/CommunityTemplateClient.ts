/**
 * Reads the community template library (`FuzzyNova/ctrlyoke-templates`) through
 * jsDelivr's GitHub mirror: its generated `index.json`, and one template file at
 * a time. Everything it returns is third-party text, so the index is validated
 * and sanitized here, before the dashboard ever sees it.
 */
import {
  COMMUNITY_TEMPLATES,
  COMMUNITY_TEMPLATES_CDN_BASE_URL,
  MAX_INSTALLED_TEMPLATE_BYTES,
  WORKFLOW_FILE_FORMATS,
  type WorkflowFileFormat,
} from "../types/DashboardConstants";
import type { CommunityTemplateEntry } from "../types/WebviewMessageTypes";
import { getErrorMessage } from "./ErrorUtils";
import { sanitizeRegistryText } from "./SkillsRegistryClient";

type FetchFn = typeof fetch;

/**
 * Dev override for the library's base URL, so a fork or a local static server
 * (serving `index.json` and `templates/`) can stand in for the real repository.
 */
export const COMMUNITY_TEMPLATES_URL_ENV = "CTRLYOKE_COMMUNITY_TEMPLATES_URL";

const USER_AGENT = "ctrlyoke-community-templates";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_INDEX_BYTES = 1024 * 1024;
const MAX_INDEX_ENTRIES = 2000;
const MAX_NAME_LENGTH = 120;
const MAX_DESCRIPTION_LENGTH = 500;
const MAX_TAGS = 10;
const MAX_TAG_LENGTH = 40;

/**
 * A template id is its file basename, such as `review-branch`, and becomes the
 * installed file's name, so it is held to a portable, path-free shape.
 */
const TEMPLATE_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const TEMPLATE_FILE_EXTENSIONS = {
  ".ctrlyoke.yaml": WORKFLOW_FILE_FORMATS.YAML,
  ".ctrlyoke.yml": WORKFLOW_FILE_FORMATS.YAML,
  ".ctrlyoke.json": WORKFLOW_FILE_FORMATS.JSON,
} as const satisfies Record<string, WorkflowFileFormat>;

/** A failure to show the user as-is. */
export class CommunityTemplateError extends Error {}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The format a library file is written in, or `undefined` for a file name the library never uses. */
export function getCommunityTemplateFormat(
  id: string,
  file: string
): WorkflowFileFormat | undefined {
  for (const [extension, format] of Object.entries(TEMPLATE_FILE_EXTENSIONS)) {
    if (file === `${id}${extension}`) return format;
  }
  return undefined;
}

/**
 * Parse `index.json`. Malformed entries are skipped rather than failing the
 * whole list; an unknown major `schemaVersion` fails it, because guessing at a
 * newer format could install the wrong file.
 */
export function parseCommunityTemplateIndex(
  data: unknown
): CommunityTemplateEntry[] {
  if (!isPlainObject(data) || !Array.isArray(data.templates)) {
    throw new CommunityTemplateError(
      "The community template index is not in a format ctrlyoke understands"
    );
  }
  if (data.schemaVersion !== COMMUNITY_TEMPLATES.indexSchemaVersion) {
    throw new CommunityTemplateError(
      `The community template index uses format ${String(data.schemaVersion)}; this version of ctrlyoke reads format ${COMMUNITY_TEMPLATES.indexSchemaVersion}. Update ctrlyoke to browse it.`
    );
  }
  const seen = new Set<string>();
  const entries: CommunityTemplateEntry[] = [];
  for (const item of data.templates.slice(0, MAX_INDEX_ENTRIES)) {
    if (!isPlainObject(item)) continue;
    const { id, file } = item;
    if (typeof id !== "string" || !TEMPLATE_ID_PATTERN.test(id)) continue;
    if (typeof file !== "string" || !getCommunityTemplateFormat(id, file))
      continue;
    if (seen.has(id)) continue;
    const name =
      typeof item.name === "string"
        ? sanitizeRegistryText(item.name, MAX_NAME_LENGTH)
        : "";
    const entry: CommunityTemplateEntry = {
      id,
      name: name || id,
      description:
        typeof item.description === "string"
          ? sanitizeRegistryText(item.description, MAX_DESCRIPTION_LENGTH)
          : "",
      tags: Array.isArray(item.tags)
        ? item.tags
            .filter((tag): tag is string => typeof tag === "string")
            .map((tag) => sanitizeRegistryText(tag, MAX_TAG_LENGTH))
            .filter(Boolean)
            .slice(0, MAX_TAGS)
        : [],
      file,
    };
    const author =
      typeof item.author === "string"
        ? sanitizeRegistryText(item.author, MAX_NAME_LENGTH)
        : "";
    if (author) entry.author = author;
    seen.add(id);
    entries.push(entry);
  }
  return entries.sort(
    (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
}

export interface CommunityTemplateClientOptions {
  fetch?: FetchFn;
  /** Library base URL; defaults to {@link COMMUNITY_TEMPLATES_URL_ENV} or jsDelivr. */
  baseUrl?: string;
}

/** Downloads the community library's index and template files. */
export class CommunityTemplateClient {
  private readonly fetchFn: FetchFn;
  private readonly baseUrl: string;

  constructor(options: CommunityTemplateClientOptions = {}) {
    this.fetchFn = options.fetch ?? ((input, init) => fetch(input, init));
    this.baseUrl = (
      options.baseUrl ??
      process.env[COMMUNITY_TEMPLATES_URL_ENV] ??
      COMMUNITY_TEMPLATES_CDN_BASE_URL
    ).replace(/\/+$/, "");
  }

  async fetchIndex(): Promise<CommunityTemplateEntry[]> {
    const text = await this.fetchText(
      `${this.baseUrl}/${COMMUNITY_TEMPLATES.indexFile}`,
      "index",
      MAX_INDEX_BYTES
    );
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new CommunityTemplateError(
        "The community template index is not valid JSON"
      );
    }
    return parseCommunityTemplateIndex(data);
  }

  /** Download the file an index entry names. */
  async fetchTemplate(entry: CommunityTemplateEntry): Promise<string> {
    if (!getCommunityTemplateFormat(entry.id, entry.file)) {
      throw new CommunityTemplateError(
        `The community template "${entry.id}" names an invalid file`
      );
    }
    return this.fetchText(
      `${this.baseUrl}/${COMMUNITY_TEMPLATES.templatesDir}/${encodeURIComponent(entry.file)}`,
      `template "${entry.id}"`,
      MAX_INSTALLED_TEMPLATE_BYTES
    );
  }

  private async fetchText(
    url: string,
    what: string,
    maxBytes: number
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchFn(url, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CommunityTemplateError(
        `Could not reach ${COMMUNITY_TEMPLATES.cdnHost} to download the community ${what}: ${getErrorMessage(error)}`
      );
    }
    if (response.status === 404) {
      throw new CommunityTemplateError(
        `The community ${what} was not found (HTTP 404)`
      );
    }
    if (!response.ok) {
      throw new CommunityTemplateError(
        `Downloading the community ${what} failed (HTTP ${response.status})`
      );
    }
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes) {
      throw new CommunityTemplateError(
        `The community ${what} is larger than ${maxBytes / 1024} KB`
      );
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf-8") > maxBytes) {
      throw new CommunityTemplateError(
        `The community ${what} is larger than ${maxBytes / 1024} KB`
      );
    }
    return text;
  }
}
