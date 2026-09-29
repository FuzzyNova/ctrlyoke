import * as vscode from "vscode";
import * as path from "path";
import {
  getVsCodeWorkspaceRoot,
  getVsCodeNamedWorkspaceRoots,
  getVsCodeTrustedWorkspaceRoots,
} from "../platform/VsCodeWorkspaceRoot";
import {
  getTrustedSourceDefinitionDir,
  resolveReferencePath,
  type ResolverWorkspaceFolder,
} from "../platform/WorkspaceRootResolver";
import {
  evaluateFileAccess,
  type FileAccessDecision,
} from "../utils/FileAccessPolicy";
import { ConfigurationUtils } from "../utils/ConfigurationUtils";
import {
  createGitChangeReferencePattern,
  createReferencePatterns,
} from "../utils/ReferencePatterns";
import { ExternalRootsTrustStore } from "../config/ExternalRootsTrustStore";
import type { FileOpenTarget } from "../ui/ExternalFileTrustPrompt";
import { PromptFileResolver } from "../core/PromptFileResolver";
import { runtimeTrustedRootRegistry } from "../utils/RuntimeTrustedRootRegistry";
import { getFrozenRunHistoryLocation } from "../utils/RunHistoryStoragePolicy";
import { projectStateRoot } from "../utils/ProjectStatePaths";
import { PROMPT_FILE_LANGUAGE_IDS } from "../types/DashboardConstants";
import { scanCtrlYokeSlashTokens } from "../utils/CtrlYokeSlashTokens";
import { SkillDiscovery } from "../utils/SkillDiscovery";
import {
  CTRLYOKE_SLASH_TOKEN_KINDS,
  VSCODE_COMMANDS,
} from "../types/DashboardConstants";
import { parseSecretReferences } from "../utils/SecretReferenceParser";

/**
 * Provides clickable links for ctrlyoke context references
 *
 * Supported patterns:
 * - @path/to/file.ts       → Open file
 * - @path/to/dir/          → Reveal directory
 * - #selection:path:10-20  → Open file with line selection
 * - #sym:path:symbol:42-58 → Open file at symbol range
 * - /skill:name             → Open the resolved ctrlyoke SKILL.md
 *
 * Enables Ctrl+Click (Cmd+Click on Mac) navigation from prompts back to source code.
 * Complements PromptCompletionProvider for bidirectional context flow.
 */
export class PromptLinkProvider implements vscode.DocumentLinkProvider {
  // Canonical reference patterns, shared with the webview decorators. Each
  // call site clones a pattern before use, so the `g` flag's lastIndex never
  // leaks between documents. See ReferencePatterns.ts for the group contract.
  private readonly patterns = createReferencePatterns();

  /**
   * Provide document links for prompt files
   */
  async provideDocumentLinks(
    document: vscode.TextDocument,
    _token: vscode.CancellationToken
  ): Promise<vscode.DocumentLink[] | undefined> {
    // Only provide links for prompt files
    if (!this.isPromptFile(document)) {
      return undefined;
    }

    const links: vscode.DocumentLink[] = [];
    const text = document.getText();
    const workspaceRoot = this.getWorkspaceRoot();

    links.push(...this.findSecretLinks(document, text));

    if (!workspaceRoot) {
      return links.length > 0 ? links : undefined;
    }

    const namedRoots = getVsCodeNamedWorkspaceRoots();
    const trustedRoots = [
      ...getVsCodeTrustedWorkspaceRoots(),
      ...runtimeTrustedRootRegistry.getRoots(),
    ];
    const sourceDefinitionDir = getTrustedSourceDefinitionDir(
      document.fileName,
      trustedRoots
    );
    const workspaceIdentity =
      ExternalRootsTrustStore.canonicalizeRoot(workspaceRoot);
    const approvedExternalRoots =
      ConfigurationUtils.getEffectiveApprovedExternalFileRoots(
        workspaceIdentity
      );
    const ownStateRoots = [
      projectStateRoot(workspaceRoot, getFrozenRunHistoryLocation()),
    ];

    // A standalone prompt-file path has no @/# marker, so it needs its own
    // link entry. Keep this separate from context-reference matching because
    // prompt parsing resolves these paths relative to the prompt document
    // before falling back to the workspace and .ctrlyoke roots.
    links.push(
      ...this.findPromptFileLinks(
        document,
        text,
        workspaceRoot,
        namedRoots,
        trustedRoots,
        approvedExternalRoots,
        ownStateRoots
      )
    );

    // 1. Detect full file references (@file.ext and @"path with spaces/file.ext")
    links.push(
      ...this.findFileLinks(
        document,
        text,
        workspaceRoot,
        namedRoots,
        trustedRoots,
        approvedExternalRoots,
        ownStateRoots,
        sourceDefinitionDir
      )
    );

    // 2. Detect directory references (@dir/ and @"path with spaces/dir/")
    links.push(
      ...this.findDirectoryLinks(
        document,
        text,
        workspaceRoot,
        namedRoots,
        trustedRoots,
        approvedExternalRoots,
        ownStateRoots,
        sourceDefinitionDir
      )
    );

    // 3. Detect line range references (#selection:path:10-20 and #selection:"path with spaces/file":10-20)
    links.push(
      ...this.findLineRangeLinks(
        document,
        text,
        workspaceRoot,
        namedRoots,
        trustedRoots,
        approvedExternalRoots,
        ownStateRoots,
        sourceDefinitionDir
      )
    );

    // 4. Detect symbol references with encoded line ranges
    links.push(
      ...this.findSymbolLinks(
        document,
        text,
        workspaceRoot,
        namedRoots,
        trustedRoots,
        approvedExternalRoots,
        ownStateRoots,
        sourceDefinitionDir
      )
    );

    // 5. Detect git change references (~diff, ~staged, ~stash:N, ~<hash>)
    links.push(...this.findGitChangeLinks(document, text));

    links.push(
      ...(await this.findSkillTokenLinks(document, text, workspaceRoot))
    );

    return links;
  }

  private findSecretLinks(
    document: vscode.TextDocument,
    text: string
  ): vscode.DocumentLink[] {
    const target = vscode.Uri.parse(
      `command:${VSCODE_COMMANDS.OPEN_SECRETS_SETTINGS}`
    );
    return parseSecretReferences(text).map((reference) => {
      const link = new vscode.DocumentLink(
        new vscode.Range(
          document.positionAt(reference.startOffset),
          document.positionAt(reference.endOffset)
        ),
        target
      );
      link.tooltip = "Open ctrlyoke Secrets settings";
      return link;
    });
  }

  /** Resolve explicit ctrlyoke skill references using runtime discovery order. */
  private async findSkillTokenLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string
  ): Promise<vscode.DocumentLink[]> {
    const skillTokens = scanCtrlYokeSlashTokens(text).filter(
      (token) => token.kind === CTRLYOKE_SLASH_TOKEN_KINDS.SKILL
    );
    if (skillTokens.length === 0) {
      return [];
    }

    const skills = await SkillDiscovery.discoverSkills(workspaceRoot);
    const links: vscode.DocumentLink[] = [];

    for (const token of skillTokens) {
      const skill = SkillDiscovery.resolveCtrlYokeSkillInvocation(
        skills,
        token.name
      );
      if (!skill) {
        continue;
      }

      const range = new vscode.Range(
        document.positionAt(token.index),
        document.positionAt(token.index + token.length)
      );
      const link = new vscode.DocumentLink(range, vscode.Uri.file(skill.path));
      link.tooltip = `Open ctrlyoke skill ${token.name}`;
      links.push(link);
    }

    return links;
  }

  /**
   * Find a link for a prompt whose entire value is a standalone file path.
   * The candidate order mirrors PromptFileParser.resolvePromptFilePath().
   */
  private findPromptFileLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string,
    namedRoots: readonly ResolverWorkspaceFolder[],
    trustedRoots: readonly string[],
    approvedExternalRoots: readonly string[],
    ownStateRoots: readonly string[]
  ): vscode.DocumentLink[] {
    const trimmedPath = text.trim();
    const resolver = new PromptFileResolver({
      workspaceRoot,
      namedRoots,
      trustedRoots,
      ownStateRoots,
      approvedExternalRoots,
    });
    if (!resolver.looksLikePromptFilePath(trimmedPath)) {
      return [];
    }

    const resolution = resolver.resolvePathSync(trimmedPath, document.fileName);
    const resolvedPath =
      resolution.status === "missing"
        ? resolution.candidates[0]
        : resolution.path;
    if (!resolvedPath) {
      return [];
    }

    const decision = evaluateFileAccess(resolvedPath, {
      workspaceRoots: trustedRoots,
      ownStateRoots,
      approvedExternalRoots,
    });
    const start = text.indexOf(trimmedPath);
    const range = new vscode.Range(
      document.positionAt(start),
      document.positionAt(start + trimmedPath.length)
    );

    const link = decision.allowed
      ? new vscode.DocumentLink(range, vscode.Uri.file(decision.normalizedPath))
      : new vscode.DocumentLink(
          range,
          this.buildTrustCommandUri({
            path: decision.normalizedPath,
            workflowSourcePath: document.fileName,
          })
        );
    link.tooltip = decision.allowed
      ? `Open prompt file ${trimmedPath}`
      : `Trust and open prompt file ${trimmedPath}`;
    return [link];
  }

  /**
   * Resolve a ref's path the same way every other `@`-reference is resolved
   * (`resolveReferencePath`) and decide whether it's inside the
   * workspace, inside a trusted external root, or neither — a folder-name
   * prefix from a multi-root `.code-workspace` (`root2/src/index.ts`)
   * resolves against that named root instead of always joining onto the
   * primary root. See `FileAccessPolicy.evaluateFileAccess`.
   */
  private resolveLinkAccess(
    relativePath: string,
    workspaceRoot: string,
    namedRoots: readonly ResolverWorkspaceFolder[],
    trustedRoots: readonly string[],
    approvedExternalRoots: readonly string[],
    ownStateRoots: readonly string[],
    sourceDefinitionDir?: string
  ): FileAccessDecision | undefined {
    let resolved: string;
    try {
      resolved = resolveReferencePath(relativePath, {
        primaryRoot: workspaceRoot,
        namedRoots,
        sourceDefinitionDir,
      }).absolutePath;
    } catch {
      return undefined;
    }
    return evaluateFileAccess(resolved, {
      workspaceRoots: trustedRoots,
      ownStateRoots,
      approvedExternalRoots,
    });
  }

  /**
   * Build a command URI routing an untrusted reference through the shared
   * `ctrlyoke.confirmExternalFileTrust` command (same "Trust Parent Folder"
   * flow used by dashboard output links) instead of a raw `file:` URI.
   */
  private buildTrustCommandUri(target: FileOpenTarget): vscode.Uri {
    return vscode.Uri.parse(
      `command:ctrlyoke.confirmExternalFileTrust?${encodeURIComponent(JSON.stringify(target))}`
    );
  }

  /**
   * Check if document is a prompt file
   */
  private isPromptFile(document: vscode.TextDocument): boolean {
    const fileName = path.basename(document.fileName);
    return (
      fileName.endsWith(".ctrlyoke.json") ||
      fileName.endsWith(".ctrlyoke.yaml") ||
      fileName.endsWith(".ctrlyoke.yml") ||
      fileName.endsWith(".prompt.md") ||
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.PROMPT ||
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.MARKDOWN ||
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.YAML ||
      document.languageId === PROMPT_FILE_LANGUAGE_IDS.YML
    );
  }

  /**
   * Get workspace root folder path
   */
  private getWorkspaceRoot(): string | undefined {
    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? getVsCodeWorkspaceRoot() : undefined;
  }

  /**
   * Find full file reference links (@path/to/file.ts and @"path with spaces/file.ts")
   */
  private findFileLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string,
    namedRoots: readonly ResolverWorkspaceFolder[],
    trustedRoots: readonly string[],
    approvedExternalRoots: readonly string[],
    ownStateRoots: readonly string[],
    sourceDefinitionDir?: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];

    // Helper to add a file link from a regex match
    const addFileLink = (match: RegExpExecArray): void => {
      const relativePath = match[1];
      const decision = this.resolveLinkAccess(
        relativePath,
        workspaceRoot,
        namedRoots,
        trustedRoots,
        approvedExternalRoots,
        ownStateRoots,
        sourceDefinitionDir
      );
      if (!decision) {
        return;
      }
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      if (decision.allowed) {
        const fileUri = vscode.Uri.file(decision.normalizedPath);
        const link = new vscode.DocumentLink(range, fileUri);
        link.tooltip = `Open ${relativePath}`;
        links.push(link);
        return;
      }

      const commandUri = this.buildTrustCommandUri({
        path: decision.normalizedPath,
        workflowSourcePath: document.fileName,
      });
      const link = new vscode.DocumentLink(range, commandUri);
      link.tooltip = `Trust and open ${relativePath}`;
      links.push(link);
    };

    // Match quoted paths first (@"path with spaces/file.ext")
    const quotedPattern = new RegExp(this.patterns.fullFileQuoted.source, "g");
    let match: RegExpExecArray | null;
    while ((match = quotedPattern.exec(text)) !== null) {
      addFileLink(match);
    }

    // Match plain unquoted paths (@file.ext)
    const plainPattern = new RegExp(this.patterns.fullFile.source, "g");
    while ((match = plainPattern.exec(text)) !== null) {
      addFileLink(match);
    }

    return links;
  }

  /**
   * Find directory reference links (@path/to/dir/ and @"path with spaces/dir/")
   */
  private findDirectoryLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string,
    namedRoots: readonly ResolverWorkspaceFolder[],
    trustedRoots: readonly string[],
    approvedExternalRoots: readonly string[],
    ownStateRoots: readonly string[],
    sourceDefinitionDir?: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];

    // Helper to add a directory link from a regex match
    const addDirLink = (match: RegExpExecArray): void => {
      const relativePath = match[1];
      const decision = this.resolveLinkAccess(
        relativePath,
        workspaceRoot,
        namedRoots,
        trustedRoots,
        approvedExternalRoots,
        ownStateRoots,
        sourceDefinitionDir
      );
      if (!decision) {
        return;
      }
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      if (decision.allowed) {
        const dirUri = vscode.Uri.file(decision.normalizedPath);
        const commandUri = vscode.Uri.parse(
          `command:revealInExplorer?${encodeURIComponent(JSON.stringify(dirUri.toString()))}`
        );
        const link = new vscode.DocumentLink(range, commandUri);
        link.tooltip = `Reveal ${relativePath} in File Explorer`;
        links.push(link);
        return;
      }

      const trustCommandUri = this.buildTrustCommandUri({
        path: decision.normalizedPath,
        isDirectory: true,
        workflowSourcePath: document.fileName,
      });
      const link = new vscode.DocumentLink(range, trustCommandUri);
      link.tooltip = `Trust and reveal ${relativePath} in File Explorer`;
      links.push(link);
    };

    // Match quoted directory paths first (@"path with spaces/dir/")
    const quotedPattern = new RegExp(this.patterns.directoryQuoted.source, "g");
    let match: RegExpExecArray | null;
    while ((match = quotedPattern.exec(text)) !== null) {
      addDirLink(match);
    }

    // Match plain unquoted directory paths (@dir/)
    const plainPattern = new RegExp(this.patterns.directory.source, "g");
    while ((match = plainPattern.exec(text)) !== null) {
      addDirLink(match);
    }

    return links;
  }

  /**
   * Find line range reference links (#selection:path:10-20 and #selection:"path with spaces":10-20)
   */
  private findLineRangeLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string,
    namedRoots: readonly ResolverWorkspaceFolder[],
    trustedRoots: readonly string[],
    approvedExternalRoots: readonly string[],
    ownStateRoots: readonly string[],
    sourceDefinitionDir?: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];

    // Helper to add a line range link from a regex match
    const addLineRangeLink = (match: RegExpExecArray): void => {
      const relativePath = match[1] ?? match[2];
      const startLine = parseInt(match[3], 10);
      const endLine = parseInt(match[4], 10);

      const decision = this.resolveLinkAccess(
        relativePath,
        workspaceRoot,
        namedRoots,
        trustedRoots,
        approvedExternalRoots,
        ownStateRoots,
        sourceDefinitionDir
      );
      if (!decision) {
        return;
      }
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      if (decision.allowed) {
        const fileUri = vscode.Uri.file(decision.normalizedPath);
        const commandUri = vscode.Uri.parse(
          `command:ctrlyoke.openFileWithSelection?${encodeURIComponent(
            JSON.stringify({ uri: fileUri.toString(), startLine, endLine })
          )}`
        );
        const link = new vscode.DocumentLink(range, commandUri);
        link.tooltip = `Open ${relativePath} at lines ${startLine}-${endLine}`;
        links.push(link);
        return;
      }

      const trustCommandUri = this.buildTrustCommandUri({
        path: decision.normalizedPath,
        startLine,
        endLine,
        workflowSourcePath: document.fileName,
      });
      const link = new vscode.DocumentLink(range, trustCommandUri);
      link.tooltip = `Trust and open ${relativePath} at lines ${startLine}-${endLine}`;
      links.push(link);
    };

    const pattern = new RegExp(this.patterns.lineRange.source, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      addLineRangeLink(match);
    }

    return links;
  }

  /**
   * Find git change reference links (~diff, ~staged, ~stash:N, ~<hash>)
   * Opens a new untitled editor with the live diff output.
   */
  private findGitChangeLinks(
    document: vscode.TextDocument,
    text: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];

    const gitPatterns = [
      {
        pattern: createGitChangeReferencePattern(),
        getRef: (m: RegExpExecArray) => m[1],
      },
    ];

    for (const { pattern, getRef } of gitPatterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(text)) !== null) {
        const ref = getRef(match);
        const startPos = document.positionAt(match.index);
        const endPos = document.positionAt(match.index + match[0].length);
        const range = new vscode.Range(startPos, endPos);

        const commandUri = vscode.Uri.parse(
          `command:ctrlyoke.openGitChange?${encodeURIComponent(
            JSON.stringify({ ref: ref.toLowerCase() })
          )}`
        );

        const link = new vscode.DocumentLink(range, commandUri);
        link.tooltip = `Open git ${ref} diff`;
        links.push(link);
      }
    }

    return links;
  }

  /**
   * Find symbol reference links with encoded line ranges.
   */
  private findSymbolLinks(
    document: vscode.TextDocument,
    text: string,
    workspaceRoot: string,
    namedRoots: readonly ResolverWorkspaceFolder[],
    trustedRoots: readonly string[],
    approvedExternalRoots: readonly string[],
    ownStateRoots: readonly string[],
    sourceDefinitionDir?: string
  ): vscode.DocumentLink[] {
    const links: vscode.DocumentLink[] = [];

    // Helper to add a symbol link from a regex match
    const addSymbolLink = (match: RegExpExecArray): void => {
      const relativePath = match[2] ?? match[3];
      const symbolName = match[4] ?? match[5];
      const startLine = parseInt(match[6], 10);
      const endLine = parseInt(match[7], 10);

      const decision = this.resolveLinkAccess(
        relativePath,
        workspaceRoot,
        namedRoots,
        trustedRoots,
        approvedExternalRoots,
        ownStateRoots,
        sourceDefinitionDir
      );
      if (!decision) {
        return;
      }
      const startPos = document.positionAt(match.index);
      const endPos = document.positionAt(match.index + match[0].length);
      const range = new vscode.Range(startPos, endPos);

      if (decision.allowed) {
        const fileUri = vscode.Uri.file(decision.normalizedPath);
        const commandUri = vscode.Uri.parse(
          `command:ctrlyoke.openFileWithSelection?${encodeURIComponent(
            JSON.stringify({
              uri: fileUri.toString(),
              startLine,
              endLine,
            })
          )}`
        );
        const link = new vscode.DocumentLink(range, commandUri);
        link.tooltip = `Go to ${symbolName} in ${relativePath}:${startLine}-${endLine}`;
        links.push(link);
        return;
      }

      const trustCommandUri = this.buildTrustCommandUri({
        path: decision.normalizedPath,
        startLine,
        endLine,
        workflowSourcePath: document.fileName,
      });
      const link = new vscode.DocumentLink(range, trustCommandUri);
      link.tooltip = `Trust and go to ${symbolName} in ${relativePath}:${startLine}-${endLine}`;
      links.push(link);
    };

    const pattern = new RegExp(this.patterns.symbol.source, "g");
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      addSymbolLink(match);
    }

    return links;
  }
}
