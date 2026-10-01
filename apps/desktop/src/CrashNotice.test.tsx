// @vitest-environment jsdom

import * as axe from "axe-core";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CrashNotice, crashReportSchema, type CrashReport } from "./CrashNotice";

afterEach(cleanup);

const report: CrashReport = {
  schemaVersion: 1,
  appVersion: "0.1.0",
  occurredAtMs: 1,
  thread: "main",
  location: "video/render.rs:12",
  message: "could not open <path>",
};

describe("CrashNotice", () => {
  it("shows nothing when there are no reports or loading fails", async () => {
    const { container } = render(<CrashNotice load={async () => []} />);
    await Promise.resolve();
    expect(container.textContent).toBe("");
    cleanup();
    const failed = render(
      <CrashNotice
        load={async () => {
          throw new Error("unavailable");
        }}
      />,
    );
    await Promise.resolve();
    expect(failed.container.textContent).toBe("");
  });

  it("surfaces the latest redacted report and can be dismissed", async () => {
    const { container } = render(<CrashNotice load={async () => [report]} />);
    expect((await screen.findByRole("status")).textContent).toContain(
      "could not open <path> (video/render.rs:12)",
    );
    const results = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] },
    });
    expect(results.violations).toEqual([]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("rejects unexpected report fields at the IPC boundary", () => {
    expect(crashReportSchema.safeParse({ ...report, path: "C:\\Users\\me" }).success).toBe(false);
  });
});
