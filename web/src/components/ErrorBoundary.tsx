// Safety net: an error in part of the UI shows an explanation instead of a blank page.
import { Component, type ReactNode } from "react";

import { Head, Panel } from "./hud";

interface Props {
  fallback: (error: Error, reset: () => void) => ReactNode;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(error);
  }

  render() {
    return this.state.error ? this.props.fallback(this.state.error, () => this.setState({ error: null })) : this.props.children;
  }
}

/** The whole page crashed: explanation and reload (link state is kept). */
export function CrashScreen({ error }: { error: Error }) {
  return (
    <div className="boot">
      <Panel>
        <Head label="SOMETHING WENT WRONG" />
        <h1>The page hit an error</h1>
        <p>Reloading usually helps: the link keeps your site, dates and route.</p>
        <p className="mono muted" style={{ fontSize: 11.5, wordBreak: "break-word" }}>{error.message}</p>
        <div className="btn-row" style={{ marginTop: 14 }}>
          <button className="btn primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </Panel>
    </div>
  );
}
