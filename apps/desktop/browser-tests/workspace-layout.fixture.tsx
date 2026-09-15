import { createRoot } from "react-dom/client";
import { TwoPaneWorkspace } from "../src/video/TwoPaneWorkspace";
import "../src/App.css";
createRoot(document.getElementById("root")!).render(
  <main className="shared-rail">
    <TwoPaneWorkspace label="Workspace pane width">
      <section className="panel">
        <h2>Program and timeline</h2>
        <button type="button">Play</button>
      </section>
      <aside className="panel">
        <h2>Source and editing controls</h2>
        <button type="button">Choose source</button>
      </aside>
    </TwoPaneWorkspace>
  </main>,
);
