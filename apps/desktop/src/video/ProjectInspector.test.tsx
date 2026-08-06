// @vitest-environment jsdom

import type { ProjectProjection, RecoveryReport } from "@supa-video/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";

import { CommandProvider, useCommandHandler } from "../commands/CommandProvider";
import { ProjectInspector } from "./ProjectInspector";

const projection: ProjectProjection = {
  projectId: "00000000-0000-4000-8000-000000000001",
  name: "Inspector fixture",
  revision: {
    number: 42,
    id: "00000000-0000-4000-8000-000000000002",
    parentId: "00000000-0000-4000-8000-000000000003",
    committedAt: "2026-07-26T12:00:00Z",
    operationId: "00000000-0000-4000-8000-000000000004",
    stateHash: "abcdef0123456789".repeat(4),
  },
  state: { assets: [], sequences: [], activeSequenceId: null },
  canUndo: true,
  canRedo: false,
  lastCommand: {
    operationId: "00000000-0000-4000-8000-000000000004",
    groupId: "00000000-0000-4000-8000-000000000005",
    summary: "Applied trim",
  },
  sources: [],
  journalHealth: "snapshot_pending",
  snapshotRevision: 25,
  recoveryStatus: "recovered",
  replayedRecordCount: 17,
};

const recovered: RecoveryReport = {
  status: "recovered",
  recoveredRevision: 42,
  replayedRecordCount: 17,
  discardedTailBytes: 32,
  message: "Project recovered from durable journal data.",
  legacyHistoryReset: false,
};

const journalRecreated: RecoveryReport = {
  status: "journal_recreated",
  recoveredRevision: 42,
  replayedRecordCount: 0,
  discardedTailBytes: 0,
  message: "Recovery journal recreated from the validated snapshot.",
  legacyHistoryReset: false,
};

function InspectorFixture({
  value,
  recovery,
  onClose = () => undefined,
}: {
  value: ProjectProjection;
  recovery: RecoveryReport | null;
  onClose?: () => void;
}) {
  useCommandHandler("view.toggleProjectInspector", { canExecute: true, execute: onClose });
  return <ProjectInspector projection={value} recovery={recovery} />;
}

function inspector(
  value: ProjectProjection,
  recovery: RecoveryReport | null,
  onClose?: () => void,
) {
  return (
    <CommandProvider>
      <InspectorFixture
        value={value}
        recovery={recovery}
        {...(onClose === undefined ? {} : { onClose })}
      />
    </CommandProvider>
  );
}

describe("ProjectInspector", () => {
  it("renders sanitized recovered details, focuses Close, and has no axe violations", async () => {
    const onClose = vi.fn();
    const { container } = render(inspector(projection, recovered, onClose));
    expect(screen.getByRole("heading", { name: "Project inspector" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Recovery report" })).toBeTruthy();
    expect(screen.getByText(projection.revision.stateHash)).toBeTruthy();
    expect(screen.getByText("snapshot pending")).toBeTruthy();
    expect(screen.getByText("32 bytes")).toBeTruthy();
    expect(screen.getByText(recovered.message)).toBeTruthy();
    const close = screen.getByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(close);
    expect((await axe.run(container)).violations).toEqual([]);
    fireEvent.click(close);
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain(".svpvideo.data");
  });

  it("renders recovered last-command metadata instead of initialization defaults", () => {
    const reopenedProjection: ProjectProjection = {
      ...projection,
      lastCommand: {
        operationId: "50000000-0000-4000-8000-000000000004",
        groupId: "50000000-0000-4000-8000-000000000001",
        summary: "Redid Applied trim",
      },
    };
    const { container } = render(inspector(reopenedProjection, recovered));

    expect(screen.getByText("Redid Applied trim")).toBeTruthy();
    expect(screen.getByText("50000000-0000-4000-8000-000000000004")).toBeTruthy();
    expect(screen.getByText("50000000-0000-4000-8000-000000000001")).toBeTruthy();
    expect(container.textContent).not.toContain("Project initialization");
    expect(container.textContent).not.toContain("Not applicable");
  });

  it("renders journal recreation and redacts path or raw-data recovery messages", async () => {
    const privateMessage = {
      ...journalRecreated,
      message:
        "Recreated C:\\Users\\Editor\\project.svpvideo.data from aabbccddeeff00112233445566778899.",
    };
    const { container } = render(inspector(projection, privateMessage));
    expect(screen.getByText("journal recreated")).toBeTruthy();
    expect(
      screen.getByText("The recovery journal was recreated from the validated project snapshot."),
    ).toBeTruthy();
    expect(screen.getByText("None")).toBeTruthy();
    expect(container.textContent).not.toContain("Users");
    expect(container.textContent).not.toContain("aabbcc");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
