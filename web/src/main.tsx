import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { CrashScreen, ErrorBoundary } from "./components/ErrorBoundary";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary fallback={(e) => <CrashScreen error={e} />}>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
