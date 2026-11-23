import { Component, type ErrorInfo, type ReactNode } from "react";
import { backend } from "./backend";
import { t } from "./i18n";

/** Shows what broke instead of a blank window; "Try again" re-renders the app. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Trixcomm UI crashed:", error);
    // In the log too, with where it happened (the first components of the stack).
    const where = (info.componentStack ?? "").trim().split("\n").slice(0, 4).map((l) => l.trim()).join(" < ");
    void backend.logUi(`UI crashed: ${error.message}${where ? ` (${where})` : ""}`).catch(() => {});
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
