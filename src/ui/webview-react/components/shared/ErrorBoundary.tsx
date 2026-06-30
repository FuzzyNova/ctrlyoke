import { Component, type ErrorInfo, type ReactNode } from "react";
import { WebviewLog } from "@utils/logger";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  componentStack: string | null;
}

/**
 * Top-level error boundary for the ctrlyoke webview.
 *
 * Catches uncaught render/effect errors (including React error #185 from
 * useSyncExternalStore tearing) and logs the component stack so we can
 * identify the crashing component even from a minified bundle.
 *
 * componentStack is the most useful diagnostic: it shows the React component
 * tree path from the root to the component that threw, using the component
 * function names preserved in the dev bundle.
 */
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, componentStack: null };
  }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const componentStack = info.componentStack ?? "(no component stack)";
    WebviewLog.error(
      `[ErrorBoundary] Caught error: ${error.message}\n\nStack:\n${error.stack}\n\nComponent stack:\n${componentStack}`
    );
    this.setState({ componentStack });
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: "12px",
            fontFamily: "monospace",
            fontSize: "12px",
            color: "var(--vscode-errorForeground, #f44)",
          }}
        >
          <strong>ctrlyoke encountered an error.</strong>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              marginTop: "8px",
              fontSize: "11px",
              opacity: 0.8,
            }}
          >
            {this.state.error?.message}
          </pre>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              marginTop: "8px",
              fontSize: "10px",
              opacity: 0.6,
            }}
          >
            {this.state.componentStack}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}
