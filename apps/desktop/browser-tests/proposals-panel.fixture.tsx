import type { CommandResult } from "@supa-video/contracts";
import type { TranscriptArtifactV1 } from "@supa-video/media";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";

import "../src/App.css";
import { ProposalsPanel, type ProposalTimelineRange } from "../src/video/ProposalsPanel";
import {
  artifact as loadArtifact,
  fakeBackend,
  id,
  projection,
  target,
} from "../src/video/proposals-panel-fixtures";

const backend = fakeBackend();

function Fixture() {
  const [artifact, setArtifact] = useState<TranscriptArtifactV1 | null>(null);
  const [ranges, setRanges] = useState<readonly ProposalTimelineRange[]>([]);
  const [log, setLog] = useState("");
  useEffect(() => {
    void (async () => setArtifact(await loadArtifact()))();
  }, []);
  const runEdit = async (run: (projectId: string) => Promise<readonly CommandResult[]>) => {
    const results = await run(projection.projectId);
    setLog(`edit:${results.length}`);
    return { ok: true } as const;
  };
  return (
    <main style={{ padding: 12, maxWidth: 480 }}>
      <ProposalsPanel
        projection={projection}
        target={target}
        artifact={artifact}
        disabled={artifact === null}
        runEdit={runEdit}
        onPreviewRanges={setRanges}
        backend={backend}
        newOperationId={() => id(900)}
      />
      <output data-testid="fixture-ranges" style={{ overflowWrap: "anywhere" }}>
        {ranges
          .map((range) => `${range.startFrame}-${range.endFrame}:${range.accepted ? "y" : "n"}`)
          .join(" ")}
      </output>
      <output data-testid="fixture-log">{log}</output>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("Missing fixture root");
ReactDOM.createRoot(root).render(<Fixture />);
