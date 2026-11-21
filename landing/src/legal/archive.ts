// Every published version of the legal documents, served at permanent URLs
// (`/terms/2.2/`, `/privacy/1.6/`, ...). The registry and texts live in the
// repo root (legal/versions.json, legal/archive/); scripts/legal-archive.mjs
// owns their rules and legal/README.md the release process.
import type { AstroComponentFactory } from "astro/runtime/server/index.js";
import registry from "../../../legal/versions.json";
// The same rules `npm run check:legal` applies (plain JS, shared with that script).
import {
  archivedVersionPath,
  findLegalArchiveProblems,
} from "../../../scripts/legal-archive.mjs";

export type LegalDocumentId =
  "eula" | "enterprise-terms" | "privacy" | "dpa" | "cla";

interface LegalDocument {
  id: LegalDocumentId;
  file: string;
  title: string;
  route: string;
}

export interface LegalVersion {
  version: string;
  published: string;
  sha256: string;
  url: string;
}

interface MarkdownModule {
  Content: AstroComponentFactory;
}

const archivedRaw = import.meta.glob<string>("../../../legal/archive/*/*.md", {
  query: "?raw",
  import: "default",
  eager: true,
});
const archivedModules = import.meta.glob<MarkdownModule>(
  "../../../legal/archive/*/*.md",
  {
    eager: true,
  }
);
// Every root file in legal/versions.json `documents` (Vite needs a literal pattern).
const currentRaw = import.meta.glob<string>(
  "../../../{LICENSE,ENTERPRISE_TERMS,PRIVACY,DPA,CLA}.md",
  {
    query: "?raw",
    import: "default",
    eager: true,
  }
);

const RELATIVE_ROOT = "../../../";
const repoRelative = (globKey: string): string =>
  globKey.slice(RELATIVE_ROOT.length);

// The site links checkout and history to these pages, so refuse to build
// from an archive that check:legal would reject.
const problems: string[] = findLegalArchiveProblems({
  registry,
  currentTexts: Object.fromEntries(
    Object.entries(currentRaw).map(([key, text]) => [repoRelative(key), text])
  ),
  archivedTexts: Object.fromEntries(
    Object.entries(archivedRaw).map(([key, text]) => [repoRelative(key), text])
  ),
});
if (problems.length > 0) {
  throw new Error(
    `Legal document archive check failed:\n- ${problems.join("\n- ")}`
  );
}

function legalDocument(id: LegalDocumentId): LegalDocument {
  const doc = (registry.documents as LegalDocument[]).find((d) => d.id === id);
  if (!doc) throw new Error(`legal/versions.json has no document "${id}"`);
  return doc;
}

/** Permanent URL of one published version. */
export function legalVersionUrl(id: LegalDocumentId, version: string): string {
  return `${legalDocument(id).route}${version}/`;
}

/** Published versions of a document, newest first. */
export function legalVersionHistory(id: LegalDocumentId): LegalVersion[] {
  return registry.versions
    .filter((v) => v.document === id)
    .map((v) => ({
      version: v.version,
      published: v.published,
      sha256: v.sha256,
      url: legalVersionUrl(id, v.version),
    }))
    .reverse();
}

/** A document's current version (the build check guarantees it is the root file's). */
export function currentLegalVersion(id: LegalDocumentId): LegalVersion {
  return legalVersionHistory(id)[0];
}

/** `eula@2.3; privacy@1.7`: the accepted-versions record checkout sends to Lemon Squeezy. */
export function acceptedVersionsRecord(
  ids: readonly LegalDocumentId[]
): string {
  return ids.map((id) => `${id}@${currentLegalVersion(id).version}`).join("; ");
}

/**
 * EULA §16(e) keeps each copy of ctrlyoke under the license version it came
 * with. The other documents carry no such rule (for example, EULA §10 applies
 * the then-current Privacy Policy), so only the EULA's pages say it.
 */
export const COPY_STAYS_ON_ITS_VERSION: ReadonlySet<LegalDocumentId> = new Set([
  "eula",
]);

export interface ArchivedLegalPageProps {
  document: LegalDocumentId;
  title: string;
  currentUrl: string;
  entry: LegalVersion;
  /** The version that replaced this one, or undefined when this is current. */
  supersededBy: LegalVersion | undefined;
  Content: AstroComponentFactory;
}

/** `getStaticPaths` for a document's `[version].astro` route. */
export function archivedVersionPaths(id: LegalDocumentId) {
  const doc = legalDocument(id);
  const history = legalVersionHistory(id);
  return history.map((entry, index) => {
    const props: ArchivedLegalPageProps = {
      document: id,
      title: doc.title,
      currentUrl: doc.route,
      entry,
      supersededBy: index > 0 ? history[index - 1] : undefined,
      Content:
        archivedModules[
          `${RELATIVE_ROOT}${archivedVersionPath(id, entry.version)}`
        ].Content,
    };
    return { params: { version: entry.version }, props };
  });
}

/** "2026-11-21" → "November 21, 2026", matching the documents' own dates. */
export function formatLegalDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}
