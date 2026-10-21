// Entry point: load the planner, start the poller and render the app.

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { store } from "./store";
import "./styles.css";

void store.start();

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

// The service worker (static/sw.js) caches only hashed assets; the planner
// works without it, so a failed registration is not worth troubling anyone.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => console.warn("The service worker was not registered."));
  });
}
