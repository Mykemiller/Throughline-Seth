import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

// Brand tokens are the repo-root single source of truth (CLAUDE.md / Brand Bible).
import "../../../tokens.css";
import "./styles/global.css";

const rootEl = document.getElementById("root");
if (!rootEl) {
  throw new Error("Root element #root not found in index.html");
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
