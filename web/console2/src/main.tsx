import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerServiceWorker } from "./lib/pwa";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Only the production build has a worker (the dev server serves modules the worker would otherwise cache), and only after
// the page has loaded, so it never competes with first paint.
if (import.meta.env.PROD) window.addEventListener("load", () => { void registerServiceWorker(); });
