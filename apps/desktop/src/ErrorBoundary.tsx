import { Component, type ReactNode } from "react";
import { t } from "./i18n";

/** Shows what broke instead of a blank window; "Try again" re-renders the app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Trixcomm UI crashed:", error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="login-screen">
        <div className="login-card crash">
          <h1>{t("crash.title")}</h1>
          <p>{t("crash.body")}</p>
          <pre>{error.message}</pre>
          <button className="btn primary" onClick={() => this.setState({ error: null })}>{t("crash.retry")}</button>
        </div>
      </div>
    );
  }
}
