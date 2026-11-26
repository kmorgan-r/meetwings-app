import React from "react";
import ReactDOM from "react-dom/client";
import Overlay from "./components/Overlay";
import { AppProvider, ThemeProvider } from "./contexts";
import { Toaster } from "./components";
import "./global.css";
import { getCurrentWindow } from "@tauri-apps/api/window";
import AppRoutes from "./routes";
import { startMainWindowUpdater } from "./lib/updater/main-window-updater";
import { logMicOpens } from "./lib/mic-diagnostics";
import { reportCaughtError } from "./lib/report-caught-error";

const currentWindow = getCurrentWindow();
const windowLabel = currentWindow.label;

// Diagnostics only: a WebKit that refuses the getUserMedia override must not
// stop the app from rendering.
try {
  logMicOpens(windowLabel);
} catch {
  // Nothing to report to: release builds have no console.
}

// Outside the React root: nothing above App catches a render error, and an
// updater a broken release can kill would strand every colleague (no rollback).
// The try keeps a future synchronous throw from also skipping createRoot below.
if (windowLabel === "main") {
  try {
    startMainWindowUpdater();
  } catch {
    // Nothing to report to: release builds have no console.
  }
}

// Render different components based on window label
if (windowLabel.startsWith("capture-overlay-")) {
  const monitorIndex = parseInt(windowLabel.split("-")[2], 10) || 0;
  // Render overlay without providers
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <Overlay monitorIndex={monitorIndex} />
    </React.StrictMode>
  );
} else {
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
    onCaughtError: reportCaughtError,
  }).render(
    <React.StrictMode>
      <ThemeProvider>
        <AppProvider>
          <AppRoutes />
          <Toaster />
        </AppProvider>
      </ThemeProvider>
    </React.StrictMode>
  );
}
