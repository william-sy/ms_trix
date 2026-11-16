import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";
import { applySettings, loadSettings } from "./settings";

// Before the first render, so there is no flash of the wrong theme.
applySettings(loadSettings());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
