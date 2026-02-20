import React, { useMemo } from "react";
import { Streamdown } from "streamdown";

interface MarkdownTextProps {
  /** The markdown string to render */
  children: string;
  /** Enable streaming animation (pass true while content is still arriving) */
  animated?: boolean;
  /** Optional additional CSS class on the container */
  className?: string;
}

/**
 * Renders AI-generated markdown text with Streamdown.
 *
 * Handles streaming-safe rendering with incomplete syntax healing.
 * Only used for TEXT and THINKING event types — tool calls retain
 * their own custom renderers.
 */
export const MarkdownText: React.FC<MarkdownTextProps> = ({
  children,
  animated = false,
  className,
}) => {
  // Memoize components to avoid re-creating on every chunk
  const components = useMemo(
    () => ({
      // Override <a> to open in external browser (webviews intercept clicks)
      a: ({
        href,
        children: linkChildren,
      }: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
        children?: React.ReactNode;
      }) => (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-[var(--vscode-textLink-foreground)] hover:underline"
        >
          {linkChildren}
        </a>
      ),
      // Inline code: VS Code monospace style
      code: ({
        children: codeChildren,
        className: langClass,
      }: React.HTMLAttributes<HTMLElement>) => (
        <code
          className={`${langClass ?? ""} bg-[var(--vscode-textCodeBlock-background)] text-[var(--vscode-editor-foreground)] rounded px-1 py-0.5 font-mono text-[0.9em]`}
        >
          {codeChildren}
        </code>
      ),
      // Code block wrapper: terminal-like appearance matching existing style
      pre: ({ children: preChildren }: React.HTMLAttributes<HTMLElement>) => (
        <pre className="bg-[var(--vscode-terminal-background,var(--vscode-editor-background))] border border-[var(--vscode-panel-border)] rounded p-3 overflow-x-auto my-2 font-mono text-[0.9em] whitespace-pre-wrap">
          {preChildren}
        </pre>
      ),
    }),
    []
  );

  return (
    <Streamdown
      animated={animated}
      className={`markdown-text ${className ?? ""}`}
      components={components}
      // No plugins prop: omitting avoids Shiki WASM CSP issues in VS Code webview
    >
      {children}
    </Streamdown>
  );
};
