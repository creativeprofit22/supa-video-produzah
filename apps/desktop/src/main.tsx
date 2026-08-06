import React from "react";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import ReactDOM from "react-dom/client";
import { AppRoot } from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
