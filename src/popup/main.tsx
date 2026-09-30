import React from "react";
import { createRoot } from "react-dom/client";
import { installDevChromeMock } from "../shared/devChromeMock";
import { ResearchRecorder } from "./ResearchRecorder";

installDevChromeMock();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode><ResearchRecorder /></React.StrictMode>
);
