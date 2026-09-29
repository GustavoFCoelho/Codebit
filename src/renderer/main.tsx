import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// In cascade order: later files override earlier ones.
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/chat.css";
import "./styles/panel.css";
import "./styles/settings.css";
import "./styles/board.css";
import "./styles/work.css";
import "./styles/features.css";
import "./styles/identity.css";
import "./styles/responsive.css";
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
