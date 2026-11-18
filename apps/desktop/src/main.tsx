import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";
import { applySettings, loadSettings } from "./settings";
import { ShareOverlay, isShareOverlay } from "./ShareOverlay";
import { CallWindow, isCallWindow } from "./OwnCallWindow";
import { ReminderWindow, isReminderWindow } from "./MeetingReminder";

// Before the first render, so there is no flash of the wrong theme.
applySettings(loadSettings());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      {isShareOverlay ? <ShareOverlay /> : isCallWindow ? <CallWindow /> : isReminderWindow ? <ReminderWindow /> : <App />}
    </ErrorBoundary>
  </StrictMode>,
);
