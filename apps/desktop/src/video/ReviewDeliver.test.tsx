// @vitest-environment jsdom

import * as axe from "axe-core";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { QcFinding } from "@supa-video/contracts";
import { computeFindingId, type ReviewDecision, type ReviewState } from "@supa-video/qc";

import { DeliverPanel } from "./DeliverPanel";
import { ReviewPanel } from "./ReviewPanel";

afterEach(cleanup);

const STATE = "a".repeat(64);
const SHA = "b".repeat(64);

async function finding(
  kind: QcFinding["kind"],
  severity: QcFinding["severity"],
  source: QcFinding["source"] = "deterministic",
): Promise<QcFinding> {
  const range = { startUs: 2_000_000, endUs: 3_500_000 };
  return {
    findingId: await computeFindingId({
      kind,
      source,
      subject: "",
      range,
      revisionStateHash: STATE,
    }),
    kind,
    severity,
    source,
    subject: "",
    range,
    message: `${kind} message`,
  };
}

function state(findings: QcFinding[], decisions: ReviewDecision[] = []): ReviewState {
  const blockers = findings
    .filter((item) => item.severity === "blocker")
    .filter(
      (item) =>
        item.source === "rights" ||
        !decisions.some((d) => d.type === "accept_anyway" && d.findingId === item.findingId),
    )
    .map((item) => item.findingId);
  return {
    manifest: {
      schemaVersion: 1,
      kind: "review",
      presetId: null,
      project: { revisionId: "00000000-0000-4000-8000-00000000000a", revisionStateHash: STATE },
      renderPlanSha256: SHA,
      toolchainId: "ffmpeg-test",
      inputs: [],
      output: {
        fileName: "export.mp4",
        sha256: SHA,
        sizeBytes: 1,
        durationMicroseconds: 4_000_000,
        width: 1920,
        height: 1080,
        videoCodec: "h264",
        audioCodec: "aac",
      },
      loudness: null,
      qc: {
        status: blockers.length > 0 ? "blocked" : "passed",
        detectorVersion: "qc-v1",
        findings,
      },
      editorial: { evaluatorVersion: "editorial-v1", evaluationSha256: SHA },
      source: null,
      appVersion: "0.1.0",
      createdAt: "2026-10-01T00:00:00Z",
    },
    manifestSha256: SHA,
    decisions,
    release:
      blockers.length > 0
        ? { status: "blocked", unresolvedFindingIds: blockers }
        : { status: "releasable", acceptedFindingIds: [], acceptedDecisionIds: [] },
  };
}

function reviewPanel(review: ReviewState | null) {
  const handlers = {
    onSeek: vi.fn<(startUs: number) => void>(),
    onAccept: vi.fn<(findingId: string, reason: string) => void>(),
    onProposeRepair: vi.fn<(finding: QcFinding) => void>(),
    onStopRepair: vi.fn<(findingId: string) => void>(),
  };
  const view = render(
    <ReviewPanel review={review} loading={false} error={null} pending={false} {...handlers} />,
  );
  return { ...handlers, container: view.container };
}

async function expectNoAxeViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag22aa"] },
  });
  expect(results.violations, results.violations.map(({ id }) => id).join(", ")).toEqual([]);
}

describe("ReviewPanel", () => {
  it("asks for an export before any review exists", () => {
    reviewPanel(null);
    expect(screen.getByText("Export the video to run quality checks.")).toBeTruthy();
  });

  it("lists findings, seeks to their range and accepts a blocker with a reason by keyboard", async () => {
    const black = await finding("black_frames", "blocker");
    const { onSeek, onAccept, container } = reviewPanel(state([black]));
    expect(screen.getByRole("status").textContent).toContain("1 problem(s)");
    const list = screen.getByRole("list", { name: "Quality findings" });
    expect(within(list).getByText("Black frames")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to Black frames at 2.0 s" }));
    expect(onSeek).toHaveBeenCalledWith(2_000_000);
    const accept = screen.getByRole("button", { name: "Accept anyway" });
    expect((accept as HTMLButtonElement).disabled).toBe(true);
    // Keyboard path: native input inside a form, so Enter submits it.
    const reason = screen.getByLabelText("Reason to accept anyway");
    reason.focus();
    expect(document.activeElement).toBe(reason);
    fireEvent.change(reason, { target: { value: "  Intentional fade " } });
    expect((accept as HTMLButtonElement).disabled).toBe(false);
    expect(accept.getAttribute("type")).toBe("submit");
    fireEvent.submit(reason.closest("form") as HTMLFormElement);
    expect(onAccept).toHaveBeenCalledWith(black.findingId, "Intentional fade");
    await expectNoAxeViolations(container);
  });

  it("offers repair for silence, counts attempts and stops at the limit", async () => {
    const silence = await finding("silence", "warning");
    const base = {
      schemaVersion: 1 as const,
      findingId: silence.findingId,
      outputSha256: SHA,
      manifestSha256: SHA,
      recordedAt: "2026-10-01T00:00:00Z",
      type: "repair_attempt" as const,
      outcome: "proposed" as const,
    };
    const { onProposeRepair } = reviewPanel(state([silence]));
    fireEvent.click(screen.getByRole("button", { name: "Suggest a fix (0/3)" }));
    expect(onProposeRepair).toHaveBeenCalledWith(silence);
    cleanup();
    const attempts: ReviewDecision[] = [1, 2, 3].map((attempt) => ({
      ...base,
      attempt,
      proposalId: `p${attempt}`,
      decisionId: `00000000-0000-4000-8000-00000000000${attempt}`,
    }));
    reviewPanel(state([silence], attempts));
    expect(screen.queryByRole("button", { name: /Suggest a fix/u })).toBeNull();
    expect(screen.getByRole("button", { name: "Stop fixing" })).toBeTruthy();
  });

  it("never offers accept-anyway for rights findings", async () => {
    const rights = await finding("rights_blocked", "blocker", "rights");
    reviewPanel(state([rights]));
    expect(screen.queryByRole("button", { name: "Accept anyway" })).toBeNull();
    expect(screen.getByText(/Rights problems cannot be accepted/u)).toBeTruthy();
  });
});

describe("DeliverPanel", () => {
  function deliverPanel(review: ReviewState | null, pending = false) {
    const onToggle = vi.fn();
    const onDeliver = vi.fn();
    const view = render(
      <DeliverPanel
        review={review}
        selected={["landscape_16x9_1080p", "square_1x1_1080p"]}
        outputs={{
          landscape_16x9_1080p: {
            phase: "done",
            outputPath: "C:\\out-16x9.mp4",
            manifestPath: "m",
          },
          square_1x1_1080p: { phase: "failed", message: "New problem found" },
        }}
        pending={pending}
        error={null}
        onToggle={onToggle}
        onDeliver={onDeliver}
      />,
    );
    return { onToggle, onDeliver, container: view.container };
  }

  it("is disabled and lists unresolved findings while review is blocked", async () => {
    const black = await finding("black_frames", "blocker");
    const { onDeliver, container } = deliverPanel(state([black]));
    const button = screen.getByRole("button", { name: "Deliver selected formats" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(onDeliver).not.toHaveBeenCalled();
    const list = screen.getByRole("list", { name: "Unresolved findings" });
    expect(within(list).getByText("black_frames message")).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("delivers when releasable and toggles presets by keyboard", async () => {
    const warning = await finding("silence", "warning");
    const { onDeliver, onToggle, container } = deliverPanel(state([warning]));
    const portrait = screen.getByRole("checkbox", { name: /Vertical 9:16/u });
    expect((portrait as HTMLInputElement).checked).toBe(false);
    portrait.focus();
    expect(document.activeElement).toBe(portrait);
    fireEvent.click(portrait); // Space on a focused native checkbox
    expect(onToggle).toHaveBeenCalledWith("portrait_9x16_1080p", true);
    const deliver = screen.getByRole("button", { name: "Deliver selected formats" });
    deliver.focus();
    expect(document.activeElement).toBe(deliver);
    expect(deliver.tabIndex).toBe(0);
    fireEvent.click(deliver); // Enter/Space on a focused native button
    expect(onDeliver).toHaveBeenCalledTimes(1);
    // Only the file name is shown; the full path stays out of the narrow column.
    expect(screen.getByText(/Done · out-16x9\.mp4/u)).toBeTruthy();
    expect(screen.queryByText(/C:\\/u)).toBeNull();
    expect(screen.getByText(/Failed · New problem found/u)).toBeTruthy();
    await expectNoAxeViolations(container);
  });

  it("asks for a review export first", () => {
    deliverPanel(null);
    expect(screen.getByText("Export and review the video first.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Deliver selected formats" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
