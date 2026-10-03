import { Component, type ReactNode } from "react";

/**
 * Catches a render error in one page and shows a plain notice in its place,
 * so a single malformed coin can't blank the whole site. Keyed by route in
 * VentureApp, so navigating away resets it.
 */
export class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("page failed to render", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="dp-notice dp-bad" role="alert" style={{ margin: "24px 18px" }}>
        <h3>This page couldn't be shown.</h3>
        <p>Something in its data couldn't be displayed. Your wallet and funds are unaffected.</p>
        <a className="dp-action" style={{ display: "inline-block", marginTop: 12 }} href="/">Back to all coins</a>
      </div>
    );
  }
}
